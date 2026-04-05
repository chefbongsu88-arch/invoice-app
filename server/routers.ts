import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { DEFAULT_MAIN_TRACKER_SHEET_NAME } from "../shared/sheets-defaults.js";
import { isMeatCategory } from "../shared/invoice-types.js";
import { getSessionCookieOptions } from "./_core/cookies";
import {
  ENV,
  getPublicServerBaseUrl,
  resolvePublicBaseForReceiptImages,
} from "./_core/env";
import { invokeLLM } from "./_core/llm";
import {
  heicBufferToJpeg,
  isLikelyHeicOrHeifBuffer,
} from "./_core/heic-to-jpeg";
import {
  encodeReceiptImageForForgeStep,
  FORGE_OCR_LADDER,
} from "./_core/receipt-image-forge";
import { parseReceiptWithClaude } from "./_core/receipt-claude";
import { parseReceiptWithGoogleGemini } from "./_core/receipt-gemini-google";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { uploadImageToStorage } from "./image-upload-storage";
import {
  applyThinTextFormatToGridRange,
  encodeValuesRange,
  getSheetIdByTitle,
  parseAppendUpdatedRangeToGridRange,
} from "./sheets-automation";
import {
  detectMimeFromBuffer,
  putReceiptShareImage,
} from "./receipt-share-store";

function looksLikeJpegMagic(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

function looksLikePngMagic(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

// Helper function to parse DD/MM/YYYY date format correctly
function parseInvoiceDateDDMMYYYY(dateStr: string): Date {
  if (!dateStr) return new Date();
  const s = String(dateStr).trim().replace(/^'/, "");
  
  // Try DD/MM/YYYY format first
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const day = parseInt(m1[1], 10);
    const month = parseInt(m1[2], 10) - 1; // 0-indexed
    const year = parseInt(m1[3], 10);
    return new Date(year, month, day);
  }
  
  // Try YYYY-MM-DD format
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) {
    const year = parseInt(m2[1], 10);
    const month = parseInt(m2[2], 10) - 1;
    const day = parseInt(m2[3], 10);
    return new Date(year, month, day);
  }
  
  // Fallback to native parsing
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

/** YYYY-MM-DD for duplicate matching (sheet stores DD/MM/YYYY with optional leading '). */
function normalizeDateKeyForDuplicate(dateStr: string): string {
  const s = String(dateStr ?? "").replace(/^'+|'+$/g, "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = parseInvoiceDateDDMMYYYY(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  return s;
}

function normalizeAmountKeyForDuplicate(val: unknown): string {
  if (typeof val === "number" && Number.isFinite(val)) return val.toFixed(2);
  const n = parseFloat(String(val ?? "").replace(/[€\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function duplicateRowKey(vendor: string, dateRaw: string, amountRaw: unknown): string {
  const v = String(vendor ?? "").trim().toLowerCase();
  const d = normalizeDateKeyForDuplicate(dateRaw);
  const a = normalizeAmountKeyForDuplicate(amountRaw);
  return `${v}|${d}|${a}`;
}

/** Strip `data:image/...;base64,` prefix if present (some clients send full data URLs). */
function normalizeReceiptImageBase64(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.*)$/s);
  if (m?.[1]) return m[1].replace(/\s/g, "");
  return trimmed.replace(/\s/g, "");
}

/**
 * Decode base64 and read magic bytes. Do NOT slice the base64 string before decoding — that breaks decoding.
 */
function detectMimeFromImageBase64(b64: string): string {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return "image/jpeg";
  }
  if (buf.length < 12) return "image/jpeg";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}

function extractLlmMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type: string }).type === "text" &&
          "text" in part
        ) {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Accept 69.50, 69,50, Spanish 1.234,56, "€ 12.30", etc. */
function parseMoneyNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    let s = value.replace(/€/g, "").replace(/\s/g, "").trim();
    if (!s) return 0;
    // Spanish/EU: thousands with dot, decimals with comma (e.g. 1.234,56 or 114,32)
    if (/^\d{1,3}(?:\.\d{3})*,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isValidGregorianDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function padDatePart(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Normalize model output to YYYY-MM-DD. Spanish/EU receipts use DD/MM/YYYY on paper — never use
 * "today" or the photo's file date; only the printed date. Accepts ISO, DD/MM/YYYY, and variants.
 */
function normalizeReceiptDateToIso(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const s0 = String(raw).trim();
  if (!s0) return "";

  let m = s0.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (isValidGregorianDate(y, mo, d)) return `${m[1]}-${m[2]}-${m[3]}`;
    return "";
  }

  m = s0.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    let day: number;
    let month: number;
    if (b > 12) {
      month = a;
      day = b;
    } else if (a > 12) {
      day = a;
      month = b;
    } else {
      // Both ≤12: ambiguous (e.g. 03/04) — assume DD/MM (Spain / EU facturas), not US MM/DD.
      day = a;
      month = b;
    }
    if (isValidGregorianDate(y, month, day)) return `${y}-${padDatePart(month)}-${padDatePart(day)}`;
    return "";
  }

  m = s0.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const yy = +m[3];
    const y = yy >= 69 ? 1900 + yy : 2000 + yy;
    let day: number;
    let month: number;
    if (b > 12) {
      month = a;
      day = b;
    } else if (a > 12) {
      day = a;
      month = b;
    } else {
      day = a;
      month = b;
    }
    if (isValidGregorianDate(y, month, day)) return `${y}-${padDatePart(month)}-${padDatePart(day)}`;
    return "";
  }

  return "";
}

/** LLMs often return Spanish/alternate keys; map into our schema before reading fields. */
function normalizeReceiptParsedFields(raw: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...raw };
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

  const firstNonEmpty = (...vals: unknown[]) => {
    for (const v of vals) {
      const t = str(v);
      if (t !== "") return v;
    }
    return undefined;
  };

  if (!str(merged.date)) {
    const v = firstNonEmpty(
      merged.fecha,
      merged.fechaFactura,
      merged.fecha_factura,
      merged.fechaEmision,
      merged.fecha_emision,
      merged.fechaExpedicion,
      merged.dateDocument,
    );
    if (v !== undefined) merged.date = v;
  }

  if (!str(merged.vendor)) {
    const v = firstNonEmpty(
      merged.emisor,
      merged.businessName,
      merged.merchantName,
      merged.nombreComercio,
      merged.nombre,
      merged.tienda,
      merged.storeName,
      merged.retailer,
    );
    if (v !== undefined) merged.vendor = v;
  }

  if (!str(merged.invoiceNumber)) {
    const v = firstNonEmpty(
      merged.numeroFactura,
      merged.numero_factura,
      merged.facturaNumber,
      merged.nFactura,
      merged.invoice_number,
      merged.number,
      merged.factura,
    );
    if (v !== undefined) merged.invoiceNumber = v;
  }

  const totalMissing =
    merged.totalAmount === undefined ||
    merged.totalAmount === null ||
    merged.totalAmount === "" ||
    (typeof merged.totalAmount === "number" && merged.totalAmount === 0);
  if (totalMissing) {
    const v = firstNonEmpty(
      merged.total,
      merged.importeTotal,
      merged.importe_total,
      merged.grandTotal,
      merged.amount,
      merged.importe,
      merged.totalEUR,
      merged.total_eur,
    );
    if (v !== undefined) merged.totalAmount = v;
  }

  const ivaMissing =
    merged.ivaAmount === undefined ||
    merged.ivaAmount === null ||
    merged.ivaAmount === "" ||
    (typeof merged.ivaAmount === "number" && merged.ivaAmount === 0);
  if (ivaMissing) {
    const v = firstNonEmpty(merged.iva, merged.cuotaIva, merged.cuota_iva, merged.tax, merged.vat);
    if (v !== undefined) merged.ivaAmount = v;
  }

  return merged;
}

