import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { uploadImageToStorage } from "./image-upload-storage";

// Helper function to generate JWT for Google Service Account
async function generateJWT(serviceAccount: any): Promise<string> {
  const { createSign } = await import("crypto");
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${header}.${encodedPayload}`;
  
  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");
  
  return `${signatureInput}.${signature}`;
}


const RECEIPT_PARSE_PROMPT = `You are an expert at extracting data from Spanish receipts and invoices.
Analyze the provided receipt image and extract the following fields.
Return ONLY a valid JSON object with these exact keys:
- invoiceNumber: string (factura/invoice number, or empty string if not found)
- vendor: string (business/company name)
- date: string (ISO format YYYY-MM-DD, today's date if not found)
- totalAmount: number (total amount including IVA, in EUR)
- ivaAmount: number (IVA/tax amount in EUR, 0 if not found)
- tipAmount: number (tip/gratuity amount in EUR, 0 if not found)
- category: string (one of: "Office Supplies", "Travel & Transport", "Meals & Entertainment", "Utilities", "Professional Services", "Software & Subscriptions", "Equipment", "Marketing", "Other")
- items: array (ONLY for La Portenia or Es Cuco vendors - extract line items with: partName, quantity (in kg), unit ("kg"), pricePerUnit, total. For other vendors, return empty array [])

Important notes:
- In Spain, IVA is the VAT tax (usually 21%, 10%, or 4%)
- Look for "TOTAL", "IMPORTE TOTAL", or similar for total amount
- Look for "IVA", "I.V.A.", "CUOTA IVA" for tax amount
- Dates may be in DD/MM/YYYY format in Spain
- For meat vendors (La Portenia, Es Cuco): Extract from table columns PRODUCTO (part name), CANT. (quantity in kg), TARIFA (price per unit), IMPORTE (total)
- For non-meat vendors: Return empty items array []
- Return only the JSON, no markdown, no explanation`;

const EMAIL_PARSE_PROMPT = `You are an expert at extracting invoice data from email content.
Analyze the provided email text and extract invoice information.
Return ONLY a valid JSON object with these exact keys:
- invoiceNumber: string (invoice/factura number)
- vendor: string (sender company/business name)
- date: string (ISO format YYYY-MM-DD)
- totalAmount: number (total amount in EUR)
- ivaAmount: number (IVA/VAT amount in EUR, 0 if not found)
- tipAmount: number (tip/gratuity amount in EUR, 0 if not found)
- category: string (one of: "Office Supplies", "Travel & Transport", "Meals & Entertainment", "Utilities", "Professional Services", "Software & Subscriptions", "Equipment", "Marketing", "Other")
- subject: string (email subject line)
- items: array (return empty array [] for email invoices)

Return only the JSON, no markdown, no explanation.`;

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  invoices: router({
    // Parse receipt image with AI OCR
    parseReceipt: publicProcedure
      .input(z.object({ imageBase64: z.string() }))
      .mutation(async ({ input }) => {
        try {
          const response = await invokeLLM({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: RECEIPT_PARSE_PROMPT },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${input.imageBase64}`,
                      detail: "high",
                    },
                  },
                ],
              },
            ],
          });

          const rawContent = response.choices?.[0]?.message?.content;
          const text = typeof rawContent === "string" ? rawContent : "{}";
          // Strip markdown code blocks if present
          const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          return JSON.parse(cleaned);
        } catch (err) {
          console.error("[OCR] Parse error:", err);
          return {
            invoiceNumber: "",
            vendor: "",
            date: new Date().toISOString().split("T")[0],
            totalAmount: 0,
            ivaAmount: 0,
            tipAmount: 0,
            category: "Other",
          };
        }
      }),

    // Parse email invoice text with AI
    parseEmailInvoice: publicProcedure
      .input(z.object({ emailText: z.string(), subject: z.string().optional() }))
      .mutation(async ({ input }) => {
        try {
          const response = await invokeLLM({
            messages: [
              {
                role: "user",
                content: `${EMAIL_PARSE_PROMPT}\n\nEmail Subject: ${input.subject ?? ""}\n\nEmail Content:\n${input.emailText}`,
              },
            ],
          });

          const rawContent = response.choices?.[0]?.message?.content;
          const text = typeof rawContent === "string" ? rawContent : "{}";
          const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          return JSON.parse(cleaned);
        } catch (err) {
          console.error("[Email Parse] error:", err);
          return {
            invoiceNumber: "",
            vendor: "",
            date: new Date().toISOString().split("T")[0],
            totalAmount: 0,
            ivaAmount: 0,
            tipAmount: 0,
            category: "Other",
            subject: input.subject ?? "",
          };
        }
      }),

    // Fix all sheets (V3)
    fixAllSheetsV3: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) {
          throw new Error("Service Account credentials not configured");
        }

        try {
          const serviceAccount = JSON.parse(serviceAccountJson);
          const { fixAllSheets } = await import("./sheets-complete-fixer-v3");
          return await fixAllSheets(serviceAccount);
        } catch (error) {
          console.error("[fixAllSheetsV3] Error:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }),

    // Export invoice to Google Sheets
    exportToSheets: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
          sheetName: z.string().default("Invoices"),
          rows: z.array(
            z.object({
              source: z.string(),
              invoiceNumber: z.string(),
              vendor: z.string(),
              date: z.string(),
              totalAmount: z.number(),
              ivaAmount: z.number(),
              baseAmount: z.number(),
              category: z.string(),
              currency: z.string().default("EUR"),
              notes: z.string().optional(),
              imageUrl: z.string().optional(),
              tip: z.number().optional(),
              items: z.array(
                z.object({
                  partName: z.string(),
                  quantity: z.number(),
                  unit: z.string(),
                  pricePerUnit: z.number(),
                  total: z.number(),
                })
              ).optional(),
            })
          ),
          automateSheets: z.boolean().optional().default(false),
        })
      )
      .mutation(async ({ input }) => {
        const { spreadsheetId, sheetName, rows } = input;
        
        // Get Service Account credentials from environment
        const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) {
          throw new Error("Service Account credentials not configured. Please contact support.");
        }

        let serviceAccount: any;
        try {
          serviceAccount = JSON.parse(serviceAccountJson);
        } catch (e) {
          throw new Error("Invalid Service Account credentials configuration.");
        }

        // Get access token using Service Account
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: await generateJWT(serviceAccount),
          }),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error("Token error:", errText);
          throw new Error("Failed to authenticate with Google Sheets.");
        }

        const tokenData = await tokenRes.json() as { access_token: string };
        const accessToken = tokenData.access_token;

        // First, ensure header row exists
        const headerValues = [
          ["Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Category", "Currency", "Tip (€)", "Notes", "Image URL", "Exported At"],
        ];

        // Check if sheet exists and has headers
        const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:K1`;
        const checkRes = await fetch(checkUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (checkRes.ok) {
          const checkData = await checkRes.json() as { values?: string[][] };
          if (!checkData.values || checkData.values.length === 0) {
            // Add headers
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:K1?valueInputOption=RAW`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ values: headerValues }),
              }
            );
          }
        }

        // Check for duplicates before appending
        // Read all data from the sheet to check for duplicates
        const existingUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:L`;
        const existingRes = await fetch(existingUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        const existingData = await existingRes.json() as { values?: string[][] };
        // Create a set of existing invoices using Vendor + Date + Amount (more reliable than Invoice #)
        const existingInvoices = new Set(
          existingData.values?.slice(1).map((row) => {
            // row[2] = Vendor, row[3] = Date, row[4] = Total (€)
            const vendor = row[2] || "";
            const date = row[3] || "";
            const amount = row[4] || "";
            return `${vendor}|${date}|${amount}`;
          }) || []
        );
        
        // Filter out duplicates based on Vendor + Date + Amount
        const newRows = rows.filter((r) => {
          const key = `${r.vendor}|${r.date}|€${r.totalAmount.toFixed(2)}`;
          if (existingInvoices.has(key)) {
            console.warn(`[Export] Skipping duplicate invoice: ${r.vendor} | ${r.date} | €${r.totalAmount.toFixed(2)}`);
            return false;
          }
          return true;
        });
        
        if (newRows.length === 0) {
          return { success: true, rowsAdded: 0, message: "All invoices are duplicates. No new data added." };
        }
        
        // Append data rows with image upload
        const now = new Date().toISOString();
        const dataRows = await Promise.all(
          newRows.map(async (r) => {
            let imageUrl = r.imageUrl ?? "";
            
            // If imageUrl is a base64 string or local file path, upload it to storage
            if (imageUrl && (imageUrl.startsWith("data:") || imageUrl.startsWith("file://"))) {
              try {
                // Extract base64 if it's a data URL
                let base64Data = "";
                if (imageUrl.startsWith("data:")) {
                  // Format: data:image/jpeg;base64,{base64data}
                  const match = imageUrl.match(/base64,(.+)$/);
                  if (match && match[1]) {
                    base64Data = match[1].trim();
                  } else {
                    console.warn("[Export] Failed to extract base64 from data URL");
                    imageUrl = "";
                  }
                } else if (imageUrl.startsWith("file://")) {
                  // For local file paths, we'll skip upload (client should send base64)
                  console.warn("[Export] Skipping local file path upload:", imageUrl);
                  imageUrl = "";
                }
                
                if (base64Data && !imageUrl.startsWith("file://")) {
                  // Generate filename from invoice number or timestamp
                  // Sanitize invoice number: remove folder separators and special characters
                  const sanitizedInvoiceNum = ((r.invoiceNumber || "receipt")
                    .split("/").pop() || "receipt")  // Extract only the last part (remove folder path)
                    .replace(/[^a-zA-Z0-9-]/g, "")  // Remove special characters
                    .substring(0, 50);  // Limit length
                  const fileName = `${sanitizedInvoiceNum || "receipt"}-${Date.now()}.jpg`;
                  imageUrl = await uploadImageToStorage(base64Data, fileName);
                  console.log(`[Export] Image uploaded for ${r.vendor}: fileName=${fileName}, url=${imageUrl}`);
                }
              } catch (error) {
                console.error(`[Export] Failed to upload image for ${r.vendor}:`, error);
                // Continue without image URL if upload fails
                imageUrl = "";
              }
            }
            
            // Format date as YYYY-MM-DD (with leading apostrophe to prevent Google Sheets auto-formatting)
            const formattedDate = `'${new Date(r.date).toISOString().split('T')[0]}'`;
            
            return [
              r.source,
              r.invoiceNumber,
              r.vendor,
              formattedDate,
              r.totalAmount,
              r.ivaAmount,
              r.baseAmount,
              r.tip ?? 0,
              r.category,
              r.currency,
              r.notes ?? "",
              imageUrl,
              now,
            ];
          })
        );

        const range = `${sheetName}!A:M`;
        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
        const appendRes = await fetch(appendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ values: dataRows }),
        });

        if (!appendRes.ok) {
          const errText = await appendRes.text();
          console.error("Sheets API error:", errText);
          console.error("Append URL:", appendUrl);
          throw new Error(`Failed to export to Google Sheets. Please try again.`);
        }

        // Automatically trigger sheet automation on every upload
        // Always run automation to keep monthly/quarterly sheets in sync
        if (true) {
          try {
            const { automateGoogleSheets } = await import("./sheets-automation-vendor-aggregated");
            
            // Fetch ALL data from 2026 Invoice tracker sheet for complete monthly/quarterly aggregation
            const trackerSheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent("2026 Invoice tracker")}!A2:L`;
            const trackerRes = await fetch(trackerSheetUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            
            let allInvoiceData: any[] = [];
            if (trackerRes.ok) {
              const trackerData = await trackerRes.json() as { values?: any[][] };
              if (trackerData.values) {
                allInvoiceData = trackerData.values.map((row: any[]) => {
                  // Helper function to parse currency strings (e.g., "€133.18" -> 133.18)
                  const parseCurrency = (val: any) => {
                    if (!val) return 0;
                    const numStr = String(val).replace(/[€,\s]/g, '').trim();
                    const num = parseFloat(numStr);
                    return isNaN(num) ? 0 : num;
                  };
                  
                  return {
                    source: row[0] || "",
                    invoiceNumber: row[1] || "",
                    vendor: row[2] || "",
                    date: row[3] || "",
                    totalAmount: parseCurrency(row[4]),
                    ivaAmount: parseCurrency(row[5]),
                    baseAmount: parseCurrency(row[6]),
                    category: row[7] || "",
                    currency: row[8] || "EUR",
                    tip: parseCurrency(row[9]),
                    notes: row[10] || "",
                    imageUrl: row[11] || "",
                  };
                });
              }
            }
            
            // Use all data for automation (includes all rows from main sheet)
            console.log(`📊 Automation: Processing ${allInvoiceData.length} invoices from main sheet`);
            
            if (allInvoiceData.length === 0) {
              console.warn("⚠️  No invoice data found in main sheet");
            }
            
            await automateGoogleSheets({
              spreadsheetId,
              accessToken,
              invoiceData: allInvoiceData,
            }, ["La portenia", "es cuco"]);
            console.log("✅ Automation completed successfully");
          } catch (error) {
            console.error("❌ Automation failed:", error);
            throw error;
          }
        }

        return { success: true, rowsAdded: rows.length, message: "Invoice exported successfully" };
      }),

    // Fetch Gmail messages with invoice keywords
    fetchGmailInvoices: publicProcedure
      .input(
        z.object({
          accessToken: z.string(),
          maxResults: z.number().default(20),
          pageToken: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { accessToken, maxResults, pageToken } = input;

        // Search for invoice-related emails
        const query = encodeURIComponent(
          "subject:(factura OR invoice OR recibo OR receipt OR albarán) has:attachment OR subject:(factura OR invoice OR recibo)"
        );
        let listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${maxResults}`;
        if (pageToken) listUrl += `&pageToken=${pageToken}`;

        const listRes = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!listRes.ok) {
          const errText = await listRes.text();
          throw new Error(`Gmail API error: ${errText}`);
        }

        const listData = await listRes.json() as { messages?: { id: string }[]; nextPageToken?: string };
        const messages = listData.messages ?? [];

        // Fetch details for each message (limit to 10 at a time)
        const details = await Promise.all(
          messages.slice(0, 10).map(async (msg) => {
            const detailRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (!detailRes.ok) return null;
            const detail = await detailRes.json() as {
              id: string;
              payload?: {
                headers?: { name: string; value: string }[];
                parts?: { mimeType: string; body?: { data?: string } }[];
                body?: { data?: string };
              };
              snippet?: string;
              internalDate?: string;
            };

            const headers = detail.payload?.headers ?? [];
            const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
            const from = headers.find((h) => h.name === "From")?.value ?? "";
            const dateHeader = headers.find((h) => h.name === "Date")?.value ?? "";

            // Extract body text
            let bodyText = "";
            const parts = detail.payload?.parts ?? [];
            for (const part of parts) {
              if (part.mimeType === "text/plain" && part.body?.data) {
                bodyText = Buffer.from(part.body.data, "base64").toString("utf-8");
                break;
              }
            }
            if (!bodyText && detail.payload?.body?.data) {
              bodyText = Buffer.from(detail.payload.body.data, "base64").toString("utf-8");
            }
            if (!bodyText) bodyText = detail.snippet ?? "";

            return {
              id: msg.id,
              subject,
              from,
              date: dateHeader,
              internalDate: detail.internalDate,
              bodyText: bodyText.slice(0, 3000), // Limit for LLM
              snippet: detail.snippet ?? "",
            };
          })
        );

        return {
          messages: details.filter(Boolean),
          nextPageToken: listData.nextPageToken,
        };
      }),
  }),
  
  // Complete fix endpoint - fixes everything at once
  executeCompleteSheetsFix: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        accessToken: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const { executeCompleteSheetsFix } = await import("./sheets-complete-fixer-v2");
        const result = await executeCompleteSheetsFix(input.spreadsheetId, input.accessToken);
        return result;
      } catch (error) {
        console.error("[CompleteFix] Error:", error);
        throw new Error(`Failed to execute complete fix: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }),

  // Apply fixes endpoint
  applyMonthlySheetFixes: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        accessToken: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const { generateAutoFixReport } = await import("./sheets-auto-fix");
        const { fixAllMonthlySheets } = await import("./sheets-apply-fixes");
        
        // First analyze
        const analysis = await generateAutoFixReport(input.spreadsheetId, input.accessToken);
        
        // Then apply fixes
        const fixResults = await fixAllMonthlySheets(
          input.spreadsheetId,
          input.accessToken,
          analysis.template
        );
        
        return {
          analysis,
          fixResults,
          message: `Fixed ${fixResults.summary.successfulFixes}/${fixResults.summary.totalMonths} months`,
        };
      } catch (error) {
        console.error("[ApplyFix] Error:", error);
        throw new Error(`Failed to apply fixes: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }),

  // Auto-fix endpoint to analyze and fix monthly sheets
  analyzeAndFixMonthlySheets: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        accessToken: z.string(),
      })
    )
    .query(async ({ input }) => {
      try {
        const { generateAutoFixReport } = await import("./sheets-auto-fix");
        const report = await generateAutoFixReport(input.spreadsheetId, input.accessToken);
        return report;
      } catch (error) {
        console.error("[AutoFix] Error:", error);
        throw new Error(`Failed to analyze sheets: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }),

  // Diagnostic endpoint to analyze Google Sheets
  diagnoseSheetsIssues: publicProcedure
    .input(
      z.object({
        spreadsheetId: z.string(),
        accessToken: z.string(),
      })
    )
    .query(async ({ input }) => {
      try {
        const { diagnoseSheetsComprehensive } = await import("./sheets-diagnostic");
        const report = await diagnoseSheetsComprehensive(input.spreadsheetId, input.accessToken);
        return report;
      } catch (error) {
        console.error("[Diagnostic] Error:", error);
        throw new Error(`Failed to diagnose sheets: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }),
});

export type AppRouter = typeof appRouter;
