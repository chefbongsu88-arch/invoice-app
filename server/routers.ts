import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

const RECEIPT_PARSE_PROMPT = `You are an expert at extracting data from Spanish receipts and invoices.
Analyze the provided receipt image and extract the following fields.
Return ONLY a valid JSON object with these exact keys:
- invoiceNumber: string (factura/invoice number, or empty string if not found)
- vendor: string (business/company name)
- date: string (ISO format YYYY-MM-DD, today's date if not found)
- totalAmount: number (total amount including IVA, in EUR)
- ivaAmount: number (IVA/tax amount in EUR, 0 if not found)
- category: string (one of: "Office Supplies", "Travel & Transport", "Meals & Entertainment", "Utilities", "Professional Services", "Software & Subscriptions", "Equipment", "Marketing", "Other")

Important notes:
- In Spain, IVA is the VAT tax (usually 21%, 10%, or 4%)
- Look for "TOTAL", "IMPORTE TOTAL", or similar for total amount
- Look for "IVA", "I.V.A.", "CUOTA IVA" for tax amount
- Dates may be in DD/MM/YYYY format in Spain
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
          apiKey: z.string(),
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
            })
          ),
        })
      )
      .mutation(async ({ input }) => {
        const { spreadsheetId, sheetName, apiKey, rows } = input;
        
        if (!apiKey) {
          throw new Error("Google API Key is required. Please configure it in Settings.");
        }

        // First, ensure header row exists
        const headerValues = [
          ["Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Category", "Currency", "Notes", "Exported At"],
        ];

        // Check if sheet exists and has headers
        const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:K1?key=${apiKey}`;
        const checkRes = await fetch(checkUrl);

        if (checkRes.ok) {
          const checkData = await checkRes.json() as { values?: string[][] };
          if (!checkData.values || checkData.values.length === 0) {
            // Add headers
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:K1?valueInputOption=RAW&key=${apiKey}`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ values: headerValues }),
              }
            );
          }
        }

        // Append data rows
        const now = new Date().toISOString();
        const dataRows = rows.map((r) => [
          r.source,
          r.invoiceNumber,
          r.vendor,
          r.date,
          r.totalAmount,
          r.ivaAmount,
          r.baseAmount,
          r.category,
          r.currency,
          r.notes ?? "",
          now,
        ]);

        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&key=${apiKey}`;
        const appendRes = await fetch(appendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ values: dataRows }),
        });

        if (!appendRes.ok) {
          const errText = await appendRes.text();
          console.error("Sheets API error:", errText);
          throw new Error(`Failed to export to Google Sheets. Check your API key and spreadsheet ID.`);
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