// Get Google OAuth access token using Refresh Token
async function getGoogleAccessToken(): Promise<string> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google OAuth credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN."
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("OAuth token error:", err);
    let message =
      "Failed to authenticate with Google Sheets. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN on the server (e.g. Railway).";
    try {
      const j = JSON.parse(err) as { error?: string; error_description?: string };
      if (j.error === "invalid_grant") {
        message =
          "Google Sheets login expired (invalid_grant). Create a new refresh token and set GOOGLE_REFRESH_TOKEN in Railway — e.g. revoke app access in Google Account settings, then run your OAuth setup again.";
      } else if (j.error === "invalid_client") {
        message =
          "Google OAuth client is invalid (invalid_client). Verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET match the Google Cloud OAuth client.";
      }
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}


const RECEIPT_PARSE_SYSTEM = `You read printed receipt and ticket photos from Spain, Europe, and elsewhere. Text may be Spanish or English. Copy every readable business name, date, and money amount into JSON. Photos may be blurry, angled, or on pink/thermal paper — still try hard.

You MUST output exactly one JSON object. Use ONLY these English key names (do not use Spanish keys like importe or emisor — read Spanish text from the image but put values under the keys below):
invoiceNumber, vendor, date, totalAmount, ivaAmount, tipAmount, category, items

CRITICAL — amounts (European style):
- Spain often uses comma as decimal separator: 114,32 means 114.32 in JSON (use JSON number 114.32). Same for 69,50 → 69.5.
- Large amounts may look like 1.234,56 (dot = thousands, comma = decimals) → use JSON number 1234.56.
- totalAmount = final amount to pay: look for TOTAL, IMPORTE TOTAL, TOTAL A PAGAR, SUMA, IMPORTE, Factura totals, or the bottom-line payment. NEVER use 0 for totalAmount if any plausible final total appears on the ticket.
- ivaAmount = VAT: IVA, CUOTA IVA, BASE IMPONIBLE, % IVA lines; use 0 only if no tax amount is visible.

Vendor:
- Copy the shop / issuer name from the header (Factura, NIF block, or letterhead). Partial names are OK. Use "" only if truly unreadable.

Date (critical — read ONLY what is printed on the paper):
- Do NOT use today's date, do NOT use the phone/camera/gallery file date, do NOT guess a year. Copy the date from the receipt text only.
- Spanish facturas almost always use DAY/MONTH/YEAR order (DD/MM/YYYY). Example printed 03/04/2026 = 3 April 2026 → date "2026-04-03". Another: 15/01/2025 = 15 January 2025 → "2025-01-15".
- If the printed date uses slashes or dashes (03-04-2026), apply the same DD/MM/YYYY rule before outputting ISO YYYY-MM-DD.
- If no legible date is on the receipt, use "" (empty string). Never invent a date.

category — one exact string:
"Meat","Seafood","Vegetables","Restaurant","Gas Station","Water","Beverages","Asian Market","Caviar","Truffle","Organic Farm","Hardware Store","Other"
Use "Meat" for butchers, carnicería, deli, embutidos, charcutería, names containing CARNS or similar.
Use "Restaurant" for bars, cafés, menús.

items: [{partName, quantity, unit:"kg", pricePerUnit, total}] ONLY when category is "Meat" AND the ticket shows weighted line items (carnicería / butcher style); for supermarkets with vegetables, fish, or mixed groceries use []. Otherwise [].

Numbers in JSON must be JSON numbers for totalAmount, ivaAmount, tipAmount (not strings). Output ONLY the JSON object, no markdown.`;

