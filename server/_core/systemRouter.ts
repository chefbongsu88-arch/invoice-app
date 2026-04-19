import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";
import { getSheets429RetryCount } from "../sheets-automation";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      }),
    )
    .query(() => ({
      ok: true,
    })),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      }),
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),

  opsCheck: publicProcedure.mutation(async () => {
    const refreshTokenSet = Boolean(process.env.GOOGLE_REFRESH_TOKEN?.trim());
    const driveFolderSet = Boolean(process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_ID?.trim());
    const sheets429Retries = getSheets429RetryCount();
    const warnings: string[] = [];
    if (!refreshTokenSet) {
      warnings.push("GOOGLE_REFRESH_TOKEN is missing on the server.");
    }
    if (!driveFolderSet) {
      warnings.push("GOOGLE_DRIVE_RECEIPTS_FOLDER_ID is not set (Drive upload fallback only).");
    }
    if (sheets429Retries > 0) {
      warnings.push(`Sheets 429 retries observed in this server runtime: ${sheets429Retries}.`);
    }
    return {
      ok: warnings.length === 0,
      refreshTokenSet,
      driveFolderSet,
      sheets429Retries,
      warnings,
      checkedAt: new Date().toISOString(),
    };
  }),
});
