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
            category: "Other",
            subject: input.subject ?? "",
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
        const existingUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!B:B`;
        const existingRes = await fetch(existingUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        const existingData = await existingRes.json() as { values?: string[][] };
        const existingInvoiceNumbers = new Set(
          existingData.values?.slice(1).map((row) => row[0]) || []
        );
        
        // Filter out duplicates
        const newRows = rows.filter((r) => {
          if (existingInvoiceNumbers.has(r.invoiceNumber)) {
            console.warn(`[Export] Skipping duplicate invoice: ${r.invoiceNumber}`);
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
                let base64Data = imageUrl;
                if (imageUrl.startsWith("data:")) {
                  // Format: data:image/jpeg;base64,{base64data}
                  const match = imageUrl.match(/base64,(.+)$/);
                  base64Data = match ? match[1] : imageUrl;
                } else if (imageUrl.startsWith("file://")) {
                  // For local file paths, we'll skip upload (client should send base64)
                  console.warn("[Export] Skipping local file path upload:", imageUrl);
                  imageUrl = "";
                }
                
                if (base64Data && !imageUrl.startsWith("file://")) {
                  // Generate filename from invoice number or timestamp
                  // Sanitize invoice number: remove folder separators and special characters
                  const sanitizedInvoiceNum = (r.invoiceNumber || "receipt")
                    .split("/").pop()  // Extract only the last part (remove folder path)
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
            
            // Format date as YYYY-MM-DD
            const formattedDate = new Date(r.date).toISOString().split('T')[0];
            
            return [
              r.source,
              r.invoiceNumber,
              r.vendor,
              formattedDate,
              r.totalAmount,
              r.ivaAmount,
              r.baseAmount,
              r.category,
              r.currency,
              r.tip ?? 0,
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

        // If automateSheets is true, trigger the full automation
        if (input.automateSheets) {
          try {
            const { automateGoogleSheets } = await import("./sheets-automation-enhanced");
            
            // Fetch ALL data from 2026 Invoice tracker sheet for complete monthly/quarterly aggregation
            const trackerSheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent("2026 Invoice tracker")}!A2:L`;
            const trackerRes = await fetch(trackerSheetUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            
            let allInvoiceData: any[] = [];
            if (trackerRes.ok) {
              const trackerData = await trackerRes.json() as { values?: any[][] };
              if (trackerData.values) {
                allInvoiceData = trackerData.values.map((row: any[]) => ({
                  source: row[0] || "",          // A: Source
                  invoiceNumber: row[1] || "",   // B: Invoice #
                  vendor: row[2] || "",          // C: Vendor
                  date: row[3] || "",            // D: Date
                  totalAmount: parseFloat(row[4]) || 0,   // E: Total (€)
                  ivaAmount: parseFloat(row[5]) || 0,     // F: IVA (€)
                  baseAmount: parseFloat(row[6]) || 0,    // G: Base (€)
                  category: row[7] || "",        // H: Category
                  currency: row[8] || "EUR",     // I: Currency
                  tip: parseFloat(row[9]) || 0,  // J: Tip (€)
                  notes: row[10] || "",          // K: Notes
                  imageUrl: row[11] || "",       // L: Image URL
                }));
              }
            }
            
            // Use all data for automation (includes current + previous invoices)
            await automateGoogleSheets({
              spreadsheetId,
              accessToken,
              invoiceData: allInvoiceData.length > 0 ? allInvoiceData : rows.map((r) => ({
                source: r.source,
                invoiceNumber: r.invoiceNumber,
                vendor: r.vendor,
                date: r.date,
                totalAmount: r.totalAmount,
                ivaAmount: r.ivaAmount,
                baseAmount: r.baseAmount,
                category: r.category,
                currency: r.currency,
                notes: r.notes,
                imageUrl: r.imageUrl,
                tip: r.tip,
              })),
            }, ["La portenia", "es cuco"]);
            console.log("Automation completed successfully");
          } catch (error) {
            console.error("Error starting automation:", error);
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
});

export type AppRouter = typeof appRouter;
