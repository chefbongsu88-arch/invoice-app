import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";

const COOKIE_NAME = "session";

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  sheets: router({
    exportInvoice: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
          accessToken: z.string(),
          invoiceData: z.object({
            source: z.string(),
            invoiceNumber: z.string(),
            vendor: z.string(),
            date: z.string(),
            totalAmount: z.number(),
            ivaAmount: z.number(),
            baseAmount: z.number(),
            category: z.string(),
            currency: z.string(),
            tip: z.number().optional(),
            notes: z.string().optional(),
            imageUrl: z.string().optional(),
          }),
        })
      )
      .mutation(async ({ input }) => {
        try {
          const { spreadsheetId, accessToken, invoiceData } = input;

          // Prepare the row data
          const rowData = [
            invoiceData.source,
            invoiceData.invoiceNumber,
            invoiceData.vendor,
            invoiceData.date,
            invoiceData.totalAmount,
            invoiceData.ivaAmount,
            invoiceData.baseAmount,
            invoiceData.category,
            invoiceData.currency,
            invoiceData.tip || "",
            invoiceData.notes || "",
            invoiceData.imageUrl || "",
            new Date().toISOString(),
          ];

          // Google Sheets API endpoint
          const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'2026 Invoice tracker'!A:M:append?valueInputOption=RAW`;

          const response = await fetch(sheetsUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              values: [rowData],
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            console.error("Google Sheets API error:", error);
            throw new Error("Failed to export to Google Sheets");
          }

          return {
            success: true,
            message: "Invoice exported successfully",
          };
        } catch (error) {
          console.error("Export error:", error);
          throw new Error("Failed to export invoice to Google Sheets");
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