const RECEIPT_PARSE_USER = `Read only text visible on this receipt image (totals, tax, vendor header, factura number, printed date). Ignore any idea of "today". Return the JSON object now.`;

/** Forge-encode to JPEG, then Gemini; on failure try raw JPEG/PNG or HEIC→JPEG. */
async function runGoogleGeminiReceiptOcr(
  normalized: string,
  mimeType: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  try {
    const jpeg = await encodeReceiptImageForForgeStep(normalized, mimeType, 0);
    return await parseReceiptWithGoogleGemini(
      jpeg.base64,
      jpeg.mimeType,
      systemPrompt,
      userPrompt,
    );
  } catch (forgeErr) {
    console.warn(
      "[OCR] Forge encode for Gemini failed; trying direct JPEG/PNG or HEIC→JPEG:",
      forgeErr instanceof Error ? forgeErr.message : forgeErr,
    );
    const rawBuf = Buffer.from(normalized, "base64");
    let geminiB64 = normalized;
    let geminiMime: "image/jpeg" | "image/png" = "image/jpeg";
    if (looksLikeJpegMagic(rawBuf)) {
      geminiMime = "image/jpeg";
    } else if (looksLikePngMagic(rawBuf)) {
      geminiMime = "image/png";
    } else if (isLikelyHeicOrHeifBuffer(rawBuf)) {
      geminiB64 = (await heicBufferToJpeg(rawBuf, 0.75)).toString("base64");
      geminiMime = "image/jpeg";
    } else {
      try {
        geminiB64 = (await heicBufferToJpeg(rawBuf, 0.75)).toString("base64");
        geminiMime = "image/jpeg";
      } catch {
        throw forgeErr instanceof Error ? forgeErr : new Error(String(forgeErr));
      }
    }
    return await parseReceiptWithGoogleGemini(
      geminiB64,
      geminiMime,
      systemPrompt,
      userPrompt,
    );
  }
}

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
      .input(
        z.object({
          imageBase64: z.string().min(1, "Image data is empty"),
        }),
      )
      .mutation(async ({ input }) => {
        const normalized = normalizeReceiptImageBase64(input.imageBase64);
        if (normalized.length < 64) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Image data is too small. Please take a clearer photo and try again.",
          });
        }

        const mimeType = detectMimeFromImageBase64(normalized);

        try {
          const useClaude = Boolean(ENV.anthropicApiKey?.trim());
          const useGeminiGoogle = Boolean(ENV.googleGeminiApiKey?.trim());
          const useForge = Boolean(ENV.forgeApiKey?.trim());
          if (!useClaude && !useGeminiGoogle && !useForge) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message:
                "Receipt AI is not configured. Set one of: ANTHROPIC_API_KEY (recommended), GOOGLE_GEMINI_API_KEY from Google AI Studio, or BUILT_IN_FORGE_API_KEY on Railway.",
            });
          }

          console.log(
            `[OCR] Providers: anthropic=${useClaude} gemini_direct=${useGeminiGoogle} forge=${useForge}`,
          );

          let text: string;
          if (useGeminiGoogle && useClaude) {
            try {
              text = await runGoogleGeminiReceiptOcr(
                normalized,
                mimeType,
                RECEIPT_PARSE_SYSTEM,
                RECEIPT_PARSE_USER,
              );
              console.log("[OCR] Primary: Google Gemini (both API keys set — avoids Claude 'Could not process image' on picky photos)");
            } catch (geminiErr) {
              console.warn(
                "[OCR] Gemini failed; trying Anthropic Claude:",
                geminiErr instanceof Error ? geminiErr.message : geminiErr,
              );
              text = await parseReceiptWithClaude(
                normalized,
                mimeType,
                RECEIPT_PARSE_SYSTEM,
                RECEIPT_PARSE_USER,
              );
            }
          } else if (useGeminiGoogle) {
            text = await runGoogleGeminiReceiptOcr(
              normalized,
              mimeType,
              RECEIPT_PARSE_SYSTEM,
              RECEIPT_PARSE_USER,
            );
            console.log("[OCR] Using Google Gemini API only (no Anthropic key)");
          } else if (useClaude) {
            text = await parseReceiptWithClaude(
              normalized,
              mimeType,
              RECEIPT_PARSE_SYSTEM,
              RECEIPT_PARSE_USER,
            );
          } else {
            // Forge often rejects huge inline base64 in JSON. Prefer a short HTTPS URL after temp upload.
            let response: Awaited<ReturnType<typeof invokeLLM>> | undefined;
            let lastForgeErr: unknown;
            for (let step = 0; step < FORGE_OCR_LADDER.length; step++) {
              const forgeImage = await encodeReceiptImageForForgeStep(normalized, mimeType, step);
              console.log(
                `[OCR] Forge step ${step}/${FORGE_OCR_LADDER.length - 1}: JPEG ${forgeImage.jpegBytes} bytes (edge ≤ ${FORGE_OCR_LADDER[forgeImage.stepUsed].maxEdge}px)`,
              );

              let visionUrl: string;
              try {
                const fileName = `receipt-ocr-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 8)}.jpg`;
                const hosted = await uploadImageToStorage(forgeImage.base64, fileName);
                if (hosted && /^https:\/\//i.test(hosted)) {
                  visionUrl = hosted;
                  console.log(`[OCR] Using hosted image URL for Forge (small request body)`);
                } else {
                  throw new Error("Storage returned no HTTPS URL");
                }
              } catch (uploadErr) {
                console.warn(`[OCR] Temp upload for OCR failed (step ${step}), using inline data URL:`, uploadErr);
                visionUrl = `data:${forgeImage.mimeType};base64,${forgeImage.base64}`;
              }

              try {
                response = await invokeLLM({
                  messages: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "text",
                          text: `${RECEIPT_PARSE_SYSTEM}\n\n${RECEIPT_PARSE_USER}`,
                        },
                        {
                          type: "image_url",
                          image_url: {
                            url: visionUrl,
                            detail: "low",
                          },
                        },
                      ],
                    },
                  ],
                  responseFormat: { type: "json_object" },
                });
                break;
              } catch (forgeErr) {
                lastForgeErr = forgeErr;
                const msg = forgeErr instanceof Error ? forgeErr.message : String(forgeErr);
                const retryable = /400|Could not process image|Bad Request/i.test(msg);
                if (retryable && step < FORGE_OCR_LADDER.length - 1) {
                  console.warn(`[OCR] Forge rejected at step ${step}; next ladder step...`);
                  continue;
                }
                throw forgeErr;
              }
            }

            if (!response) {
              throw lastForgeErr instanceof Error
                ? lastForgeErr
                : new Error("Forge OCR failed after all resize steps");
            }

            const rawContent = response.choices?.[0]?.message?.content;
            text = extractLlmMessageText(rawContent);
          }
          console.log(
            "[OCR] Raw LLM response:",
            text.length > 0 ? text.slice(0, 240) : "(empty)",
          );

          if (!text || text.trim().length === 0) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "The recognition service returned no text. Please try again with a sharper image.",
            });
          }

          const cleaned = text
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
          const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;
          const rawParsed = JSON.parse(jsonStr) as Record<string, unknown>;
          const parsed = normalizeReceiptParsedFields(rawParsed);

          const dateOut = normalizeReceiptDateToIso(parsed.date);

          return {
            invoiceNumber: String(parsed.invoiceNumber ?? "").trim(),
            vendor: String(parsed.vendor ?? "").trim(),
            date: dateOut,
            totalAmount: parseMoneyNumber(parsed.totalAmount),
            ivaAmount: parseMoneyNumber(parsed.ivaAmount),
            tipAmount: parseMoneyNumber(parsed.tipAmount),
            category: String(parsed.category ?? "Other").trim() || "Other",
            items: Array.isArray(parsed.items) ? parsed.items : [],
          };
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          console.error("[OCR] Parse error:", err);
          const msg = err instanceof Error ? err.message : String(err);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Receipt recognition failed: ${msg}`,
            cause: err,
          });
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
          sheetName: z.string().default(DEFAULT_MAIN_TRACKER_SHEET_NAME),
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
          skipDuplicateCheck: z.boolean().optional().default(false),
          /** App sends EXPO_PUBLIC_API_BASE_URL so /api/receipt-share URLs work when Railway has no PUBLIC_SERVER_URL */
          publicApiBaseUrl: z.string().max(512).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { spreadsheetId, sheetName, rows, skipDuplicateCheck, publicApiBaseUrl } = input;
        const receiptPublicBase = resolvePublicBaseForReceiptImages(publicApiBaseUrl);
        // If Deploy logs never show this line, the server is still running an old bundle (Forge export).
        console.log("[Export] image_pipeline=receipt-share-v2");
        console.log(
          `[Export] Sheets row image: publicBase=${receiptPublicBase ? receiptPublicBase.slice(0, 48) : "MISSING"}`,
        );

        // Get access token using OAuth Refresh Token
        const accessToken = await getGoogleAccessToken();

        // First, ensure header row exists
        // ✅ Column order (English labels for Sheets): Source, Invoice#, Vendor, Date, Total, VAT, Base, Tip, ...
        const headerValues = [
          ["Source", "Invoice #", "Vendor", "Date", "Total (€)", "VAT (€)", "Base (€)", "Tip (€)", "Category", "Currency", "Notes", "Receipt", "Exported At"],
        ];

        // Check if sheet exists and has headers
        const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A1:M1")}`;
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
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A1:M1")}?valueInputOption=RAW`,
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

        // Check for duplicates before appending (skip if skipDuplicateCheck is true)
        let newRows = rows;
        if (!skipDuplicateCheck) {
        const existingUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A:L")}`;
        const existingRes = await fetch(existingUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        
        const existingData = await existingRes.json() as { values?: string[][] };
        // Create a set of existing invoices using multiple checks for accuracy
        // Check 1: Invoice Number (if available)
        // Check 2: Vendor + Date + Amount (fallback for missing invoice numbers)
        const existingInvoicesByNumber = new Set(
          existingData.values?.slice(1).map((row) => {
            // row[1] = Invoice #
            const invoiceNum = row[1]?.trim() || "";
            return invoiceNum;
          }).filter(num => num.length > 0) || []
        );
        
        const existingInvoicesByVendorDateAmount = new Set(
          existingData.values?.slice(1).map((row) => {
            const vendor = row[2] || "";
            const date = row[3] || "";
            const amount = row[4] ?? "";
            return duplicateRowKey(vendor, String(date), amount);
          }) || [],
        );

        newRows = rows.filter((r) => {
          if (r.invoiceNumber && r.invoiceNumber.trim().length > 0) {
            if (existingInvoicesByNumber.has(r.invoiceNumber.trim())) {
              console.warn(`[Export] Skipping duplicate invoice (by Invoice #): ${r.invoiceNumber}`);
              return false;
            }
          }

          const key = duplicateRowKey(r.vendor, r.date, r.totalAmount);
          if (existingInvoicesByVendorDateAmount.has(key)) {
            console.warn(
              `[Export] Skipping duplicate (Vendor+Date+Amount): ${r.vendor} | ${r.date} | €${r.totalAmount.toFixed(2)}`,
            );
            return false;
          }
          return true;
        });
        
        if (newRows.length === 0) {
          return { success: true, rowsAdded: 0, message: "All invoices are duplicates. No new data added." };
        }
        } // end of !skipDuplicateCheck block

        // Append data rows with image upload
        const now = new Date().toISOString();
        let receiptImageMissing = false;
        const dataRows = await Promise.all(
          newRows.map(async (r) => {
            let imageUrl = r.imageUrl ?? "";
            const userProvidedImage = Boolean(r.imageUrl?.trim());
            if (
              userProvidedImage &&
              !imageUrl.startsWith("data:") &&
              !imageUrl.startsWith("file://") &&
              !/^https?:\/\//i.test(imageUrl)
            ) {
              console.warn(
                `[Export] Skipping image for ${r.vendor}: expected data:image/…;base64 from the app (got non-URL prefix).`,
              );
            }

            // data:/file: → in-memory /api/receipt-share only (Sheets =IMAGE); Forge is not used here
            if (imageUrl && (imageUrl.startsWith("data:") || imageUrl.startsWith("file://"))) {
              try {
                let base64Data = "";
                let mimeFromDataUrl = "image/jpeg";
                if (imageUrl.startsWith("data:")) {
                  const mimeMatch = imageUrl.match(/^data:([^;]+);base64,/i);
                  if (mimeMatch?.[1]) mimeFromDataUrl = mimeMatch[1];
                  const match = imageUrl.match(/base64,(.+)$/);
                  if (match?.[1]) {
                    base64Data = match[1].trim();
                  } else {
                    console.warn("[Export] Failed to extract base64 from data URL");
                    imageUrl = "";
                  }
                } else if (imageUrl.startsWith("file://")) {
                  console.warn("[Export] Skipping local file path upload:", imageUrl);
                  imageUrl = "";
                }

                if (base64Data && !imageUrl.startsWith("file://")) {
                  const tryReceiptShare = (): void => {
                    const buf = Buffer.from(base64Data, "base64");
                    const mime = detectMimeFromBuffer(buf) || mimeFromDataUrl;
                    const token = putReceiptShareImage(buf, mime);
                    const base = receiptPublicBase;
                    if (token && base) {
                      imageUrl = `${base}/api/receipt-share/${token}`;
                      console.log(
                        `[Export] Receipt image for Sheets (/api/receipt-share): ${r.vendor}`,
                      );
                    } else if (!base) {
                      console.warn(
                        "[Export] No public API base URL — pass publicApiBaseUrl from the app (getApiBaseUrl) or set PUBLIC_SERVER_URL / RECEIPT_IMAGE_PUBLIC_BASE_URL on the server.",
                      );
                    } else if (!token) {
                      console.warn(
                        `[Export] /api/receipt-share skipped (max 8 MiB per image): ${r.vendor}`,
                      );
                    }
                  };

                  tryReceiptShare();
                  if (!String(imageUrl ?? "").trim()) {
                    console.warn(
                      `[Export] No receipt image URL for ${r.vendor} (check /api/receipt-share token or 8 MiB limit).`,
                    );
                  }
                }
              } catch (error) {
                console.error(`[Export] Failed to upload image for ${r.vendor}:`, error);
                imageUrl = "";
              }
            }
            
            // Format date as DD/MM/YYYY (with leading apostrophe to prevent Google Sheets auto-formatting)
            const rawDate = String(r.date ?? "").trim();
            let formattedDate = "";
            if (rawDate) {
              const parsedDate = parseInvoiceDateDDMMYYYY(rawDate);
              const dd = String(parsedDate.getDate()).padStart(2, "0");
              const mm = String(parsedDate.getMonth() + 1).padStart(2, "0");
              const yyyy = parsedDate.getFullYear();
              formattedDate = `'${dd}/${mm}/${yyyy}`;
            }

            // L: in-cell preview via =IMAGE (Google fetches the URL; Forge or our /api/receipt-share)
            let imageColumnValue: string = imageUrl;
            if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
              const safe = imageUrl.replace(/"/g, '""');
              imageColumnValue = `=IMAGE("${safe}", 1)`;
            }

            if (userProvidedImage && !String(imageUrl ?? "").trim()) {
              receiptImageMissing = true;
            }

            return [
              r.source?.toLowerCase() === "camera" ? "Camera" : "Email", // A - Source
              r.invoiceNumber,       // B - Invoice #
              r.vendor,              // C - Vendor
              formattedDate,         // D - Date (DD/MM/YYYY)
              r.totalAmount,                                                           // E - Total (€)
              r.ivaAmount ?? 0,                                                        // F - VAT (€)
              r.baseAmount != null ? r.baseAmount : r.totalAmount - (r.ivaAmount ?? 0), // G - Base (€) fallback for old invoices
              r.tip ?? 0,            // H - Tip (€)
              r.category,            // I - Category
              r.currency,            // J - Currency
              r.notes ?? "",         // K - Notes
              imageColumnValue,      // L - Receipt image (IMAGE formula) or URL / empty
              now,                   // M - Exported At
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

        const appendJson = (await appendRes.json()) as {
          updates?: { updatedRange?: string };
        };
        const updatedRange = appendJson.updates?.updatedRange;
        if (updatedRange) {
          const sheetIdForFormat = await getSheetIdByTitle(
            spreadsheetId,
            sheetName,
            accessToken,
          );
          const grid = parseAppendUpdatedRangeToGridRange(updatedRange);
          if (sheetIdForFormat != null && grid) {
            await applyThinTextFormatToGridRange(
              spreadsheetId,
              accessToken,
              sheetIdForFormat,
              grid,
            );
          }
        }

        // Automatically trigger sheet automation on every upload
        // Always run automation to keep monthly/quarterly sheets in sync
        if (true) {
          try {
            const { automateGoogleSheets, updateMeatMonthlySheet } = await import("./sheets-automation-vendor-aggregated");
            
            // Fetch ALL data from 2026 Invoice tracker sheet for complete monthly/quarterly aggregation
            // FORMULA so L column returns =IMAGE("https://...") for automation (display values are often empty)
            const trackerSheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A2:M")}?valueRenderOption=FORMULA`;
            const trackerRes = await fetch(trackerSheetUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            
            let allInvoiceData: any[] = [];
            if (trackerRes.ok) {
              const trackerData = await trackerRes.json() as { values?: any[][] };
              if (trackerData.values) {
                allInvoiceData = trackerData.values.map((row: any[]) => {
                  // Parse currency strings (e.g., "€133.18" -> 133.18)
                  const parseCurrency = (val: any) => {
                    if (!val) return 0;
                    const numStr = String(val).replace(/[€,\s]/g, '').trim();
                    const num = parseFloat(numStr);
                    return isNaN(num) ? 0 : num;
                  };

                  // Strip apostrophes and convert DD/MM/YYYY → YYYY-MM-DD
                  const parseDate = (val: any): string => {
                    if (!val) return "";
                    const s = String(val).replace(/^'+|'+$/g, "").trim();
                    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
                    return s;
                  };

                  return {
                    source: row[0]?.toLowerCase() === "camera" ? "Camera" : "Email",
                    invoiceNumber: row[1] || "",
                    vendor: row[2] || "",
                    date: parseDate(row[3]),
                    totalAmount: parseCurrency(row[4]),
                    ivaAmount: parseCurrency(row[5]),
                    baseAmount: parseCurrency(row[6]),
                    tip: parseCurrency(row[7]),
                    category: row[8] || "",
                    currency: row[9] || "EUR",
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
            }, ["La Portenia", "Es Cuco"]);

            // Meat_Monthly: 줄항목 + 카테고리 Meat만 (벤더 필터는 updateMeatMonthlySheet 내부)
            const meatRows = newRows.filter(
              (r) => Boolean(r.items?.length) && isMeatCategory(r.category),
            );
            if (meatRows.length > 0) {
              await updateMeatMonthlySheet(accessToken, spreadsheetId, meatRows);
            }

            console.log("✅ Automation completed successfully");
          } catch (error) {
            console.error("❌ Automation failed:", error);
            // Continue anyway - local storage is still updated
            // Don't throw raw error object as it may contain non-serializable types
            console.warn("⚠️  Automation failed but invoice was saved to main sheet. Monthly/quarterly sheets may not be updated.");
          }
        }

        return {
          success: true,
          rowsAdded: newRows.length,
          message: "Invoice exported successfully",
          /** True if the client sent image data but storage upload failed so the sheet row has no image URL */
          receiptImageMissing,
        };
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
    // Delete a single invoice row from the main tracker sheet
    deleteInvoiceFromSheets: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
          invoiceNumber: z.string().optional(),
          vendor: z.string(),
          date: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { spreadsheetId, invoiceNumber, vendor } = input;
        const accessToken = await getGoogleAccessToken();
        const TRACKER = "2026 Invoice tracker";

        // Read all rows to find the matching row
        const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(TRACKER + "!A:M")}`;
        const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!readRes.ok) throw new Error(`Read failed: ${await readRes.text()}`);
        const readData = await readRes.json() as { values?: string[][] };
        const rows = readData.values ?? [];

        // Find matching row index (1-indexed, row 1 = header)
        let foundRowIndex = -1;
        for (let i = 1; i < rows.length; i++) {
          const rowInvNum = rows[i][1]?.trim() ?? "";
          const rowVendor  = rows[i][2]?.trim() ?? "";
          if (invoiceNumber?.trim() && rowInvNum && rowInvNum === invoiceNumber.trim()) {
            foundRowIndex = i + 1; break;
          }
          if (!invoiceNumber?.trim() && rowVendor.toLowerCase() === vendor.toLowerCase()) {
            foundRowIndex = i + 1; break;
          }
        }
        if (foundRowIndex === -1) return { success: false, message: "Row not found" };

        // Get numeric sheetId
        const infoUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`;
        const infoRes = await fetch(infoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        const info = await infoRes.json() as { sheets?: Array<{ properties: { title: string; sheetId: number } }> };
        const sheetId = info.sheets?.find(s => s.properties.title === TRACKER)?.properties.sheetId;
        if (sheetId === undefined) throw new Error("Sheet not found");

        // Delete the row via batchUpdate
        const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
        const batchRes = await fetch(batchUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{
              deleteDimension: {
                range: { sheetId, dimension: "ROWS", startIndex: foundRowIndex - 1, endIndex: foundRowIndex },
              },
            }],
          }),
        });
        if (!batchRes.ok) throw new Error(`Delete failed: ${await batchRes.text()}`);
        return { success: true };
      }),

    // Update a single invoice row in the main tracker sheet
    updateInvoiceInSheets: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
          originalInvoiceNumber: z.string().optional(),
          originalVendor: z.string(),
          source: z.string(),
          invoiceNumber: z.string(),
          vendor: z.string(),
          date: z.string(),
          totalAmount: z.number(),
          ivaAmount: z.number(),
          baseAmount: z.number(),
          tip: z.number().optional(),
          category: z.string(),
          currency: z.string().default("EUR"),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { spreadsheetId, originalInvoiceNumber, originalVendor, ...data } = input;
        const accessToken = await getGoogleAccessToken();
        const TRACKER = "2026 Invoice tracker";

        // Read all rows to find the matching row
        const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(TRACKER + "!A:M")}`;
        const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!readRes.ok) throw new Error(`Read failed: ${await readRes.text()}`);
        const readData = await readRes.json() as { values?: string[][] };
        const rows = readData.values ?? [];

        let foundRowIndex = -1;
        let existingImageUrl = "";
        for (let i = 1; i < rows.length; i++) {
          const rowInvNum = rows[i][1]?.trim() ?? "";
          const rowVendor  = rows[i][2]?.trim() ?? "";
          if (originalInvoiceNumber?.trim() && rowInvNum && rowInvNum === originalInvoiceNumber.trim()) {
            foundRowIndex = i + 1; existingImageUrl = rows[i][11] ?? ""; break;
          }
          if (!originalInvoiceNumber?.trim() && rowVendor.toLowerCase() === originalVendor.toLowerCase()) {
            foundRowIndex = i + 1; existingImageUrl = rows[i][11] ?? ""; break;
          }
        }
        if (foundRowIndex === -1) return { success: false, message: "Row not found" };

        // Format date as DD/MM/YYYY with leading apostrophe
        const formatDate = (d: string) => {
          const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
          return m ? `'${m[3]}/${m[2]}/${m[1]}` : d;
        };

        const updatedRow = [
          data.source?.toLowerCase() === "camera" ? "Camera" : "Email",
          data.invoiceNumber,
          data.vendor,
          formatDate(data.date),
          data.totalAmount,
          data.ivaAmount,
          data.baseAmount,
          data.tip ?? 0,
          data.category,
          data.currency,
          data.notes ?? "",
          existingImageUrl,
          new Date().toISOString(),
        ];

        const range = `${TRACKER}!A${foundRowIndex}:M${foundRowIndex}`;
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
        const updateRes = await fetch(updateUrl, {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [updatedRow] }),
        });
        if (!updateRes.ok) throw new Error(`Update failed: ${await updateRes.text()}`);
        return { success: true };
      }),

    // Reset all data endpoint - clears all invoices from Google Sheets for testing
    resetAllData: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
        })
      )
      .mutation(async ({ input }) => {
        try {
        const { spreadsheetId } = input;
        const accessToken = await getGoogleAccessToken();
        const { google } = await import("googleapis");
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: accessToken });
        const sheets = google.sheets({ version: "v4", auth });

        // Get all sheet names
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetNames = spreadsheet.data.sheets?.map((s) => s.properties?.title).filter(Boolean) as string[];

        if (!sheetNames || sheetNames.length === 0) {
          throw new Error("No sheets found in spreadsheet");
        }

        // Clear data from main sheet (keep headers)
        const mainSheetName = "2026 Invoice tracker";
        if (sheetNames.includes(mainSheetName)) {
          await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: `'${mainSheetName}'!A2:M`,
            auth,
          });
          console.log(`Cleared main sheet: ${mainSheetName}`);
        }

        // Clear data from all monthly sheets (keep headers, but clear TOTAL row amounts)
        const monthlySheets = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        for (const month of monthlySheets) {
          if (sheetNames.includes(month)) {
            // Clear TOTAL row amounts (E2:L2)
            await sheets.spreadsheets.values.clear({
              spreadsheetId,
              range: `'${month}'!E2:L2`,
              auth,
            });
            // Clear data rows (A3:L)
            await sheets.spreadsheets.values.clear({
              spreadsheetId,
              range: `'${month}'!A3:L`,
              auth,
            });
            console.log(`Cleared monthly sheet: ${month}`);
          }
        }

        // Clear data from quarterly sheets (keep headers, but clear TOTAL row amounts)
        const quarterlySheets = ["Q1", "Q2", "Q3", "Q4"];
        for (const quarter of quarterlySheets) {
          if (sheetNames.includes(quarter)) {
            // Clear TOTAL row amounts (E2:L2)
            await sheets.spreadsheets.values.clear({
              spreadsheetId,
              range: `'${quarter}'!E2:L2`,
              auth,
            });
            // Clear data rows (A3:L)
            await sheets.spreadsheets.values.clear({
              spreadsheetId,
              range: `'${quarter}'!A3:L`,
              auth,
            });
            console.log(`Cleared quarterly sheet: ${quarter}`);
          }
        }

        // Clear data from meat tracking sheets
        const meatSheets = ["Meat_Monthly", "Meat_Quarterly", "Meat_Analysis", "Meat_Detail"];
        for (const meatSheet of meatSheets) {
          if (sheetNames.includes(meatSheet)) {
            await sheets.spreadsheets.values.clear({
              spreadsheetId,
              range: `'${meatSheet}'!A2:L`,
              auth,
            });
            console.log(`Cleared meat sheet: ${meatSheet}`);
          }
        }

        return {
          success: true,
          message: "All invoice data has been cleared successfully. Ready for fresh testing.",
          clearedSheets: [...[mainSheetName], ...monthlySheets, ...quarterlySheets, ...meatSheets].filter((s) => sheetNames.includes(s)),
        };
      } catch (error) {
        console.error("[Reset] Error:", error);
        throw new Error(`Failed to reset data: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
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
