import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import {
  DEFAULT_MAIN_TRACKER_SHEET_NAME,
  receiptSheetsReceiptUrlCell,
} from "../shared/sheets-defaults.js";
import {
  MAIN_TRACKER_HEADER_ROW,
  resolveMainTrackerMoneyColumnIndices,
} from "../shared/sheets-tracker-columns.js";
import { getSessionCookieOptions } from "./_core/cookies";
import {
  ENV,
  getPublicServerBaseUrl,
  isForgeStorageConfigured,
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
import {
  parseInvoicePdfWithGoogleGemini,
  parseReceiptWithGoogleGemini,
} from "./_core/receipt-gemini-google";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { uploadImageToStorage, uploadReceiptBinaryToForgeIfConfigured } from "./image-upload-storage";
import {
  applyThinTextFormatToGridRange,
  encodeValuesRange,
  getSheetIdByTitle,
  parseAppendUpdatedRangeToGridRange,
  TRACKER_COLUMN_COUNT,
} from "./sheets-automation";
import {
  parseMainTrackerDateCellToIso,
  parseTrackerMeatItemsJsonCell,
} from "./sheets-automation-vendor-aggregated";
import { isInvoiceNumberBlockedFromSheetsExport } from "../shared/blocked-invoice-export";
import {
  hasMeatLineItems,
  isMeatCategory,
  isMeatLotOrigenTraceabilityLine,
  shouldIncludeInvoiceInMeatLineSheets,
  shouldTriggerMeatTrackerAutomationMerge,
} from "../shared/invoice-types";
import { reconcileMeatLineItemsForInvoice } from "../shared/meat-line-reconcile";
import { canonicalVendorDisplayName } from "../shared/vendor-canonical";
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

function normalizeVendorKeyForDuplicate(vendor: string): string {
  const raw = String(vendor ?? "").trim().toLowerCase();
  const compact = raw.replace(/[\s'".,;:()_-]+/g, "");
  // Keep aliases in one bucket so camera/email variants collapse to the same business.
  if (compact.includes("porteni") || compact.includes("rapolteni") || compact.includes("lapolteni")) {
    return "la_portenia";
  }
  if (compact.includes("cuco") || compact.includes("coco") || compact.includes("escoco")) {
    return "es_cuco";
  }
  return compact;
}

function normalizeInvoiceNumberKey(invoiceNumber: string): string {
  return String(invoiceNumber ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/.:]+/g, "");
}

function duplicateRowKey(vendor: string, dateRaw: string, amountRaw: unknown): string {
  const v = normalizeVendorKeyForDuplicate(vendor);
  const d = normalizeDateKeyForDuplicate(dateRaw);
  const a = normalizeAmountKeyForDuplicate(amountRaw);
  return `${v}|${d}|${a}`;
}

type GmailFetchResult = {
  messages: {
    id: string;
    threadId?: string;
    subject: string;
    from: string;
    date: string;
    internalDate?: string;
    bodyText: string;
    snippet: string;
  }[];
  nextPageToken?: string;
};

type DuplicateReason =
  | "invoice_number"
  | "vendor_date_amount"
  | "batch_invoice_number"
  | "batch_vendor_date_amount";

function describeDuplicateReason(reason: DuplicateReason): string {
  switch (reason) {
    case "invoice_number":
      return "Same invoice number already exists in Google Sheets";
    case "vendor_date_amount":
      return "Same vendor, date, and amount already exist in Google Sheets";
    case "batch_invoice_number":
      return "Same invoice number appears more than once in this upload";
    case "batch_vendor_date_amount":
      return "Same vendor, date, and amount appear more than once in this upload";
  }
}

async function applyDuplicateHighlightToGridRows(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  rowRanges: Array<{
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  }>,
): Promise<void> {
  if (rowRanges.length === 0) return;
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: rowRanges.map((range) => ({
          repeatCell: {
            range: { sheetId, ...range },
            cell: {
              userEnteredFormat: {
                backgroundColor: {
                  red: 1,
                  green: 0.95,
                  blue: 0.8,
                },
                textFormat: {
                  foregroundColor: {
                    red: 0.64,
                    green: 0.18,
                    blue: 0.12,
                  },
                },
              },
            },
            fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor",
          },
        })),
      }),
    },
  );
  if (!batchRes.ok) {
    console.warn("[Sheets] duplicate highlight failed:", await batchRes.text());
  }
}

async function applyZeroAmountHighlightToGridRows(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  rowRanges: Array<{
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  }>,
): Promise<void> {
  if (rowRanges.length === 0) return;
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: rowRanges.map((range) => ({
          repeatCell: {
            range: { sheetId, ...range },
            cell: {
              userEnteredFormat: {
                backgroundColor: {
                  red: 1,
                  green: 0.86,
                  blue: 0.86,
                },
                textFormat: {
                  foregroundColor: {
                    red: 0.72,
                    green: 0.08,
                    blue: 0.08,
                  },
                  bold: true,
                },
              },
            },
            fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold",
          },
        })),
      }),
    },
  );
  if (!batchRes.ok) {
    console.warn("[Sheets] zero-amount highlight failed:", await batchRes.text());
  }
}

async function applyDateDisplayFormatToGridRange(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  range: {
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  },
): Promise<void> {
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: { sheetId, ...range },
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "DATE",
                    pattern: "dd/mm/yyyy",
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          },
        ],
      }),
    },
  );
  if (!batchRes.ok) {
    console.warn("[Sheets] date display format failed:", await batchRes.text());
  }
}

function buildAutomationItemMergeKey(
  invoiceNumber: unknown,
  vendor: unknown,
  dateRaw: unknown,
): string {
  const inv = String(invoiceNumber ?? "").trim();
  const ven = String(vendor ?? "").trim();
  const iso = parseMainTrackerDateCellToIso(dateRaw ?? "");
  const d = iso || String(dateRaw ?? "").trim();
  return `${inv}|||${ven}|||${d}`;
}

function serializeMeatLineItemsForSheetsCell(
  category: string,
  vendor: string,
  items:
    | Array<{
        partName: string;
        quantity: number;
        unit: string;
        pricePerUnit: number;
        total: number;
        ivaPercent?: number;
      }>
    | undefined,
): string {
  if (!shouldIncludeInvoiceInMeatLineSheets({ items, category, vendor })) return "";
  if (!Array.isArray(items) || items.length === 0) return "";
  try {
    return JSON.stringify(
      items.map((it) => {
        const row: Record<string, unknown> = {
          partName: String(it.partName ?? "").trim(),
          quantity: Number(it.quantity),
          unit: String(it.unit ?? "kg"),
          pricePerUnit: Number(it.pricePerUnit),
          total: Number(it.total),
        };
        const p = it.ivaPercent;
        if (p !== undefined && Number.isFinite(p) && p > 0) row.ivaPercent = Number(p);
        return row;
      }),
    );
  } catch {
    return "";
  }
}

type AutomationInvoiceRow = {
  source: string;
  invoiceNumber: string;
  vendor: string;
  date: string;
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  tip: number;
  category: string;
  currency: string;
  notes: string;
  imageUrl: string;
  items?: Array<{
    partName: string;
    quantity: number;
    unit: string;
    pricePerUnit: number;
    total: number;
  }>;
};

/**
 * Reads the main tracker (A2:N), applies export blocklist, merges meat line items from column N
 * and optional `recentRowsWithItems` (same keys as export automation).
 */
async function buildAutomationInvoiceDataFromMainTracker(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
  recentRowsWithItems: Array<{
    invoiceNumber: string;
    vendor: string;
    date: string;
    items?: Array<{
      partName: string;
      quantity: number;
      unit: string;
      pricePerUnit: number;
      total: number;
    }>;
  }> = [],
): Promise<AutomationInvoiceRow[]> {
  const trackerSheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A1:N")}?valueRenderOption=FORMULA`;
  const trackerRes = await fetch(trackerSheetUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let allInvoiceData: AutomationInvoiceRow[] = [];
  let trackerRowsForAutomation: Array<{ invoice: AutomationInvoiceRow; raw: any[] }> = [];

  if (trackerRes.ok) {
    const trackerData = (await trackerRes.json()) as { values?: any[][] };
    const trackerRawRows = trackerData.values;
    if (trackerRawRows?.length) {
      const first = trackerRawRows[0] ?? [];
      const looksLikeHeader =
        String(first[0] ?? "").trim().toLowerCase() === "source" ||
        String(first[2] ?? "").trim().toLowerCase() === "vendor";
      const headerRow = looksLikeHeader ? first : [];
      const money = resolveMainTrackerMoneyColumnIndices(headerRow);
      const dataRowsOnly = looksLikeHeader ? trackerRawRows.slice(1) : trackerRawRows;
      const mapped = dataRowsOnly.map((row: any[]) => {
        const parseCurrency = (val: any) => {
          if (!val) return 0;
          const numStr = String(val).replace(/[€,\s]/g, "").trim();
          const num = parseFloat(numStr);
          return isNaN(num) ? 0 : num;
        };

        const parseDate = (val: any): string => parseMainTrackerDateCellToIso(val);

        const invoice: AutomationInvoiceRow = {
          source: row[0]?.toLowerCase() === "camera" ? "Camera" : "Email",
          invoiceNumber: row[1] || "",
          vendor: row[2] || "",
          date: parseDate(row[3]),
          totalAmount: parseCurrency(row[money.total]),
          ivaAmount: parseCurrency(row[money.iva]),
          baseAmount: parseCurrency(row[money.base]),
          tip: parseCurrency(row[money.tip]),
          category: row[8] || "",
          currency: row[9] || "EUR",
          notes: row[10] || "",
          imageUrl: row[11] || "",
        };
        return { invoice, raw: row };
      });
      const beforeBlock = mapped.length;
      trackerRowsForAutomation = mapped.filter(
        ({ invoice }) => !isInvoiceNumberBlockedFromSheetsExport(String(invoice.invoiceNumber ?? "")),
      );
      allInvoiceData = trackerRowsForAutomation.map((x) => x.invoice);
      if (trackerRowsForAutomation.length < beforeBlock) {
        console.warn(
          `[Sheets] Automation: omitted ${beforeBlock - trackerRowsForAutomation.length} row(s) with blocklisted invoice # (not pushed to monthly/meat rebuild).`,
        );
      }
    }
  }

  const itemLookup = new Map(
    recentRowsWithItems.map((row) => [
      buildAutomationItemMergeKey(row.invoiceNumber, row.vendor, row.date),
      Array.isArray(row.items) ? row.items : undefined,
    ]),
  );

  console.log(`📊 Automation: Processing ${allInvoiceData.length} invoices from main sheet`);
  if (allInvoiceData.length === 0) {
    console.warn("⚠️  No invoice data found in main sheet");
  }

  if (trackerRowsForAutomation.length > 0) {
    return trackerRowsForAutomation.map(({ invoice, raw }) => {
      const fromSheet = parseTrackerMeatItemsJsonCell(raw[13]);
      const fromRecent = itemLookup.get(
        buildAutomationItemMergeKey(invoice.invoiceNumber, invoice.vendor, invoice.date),
      );
      const items =
        fromSheet && fromSheet.length > 0
          ? fromSheet
          : fromRecent && fromRecent.length > 0
            ? fromRecent
            : undefined;
      return items && items.length > 0 ? { ...invoice, items } : invoice;
    });
  }
  return allInvoiceData.map((invoice) => {
    const fromRecent = itemLookup.get(
      buildAutomationItemMergeKey(invoice.invoiceNumber, invoice.vendor, invoice.date),
    );
    return fromRecent && fromRecent.length > 0 ? { ...invoice, items: fromRecent } : invoice;
  });
}

async function runTrackerSheetsAutomation(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
  recentRowsWithItems: Array<{
    invoiceNumber: string;
    vendor: string;
    date: string;
    items?: Array<{
      partName: string;
      quantity: number;
      unit: string;
      pricePerUnit: number;
      total: number;
    }>;
  }> = [],
): Promise<void> {
  const { automateGoogleSheets } = await import("./sheets-automation-vendor-aggregated");

  const invoiceData = await buildAutomationInvoiceDataFromMainTracker(
    spreadsheetId,
    sheetName,
    accessToken,
    recentRowsWithItems,
  );

  await automateGoogleSheets({
    spreadsheetId,
    accessToken,
    invoiceData,
  });

  console.log("✅ Automation completed successfully");
}

const GMAIL_FETCH_CACHE_MS = 12_000;
const gmailFetchCache = new Map<string, { expiresAt: number; result: GmailFetchResult }>();
const gmailFetchInflight = new Map<string, Promise<GmailFetchResult>>();

function pruneExpiredGmailFetchCache(nowMs: number) {
  for (const [k, v] of gmailFetchCache) {
    if (v.expiresAt <= nowMs) gmailFetchCache.delete(k);
  }
}

function decodeGmailBase64UrlToUtf8(raw: string): string {
  const normalized = String(raw ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function decodeGmailBase64UrlToBuffer(raw: string): Buffer | null {
  const normalized = String(raw ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function extractEmbeddedPdfFromMimeMessage(rawBuf: Buffer | null | undefined): Buffer | null {
  if (!rawBuf?.length) return null;
  const text = rawBuf.toString("utf-8");
  if (!/content-type:\s*application\/pdf/i.test(text)) return null;
  const m = text.match(
    /content-type:\s*application\/pdf[\s\S]*?content-transfer-encoding:\s*base64[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/i,
  );
  const payload = String(m?.[1] ?? "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (payload.length < 256) return null;
  try {
    const out = Buffer.from(payload, "base64");
    if (!out.length) return null;
    const mime = detectMimeFromBuffer(out);
    return mime === "application/pdf" || mime === "application/x-pdf" ? out : null;
  } catch {
    return null;
  }
}

/** Align with receipt-share / typical Mercadona PDFs (~10–15MB). */
const GMAIL_RECEIPT_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

type GmailExportAttCandidate = { attachmentId: string; mime: string; priority: number };

type GmailInlinePart = { buffer: Buffer; mime: string; priority: number };

function mimePriorityForGmailExport(mimeRaw: string): number {
  if (mimeRaw === "application/pdf" || mimeRaw === "application/x-pdf") return 1;
  if (mimeRaw.startsWith("image/")) {
    if (mimeRaw.includes("png")) return 5;
    if (mimeRaw.includes("jpeg") || mimeRaw.includes("jpg")) return 6;
    if (mimeRaw.includes("webp")) return 7;
    if (mimeRaw.includes("gif")) return 8;
    return 9;
  }
  if (mimeRaw === "application/octet-stream") return 15;
  return 100;
}

function resolveGmailAttachmentMime(
  mimeRaw: string,
  filename: string,
  buf?: Buffer | null,
): string {
  const name = String(filename ?? "").toLowerCase().trim();
  const mime = String(mimeRaw ?? "").toLowerCase().trim();

  /** Wrong Content-Type on PDF parts is common (Mercadona, etc.) — trust magic + extension first. */
  if (buf?.length >= 4) {
    const b = buf;
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  }
  if (name.endsWith(".pdf")) return "application/pdf";
  if (/\.(png)$/i.test(name)) return "image/png";
  if (/\.(jpe?g)$/i.test(name)) return "image/jpeg";
  if (/\.(webp)$/i.test(name)) return "image/webp";
  if (/\.(gif)$/i.test(name)) return "image/gif";

  if (mime && mime !== "application/octet-stream") return mime;
  if (buf?.length) return detectMimeFromBuffer(buf);
  return mime || "application/octet-stream";
}

/**
 * First PDF attachment (typical invoice), else first image — for Sheets receipt column.
 * Handles both Gmail `attachmentId` parts and small inline parts with `body.data` only.
 */
async function fetchFirstGmailAttachmentForReceiptExport(
  userAccessToken: string,
  messageId: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const tok = userAccessToken.trim();
  const mid = messageId.trim();
  if (!tok || !mid) return null;

  const msgRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}?format=full`,
    { headers: { Authorization: `Bearer ${tok}` } },
  );
  if (!msgRes.ok) {
    console.warn("[Export] Gmail message fetch for attachment failed:", msgRes.status);
    return null;
  }
  const detail = (await msgRes.json()) as { payload?: any };
  const idCandidates: GmailExportAttCandidate[] = [];
  const inlineParts: GmailInlinePart[] = [];
  const seen = new Set<string>();

  const walk = (part: any) => {
    for (const child of part?.parts ?? []) {
      walk(child);
    }
    const mimeRaw = String(part?.mimeType ?? "").toLowerCase();
    const filename = String(part?.filename ?? "").trim();
    const id = String(part?.body?.attachmentId ?? "").trim();
    const rawData = part?.body?.data;

    if (id) {
      if (seen.has(id)) return;
      const mimeResolved = resolveGmailAttachmentMime(mimeRaw, filename);
      const priority = mimePriorityForGmailExport(mimeResolved);
      if (priority >= 100) return;
      seen.add(id);
      idCandidates.push({ attachmentId: id, mime: mimeResolved, priority });
      return;
    }

    if (!rawData || typeof rawData !== "string") return;
    const buf = decodeGmailBase64UrlToBuffer(rawData);
    if (!buf?.length || buf.length < 32 || buf.length > GMAIL_RECEIPT_EXPORT_MAX_BYTES) return;
    const embeddedPdf = mimeRaw.includes("message/rfc822") ? extractEmbeddedPdfFromMimeMessage(buf) : null;
    if (embeddedPdf?.length) {
      inlineParts.push({ buffer: embeddedPdf, mime: "application/pdf", priority: 1 });
      return;
    }

    let mimeOut = resolveGmailAttachmentMime(mimeRaw, filename, buf);
    let priority = mimePriorityForGmailExport(mimeOut);
    if (priority >= 100) return;
    if (
      mimeOut === "application/pdf" ||
      mimeOut === "application/x-pdf" ||
      mimeOut.startsWith("image/")
    ) {
      inlineParts.push({ buffer: buf, mime: mimeOut, priority });
    }
  };

  if (detail.payload) {
    walk(detail.payload);
  }
  idCandidates.sort((a, b) => a.priority - b.priority);

  for (const c of idCandidates) {
    const attRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}/attachments/${encodeURIComponent(c.attachmentId)}`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!attRes.ok) continue;
    const att = (await attRes.json()) as { data?: string };
    const buf = decodeGmailBase64UrlToBuffer(att.data ?? "");
    if (!buf?.length || buf.length < 32 || buf.length > GMAIL_RECEIPT_EXPORT_MAX_BYTES) continue;
    const embeddedPdf = extractEmbeddedPdfFromMimeMessage(buf);
    if (embeddedPdf?.length) {
      return { buffer: embeddedPdf, mime: "application/pdf" };
    }

    let mimeOut = resolveGmailAttachmentMime(c.mime, "", buf);
    if (
      mimeOut === "application/pdf" ||
      mimeOut === "application/x-pdf" ||
      mimeOut.startsWith("image/")
    ) {
      return { buffer: buf, mime: mimeOut };
    }
  }

  inlineParts.sort(
    (a, b) => a.priority - b.priority || b.buffer.length - a.buffer.length,
  );
  const best = inlineParts[0];
  if (best) {
    console.log(
      `[Export] Using inline Gmail part (no attachmentId): ${best.mime}, ${best.buffer.length} bytes`,
    );
    return { buffer: best.buffer, mime: best.mime };
  }

  // Last fallback: parse the full raw MIME message and extract embedded PDF payload.
  try {
    const rawRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}?format=raw`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (rawRes.ok) {
      const rawJson = (await rawRes.json()) as { raw?: string };
      const rawBuf = decodeGmailBase64UrlToBuffer(rawJson.raw ?? "");
      const embeddedPdf = extractEmbeddedPdfFromMimeMessage(rawBuf);
      if (embeddedPdf?.length) {
        console.log(`[Export] Using embedded PDF from Gmail raw message: ${embeddedPdf.length} bytes`);
        return { buffer: embeddedPdf, mime: "application/pdf" };
      }
    }
  } catch (rawErr) {
    console.warn("[Export] Gmail raw MIME fallback failed:", rawErr);
  }
  return null;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
    let s = value
      .replace(/€/g, "")
      .replace(/[·∙]/g, ".")
      .replace(/\s/g, "")
      .trim();
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

function normalizeExtractedInvoiceText(raw: string): string {
  return String(raw ?? "")
    .replace(/\u0000/g, " ")
    .replace(/[·∙]/g, ".")
    .replace(/(\d)\s+([.,])\s*(\d{1,2}\b)/g, "$1$2$3")
    .replace(/(\d{1,3}(?:[.,]\d{3})*)\s+([.,]\d{2}\b)/g, "$1$2")
    .replace(/([€$])\s+(\d)/g, "$1$2")
    .replace(/(\d)\s+(€|eur\b)/gi, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isUsefulExtractedPdfText(raw: string): boolean {
  const text = normalizeExtractedInvoiceText(raw);
  if (text.length >= 72) return true;

  const moneyMatches =
    text.match(/[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]{1,6}[.,][0-9]{1,2}/g) ?? [];
  const hasInvoiceLabel =
    /\b(total|importe|factura|invoice|iva|vat|base(?:\s+imponible)?|cuota\s+iva|amount\s+due|total\s+a\s+pagar)\b/i.test(
      text,
    );
  const hasCurrency = /€|\beur\b/i.test(text);

  return text.length >= 28 && moneyMatches.length >= 1 && (hasInvoiceLabel || hasCurrency);
}

function cleanParsedVendorName(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/^from:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(s)) return "";
  if (/\b(?:noreply|no-reply|do-not-reply|donotreply)\b/i.test(s)) return "";
  if (/^factura(?:[-\s_]?correo)?$/i.test(s)) return "";
  if (/^(?:invoice|receipt)(?:[-\s_]?mail|[-\s_]?email)?$/i.test(s)) return "";
  if (/^(?:factura|invoice)(?:[\s:_-].*)$/i.test(s)) return "";
  if (/^(?:n[ºo°]\s*factura|factura\s+simplificada|fecha\s+factura|fra\s+simp)\s*:/i.test(s)) return "";
  if (/^(?:factura|invoice)\s+[A-Z]-?V?\d/i.test(s)) return "";
  if (/\b(?:n[ºo°]\s*factura|fecha\s+factura|factura\s+simplificada)\b/i.test(s)) return "";
  /** Subject lines like "Factura Mercadona A-V2026-1409771" — keep vendor, drop invoice id. */
  if (/^[A-Za-zÀ-ÿ\s]+A[\-‑–—]V\d{4}[\-‑–—]\d+/i.test(s)) {
    const stripped = s.replace(/\s+A[\-‑–—]V\d{4}[\-‑–—]\d+.*$/i, "").trim();
    if (stripped) return stripped;
    return "";
  }
  if (/^unknown\b/i.test(s)) return "";
  if (
    /^(?:cliente|company|nombre|direcci[oó]n|poblaci[oó]n|empresa|factura|invoice|receipt|email subject|email content|attachment context)$/i.test(
      s,
    )
  ) {
    return "";
  }
  return s;
}

function pickBestParsedVendor(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const cleaned = cleanParsedVendorName(candidate);
    if (!cleaned) continue;
    if (!/[A-Za-zÀ-ÿ]/.test(cleaned)) continue;
    return cleaned;
  }
  return "";
}

function cleanParsedInvoiceNumber(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(s)) return "";
  if (
    /^(?:mercadona|can pizza madre,?\s*s\.?l\.?|zara home espa[ñn]a,?\s*s\.?a\.?|macao cafe santa gertrudis,?\s*s\.?l\.?)$/i.test(
      s,
    )
  ) {
    return "";
  }
  if (!/[0-9]/.test(s)) return "";
  if (/^(?:cliente|company|empresa|vendor|merchant|factura|invoice)$/i.test(s)) return "";
  /** Common buyer CIF on Es Cuco / B2B tickets — not a document id (OCR often misreads as invoice #). */
  if (s.replace(/[\s-]/g, "").toUpperCase() === "B56819451") return "";
  return s;
}

type ParsedEmailInvoiceCandidate = {
  invoiceNumber: string;
  vendor: string;
  date: string;
  totalAmount: number;
  ivaAmount: number;
  tipAmount: number;
  category: string;
  subject: string;
  items: unknown[];
};

function normalizeParsedMeatItems(raw: unknown): {
  partName: string;
  quantity: number;
  unit: "kg";
  pricePerUnit: number;
  total: number;
  ivaPercent?: number;
  totalIsNet?: boolean;
  lineTotalIsNet?: boolean;
  totalIncludesVat?: boolean;
}[] {
  if (!Array.isArray(raw)) return [];
  const out: {
    partName: string;
    quantity: number;
    unit: "kg";
    pricePerUnit: number;
    total: number;
    ivaPercent?: number;
    totalIsNet?: boolean;
    lineTotalIsNet?: boolean;
    totalIncludesVat?: boolean;
  }[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const partName = String(
      row.partName ??
        row.part ??
        row.cutName ??
        row.cut ??
        row.name ??
        row.product ??
        row.description ??
        row.descripcion ??
        "",
    ).trim();
    if (!partName) continue;
    if (isMeatLotOrigenTraceabilityLine(partName)) continue;

    const rawUnit = String(row.unit ?? row.uom ?? row.measure ?? "kg").trim().toLowerCase();
    let quantity = parseMoneyNumber(
      row.quantity ?? row.qty ?? row.kg ?? row.kilos ?? row.weight ?? row.peso ?? 0,
    );
    if (rawUnit === "g" || rawUnit === "gram" || rawUnit === "grams" || rawUnit === "gr") {
      quantity = quantity / 1000;
    }

    let pricePerUnit = parseMoneyNumber(
      row.pricePerUnit ?? row.price_per_unit ?? row.unitPrice ?? row.priceKg ?? row.price_kg ?? 0,
    );
    let total = parseMoneyNumber(row.total ?? row.amount ?? row.importe ?? row.lineTotal ?? 0);

    const ivaLine = parseMoneyNumber(row.ivaPercent ?? row.iva ?? row.lineIvaPercent ?? 0);

    if (quantity > 0 && total > 0 && pricePerUnit <= 0) {
      pricePerUnit = total / quantity;
    }
    if (quantity > 0 && pricePerUnit > 0 && total <= 0) {
      total = quantity * pricePerUnit;
    }
    if (quantity <= 0 || total <= 0) continue;

    const base: (typeof out)[number] = {
      partName,
      quantity: Math.round(quantity * 1000) / 1000,
      unit: "kg",
      pricePerUnit: Math.round(pricePerUnit * 100) / 100,
      total: Math.round(total * 100) / 100,
    };
    if (row.totalIsNet === true) base.totalIsNet = true;
    if (row.lineTotalIsNet === true) base.lineTotalIsNet = true;
    if (row.totalIncludesVat === false) base.totalIncludesVat = false;
    if (ivaLine > 0 && ivaLine <= 30) {
      out.push({ ...base, ivaPercent: Math.round(ivaLine * 100) / 100 });
    } else {
      out.push(base);
    }
  }

  return out;
}

function applyMeatLineReconcile(
  normalized: {
    partName: string;
    quantity: number;
    unit: "kg";
    pricePerUnit: number;
    total: number;
    ivaPercent?: number;
  }[],
  totalAmount: number,
  vendorRaw: string,
): {
  partName: string;
  quantity: number;
  unit: "kg";
  pricePerUnit: number;
  total: number;
  ivaPercent?: number;
}[] {
  const v =
    canonicalVendorDisplayName(String(vendorRaw ?? "").trim()) || String(vendorRaw ?? "").trim();
  return reconcileMeatLineItemsForInvoice(normalized as unknown[], {
    totalAmount,
    vendor: v,
  }).map((x) => ({
    partName: x.partName,
    quantity: x.quantity,
    unit: "kg",
    pricePerUnit: x.pricePerKgIncVat,
    total: x.total,
    ...(x.ivaPercentResolved != null ? { ivaPercent: x.ivaPercentResolved } : {}),
  }));
}

function scoreEmailInvoiceCandidate(candidate: Partial<ParsedEmailInvoiceCandidate> | null | undefined): number {
  if (!candidate) return -1;
  let score = 0;
  if ((candidate.totalAmount ?? 0) > 0) score += 4;
  if ((candidate.ivaAmount ?? 0) > 0) score += 1;
  if (cleanParsedVendorName(candidate.vendor)) score += 3;
  if (String(candidate.date ?? "").trim()) score += 1;
  if (String(candidate.invoiceNumber ?? "").trim()) score += 1;
  return score;
}

function chooseBetterEmailInvoiceCandidate(
  current: ParsedEmailInvoiceCandidate | null,
  next: ParsedEmailInvoiceCandidate | null,
): ParsedEmailInvoiceCandidate | null {
  if (!next) return current;
  if (!current) return next;
  const currentScore = scoreEmailInvoiceCandidate(current);
  const nextScore = scoreEmailInvoiceCandidate(next);
  if (nextScore > currentScore) return next;
  if (nextScore < currentScore) return current;
  if ((next.totalAmount ?? 0) > (current.totalAmount ?? 0)) return next;
  return current;
}

function mergeEmailInvoiceCandidates(
  primary: ParsedEmailInvoiceCandidate,
  secondary: ParsedEmailInvoiceCandidate | null,
): ParsedEmailInvoiceCandidate {
  if (!secondary) return primary;
  const primaryVendor = cleanParsedVendorName(primary.vendor);
  const secondaryVendor = cleanParsedVendorName(secondary.vendor);
  const primaryInvoiceNumber = cleanParsedInvoiceNumber(primary.invoiceNumber);
  const secondaryInvoiceNumber = cleanParsedInvoiceNumber(secondary.invoiceNumber);
  const chosenVendor = pickBestParsedVendor(primaryVendor, secondaryVendor);
  return {
    invoiceNumber: String(primaryInvoiceNumber || secondaryInvoiceNumber || "").trim(),
    vendor: chosenVendor,
    date: String(primary.date || secondary.date || "").trim(),
    totalAmount: primary.totalAmount > 0 ? primary.totalAmount : secondary.totalAmount,
    ivaAmount: primary.ivaAmount > 0 ? primary.ivaAmount : secondary.ivaAmount,
    tipAmount: primary.tipAmount > 0 ? primary.tipAmount : secondary.tipAmount,
    category:
      String(primary.category || "").trim() && primary.category !== "Other"
        ? primary.category
        : secondary.category,
    subject: String(primary.subject || secondary.subject || "").trim(),
    items: Array.isArray(primary.items) && primary.items.length > 0 ? primary.items : secondary.items,
  };
}

/** Gmail subjects e.g. "Factura Mercadona A-V2026-1409771". */
function mercadonaSubjectHintsCandidate(subject?: string): ParsedEmailInvoiceCandidate | null {
  const m = String(subject ?? "").match(
    /\bfactura\s+mercadona\s+(A[\-‑–—]V\d{4}[\-‑–—]\d{4,})\b/i,
  );
  if (!m?.[1]) return null;
  const invoiceNumber = cleanParsedInvoiceNumber(m[1]);
  if (!invoiceNumber) return null;
  return {
    invoiceNumber,
    vendor: "MERCADONA S.A.",
    date: "",
    totalAmount: 0,
    ivaAmount: 0,
    tipAmount: 0,
    category: "Other",
    subject: String(subject ?? "").trim(),
    items: [],
  };
}

function mergeMercadonaSubjectHints(
  candidate: ParsedEmailInvoiceCandidate,
  subject?: string,
): ParsedEmailInvoiceCandidate {
  const hints = mercadonaSubjectHintsCandidate(subject);
  if (!hints) return candidate;
  return mergeEmailInvoiceCandidates(candidate, hints);
}

function receiptLikeCandidateFromRawParsed(
  rawParsed: Record<string, unknown>,
  opts: { headerFrom: string; headerDate: string; subject?: string },
): ParsedEmailInvoiceCandidate {
  const parsed = normalizeReceiptParsedFields(rawParsed);
  const vendorOut = canonicalVendorDisplayName(pickBestParsedVendor(parsed.vendor, opts.headerFrom));
  const totalAmt = parseMoneyNumber(parsed.totalAmount);
  return {
    invoiceNumber: cleanParsedInvoiceNumber(parsed.invoiceNumber),
    vendor: vendorOut,
    date: resolveReceiptDateIso(parsed) || dateIsoFromEmailDateHeader(opts.headerDate),
    totalAmount: totalAmt,
    ivaAmount: parseMoneyNumber(parsed.ivaAmount),
    tipAmount: parseMoneyNumber(parsed.tipAmount),
    category: String(parsed.category ?? "Other").trim() || "Other",
    subject: opts.subject ?? "",
    items: applyMeatLineReconcile(normalizeParsedMeatItems(parsed.items), totalAmt, vendorOut),
  };
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

/** Gmail `Date:` header → YYYY-MM-DD (UTC calendar day). */
function dateIsoFromEmailDateHeader(headerDate: string): string {
  const s = String(headerDate ?? "").trim();
  if (!s) return "";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (y < 1990 || y > 2110) return "";
  return `${y}-${padDatePart(mo)}-${padDatePart(day)}`;
}

/**
 * Map alternate LLM keys (ES/EN) and header fallbacks — many models return `total` not `totalAmount`.
 */
function normalizeEmailInvoiceModelFields(
  raw: Record<string, unknown>,
  opts: { headerFrom: string; headerDate: string },
): {
  totalAmount: number;
  ivaAmount: number;
  tipAmount: number;
  vendor: string;
  dateIso: string;
  invoiceNumber: string;
  category: string;
  items: {
    partName: string;
    quantity: number;
    unit: "kg";
    pricePerUnit: number;
    total: number;
  }[];
} {
  const nested =
    raw.amounts && typeof raw.amounts === "object" && !Array.isArray(raw.amounts)
      ? (raw.amounts as Record<string, unknown>)
      : null;
  const flat = nested ? { ...raw, ...nested } : raw;

  const merged: Record<string, unknown> = {
    ...flat,
    fecha:
      flat.fecha ??
      flat.date ??
      flat.issueDate ??
      flat.fechaFactura ??
      flat.fecha_factura ??
      flat.fechaEmision,
    date: flat.date ?? flat.fecha ?? flat.issueDate ?? flat.fechaFactura,
  };

  const dateIso =
    resolveReceiptDateIso(merged) ||
    normalizeReceiptDateToIso(flat.date) ||
    normalizeReceiptDateToIso(flat.fecha) ||
    normalizeReceiptDateToIso(flat.issueDate) ||
    dateIsoFromEmailDateHeader(opts.headerDate) ||
    new Date().toISOString().split("T")[0];

  const totalKeys = [
    "totalAmount",
    "total",
    "importeTotal",
    "importe_total",
    "totalEUR",
    "total_eur",
    "amount",
    "grandTotal",
    "grand_total",
    "importe",
    "precioTotal",
    "totalConIva",
    "total_con_iva",
    "amountDue",
    "amount_due",
  ];
  let totalAmount = 0;
  for (const k of totalKeys) {
    if (flat[k] !== undefined && flat[k] !== null && String(flat[k]).trim() !== "") {
      const n = parseMoneyNumber(flat[k]);
      if (n > 0) {
        totalAmount = n;
        break;
      }
    }
  }

  const ivaKeys = [
    "ivaAmount",
    "iva",
    "vat",
    "tax",
    "cuotaIva",
    "cuota_iva",
    "iva_total",
    "importeIva",
    "importe_iva",
  ];
  let ivaAmount = 0;
  for (const k of ivaKeys) {
    if (flat[k] !== undefined && flat[k] !== null && String(flat[k]).trim() !== "") {
      ivaAmount = parseMoneyNumber(flat[k]);
      break;
    }
  }

  const tipKeys = ["tipAmount", "tip", "propina"];
  let tipAmount = 0;
  for (const k of tipKeys) {
    if (flat[k] !== undefined && flat[k] !== null && String(flat[k]).trim() !== "") {
      tipAmount = parseMoneyNumber(flat[k]);
      break;
    }
  }

  const vendor = pickBestParsedVendor(
    flat.vendor,
    flat.merchant,
    flat.company,
    flat.supplier,
    flat.store,
    opts.headerFrom,
  );

  const invoiceNumber = String(
    flat.invoiceNumber ??
      flat.invoice_number ??
      flat.numFactura ??
      flat.num_factura ??
      flat.number ??
      flat.numeroAlbaran ??
      flat.numero_albaran ??
      flat.numAlbaran ??
      flat.num_albaran ??
      flat.albaran ??
      flat.albaranNumber ??
      flat.albaran_number ??
      flat.deliveryNoteNumber ??
      flat.delivery_note_number ??
      "",
  ).trim();

  const category = String(flat.category ?? "Other").trim() || "Other";

  const vendorCanon = canonicalVendorDisplayName(vendor) || vendor;
  return {
    totalAmount,
    ivaAmount,
    tipAmount,
    vendor,
    dateIso,
    invoiceNumber,
    category,
    items: applyMeatLineReconcile(normalizeParsedMeatItems(flat.items), totalAmount, vendorCanon),
  };
}

/**
 * Prefer DD/MM/YYYY (or DD-MM-YYYY) from any merged field before trusting a bare ISO `date`.
 * Models often mis-read 11/03/2026 as US → "2026-11-03"; slash forms on the receipt are authoritative.
 */
function resolveReceiptDateIso(parsed: Record<string, unknown>): string {
  const candidates: unknown[] = [
    parsed.fecha,
    parsed.fechaFactura,
    parsed.fecha_factura,
    parsed.fechaEmision,
    parsed.fecha_emision,
    parsed.fechaExpedicion,
    parsed.dateDocument,
    parsed.date,
  ];
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (/^\d{1,2}[/.-]\d{1,2}[/.-](\d{4}|\d{2})$/.test(s)) {
      const iso = normalizeReceiptDateToIso(s);
      if (iso) return iso;
    }
  }
  return normalizeReceiptDateToIso(parsed.date);
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
      merged.numeroAlbaran,
      merged.numero_albaran,
      merged.numAlbaran,
      merged.num_albaran,
      merged.albaran,
      merged.albaranNumber,
      merged.albaran_number,
      merged.albarán,
      merged.deliveryNoteNumber,
      merged.delivery_note_number,
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

  const vend = str(merged.vendor);
  if (vend) merged.vendor = canonicalVendorDisplayName(vend);

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
      const detail =
        typeof j.error_description === "string" && j.error_description.trim()
          ? ` (${j.error_description.trim()})`
          : "";
      if (j.error === "invalid_grant") {
        message =
          "Google Sheets login expired (invalid_grant). Create a new refresh token and set GOOGLE_REFRESH_TOKEN in Railway — e.g. revoke app access in Google Account settings, then run your OAuth setup again." +
          detail;
      } else if (j.error === "invalid_client") {
        message =
          "Google OAuth client is invalid (invalid_client). Verify GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET match the Google Cloud OAuth client." +
          detail;
      } else if (detail) {
        message += detail;
      }
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

/** Google Sheets allows at most 50,000 characters per cell (leave margin for encoding). */
const GOOGLE_SHEETS_MAX_CELL_CHARS = 49_900;

function clampStringForSheetsCell(value: unknown, fieldLabel?: string): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s.length <= GOOGLE_SHEETS_MAX_CELL_CHARS) return s;
  const hint = fieldLabel ? ` [${fieldLabel}]` : "";
  console.warn(`[Export] Truncated sheet cell${hint}: ${s.length} chars`);
  return `${s.slice(0, GOOGLE_SHEETS_MAX_CELL_CHARS - 48)} ... (truncated for Google Sheets)`;
}

/** After Forge (or any step), still need a short https URL: empty, data:, file:, or non-http. */
function needsPublicReceiptHttpsUrl(url: string | undefined | null): boolean {
  const s = String(url ?? "").trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("file:")) return true;
  return !/^https?:\/\//i.test(s);
}

function googleSheetsErrorLooksLikeCellCharLimit(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /50000|50\s*,?\s*000|fifty\s*thousand/.test(m) ||
    /maximum\s+number\s+of\s+characters.*cell|cell.*50\s*,?\s*000|characters.*cell/.test(m) ||
    /[\uAC00-\uD7A3].*50000|50000.*[\uAC00-\uD7A3]/.test(msg) ||
    /최대\s*문자|문자수.*50000|50000.*문자|하나의\s*셀|단일\s*셀/.test(msg)
  );
}

/** Maps Sheets v4 JSON errors to English-only messages for the mobile app. */
function userFacingMessageFromSheetsApiBody(errText: string): string {
  try {
    const j = JSON.parse(errText) as {
      error?: {
        code?: number;
        message?: string;
        status?: string;
        details?: Array<{ reason?: string }>;
      };
    };
    const msg = String(j.error?.message ?? "");
    const status = String(j.error?.status ?? "");
    const code = Number(j.error?.code ?? 0);
    const reasons = (j.error?.details ?? []).map((d) => d.reason).filter(Boolean);
    if (
      status === "PERMISSION_DENIED" &&
      (reasons.includes("SERVICE_DISABLED") ||
        /has not been used|it is disabled|Enable it by visiting/i.test(msg))
    ) {
      return (
        "Google Sheets API is disabled for your Google Cloud project. In Google Cloud Console: APIs & Services → Library → search “Google Sheets API” → Enable (same project as your OAuth client ID). Wait 2–5 minutes, then export again."
      );
    }

    if (
      (status === "INVALID_ARGUMENT" || code === 400) &&
      googleSheetsErrorLooksLikeCellCharLimit(msg)
    ) {
      return (
        "Google Sheets: A cell cannot hold more than 50,000 characters. The receipt column must be a short HTTPS link, not raw image data. Export again so the server can upload the receipt, or set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY on the server for reliable hosting."
      );
    }

    // Google often returns localized (e.g. Korean) messages; keep the app English-only.
    if (/[\uAC00-\uD7A3]/.test(msg)) {
      if (status === "INVALID_ARGUMENT" || code === 400) {
        return "Google Sheets rejected the request (invalid argument). Check server logs, or try exporting again after a short wait.";
      }
      if (status === "PERMISSION_DENIED") {
        return "Google Sheets permission denied. Check spreadsheet sharing and OAuth scopes, or see server logs.";
      }
      if (status === "NOT_FOUND") {
        return "Google Sheets spreadsheet or tab was not found. Check the spreadsheet ID and sheet name in Settings.";
      }
      return `Google Sheets returned ${status || "an error"}. Please try again or check server logs.`;
    }

    if (msg.length > 0 && msg.length < 450) {
      return `Google Sheets: ${msg}`;
    }
  } catch {
    /* keep fallback */
  }
  return "Failed to export to Google Sheets. Please try again.";
}

function isSheetsWriteQuotaError(status: number, errText: string): boolean {
  return (
    status === 429 ||
    /RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|Write requests per minute per user|write requests/i.test(
      errText,
    )
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableReceiptOcrError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /529|503|502|500|408|429|overloaded|rate\s*limit|quota|RESOURCE_EXHAUSTED|free_tier|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
      msg,
    )
  ) {
    return true;
  }
  return /overloaded_error/i.test(msg);
}

/** Anthropic/Gemini often return transient overload or rate limits; brief backoff helps staff retries. */
async function withRetryReceiptOcr<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const backoffMs = [700, 2200, 6000];
  let last: unknown;
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryableReceiptOcrError(e) || attempt === backoffMs.length) {
        throw e;
      }
      const wait = backoffMs[attempt] ?? 6000;
      console.warn(
        `[OCR] ${label}: transient error (attempt ${attempt + 1}/${backoffMs.length + 1}), waiting ${wait}ms — ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`,
      );
      await sleepMs(wait);
    }
  }
  throw last;
}

function receiptOcrFailureUserMessage(raw: string): string {
  const m = raw.slice(0, 900);
  if (/429|quota|free_tier|generativelanguage|RESOURCE_EXHAUSTED/i.test(m)) {
    return "Receipt scanning hit Google Gemini limits (quota or free tier). Wait a few minutes and try again, or ask your admin to add billing / a paid tier for the Gemini API key on Google AI Studio.";
  }
  if (/529|overloaded|Overloaded/i.test(m)) {
    return "Receipt scanning is temporarily busy (AI provider overloaded). Please wait 1–2 minutes and try again.";
  }
  if (/401|403|invalid.?api|API key|not set/i.test(m)) {
    return "Receipt AI is misconfigured on the server (API key). Ask your admin to check Railway environment variables.";
  }
  return `Receipt recognition failed. ${m.length > 280 ? m.slice(0, 280) + "…" : m}`;
}

const RECEIPT_PARSE_SYSTEM = `You read printed receipt and ticket photos from Spain, Europe, and elsewhere. Text may be Spanish or English. Copy every readable business name, date, and money amount into JSON. Photos may be blurry, angled, or on pink/thermal paper — still try hard.

You MUST output exactly one JSON object. Use these English key names (read Spanish text from the image but put values under the keys below; do not use other Spanish keys like importe or emisor):
invoiceNumber, vendor, date, totalAmount, ivaAmount, tipAmount, category, items
Optional extra key "fecha" (string): the date exactly as printed on the ticket when it shows slashes or dashes (e.g. "11/03/2026"). Helps verify DD/MM order alongside ISO in "date".

CRITICAL — amounts (European style):
- Spain often uses comma as decimal separator: 114,32 means 114.32 in JSON (use JSON number 114.32). Same for 69,50 → 69.5.
- Large amounts may look like 1.234,56 (dot = thousands, comma = decimals) → use JSON number 1234.56.
- totalAmount = final amount to pay: look for TOTAL, IMPORTE TOTAL, TOTAL A PAGAR, SUMA, IMPORTE, Factura totals, or the bottom-line payment. NEVER use 0 for totalAmount if any plausible final total appears on the ticket.
- ivaAmount = VAT: IVA, CUOTA IVA, BASE IMPONIBLE, % IVA lines; use 0 only if no tax amount is visible.

invoiceNumber (document reference):
- Prefer the printed invoice / factura id when you see labels like Nº Factura, FACTURA, Invoice No., etc.
- On Spanish delivery notes and supplier tickets, the word ALBARÁN or ALBARAN (delivery note) is common: the document number is often on the same line after ":" or "-" or printed on the line directly below that heading. Use that full reference as invoiceNumber when no separate "Factura" number exists.
- **Never** use a **customer CIF/NIF** as invoiceNumber. The buyer tax id **B56819451** appears on many Es Cuco / supplier tickets near "Cliente" or "CIF" — it is **not** the albarán or factura number; leave invoiceNumber empty or use the real document id from ALBARÁN / Nº only, never B56819451.

Vendor:
- Copy the shop / issuer name from the header (Factura, NIF block, or letterhead). Partial names are OK. Use "" only if truly unreadable.
- If the brand is clearly Mercadona (any casing), set vendor exactly to: Mercadona S.A.
- If the brand is clearly Es Cuco / Super Es Cuco / Es Cuco Carns (carnicería chain), set vendor exactly to: Es Cuco
- If the brand is clearly La Portenia / La Porteña (carnes), set vendor exactly to: La Portenia

Date (critical — read ONLY what is printed on the paper):
- Do NOT use today's date, do NOT use the phone/camera/gallery file date, do NOT guess a year. Copy the date from the receipt text only.
- Spanish facturas almost always use DAY/MONTH/YEAR order (DD/MM/YYYY). Example printed 03/04/2026 = 3 April 2026 → date "2026-04-03". Another: 15/01/2025 = 15 January 2025 → "2025-01-15".
- Printed 11/03/2026 (or 11-03-2026) is 11 March 2026 → "2026-03-11". NEVER treat as US MM/DD (that would wrongly give November).
- If the printed date uses slashes or dashes (03-04-2026), apply the same DD/MM/YYYY rule before outputting ISO YYYY-MM-DD.
- If no legible date is on the receipt, use "" (empty string). Never invent a date.

category — one exact string:
"Meat","Seafood","Vegetables","Restaurant","Gas Station","Water","Beverages","Asian Market","Caviar","Truffle","Organic Farm","Hardware Store","Other"
Use "Meat" for butchers, carnicería, deli, embutidos, charcutería, names containing CARNS or similar.
Use "Restaurant" for bars, cafés, menús.

items: [{partName, quantity, unit:"kg", pricePerUnit, total, ivaPercent?}] ONLY when category is "Meat" AND the ticket shows weighted line items (carnicería / butcher style); for supermarkets with vegetables, fish, or mixed groceries use []. Otherwise [].
- On Spanish supplier albaranes, each product line often shows Precio (€/kg ex IVA), IVA % (e.g. 10), P.V.P. (€/kg inc IVA), and Importe (line total). Put ivaPercent as the printed VAT percent per line (e.g. 10) when visible. pricePerUnit should be Precio (ex VAT) €/kg when readable; total must be the line Importe (amount to pay for that line).
- **La Portenia** / La Porteña only — ALBARÁN table with **CANT.** / **CANT**, **TARIFA**, **IVA**, **IMPORTE**: quantity = under **CANT.** / CANT (kg); pricePerUnit = **TARIFA** (€/kg ex IVA); total = **IMPORTE** (line net). Never use the **IVA** column for quantity, price, or line total.
- **Es Cuco** only — ALBARÁN table with **CANT**, **P.V.P.**, **IMPORTE** (and often IVA): quantity = number **under CANT**; pricePerUnit = **P.V.P.** (follow the €/kg value under the **P.V.P.** column on that line); total = **IMPORTE** (line net under **IMPORTE**). Do not read line price from TARIFA unless that is what is printed for Es Cuco; do not confuse **IVA** (tax €) with P.V.P. or total.
- For any other meat vendor, use the general albarán line rules above; do not assume La Portenia or Es Cuco column layouts.
- Never put traceability-only rows in items: lines whose text is mainly "LOTE: …", "Nº lote", "ORIGEN: …", "País de origen", or "TRAZABILIDAD" (often printed under the real cut with IMPORTE 0 or no weight) are not products — omit them entirely. Only real cuts (CHULETÓN, TAPA DE VACUNO, etc.) with real kg and line totals belong in items.

Numbers in JSON must be JSON numbers for totalAmount, ivaAmount, tipAmount (not strings). Output ONLY the JSON object, no markdown.`;

const RECEIPT_PARSE_USER = `Read only text visible on this receipt image (totals, tax, vendor header, factura or ALBARÁN/ALBARAN document number, printed date). Ignore any idea of "today". Return the JSON object now.`;

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

/** When both Claude and Gemini are configured: order follows ENV.ocrGeminiFirstWhenBoth (default Claude first). */
async function runDualProviderImageReceiptOcr(
  normalized: string,
  mimeType: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const geminiFirst = ENV.ocrGeminiFirstWhenBoth;
  const runGemini = () =>
    runGoogleGeminiReceiptOcr(normalized, mimeType, systemPrompt, userPrompt);
  const runClaude = () =>
    parseReceiptWithClaude(normalized, mimeType, systemPrompt, userPrompt);

  if (geminiFirst) {
    try {
      return await runGemini();
    } catch (geminiErr) {
      console.warn(
        "[OCR] Gemini failed; trying Anthropic Claude:",
        geminiErr instanceof Error ? geminiErr.message : geminiErr,
      );
      return await runClaude();
    }
  }

  try {
    return await runClaude();
  } catch (claudeErr) {
    console.warn(
      "[OCR] Claude failed; trying Google Gemini:",
      claudeErr instanceof Error ? claudeErr.message : claudeErr,
    );
    return await runGemini();
  }
}

const EMAIL_PARSE_PROMPT = `You are an expert at extracting invoice data from email content.
Analyze the provided email text and extract invoice information.
Return ONLY a valid JSON object with these exact keys:
- invoiceNumber: string (invoice/factura number, or ALBARÁN/ALBARAN delivery-note number when that is the only document id)
- vendor: string (sender company/business name)
- date: string (ISO format YYYY-MM-DD, European DD/MM/YYYY in source → convert correctly)
- totalAmount: number (total amount in EUR)
- ivaAmount: number (IVA/VAT amount in EUR, 0 if not found)
- tipAmount: number (tip/gratuity amount in EUR, 0 if not found)
- category: string (one of: "Meat", "Seafood", "Vegetables", "Restaurant", "Gas Station", "Water", "Beverages", "Asian Market", "Caviar", "Truffle", "Organic Farm", "Hardware Store", "Other")
- subject: string (email subject line)
- items: array of {partName, quantity, unit:"kg", pricePerUnit, total, ivaPercent?}

When the PDF or body shows ALBARÁN / ALBARAN (delivery note) and the reference is on the next line or after a colon, use that value as invoiceNumber if no separate factura number exists.
- **Never** set invoiceNumber to **B56819451** — that is a customer **CIF**, not a document number.

For Meat invoices:
- If the attachment or email clearly shows butcher / meat line items, return those items.
- Include only actual meat cuts or weighted meat line items.
- Do not include packaging, sauces, drinks, vegetables, fish, or other non-meat products.
- Omit traceability-only lines (e.g. Spanish albarán "LOTE: … ORIGEN: ESPAÑA", "Nº lote", "País de origen", "TRAZABILIDAD") — they are not billable items even if OCR shows a quantity column.
- **La Portenia** ALBARÁN PDFs: **CANT.** / CANT, **TARIFA**, **IVA**, **IMPORTE** — quantity under CANT; pricePerUnit = **TARIFA**; total = **IMPORTE** (line net).
- **Es Cuco** ALBARÁN PDFs: **CANT**, **P.V.P.**, **IMPORTE** — quantity under **CANT**; pricePerUnit = **P.V.P.** (€/kg under that column); total = **IMPORTE**. Never use customer CIF **B56819451** as invoiceNumber.
- If line items are not clear, return [].

Return only the JSON, no markdown, no explanation.`;

/**
 * Spanish B2B PDFs often print ALBARÁN / ALBARAN with the document id on the same line (after ":") or on the following line.
 */
function extractDocumentIdNearAlbaranLabel(rawMultiline: string): string {
  const text = String(rawMultiline ?? "");
  const flattened = normalizeExtractedInvoiceText(text)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const inline = flattened.match(
    /\bALBAR[AÁ]N\b\s*(?:N[ºo°]?\.?|NUM(?:ERO)?\.?|N[ÚU]M\.?)?\s*[:\s#.-]*\s*([A-Z0-9][A-Z0-9\-_/]{2,})\b/i,
  );
  if (inline?.[1]) {
    const id = cleanParsedInvoiceNumber(inline[1]);
    if (id) return id;
  }

  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!/^ALBAR[AÁ]N\b/i.test(line)) continue;

    const after = line.replace(/^ALBAR[AÁ]N\b\s*/i, "").trim();
    if (after) {
      const id = cleanParsedInvoiceNumber(after.replace(/^[:\s#.-]+/, ""));
      if (id) return id;
    }

    for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
      const cand = (lines[k] ?? "").trim();
      if (!cand) continue;
      if (!/[0-9]/.test(cand)) break;
      const id = cleanParsedInvoiceNumber(cand);
      if (id) return id;
      break;
    }
  }
  return "";
}

function fallbackParseEmailInvoiceFromText(
  emailText: string,
  subject?: string,
  opts?: { headerFrom?: string; headerDate?: string },
) {
  const raw = `${subject ?? ""}\n${emailText ?? ""}\n${opts?.headerFrom ?? ""}\n${opts?.headerDate ?? ""}`;
  const rawMultiline = String(raw)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n|\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  const rawLines = rawMultiline
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  /** One line so "TOTAL A PAGAR" and "12,33" on adjacent lines in PDF text still match. */
  const normalized = normalizeExtractedInvoiceText(rawMultiline)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const invMatch =
    normalized.match(
      /\bALBAR[AÁ]N\b\s*(?:N[ºo°]?\.?|NUM(?:ERO)?\.?|N[ÚU]M\.?)?\s*[:\s#.-]*\s*([A-Z0-9][A-Z0-9\-_/]{2,})\b/i,
    ) ??
    normalized.match(
      /\b(?:invoice|factura|n[úu]mero(?:\s*de)?\s*factura|n[úu]m(?:ero)?\.?\s*factura|n[oº°]\s*(?:de\s*)?factura)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-_/]{2,})/i,
    ) ??
    normalized.match(/\badjuntamos\s+factura\s+num\s*:\s*([0-9]+)\b/i) ??
    normalized.match(/\bfactura\s+num\s*:\s*([0-9]+)\b/i) ??
    normalized.match(/\bfactura\s*[#Nº]\s*([A-Z0-9][A-Z0-9\-_/]{1,})/i) ??
    normalized.match(/\b(?:invoice|factura)\s*[#:]?\s*([A-Z0-9][A-Z0-9\-_/]{2,})/i) ??
    normalized.match(/\bn[ºo°]\s*documento\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_/]{3,})\b/i) ??
    normalized.match(/\bdocumento\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_/]{3,})\b/i) ??
    normalized.match(/\b([A-Z]{1,4}\-\d{3,}|\d{6,})\b/);
  const numFacturaOnly = normalized.match(
    /\bn[oº°]\s*\.?\s*factura\s*:?\s*([0-9]{4,})\b/i,
  );
  const serieEmision = normalized.match(
    /\bserie\s*(?:emis[ií]on|emisi[oó]n)\s*:?\s*([A-Z0-9]{2,})\b/i,
  );
  const dateMatch =
    normalized.match(/\b(\d{4}\-\d{2}\-\d{2})\b/) ??
    normalized.match(
      /\bfecha\s*(?:de\s*)?factura\s*:?\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/i,
    ) ??
    normalized.match(/\bfecha\s*:\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/i) ??
    normalized.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  /**
   * EU amounts: 12,33 / 1.234,56 — plus PDF text that uses 12.33 (dot decimals) without thousands.
   */
  const euMoney =
    "([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]{1,6}(?:[.,][0-9]{1,2})?|[0-9]{1,3}(?:[.,][0-9]{3})+)";
  const totalMatch =
    /** Thermal / ticket printers: "TOTAL: 52,20" */
    normalized.match(new RegExp(`\\bTOTAL\\s*:\\s*${euMoney}`, "i")) ??
    normalized.match(new RegExp(`\\bTOTAL\\s*:\\s*${euMoney}\\s*(?:€|EUR)?`, "i")) ??
    normalized.match(new RegExp(`\\bSUMA\\s*:\\s*${euMoney}\\s*(?:€|EUR)?`, "i")) ??
    normalized.match(new RegExp(`\\bIMPORTE\\s+TOTAL\\s*:\\s*${euMoney}`, "i")) ??
    normalized.match(new RegExp(`\\btotal\\s+a\\s+pagar\\b\\s*:?\\s*${euMoney}`, "i")) ??
    normalized.match(
      new RegExp(
        `\\b(?:importe\\s+total|total\\s+con\\s+iva|total\\s+iva\\s+incluido|importe\\s+total\\s+con\\s+iva)\\b[^0-9€]{0,48}${euMoney}`,
        "i",
      ),
    ) ??
    normalized.match(
      /\b(?:total(?:\s+a\s+pagar)?|importe\s+total|total\s+factura|amount\s+due|importe\s+con\s+iva)\b[^0-9€]{0,48}([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]{1,6}(?:[.,][0-9]{1,2})?)/i,
    ) ??
    normalized.match(
      /\b(?:total|importe)\b[^0-9€]{0,52}€\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]{1,6}(?:[.,][0-9]{1,2})?)/i,
    ) ??
    normalized.match(
      /€\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]{1,6}(?:[.,][0-9]{1,2})?)/,
    ) ??
    normalized.match(
      /([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})|[0-9]{1,6}(?:[.,][0-9]{1,2})?)\s*€/,
    );
  /**
   * Tabular factura PDFs often print totals like:
   * - TOTAL IVA INCLUIDO    12,33
   * - TOTAL A PAGAR         12,33
   * Prefer these exact labels before generic amount heuristics.
   */
  const totalLabelMatch =
    normalized.match(
      /\b(?:total\s+iva\s+incluido|total\s+a\s+pagar)\b[^0-9€]{0,120}([0-9]{1,6}(?:[.,][0-9]{1,2})?)\b/i,
    ) ??
    normalized.match(
      /\b(?:importe\s+total|total\s+factura)\b[^0-9€]{0,120}([0-9]{1,6}(?:[.,][0-9]{1,2})?)\b/i,
    ) ??
    normalized.match(
      /\b(?:suma|total|importe)\b[^0-9€]{0,24}([0-9]{1,6}(?:[.,][0-9]{1,2})?)\s*(?:€|eur)\b/i,
    );
  /**
   * Some supermarket PDFs print a 3-column summary line:
   *   TOTAL (€)  52,22  3,22  55,44
   *              base   iva   total
   * When present, trust this more than generic heuristics.
   */
  const totalTripleMatch = normalized.match(
    /\btotal\s*\(?(?:€|eur)?\)?\s*([0-9]{1,6}(?:[.,][0-9]{1,2})?)\s+([0-9]{1,6}(?:[.,][0-9]{1,2})?)\s+([0-9]{1,6}(?:[.,][0-9]{1,2})?)\b/i,
  );
  const mercadonaTotalFacturaMatch =
    rawMultiline.match(/(?:^|\n)\s*Total\s+Factura\s+([0-9]{1,6}(?:[.,][0-9]{2}))\s*(?:€|eur|e)?/i) ??
    normalized.match(
      /\btotal\s+factura\b[^0-9€]{0,20}([0-9]{1,6}(?:[.,][0-9]{2}))\s*(?:€|eur|e)?/i,
    );
  const mercadonaTotalRowMatch = rawMultiline.match(
    /(?:^|\n)\s*TOTAL\s*\([^0-9)]*\)\s+([0-9]{1,6}(?:[.,][0-9]{2}))\s+([0-9]{1,6}(?:[.,][0-9]{2}))\s+([0-9]{1,6}(?:[.,][0-9]{2}))/i,
  );
  const mercadonaVendorMatch =
    rawMultiline.match(/(?:^|\n)\s*(MERCADONA\s+S\.?A\.?)\s*(?:\n|$)/i) ??
    rawMultiline.match(/(?:^|\n)\s*(MERCADONA)\s*(?:\n|$)/i);
  const mercadonaInvoiceMatch =
    rawMultiline.match(/(?:^|\n)\s*N[ºo°]\s*Factura\s*:\s*([A-Z]-V\d{4,}-\d{4,})/i) ??
    rawMultiline.match(/(?:^|\n)\s*Factura\s+Simplificada\s*:\s*([0-9-]{6,})/i);
  const baseIvaSummaryMatch = normalized.match(
    /\bbase\s*%\s*iva\s*total\s*iva\b[^0-9]{0,24}([0-9]{1,6}(?:[.,][0-9]{1,2})?)\s+([0-9]{1,3}(?:[.,][0-9]{1,2})?)\s+([0-9]{1,6}(?:[.,][0-9]{1,2})?)\b/i,
  );
  const baseMatch =
    normalized.match(new RegExp(`\\bBASE\\s*:\\s*${euMoney}`, "i")) ??
    normalized.match(new RegExp(`\\bbase\\b[^0-9€]{0,24}${euMoney}`, "i")) ??
    normalized.match(
      new RegExp(
        `\\bbase\\s+imponible\\b[^0-9€]{0,40}${euMoney}`,
        "i",
      ),
    );
  const ivaMatch =
    normalized.match(new RegExp(`\\b(?:total\\s+iva|iva\\s+total)\\s*:?\\s*${euMoney}`, "i")) ??
    normalized.match(
      new RegExp(
        `\\bcuota\\s*(?:de\\s*)?iva\\b[^0-9€]{0,40}${euMoney}`,
        "i",
      ),
    ) ??
    normalized.match(
      /\b(?:cuota\s*(?:de\s*)?iva|cuota\s+iva|iva|vat|tax|impuesto)\b[^0-9€]{0,36}([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2}|[0-9]{1,6}\.[0-9]{2}|[0-9]{1,6},[0-9]{2}))/i,
    );
  const fromMatch = normalized.match(/\bfrom:\s*([^\n<]{3,80})/i);
  const subjectVendorMatch = String(subject ?? "").match(
    /\bfactura(?:\s+mensual)?(?:\s+de(?:l)?)?\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9\s&.'-]{1,60})/i,
  );
  const mercadonaSubjectId = String(subject ?? "").match(
    /\bfactura\s+mercadona\s+(A[\-‑–—]V\d{4}[\-‑–—]\d{4,})\b/i,
  );
  const companyLabelVendorMatch =
    rawMultiline.match(/(?:^|\n)\s*empresa\s*:\s*([^\n]{3,80})/i) ??
    rawMultiline.match(/(?:^|\n)\s*empresa\s*\n\s*([^\n]{3,80})/i);
  const topHeadingVendor =
    rawLines.find(
      (line, index) =>
        index < 12 &&
        /[A-Za-zÀ-ÿ]/.test(line) &&
        !/^(?:cliente|company|empresa|factura|invoice|receipt|from:|fecha:?|fra\s+simp:?|le\s+atendi[oó]:?|n\.?i\.?f\.?:?|nombre:?|direcci[oó]n:?|poblaci[oó]n:?|unid\.?|descripci[oó]n|precio|importe|base|% iva|total iva|subtotal|descuento|gratuity|impuesto|albar[aá]n|\[[^\]]+\])$/i.test(
          line,
        ) &&
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(line) &&
        !/^\d[\d\s.,/-]*$/.test(line),
    ) ?? "";

  let dateIso = "";
  if (dateMatch) {
    if (dateMatch[1] && /^\d{4}\-\d{2}\-\d{2}$/.test(dateMatch[1])) {
      dateIso = dateMatch[1];
    } else if (dateMatch[1] && dateMatch[2] && dateMatch[3]) {
      const dd = String(dateMatch[1]).padStart(2, "0");
      const mm = String(dateMatch[2]).padStart(2, "0");
      const yyyy = String(dateMatch[3]);
      dateIso = `${yyyy}-${mm}-${dd}`;
    }
  }

  const parseMoney = (v: string | undefined) => {
    if (!v) return 0;
    const t = v.trim().replace(/[·∙]/g, ".");
    if (!t) return 0;
    const hasComma = t.includes(",");
    const hasDot = t.includes(".");
    let cleaned = t;
    if (hasComma && hasDot) {
      cleaned = t.replace(/\./g, "").replace(",", ".");
    } else if (hasComma && !hasDot) {
      const lastComma = t.lastIndexOf(",");
      if (lastComma >= 0 && t.length - lastComma - 1 <= 2) {
        cleaned = `${t.slice(0, lastComma).replace(/,/g, "")}.${t.slice(lastComma + 1)}`;
      } else {
        cleaned = t.replace(/,/g, ".");
      }
    } else {
      cleaned = t.replace(/,/g, "");
    }
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  const moneyTokens =
    normalized.match(
      /[0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{1,2}|[0-9]{1,6}\.[0-9]{1,2}|[0-9]{1,6},[0-9]{1,2}/g,
    ) ?? [];
  const largestAmount = moneyTokens
    .map((m) => parseMoney(m))
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce((max, cur) => (cur > max ? cur : max), 0);

  const euroTaggedTokens = [
    ...(normalized.match(/€\s*[0-9]{1,6}(?:[.,][0-9]{1,2})?/g) ?? []),
    ...(normalized.match(/[0-9]{1,6}(?:[.,][0-9]{1,2})?\s*(?:€|eur)\b/gi) ?? []),
  ];
  const largestEuroTagged = euroTaggedTokens
    .map((rawToken) => parseMoney(rawToken.replace(/eur|€/gi, "")))
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce((max, cur) => (cur > max ? cur : max), 0);

  const summaryBaseParsed =
    parseMoney(mercadonaTotalRowMatch?.[1]) ||
    parseMoney(totalTripleMatch?.[1]) ||
    parseMoney(baseIvaSummaryMatch?.[1]);
  const summaryIvaParsed =
    parseMoney(mercadonaTotalRowMatch?.[2]) ||
    parseMoney(totalTripleMatch?.[2]) ||
    parseMoney(baseIvaSummaryMatch?.[3]);
  const summaryTotalParsed =
    parseMoney(mercadonaTotalFacturaMatch?.[1]) ||
    parseMoney(mercadonaTotalRowMatch?.[3]) ||
    parseMoney(totalTripleMatch?.[3]);

  let totalParsed =
    summaryTotalParsed ||
    parseMoney(totalLabelMatch?.[1]) ||
    parseMoney(totalMatch?.[1]) ||
    largestEuroTagged;
  const baseParsed = summaryBaseParsed || parseMoney(baseMatch?.[1]);
  let ivaParsed = summaryIvaParsed || parseMoney(ivaMatch?.[1]);
  if (totalParsed <= 0 && baseParsed > 0 && ivaParsed > 0) {
    totalParsed = Math.round((baseParsed + ivaParsed) * 100) / 100;
  }
  if (ivaParsed <= 0 && totalParsed > 0 && baseParsed > 0 && totalParsed >= baseParsed) {
    ivaParsed = Math.round((totalParsed - baseParsed) * 100) / 100;
  }

  const fallbackDateFromHeader = normalizeDateKeyForDuplicate(opts?.headerDate ?? "");
  const safeDate =
    dateIso ||
    (/^\d{4}\-\d{2}\-\d{2}$/.test(fallbackDateFromHeader) ? fallbackDateFromHeader : "") ||
    new Date().toISOString().split("T")[0];

  let invoiceNumberOut = cleanParsedInvoiceNumber(invMatch?.[1]);
  if (!invoiceNumberOut) {
    const fromAlbaran = extractDocumentIdNearAlbaranLabel(rawMultiline);
    if (fromAlbaran) invoiceNumberOut = fromAlbaran;
  }
  if (mercadonaInvoiceMatch?.[1]) {
    invoiceNumberOut = cleanParsedInvoiceNumber(mercadonaInvoiceMatch[1]);
  } else if (mercadonaSubjectId?.[1]) {
    const subInv = cleanParsedInvoiceNumber(mercadonaSubjectId[1]);
    if (subInv) invoiceNumberOut = subInv;
  } else if (serieEmision?.[1] && numFacturaOnly?.[1]) {
    invoiceNumberOut = cleanParsedInvoiceNumber(
      `${String(serieEmision[1]).trim()}-${String(numFacturaOnly[1]).trim()}`,
    );
  } else if (!invoiceNumberOut && numFacturaOnly?.[1]) {
    invoiceNumberOut = cleanParsedInvoiceNumber(numFacturaOnly[1]);
  }

  const vendorFromSubject = String(subjectVendorMatch?.[1] ?? "").trim();
  const mercadonaSubjectVendor = mercadonaSubjectId?.[1] ? "MERCADONA S.A." : "";
  const vendorOut = pickBestParsedVendor(
    mercadonaVendorMatch?.[1],
    mercadonaSubjectVendor,
    companyLabelVendorMatch?.[1],
    topHeadingVendor,
    vendorFromSubject,
    fromMatch?.[1],
    opts?.headerFrom,
  );

  return {
    invoiceNumber: invoiceNumberOut,
    vendor: vendorOut,
    date: safeDate,
    totalAmount: totalParsed,
    ivaAmount: ivaParsed,
    tipAmount: 0,
    category: "Other",
    subject: subject ?? "",
    items: [],
  };
}

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
          const useGeminiGoogle =
            Boolean(ENV.googleGeminiApiKey?.trim()) && !ENV.ocrSkipGemini;
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
            text = await withRetryReceiptOcr("dual-provider", () =>
              runDualProviderImageReceiptOcr(
                normalized,
                mimeType,
                RECEIPT_PARSE_SYSTEM,
                RECEIPT_PARSE_USER,
              ),
            );
          } else if (useGeminiGoogle) {
            text = await withRetryReceiptOcr("gemini-only", () =>
              runGoogleGeminiReceiptOcr(
                normalized,
                mimeType,
                RECEIPT_PARSE_SYSTEM,
                RECEIPT_PARSE_USER,
              ),
            );
            console.log("[OCR] Using Google Gemini API only (no Anthropic key)");
          } else if (useClaude) {
            text = await withRetryReceiptOcr("claude-only", () =>
              parseReceiptWithClaude(
                normalized,
                mimeType,
                RECEIPT_PARSE_SYSTEM,
                RECEIPT_PARSE_USER,
              ),
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

          const dateOut = resolveReceiptDateIso(parsed);

          const vendorOcr =
            canonicalVendorDisplayName(String(parsed.vendor ?? "").trim()) ||
            String(parsed.vendor ?? "").trim();
          const totalOcr = parseMoneyNumber(parsed.totalAmount);
          return {
            invoiceNumber: String(parsed.invoiceNumber ?? "").trim(),
            vendor: vendorOcr,
            date: dateOut,
            totalAmount: totalOcr,
            ivaAmount: parseMoneyNumber(parsed.ivaAmount),
            tipAmount: parseMoneyNumber(parsed.tipAmount),
            category: String(parsed.category ?? "Other").trim() || "Other",
            items: applyMeatLineReconcile(normalizeParsedMeatItems(parsed.items), totalOcr, vendorOcr),
          };
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          console.error("[OCR] Parse error:", err);
          const msg = err instanceof Error ? err.message : String(err);
          const userMsg = receiptOcrFailureUserMessage(msg);
          const code =
            /429|quota|free_tier|RESOURCE_EXHAUSTED/i.test(msg) ? "TOO_MANY_REQUESTS" : "INTERNAL_SERVER_ERROR";
          throw new TRPCError({
            code: code as "INTERNAL_SERVER_ERROR" | "TOO_MANY_REQUESTS",
            message: userMsg,
            cause: err,
          });
        }
      }),

    // Parse email invoice text with AI
    parseEmailInvoice: publicProcedure
      .input(
        z.object({
          emailText: z.string(),
          subject: z.string().optional(),
          accessToken: z.string().optional(),
          messageId: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        let attachmentAugmentedText = "";
        let attachmentBestCandidate: ParsedEmailInvoiceCandidate | null = null;
        let headerFrom = "";
        let headerDate = "";
        try {
          const accessToken = input.accessToken?.trim();
          const messageId = input.messageId?.trim();
          if (accessToken && messageId) {
            try {
              const msgRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
                { headers: { Authorization: `Bearer ${accessToken}` } },
              );
              if (msgRes.ok) {
                const detail = (await msgRes.json()) as {
                  threadId?: string;
                  payload?: {
                    headers?: { name?: string; value?: string }[];
                    parts?: {
                      mimeType?: string;
                      filename?: string;
                      body?: { attachmentId?: string };
                      parts?: any[];
                    }[];
                    mimeType?: string;
                    filename?: string;
                    body?: { attachmentId?: string };
                  };
                };
                const isMercadonaSubject = /mercadona/i.test(String(input.subject ?? ""));

                const imageAttachmentIds: { attachmentId: string; filename: string; mimeType: string }[] = [];
                const pdfAttachments: { attachmentId?: string; filename: string; inlineData?: string }[] = [];
                const headers = detail.payload?.headers ?? [];
                headerFrom = String(
                  headers.find((h) => String(h.name ?? "").toLowerCase() === "from")?.value ?? "",
                )
                  .replace(/<[^>]+>/g, "")
                  .trim();
                headerDate = String(
                  headers.find((h) => String(h.name ?? "").toLowerCase() === "date")?.value ?? "",
                ).trim();

                const walk = (part: {
                  mimeType?: string;
                  filename?: string;
                  body?: { attachmentId?: string; data?: string };
                  parts?: any[];
                }) => {
                  const mimeType = String(part.mimeType ?? "").toLowerCase();
                  const filename = String(part.filename ?? "").trim();
                  const attachmentId = part.body?.attachmentId?.trim();
                  const inlineData = typeof part.body?.data === "string" ? part.body.data : "";
                  // Many invoice emails use inline images (cid) with no filename — still has attachmentId.
                  if (attachmentId) {
                    const resolvedMime = resolveGmailAttachmentMime(mimeType, filename);
                    if (resolvedMime.startsWith("image/")) {
                      const label =
                        filename ||
                        `inline.${resolvedMime.includes("png") ? "png" : resolvedMime.includes("gif") ? "gif" : resolvedMime.includes("webp") ? "webp" : "jpg"}`;
                      imageAttachmentIds.push({ attachmentId, filename: label, mimeType: resolvedMime });
                    } else if (
                      resolvedMime === "application/pdf" ||
                      resolvedMime === "application/x-pdf" ||
                      resolvedMime === "application/octet-stream"
                    ) {
                      const label = filename || "attachment.pdf";
                      pdfAttachments.push({ attachmentId, filename: label });
                    }
                  } else if (inlineData) {
                    const inlineBuf = decodeGmailBase64UrlToBuffer(inlineData);
                    const inlineMime = resolveGmailAttachmentMime(mimeType, filename, inlineBuf);
                    if (inlineMime.startsWith("image/")) {
                      const label =
                        filename ||
                        `inline.${inlineMime.includes("png") ? "png" : inlineMime.includes("gif") ? "gif" : inlineMime.includes("webp") ? "webp" : "jpg"}`;
                      imageAttachmentIds.push({
                        attachmentId: "",
                        filename: label,
                        mimeType: inlineMime,
                      });
                    } else if (
                      inlineMime === "application/pdf" ||
                      inlineMime === "application/x-pdf" ||
                      inlineMime === "application/octet-stream"
                    ) {
                      const label = filename || "attachment.pdf";
                      pdfAttachments.push({ filename: label, inlineData });
                    } else if (mimeType.includes("message/rfc822") && inlineBuf?.length) {
                      const embeddedPdf = extractEmbeddedPdfFromMimeMessage(inlineBuf);
                      if (embeddedPdf?.length) {
                        pdfAttachments.push({
                          filename: filename || "embedded-attachment.pdf",
                          inlineData: embeddedPdf.toString("base64"),
                        });
                      }
                    }
                  }
                  for (const child of part.parts ?? []) {
                    walk(child);
                  }
                };

                if (detail.payload) {
                  walk(detail.payload);
                }
                if (pdfAttachments.length === 0 && detail.threadId) {
                  try {
                    const threadRes = await fetch(
                      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(detail.threadId)}?format=full`,
                      { headers: { Authorization: `Bearer ${accessToken}` } },
                    );
                    if (threadRes.ok) {
                      const thread = (await threadRes.json()) as {
                        messages?: Array<{
                          id?: string;
                          payload?: {
                            mimeType?: string;
                            filename?: string;
                            body?: { attachmentId?: string; data?: string };
                            parts?: any[];
                          };
                        }>;
                      };
                      for (const msg of thread.messages ?? []) {
                        if (!msg?.payload) continue;
                        walk(msg.payload);
                      }
                      if (pdfAttachments.length > 0) {
                        console.log(
                          `[Email Parse] Thread fallback found ${pdfAttachments.length} pdf attachment candidate(s).`,
                        );
                      }
                    }
                  } catch (threadErr) {
                    console.warn("[Email Parse] Thread fallback fetch failed:", threadErr);
                  }
                }
                const collectGmailPartTree = (
                  part: any,
                  out: string[],
                  path = "root",
                ): void => {
                  if (!part || out.length >= 40) return;
                  const mime = String(part?.mimeType ?? "");
                  const name = String(part?.filename ?? "");
                  const attachmentId = String(part?.body?.attachmentId ?? "");
                  const bodySize = Number(part?.body?.size ?? 0);
                  const hasData = typeof part?.body?.data === "string" && part.body.data.length > 0;
                  const childCount = Array.isArray(part?.parts) ? part.parts.length : 0;
                  out.push(
                    `${path} mime=${mime || "-"} file=${name || "-"} attId=${attachmentId ? "y" : "n"} data=${hasData ? "y" : "n"} size=${Number.isFinite(bodySize) ? bodySize : 0} children=${childCount}`,
                  );
                  for (let i = 0; i < childCount; i++) {
                    collectGmailPartTree(part.parts[i], out, `${path}.${i}`);
                    if (out.length >= 40) break;
                  }
                };

                const maxImageOcr = 2;
                const imageOcrBlocks: string[] = [];
                for (const info of imageAttachmentIds.slice(0, maxImageOcr)) {
                  try {
                    let decodedBuf: Buffer | null = null;
                    if (info.attachmentId) {
                      const attRes = await fetch(
                        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(info.attachmentId)}`,
                        { headers: { Authorization: `Bearer ${accessToken}` } },
                      );
                      if (!attRes.ok) continue;
                      const att = (await attRes.json()) as { data?: string };
                      decodedBuf = decodeGmailBase64UrlToBuffer(att.data ?? "");
                    }
                    const b64 = decodedBuf ? decodedBuf.toString("base64") : "";
                    if (!b64 || b64.length < 64) continue;

                    const mimeType = info.mimeType || detectMimeFromImageBase64(b64);
                    let ocrText = "";
                    const useClaude = Boolean(ENV.anthropicApiKey?.trim());
                    const useGeminiGoogle =
                      Boolean(ENV.googleGeminiApiKey?.trim()) && !ENV.ocrSkipGemini;
                    if (useGeminiGoogle && useClaude) {
                      ocrText = await runDualProviderImageReceiptOcr(
                        b64,
                        mimeType,
                        RECEIPT_PARSE_SYSTEM,
                        RECEIPT_PARSE_USER,
                      );
                    } else if (useGeminiGoogle) {
                      try {
                        ocrText = await runGoogleGeminiReceiptOcr(
                          b64,
                          mimeType,
                          RECEIPT_PARSE_SYSTEM,
                          RECEIPT_PARSE_USER,
                        );
                      } catch (geminiImageErr) {
                        console.warn(
                          "[Email Parse] Gemini image OCR failed (no Anthropic key):",
                          info.filename,
                          geminiImageErr instanceof Error ? geminiImageErr.message : geminiImageErr,
                        );
                      }
                    } else if (useClaude) {
                      ocrText = await parseReceiptWithClaude(
                        b64,
                        mimeType,
                        RECEIPT_PARSE_SYSTEM,
                        RECEIPT_PARSE_USER,
                      );
                    }
                    if (ocrText.trim()) {
                      try {
                        const cleanedOcr = ocrText
                          .replace(/```json\n?/g, "")
                          .replace(/```\n?/g, "")
                          .trim();
                        const ocrJsonMatch = cleanedOcr.match(/\{[\s\S]*\}/);
                        if (ocrJsonMatch) {
                          const ocrRawParsed = JSON.parse(ocrJsonMatch[0]) as Record<string, unknown>;
                          attachmentBestCandidate = chooseBetterEmailInvoiceCandidate(
                            attachmentBestCandidate,
                            receiptLikeCandidateFromRawParsed(ocrRawParsed, {
                              headerFrom,
                              headerDate,
                              subject: input.subject,
                            }),
                          );
                        }
                      } catch (ocrParseErr) {
                        console.warn("[Email Parse] Attachment OCR JSON parse failed:", ocrParseErr);
                      }
                      imageOcrBlocks.push(`[Image attachment OCR: ${info.filename}]\n${ocrText.trim()}`);
                    }
                  } catch (imageOcrErr) {
                    console.warn(
                      "[Email Parse] Image attachment OCR skipped:",
                      info.filename,
                      imageOcrErr instanceof Error ? imageOcrErr.message : imageOcrErr,
                    );
                  }
                }

                const maxPdfExtract = 2;
                const pdfTextBlocks: string[] = [];
                let pdfTextExtractFn: ((dataBuffer: Buffer) => Promise<string>) | null = null;
                if (pdfAttachments.length > 0) {
                  try {
                    const mod = await import("unpdf");
                    const extractText = mod.extractText as (
                      data: Uint8Array,
                      options: { mergePages: true },
                    ) => Promise<{ text: string }>;
                    pdfTextExtractFn = async (dataBuffer: Buffer) => {
                      const result = await extractText(new Uint8Array(dataBuffer), { mergePages: true });
                      return String(result.text ?? "");
                    };
                  } catch (importErr) {
                    console.warn("[Email Parse] unpdf module not available:", importErr);
                  }
                }
                const minPdfTextChars = 72;
                const maxPdfBytesForGemini = 20 * 1024 * 1024;
                let allowGeminiPdf =
                  Boolean(ENV.googleGeminiApiKey?.trim()) && !ENV.ocrSkipGemini;

                for (const info of pdfAttachments.slice(0, maxPdfExtract)) {
                  let pdfBuf: Buffer | null = null;
                  if (info.inlineData) {
                    pdfBuf = decodeGmailBase64UrlToBuffer(info.inlineData);
                  } else if (info.attachmentId) {
                    const attRes = await fetch(
                      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(info.attachmentId)}`,
                      { headers: { Authorization: `Bearer ${accessToken}` } },
                    );
                    if (!attRes.ok) continue;
                    const att = (await attRes.json()) as { data?: string };
                    pdfBuf = decodeGmailBase64UrlToBuffer(att.data ?? "");
                  }
                  if (!pdfBuf || pdfBuf.length < 64) continue;
                  const embeddedPdf = extractEmbeddedPdfFromMimeMessage(pdfBuf);
                  if (embeddedPdf?.length) {
                    pdfBuf = embeddedPdf;
                  }
                  const detectedMime = detectMimeFromBuffer(pdfBuf);
                  const pdfLike =
                    detectedMime === "application/pdf" ||
                    detectedMime === "application/x-pdf" ||
                    /\.pdf$/i.test(String(info.filename ?? ""));
                  if (!pdfLike) continue;

                  let pdfText = "";
                  if (pdfTextExtractFn) {
                    try {
                      pdfText = await pdfTextExtractFn(pdfBuf);
                      pdfText = normalizeExtractedInvoiceText(String(pdfText).replace(/\s+\n/g, "\n"));
                    } catch (pdfErr) {
                      console.warn("[Email Parse] unpdf extract failed:", info.filename, pdfErr);
                    }
                  }

                  if (pdfText.length >= minPdfTextChars || isUsefulExtractedPdfText(pdfText)) {
                    attachmentBestCandidate = chooseBetterEmailInvoiceCandidate(
                      attachmentBestCandidate,
                      fallbackParseEmailInvoiceFromText(pdfText, input.subject, {
                        headerFrom,
                        headerDate,
                      }),
                    );
                    pdfTextBlocks.push(`[PDF text: ${info.filename}]\n${pdfText.slice(0, 4500)}`);
                    continue;
                  }

                  // Scanned PDFs: no text layer — send PDF to Gemini (same JSON receipt schema as camera OCR).
                  if (
                    allowGeminiPdf &&
                    pdfBuf.length <= maxPdfBytesForGemini
                  ) {
                    try {
                      const b64pdf = pdfBuf.toString("base64");
                      const geminiJson = await parseInvoicePdfWithGoogleGemini(
                        b64pdf,
                        RECEIPT_PARSE_SYSTEM,
                        RECEIPT_PARSE_USER,
                      );
                      if (geminiJson.trim()) {
                        try {
                          const cleanedGeminiJson = geminiJson
                            .replace(/```json\n?/g, "")
                            .replace(/```\n?/g, "")
                            .trim();
                          const geminiJsonMatch = cleanedGeminiJson.match(/\{[\s\S]*\}/);
                          if (geminiJsonMatch) {
                            const geminiRawParsed = JSON.parse(
                              geminiJsonMatch[0],
                            ) as Record<string, unknown>;
                            attachmentBestCandidate = chooseBetterEmailInvoiceCandidate(
                              attachmentBestCandidate,
                              receiptLikeCandidateFromRawParsed(geminiRawParsed, {
                                headerFrom,
                                headerDate,
                                subject: input.subject,
                              }),
                            );
                          }
                        } catch (geminiParseErr) {
                          console.warn("[Email Parse] Gemini PDF JSON parse failed:", geminiParseErr);
                        }
                        pdfTextBlocks.push(`[PDF invoice (Gemini): ${info.filename}]\n${geminiJson.trim().slice(0, 4500)}`);
                      }
                    } catch (geminiPdfErr) {
                      const geminiMsg =
                        geminiPdfErr instanceof Error ? geminiPdfErr.message : String(geminiPdfErr);
                      if (/429|quota|rate limit/i.test(geminiMsg)) {
                        allowGeminiPdf = false;
                      }
                      console.warn(
                        "[Email Parse] Gemini PDF read failed (quota or model):",
                        info.filename,
                        geminiMsg,
                      );
                    }
                  }
                }

                if (!attachmentBestCandidate && accessToken && messageId) {
                  try {
                    const fallbackAtt = await fetchFirstGmailAttachmentForReceiptExport(accessToken, messageId);
                    if (fallbackAtt?.buffer?.length) {
                      if (
                        fallbackAtt.mime === "application/pdf" ||
                        fallbackAtt.mime === "application/x-pdf"
                      ) {
                        const pdfBuf = fallbackAtt.buffer;
                        let pdfText = "";
                        if (pdfTextExtractFn) {
                          try {
                            pdfText = await pdfTextExtractFn(pdfBuf);
                            pdfText = normalizeExtractedInvoiceText(String(pdfText).replace(/\s+\n/g, "\n"));
                          } catch (fallbackPdfErr) {
                            console.warn("[Email Parse] Fallback PDF extract failed:", fallbackPdfErr);
                          }
                        }
                        if (pdfText.length >= minPdfTextChars || isUsefulExtractedPdfText(pdfText)) {
                          attachmentBestCandidate = chooseBetterEmailInvoiceCandidate(
                            attachmentBestCandidate,
                            fallbackParseEmailInvoiceFromText(pdfText, input.subject, {
                              headerFrom,
                              headerDate,
                            }),
                          );
                          pdfTextBlocks.push(`[PDF text: fallback attachment]\n${pdfText.slice(0, 4500)}`);
                        }
                      } else if (fallbackAtt.mime.startsWith("image/")) {
                        const b64 = fallbackAtt.buffer.toString("base64");
                        const useClaude = Boolean(ENV.anthropicApiKey?.trim());
                        const useGeminiGoogle =
                          Boolean(ENV.googleGeminiApiKey?.trim()) && !ENV.ocrSkipGemini;
                        let ocrText = "";
                        if (useGeminiGoogle && useClaude) {
                          ocrText = await runDualProviderImageReceiptOcr(
                            b64,
                            fallbackAtt.mime,
                            RECEIPT_PARSE_SYSTEM,
                            RECEIPT_PARSE_USER,
                          );
                        } else if (useGeminiGoogle) {
                          try {
                            ocrText = await runGoogleGeminiReceiptOcr(
                              b64,
                              fallbackAtt.mime,
                              RECEIPT_PARSE_SYSTEM,
                              RECEIPT_PARSE_USER,
                            );
                          } catch (fallbackImgErr) {
                            console.warn("[Email Parse] Fallback image OCR failed:", fallbackImgErr);
                          }
                        } else if (useClaude) {
                          ocrText = await parseReceiptWithClaude(
                            b64,
                            fallbackAtt.mime,
                            RECEIPT_PARSE_SYSTEM,
                            RECEIPT_PARSE_USER,
                          );
                        }
                        if (ocrText.trim()) {
                          try {
                            const cleanedOcr = ocrText
                              .replace(/```json\n?/g, "")
                              .replace(/```\n?/g, "")
                              .trim();
                            const ocrJsonMatch = cleanedOcr.match(/\{[\s\S]*\}/);
                            if (ocrJsonMatch) {
                              const ocrRawParsed = JSON.parse(ocrJsonMatch[0]) as Record<string, unknown>;
                              attachmentBestCandidate = chooseBetterEmailInvoiceCandidate(
                                attachmentBestCandidate,
                                receiptLikeCandidateFromRawParsed(ocrRawParsed, {
                                  headerFrom,
                                  headerDate,
                                  subject: input.subject,
                                }),
                              );
                            }
                          } catch (fallbackImgParseErr) {
                            console.warn("[Email Parse] Fallback image OCR JSON parse failed:", fallbackImgParseErr);
                          }
                          imageOcrBlocks.push(`[Image attachment OCR: fallback attachment]\n${ocrText.trim()}`);
                        }
                      }
                    }
                  } catch (fallbackAttErr) {
                    console.warn("[Email Parse] Attachment fallback fetch failed:", fallbackAttErr);
                  }
                }

                if (!attachmentBestCandidate && accessToken && messageId) {
                  try {
                    const rawRes = await fetch(
                      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=raw`,
                      { headers: { Authorization: `Bearer ${accessToken}` } },
                    );
                    if (rawRes.ok) {
                      const rawJson = (await rawRes.json()) as { raw?: string };
                      const rawBuf = decodeGmailBase64UrlToBuffer(rawJson.raw ?? "");
                      const embeddedPdf = extractEmbeddedPdfFromMimeMessage(rawBuf);
                      if (embeddedPdf?.length) {
                        let pdfText = "";
                        if (pdfTextExtractFn) {
                          try {
                            pdfText = await pdfTextExtractFn(embeddedPdf);
                            pdfText = normalizeExtractedInvoiceText(String(pdfText).replace(/\s+\n/g, "\n"));
                          } catch (rawPdfErr) {
                            console.warn("[Email Parse] Raw MIME PDF extract failed:", rawPdfErr);
                          }
                        }
                        if (pdfText.length >= minPdfTextChars || isUsefulExtractedPdfText(pdfText)) {
                          attachmentBestCandidate = chooseBetterEmailInvoiceCandidate(
                            attachmentBestCandidate,
                            fallbackParseEmailInvoiceFromText(pdfText, input.subject, {
                              headerFrom,
                              headerDate,
                            }),
                          );
                          pdfTextBlocks.push(`[PDF text: raw MIME fallback]\n${pdfText.slice(0, 4500)}`);
                        }
                      }
                    }
                  } catch (rawMimeErr) {
                    console.warn("[Email Parse] Raw MIME fallback fetch failed:", rawMimeErr);
                  }
                }

                if (!attachmentBestCandidate && /mercadona/i.test(String(input.subject ?? ""))) {
                  console.warn(
                    `[Email Parse][Mercadona] no structured candidate from attachments. imageOcrBlocks=${imageOcrBlocks.length} pdfTextBlocks=${pdfTextBlocks.length} pdfAttachments=${pdfAttachments.length} payloadMime=${String(detail.payload?.mimeType ?? "")}`,
                  );
                  if (isMercadonaSubject && detail.payload) {
                    const partTreeSummary: string[] = [];
                    collectGmailPartTree(detail.payload, partTreeSummary);
                    console.warn(
                      `[Email Parse][Mercadona] gmail part tree:\n${partTreeSummary.join("\n")}`,
                    );
                  }
                }

                if (imageOcrBlocks.length > 0 || pdfTextBlocks.length > 0 || pdfAttachments.length > 0) {
                  attachmentAugmentedText =
                    `\n\nAttachment context:\n` +
                    (imageOcrBlocks.length > 0 ? `${imageOcrBlocks.join("\n\n")}\n` : "") +
                    (pdfTextBlocks.length > 0 ? `${pdfTextBlocks.join("\n\n")}\n` : "") +
                    (pdfAttachments.length > 0 && pdfTextBlocks.length === 0
                      ? `[PDF attachments found but text could not be extracted]: ${pdfAttachments.map((p) => p.filename).join(", ")}\n`
                      : "");
                }
              }
            } catch (attErr) {
              console.warn("[Email Parse] Attachment OCR augmentation failed:", attErr);
            }
          }

          const mergedEmailContent = `${input.emailText}${attachmentAugmentedText}`;
          const response = await invokeLLM({
            messages: [
              {
                role: "user",
                content: `${EMAIL_PARSE_PROMPT}\n\nEmail Subject: ${input.subject ?? ""}\n\nEmail Content:\n${mergedEmailContent}`,
              },
            ],
          });

          const rawContent = response.choices?.[0]?.message?.content;
          const text = extractLlmMessageText(rawContent).trim();
          if (!text) {
            return mergeMercadonaSubjectHints(
              mergeEmailInvoiceCandidates(
                fallbackParseEmailInvoiceFromText(mergedEmailContent, input.subject, {
                  headerFrom,
                  headerDate,
                }),
                attachmentBestCandidate,
              ),
              input.subject,
            );
          }
          const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          let rawParsed: Record<string, unknown>;
          try {
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;
            rawParsed = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch (parseErr) {
            console.warn("[Email Parse] LLM JSON parse failed, using regex fallback:", parseErr);
            return mergeMercadonaSubjectHints(
              mergeEmailInvoiceCandidates(
                fallbackParseEmailInvoiceFromText(mergedEmailContent, input.subject, {
                  headerFrom,
                  headerDate,
                }),
                attachmentBestCandidate,
              ),
              input.subject,
            );
          }

          const norm = normalizeEmailInvoiceModelFields(rawParsed, { headerFrom, headerDate });
          const llmCandidate: ParsedEmailInvoiceCandidate = {
            invoiceNumber: norm.invoiceNumber,
            vendor: norm.vendor,
            date: norm.dateIso,
            totalAmount: norm.totalAmount,
            ivaAmount: norm.ivaAmount,
            tipAmount: norm.tipAmount,
            category: norm.category,
            subject: input.subject ?? "",
            items: norm.items,
          };
          const mergedCandidate = mergeEmailInvoiceCandidates(llmCandidate, attachmentBestCandidate);
          if (!mergedCandidate.totalAmount || mergedCandidate.totalAmount <= 0 || !mergedCandidate.vendor) {
            return mergeMercadonaSubjectHints(
              mergeEmailInvoiceCandidates(
                fallbackParseEmailInvoiceFromText(mergedEmailContent, input.subject, {
                  headerFrom,
                  headerDate,
                }),
                attachmentBestCandidate,
              ),
              input.subject,
            );
          }

          return mergeMercadonaSubjectHints(mergedCandidate, input.subject);
        } catch (err) {
          console.error("[Email Parse] error:", err);
          return mergeMercadonaSubjectHints(
            mergeEmailInvoiceCandidates(
              fallbackParseEmailInvoiceFromText(`${input.emailText}${attachmentAugmentedText}`, input.subject, {
                headerFrom,
                headerDate,
              }),
              attachmentBestCandidate,
            ),
            input.subject,
          );
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
              /** Gmail message id for fallback hyperlink in Receipt column even when attachment fetch fails. */
              gmailMessageId: z.string().optional(),
              /** When imageUrl is empty, server fetches first PDF or image attachment from this Gmail message. */
              gmailReceiptFetch: z
                .object({
                  userAccessToken: z.string().min(10),
                  messageId: z.string().min(2),
                })
                .optional(),
              tip: z.number().optional(),
              items: z.array(
                z.object({
                  partName: z.string(),
                  quantity: z.number(),
                  unit: z.string(),
                  pricePerUnit: z.number(),
                  total: z.number(),
                  ivaPercent: z.number().optional(),
                  totalIsNet: z.boolean().optional(),
                  lineTotalIsNet: z.boolean().optional(),
                  totalIncludesVat: z.boolean().optional(),
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

        for (const r of rows) {
          if (isInvoiceNumberBlockedFromSheetsExport(String(r.invoiceNumber ?? ""))) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This invoice number cannot be sent to Google Sheets (blocked: company-internal number B56819451 or configured blocklist). Correct the invoice # and export again.",
            });
          }
        }

        const receiptPublicBase = resolvePublicBaseForReceiptImages(publicApiBaseUrl);
        // If Deploy logs never show this line, the server is still running an old bundle (Forge export).
        console.log("[Export] image_pipeline=receipt-plain-url-v1");
        console.log(
          `[Export] Sheets row image: publicBase=${receiptPublicBase ? receiptPublicBase.slice(0, 48) : "MISSING"}`,
        );

        // Get access token using OAuth Refresh Token
        const accessToken = await getGoogleAccessToken();

        // First, ensure header row exists
        // ✅ Column order: Source…Date, then IVA, Base, Tip, Total (€) — Total immediately after Tip.
        const headerValues = [[...MAIN_TRACKER_HEADER_ROW]];

        // Check if sheet exists and has headers
        const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A1:N1")}`;
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
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A1:N1")}?valueInputOption=RAW`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ values: headerValues }),
              }
            );
          } else if ((checkData.values[0]?.length ?? 0) < 14) {
            // Migrate 13-column tracker → add "Meat line items (JSON)" so new rows align.
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A1:N1")}?valueInputOption=RAW`,
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

        const existingUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A:L")}`;
        const existingRes = await fetch(existingUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const existingData = await existingRes.json() as { values?: string[][] };
        const existingRows = existingData.values ?? [];
        const existingMoneyIdx = resolveMainTrackerMoneyColumnIndices(existingRows[0] ?? []);
        const existingInvoicesByNumber = new Set(
          existingRows.slice(1).map((row) => {
            const invoiceNum = normalizeInvoiceNumberKey(row[1] ?? "");
            return invoiceNum;
          }).filter(num => num.length > 0)
        );

        const existingInvoicesByVendorDateAmount = new Set(
          existingRows.slice(1).map((row) => {
            const vendor = row[2] || "";
            const date = row[3] || "";
            const amount = row[existingMoneyIdx.total] ?? "";
            return duplicateRowKey(vendor, String(date), amount);
          }),
        );

        const requestInvoicesByNumber = new Set<string>();
        const requestInvoicesByVendorDateAmount = new Set<string>();
        const duplicateRows = rows
          .map((r, index) => {
            const invoiceNumKey = normalizeInvoiceNumberKey(r.invoiceNumber);
            const key = duplicateRowKey(r.vendor, r.date, r.totalAmount);
            let reason: DuplicateReason | null = null;

            if (invoiceNumKey.length > 0 && existingInvoicesByNumber.has(invoiceNumKey)) {
              reason = "invoice_number";
            } else if (existingInvoicesByVendorDateAmount.has(key)) {
              reason = "vendor_date_amount";
            } else if (invoiceNumKey.length > 0 && requestInvoicesByNumber.has(invoiceNumKey)) {
              reason = "batch_invoice_number";
            } else if (requestInvoicesByVendorDateAmount.has(key)) {
              reason = "batch_vendor_date_amount";
            }

            if (invoiceNumKey.length > 0) {
              requestInvoicesByNumber.add(invoiceNumKey);
            }
            requestInvoicesByVendorDateAmount.add(key);

            return reason
              ? {
                  index,
                  invoiceNumber: r.invoiceNumber,
                  vendor: r.vendor,
                  date: r.date,
                  totalAmount: r.totalAmount,
                  reason,
                }
              : null;
          })
          .filter(
            (
              item,
            ): item is {
              index: number;
              invoiceNumber: string;
              vendor: string;
              date: string;
              totalAmount: number;
              reason: DuplicateReason;
            } => item !== null,
          );

        const duplicateIndexSet = new Set(duplicateRows.map((row) => row.index));
        duplicateRows.forEach((row) => {
          const prefix =
            row.reason === "invoice_number" || row.reason === "batch_invoice_number"
              ? "[Export] Duplicate invoice"
              : "[Export] Duplicate vendor/date/amount";
          console.warn(
            `${prefix}: ${row.invoiceNumber || "(no invoice #)"} | ${row.vendor} | ${row.date} | €${row.totalAmount.toFixed(2)} | ${describeDuplicateReason(row.reason)}`,
          );
        });

        const duplicateSummary = {
          skippedCount: skipDuplicateCheck ? 0 : duplicateRows.length,
          insertedDuplicateCount: skipDuplicateCheck ? duplicateRows.length : 0,
          details: duplicateRows.map((row) => ({
            invoiceNumber: row.invoiceNumber,
            vendor: row.vendor,
            date: row.date,
            totalAmount: row.totalAmount,
            reason: describeDuplicateReason(row.reason),
          })),
        };
        const zeroAmountRows = rows
          .map((row, index) => {
            const numericTotal = Number(row.totalAmount ?? 0);
            if (!Number.isFinite(numericTotal) || numericTotal !== 0) return null;
            return { index };
          })
          .filter((item): item is { index: number } => item !== null);

        // Check for duplicates before appending (skip if skipDuplicateCheck is true)
        const newRows = rows.filter((_, index) => {
          if (skipDuplicateCheck) return true;
          if (duplicateIndexSet.has(index)) {
            return false;
          }
          return true;
        });

        if (newRows.length === 0) {
          /**
           * Receipt detail uses automateSheets: true. When the main row is skipped as duplicate,
           * we still need tracker automation so meat tabs merge `items` from this request (column N
           * on the existing row is often empty). Gmail defers automation client-side; export path
           * must run it here when automateSheets is on.
           */
          if (
            input.automateSheets &&
            rows.length > 0 &&
            rows.some((r) =>
              shouldTriggerMeatTrackerAutomationMerge({
                items: r.items,
                category: r.category,
                vendor: r.vendor,
              }),
            )
          ) {
            try {
              const recentRowsWithItems = rows.map((r) => ({
                invoiceNumber: String(r.invoiceNumber ?? "").trim(),
                vendor: String(r.vendor ?? "").trim(),
                date: String(r.date ?? "").trim(),
                items: Array.isArray(r.items)
                  ? (r.items as Array<{
                      partName: string;
                      quantity: number;
                      unit: string;
                      pricePerUnit: number;
                      total: number;
                    }>)
                  : undefined,
              }));
              await runTrackerSheetsAutomation(
                spreadsheetId,
                sheetName,
                accessToken,
                recentRowsWithItems,
              );
              console.log("[Export] Tracker automation after duplicate-only export (meat / monthly sync).");
            } catch (error) {
              console.error("[Export] Automation after duplicate-only export failed:", error);
            }
          }
          return {
            success: true,
            rowsAdded: 0,
            message: "All invoices are duplicates. No new data added.",
            duplicateSummary,
          };
        }

        // Append data rows with image upload
        const now = new Date().toISOString();
        let receiptImageMissing = false;
        const dataRows = await Promise.all(
          newRows.map(async (r) => {
            // Deployment marker for debugging production freshness.
            console.log(
              `[Export][v2026-04-07-b] gmailMessageId=${Boolean(String(r.gmailMessageId ?? "").trim())} gmailFetch=${Boolean(
                r.gmailReceiptFetch?.messageId,
              )} vendor=${r.vendor}`,
            );
            let imageUrl = r.imageUrl ?? "";
            const userProvidedImage = Boolean(r.imageUrl?.trim());
            const userRequestedGmailAttachment = Boolean(
              r.gmailReceiptFetch?.userAccessToken?.trim() &&
                r.gmailReceiptFetch?.messageId?.trim(),
            );
            const userWantsReceiptCell =
              userProvidedImage ||
              userRequestedGmailAttachment ||
              Boolean(String(r.gmailMessageId ?? "").trim());
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

            // data:/file: → Forge if configured, else in-memory /api/receipt-share
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
                  const buf = Buffer.from(base64Data, "base64");
                  const mime = detectMimeFromBuffer(buf) || mimeFromDataUrl;
                  const base = receiptPublicBase;

                  if (isForgeStorageConfigured()) {
                    const forgeUrl = await uploadReceiptBinaryToForgeIfConfigured(buf, mime, r.vendor);
                    if (forgeUrl) {
                      imageUrl = forgeUrl;
                      console.log(`[Export] Receipt for Sheets (Forge, persistent): ${r.vendor}`);
                    } else {
                      console.log(`[Export] Using /api/receipt-share for ${r.vendor} (Forge did not return a URL).`);
                    }
                  }

                  if (needsPublicReceiptHttpsUrl(imageUrl)) {
                    const token = putReceiptShareImage(buf, mime);
                    if (token && base) {
                      imageUrl = `${base}/api/receipt-share/${token}`;
                      console.log(`[Export] Receipt image for Sheets (/api/receipt-share): ${r.vendor}`);
                    } else if (!base) {
                      console.warn(
                        "[Export] No public API base URL — pass publicApiBaseUrl from the app (getApiBaseUrl) or set PUBLIC_SERVER_URL / RECEIPT_IMAGE_PUBLIC_BASE_URL on the server.",
                      );
                    } else if (!token) {
                      console.warn(
                        `[Export] /api/receipt-share skipped (max 8 MiB per image): ${r.vendor}`,
                      );
                    }
                  }

                  if (!String(imageUrl ?? "").trim()) {
                    console.warn(
                      `[Export] No receipt image URL for ${r.vendor} (check Forge env, /api/receipt-share token, RECEIPT_SHARE_DISK_DIR, or 8 MiB limit).`,
                    );
                  }
                }
              } catch (error) {
                console.error(`[Export] Failed to upload image for ${r.vendor}:`, error);
                imageUrl = "";
              }
              // Leftover data: URLs skip Gmail fallback and exceed Sheets' 50k cell limit — clear so we can fetch attachment.
              if (String(imageUrl ?? "").trim().toLowerCase().startsWith("data:")) {
                console.warn(
                  `[Export] Stripping data URL after upload did not produce HTTPS (${r.vendor}).`,
                );
                imageUrl = "";
              }
            }

            if (
              !String(imageUrl ?? "").trim() &&
              userRequestedGmailAttachment &&
              r.gmailReceiptFetch
            ) {
              try {
                const att = await fetchFirstGmailAttachmentForReceiptExport(
                  r.gmailReceiptFetch.userAccessToken,
                  r.gmailReceiptFetch.messageId,
                );
                if (att?.buffer?.length) {
                  let buf = att.buffer;
                  let mime = att.mime;
                  if (isLikelyHeicOrHeifBuffer(buf)) {
                    try {
                      buf = await heicBufferToJpeg(buf, 0.75);
                      mime = "image/jpeg";
                    } catch (heicErr) {
                      console.warn(
                        `[Export] HEIC→JPEG failed for Gmail attachment (${r.vendor}):`,
                        heicErr,
                      );
                    }
                  }
                  const base = receiptPublicBase;

                  if (isForgeStorageConfigured()) {
                    const forgeUrl = await uploadReceiptBinaryToForgeIfConfigured(buf, mime, r.vendor);
                    if (forgeUrl) {
                      imageUrl = forgeUrl;
                      console.log(`[Export] Gmail attachment → Forge (persistent): ${r.vendor} (${mime})`);
                    } else {
                      console.log(
                        `[Export] Gmail → /api/receipt-share for ${r.vendor} (Forge did not return a URL).`,
                      );
                    }
                  }

                  if (needsPublicReceiptHttpsUrl(imageUrl)) {
                    const token = putReceiptShareImage(buf, mime);
                    if (token && base) {
                      imageUrl = `${base}/api/receipt-share/${token}`;
                      console.log(
                        `[Export] Gmail attachment → receipt-share: ${r.vendor} (${mime})`,
                      );
                    } else if (!token) {
                      console.warn(
                        `[Export] Gmail attachment too large or empty for receipt-share: ${r.vendor} (${mime}, bytes=${buf.length})`,
                      );
                    } else if (!base) {
                      console.warn(
                        "[Export] Gmail attachment skipped — no public API base URL for receipt-share.",
                      );
                    }
                  }
                }
              } catch (gmailAttErr) {
                console.error(
                  `[Export] Gmail attachment fetch failed for ${r.vendor}:`,
                  gmailAttErr,
                );
              }
            }
            
            // Store a real Sheets date so sorting works, then format the display as DD/MM/YYYY.
            const rawDate = String(r.date ?? "").trim();
            let formattedDate = "";
            if (rawDate) {
              const parsedDate = parseInvoiceDateDDMMYYYY(rawDate);
              const yyyy = parsedDate.getFullYear();
              const mm = parsedDate.getMonth() + 1;
              const dd = parsedDate.getDate();
              formattedDate = `=DATE(${yyyy},${mm},${dd})`;
            }

            // L: plain https URL only — never write data:/file: blobs (exceeds Sheets 50k cell limit).
            const rawImg = String(imageUrl ?? "").trim();
            let imageColumnValue = "";
            if (/^https?:\/\//i.test(rawImg)) {
              imageColumnValue = receiptSheetsReceiptUrlCell(rawImg);
            } else if (rawImg.toLowerCase().startsWith("data:") || rawImg.toLowerCase().startsWith("file:")) {
              console.warn(
                `[Export] Skipping non-HTTPS receipt value for sheet cell (${r.vendor}); length=${rawImg.length}`,
              );
            }

            // If attachment fetch/upload failed, still provide the raw Gmail message URL.
            // Sheets auto-links plain https text.
            if (!String(imageColumnValue ?? "").trim()) {
              const safeMsgId = String(
                r.gmailReceiptFetch?.messageId ?? r.gmailMessageId ?? "",
              )
                .replace(/"/g, "")
                .trim();
              if (safeMsgId) {
                const gmailMsgUrl = `https://mail.google.com/mail/u/0/#inbox/${safeMsgId}`;
                imageColumnValue = gmailMsgUrl;
              }
            }

            if (userWantsReceiptCell && !String(imageColumnValue ?? "").trim()) {
              receiptImageMissing = true;
            }

            const meatJson = serializeMeatLineItemsForSheetsCell(
              String(r.category ?? ""),
              String(r.vendor ?? ""),
              r.items,
            );
            const meatCell =
              meatJson.length > 50_000 ? "" : clampStringForSheetsCell(meatJson, "Meat line items (JSON)");

            return [
              r.source?.toLowerCase() === "camera" ? "Camera" : "Email", // A - Source
              clampStringForSheetsCell(r.invoiceNumber, "Invoice #"),
              clampStringForSheetsCell(r.vendor, "Vendor"),
              clampStringForSheetsCell(formattedDate, "Date"),
              r.ivaAmount ?? 0,                                                        // E - IVA (€)
              r.baseAmount != null ? r.baseAmount : r.totalAmount - (r.ivaAmount ?? 0), // F - Base (€)
              r.tip ?? 0,                                                              // G - Tip (€)
              r.totalAmount,                                                           // H - Total (€)
              clampStringForSheetsCell(r.category, "Category"),
              clampStringForSheetsCell(r.currency, "Currency"),
              clampStringForSheetsCell(r.notes ?? "", "Notes"),
              clampStringForSheetsCell(imageColumnValue, "Receipt"),
              clampStringForSheetsCell(now, "Exported At"),
              meatCell,
            ];
          })
        );

        const range = `${sheetName}!A:N`;
        const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
        let appendRes: Response | null = null;
        let appendErrText = "";
        const appendRetryDelaysMs = [0, 1200, 3000];
        for (const delayMs of appendRetryDelaysMs) {
          if (delayMs > 0) {
            console.warn(`[Export] Retrying Sheets append after ${delayMs}ms backoff...`);
            await sleepMs(delayMs);
          }
          appendRes = await fetch(appendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ values: dataRows }),
          });
          if (appendRes.ok) {
            appendErrText = "";
            break;
          }
          appendErrText = await appendRes.text();
          if (!isSheetsWriteQuotaError(appendRes.status, appendErrText)) {
            break;
          }
        }

        if (!appendRes?.ok) {
          console.error("Sheets API error:", appendErrText);
          console.error("Append URL:", appendUrl);
          throw new Error(userFacingMessageFromSheetsApiBody(appendErrText));
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
            await applyDateDisplayFormatToGridRange(
              spreadsheetId,
              accessToken,
              sheetIdForFormat,
              {
                startRowIndex: grid.startRowIndex,
                endRowIndex: grid.endRowIndex,
                startColumnIndex: 3,
                endColumnIndex: 4,
              },
            );
            if (skipDuplicateCheck && duplicateRows.length > 0) {
              const duplicateHighlightRanges = duplicateRows
                .map((row) => {
                  const appendedRowOffset = row.index;
                  const startRowIndex = grid.startRowIndex + appendedRowOffset;
                  const endRowIndex = startRowIndex + 1;
                  if (startRowIndex >= grid.endRowIndex) return null;
                  return {
                    startRowIndex,
                    endRowIndex,
                    startColumnIndex: grid.startColumnIndex,
                    endColumnIndex: grid.endColumnIndex,
                  };
                })
                .filter(
                  (
                    item,
                  ): item is {
                    startRowIndex: number;
                    endRowIndex: number;
                    startColumnIndex: number;
                    endColumnIndex: number;
                  } => item !== null,
                );
              await applyDuplicateHighlightToGridRows(
                spreadsheetId,
                accessToken,
                sheetIdForFormat,
                duplicateHighlightRanges,
              );
            }
            if (zeroAmountRows.length > 0) {
              const zeroAmountHighlightRanges = zeroAmountRows
                .map((row) => {
                  const appendedRowOffset = row.index;
                  const startRowIndex = grid.startRowIndex + appendedRowOffset;
                  const endRowIndex = startRowIndex + 1;
                  if (startRowIndex >= grid.endRowIndex) return null;
                  return {
                    startRowIndex,
                    endRowIndex,
                    startColumnIndex: grid.startColumnIndex,
                    endColumnIndex: grid.endColumnIndex,
                  };
                })
                .filter(
                  (
                    item,
                  ): item is {
                    startRowIndex: number;
                    endRowIndex: number;
                    startColumnIndex: number;
                    endColumnIndex: number;
                  } => item !== null,
                );
              await applyZeroAmountHighlightToGridRows(
                spreadsheetId,
                accessToken,
                sheetIdForFormat,
                zeroAmountHighlightRanges,
              );
            }
          }
        }

        const trackerSheetId = await getSheetIdByTitle(spreadsheetId, sheetName, accessToken);
        if (trackerSheetId != null) {
          const sortRes = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                requests: [
                  {
                    sortRange: {
                      range: {
                        sheetId: trackerSheetId,
                        startRowIndex: 1,
                        startColumnIndex: 0,
                        endColumnIndex: TRACKER_COLUMN_COUNT,
                      },
                      sortSpecs: [
                        {
                          dimensionIndex: 3,
                          sortOrder: "DESCENDING",
                        },
                      ],
                    },
                  },
                ],
              }),
            },
          );
          if (!sortRes.ok) {
            console.warn("[Sheets] Main tracker date sort failed:", await sortRes.text());
          }
        }

        // Automatically trigger sheet automation on every upload
        // Always run automation to keep monthly/quarterly sheets in sync
        if (input.automateSheets) {
          try {
            await runTrackerSheetsAutomation(spreadsheetId, sheetName, accessToken, newRows);
          } catch (error) {
            console.error("❌ Automation failed:", error);
            // Continue anyway - local storage is still updated
            // Don't throw raw error object as it may contain non-serializable types
            console.warn("⚠️  Automation failed but invoice was saved to main sheet. Monthly/quarterly sheets may not be updated.");
          }
        }

        const skippedDupes = duplicateSummary.skippedCount ?? 0;
        const message =
          skippedDupes > 0 && newRows.length > 0
            ? `Added ${newRows.length} row(s); ${skippedDupes} duplicate(s) skipped (already in Sheets).`
            : "Invoice exported successfully";

        return {
          success: true,
          rowsAdded: newRows.length,
          message,
          /** True if the client sent image data but storage upload failed so the sheet row has no image URL */
          receiptImageMissing,
          duplicateSummary,
        };
      }),

    runSheetsAutomation: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
          sheetName: z.string().default(DEFAULT_MAIN_TRACKER_SHEET_NAME),
          recentRows: z
            .array(
              z.object({
                invoiceNumber: z.string(),
                vendor: z.string(),
                date: z.string(),
                items: z
                  .array(
                    z.object({
                      partName: z.string(),
                      quantity: z.number(),
                      unit: z.string(),
                      pricePerUnit: z.number(),
                      total: z.number(),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional()
            .default([]),
        }),
      )
      .mutation(async ({ input }) => {
        const accessToken = await getGoogleAccessToken();
        await runTrackerSheetsAutomation(
          input.spreadsheetId,
          input.sheetName,
          accessToken,
          input.recentRows,
        );
        return {
          success: true,
          message: "Sheets automation completed successfully",
        };
      }),

    /**
     * Rebuild only Meat_Line_Items / Meat_Orders / Meat_Cut_Summary / Meat_Monthly_Summary from the
     * current main tracker. Uses column N JSON and the same merge rules as full automation (no OCR).
     */
    rebuildMeatSheetsFromMainTracker: publicProcedure
      .input(
        z.object({
          spreadsheetId: z.string(),
          sheetName: z.string().default(DEFAULT_MAIN_TRACKER_SHEET_NAME),
        }),
      )
      .mutation(async ({ input }) => {
        const accessToken = await getGoogleAccessToken();
        const invoiceData = await buildAutomationInvoiceDataFromMainTracker(
          input.spreadsheetId,
          input.sheetName,
          accessToken,
          [],
        );
        const { updateMeatSheets, buildMeatLineItems, meatItemsColumnNDiagnostic } = await import(
          "./sheets-automation-vendor-aggregated",
        );
        await updateMeatSheets(accessToken, input.spreadsheetId, invoiceData);
        const meatLines = buildMeatLineItems(invoiceData);
        let meatRebuildHint = "";
        if (meatLines.length === 0) {
          const diagUrl = `https://sheets.googleapis.com/v4/spreadsheets/${input.spreadsheetId}/values/${encodeValuesRange(input.sheetName, "A2:N")}?valueRenderOption=FORMULA`;
          const diagRes = await fetch(diagUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (diagRes.ok) {
            const diagData = (await diagRes.json()) as { values?: unknown[][] };
            const diagRows = diagData.values ?? [];
            const hints = diagRows
              .map((row, i) => {
                const d = meatItemsColumnNDiagnostic(row[13]);
                return d ? `Row ${i + 2} (N열): ${d}` : null;
              })
              .filter(Boolean) as string[];
            if (hints.length > 0) meatRebuildHint = `\n\n${hints.join("\n")}`;
          }
          const excludedForCategory = invoiceData.filter(
            (inv) =>
              hasMeatLineItems(inv.items) &&
              !shouldIncludeInvoiceInMeatLineSheets({
                items: inv.items,
                category: inv.category,
                vendor: inv.vendor,
              }),
          );
          if (excludedForCategory.length > 0) {
            meatRebuildHint += `\n\n${excludedForCategory.length} row(s) have line items in N but are excluded from meat tabs (category must be Meat or vendor Es Cuco / La Portenia).`;
          }
        }
        return {
          success: true,
          trackerInvoiceCount: invoiceData.length,
          meatLineItemCount: meatLines.length,
          message:
            meatLines.length === 0
              ? `No meat line items found. Add valid JSON array in column N (starts with [ ), or re-export from the app.${meatRebuildHint}`
              : `Meat sheets updated: ${meatLines.length} line item row(s) from ${invoiceData.length} tracker row(s).`,
        };
      }),

    // Fetch Gmail: optional user label (read + unread) or legacy keyword search
    fetchGmailInvoices: publicProcedure
      .input(
        z.object({
          accessToken: z.string(),
          maxResults: z.number().min(1).max(100).default(10),
          pageToken: z.string().optional(),
          /** If set, search is only label:"…" (must match Gmail label name). */
          preparingLabelName: z.string().optional(),
          /** If set, exclude this label from fetch results. */
          excludeLabelName: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const { accessToken, maxResults, pageToken, preparingLabelName, excludeLabelName } = input;

        const trimmedLabel = preparingLabelName?.trim() ?? "";
        const trimmedExcludeLabel = excludeLabelName?.trim() ?? "";
        const cacheKey = `${accessToken}|${trimmedLabel.toLowerCase()}|${trimmedExcludeLabel.toLowerCase()}|${maxResults}|${pageToken ?? ""}`;
        const nowMs = Date.now();
        pruneExpiredGmailFetchCache(nowMs);
        const cached = gmailFetchCache.get(cacheKey);
        if (cached && cached.expiresAt > nowMs) {
          return cached.result;
        }
        const inFlight = gmailFetchInflight.get(cacheKey);
        if (inFlight) {
          return inFlight;
        }

        const task = (async (): Promise<GmailFetchResult> => {
        let searchQuery: string;
        if (trimmedLabel) {
          const safe = trimmedLabel.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          searchQuery = `label:"${safe}"`;
        } else {
          searchQuery =
            "subject:(factura OR invoice OR recibo OR receipt OR albarán) has:attachment OR subject:(factura OR invoice OR recibo)";
        }
        if (trimmedExcludeLabel) {
          const safeExclude = trimmedExcludeLabel.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          searchQuery += ` -label:"${safeExclude}"`;
        }
        const query = encodeURIComponent(searchQuery);
        let listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${maxResults}`;
        if (pageToken) listUrl += `&pageToken=${pageToken}`;

        const listRes = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!listRes.ok) {
          const errText = await listRes.text();
          if (/quota.*exceeded|rate.?limit|userRateLimitExceeded/i.test(errText)) {
            throw new TRPCError({
              code: "TOO_MANY_REQUESTS",
              message: "Gmail API quota exceeded. Wait about 60 seconds and try again.",
            });
          }
          throw new Error(`Gmail API error: ${errText}`);
        }

        const listData = await listRes.json() as { messages?: { id: string }[]; nextPageToken?: string };
        const messages = listData.messages ?? [];

        async function fetchOneMessage(msg: { id: string }) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!detailRes.ok) return null;
          const detail = await detailRes.json() as {
            id: string;
            threadId?: string;
            payload?: {
              headers?: { name: string; value: string }[];
              parts?: {
                mimeType?: string;
                filename?: string;
                body?: { data?: string; attachmentId?: string };
                parts?: any[];
              }[];
              mimeType?: string;
              filename?: string;
              body?: { data?: string };
            };
            snippet?: string;
            internalDate?: string;
          };

          const headers = detail.payload?.headers ?? [];
          const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
          const from = headers.find((h) => h.name === "From")?.value ?? "";
          const dateHeader = headers.find((h) => h.name === "Date")?.value ?? "";

          const plainTexts: string[] = [];
          const htmlTexts: string[] = [];
          const attachmentHints: string[] = [];

          const fetchAttachmentTextIfNeeded = async (
            attachmentId: string,
            mimeType: string,
          ): Promise<string> => {
            if (!attachmentId) return "";
            if (!(mimeType === "text/plain" || mimeType === "text/html")) return "";
            const attRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(attachmentId)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            );
            if (!attRes.ok) return "";
            const att = (await attRes.json()) as { data?: string };
            return decodeGmailBase64UrlToUtf8(att.data ?? "");
          };

          const walkParts = async (part: {
            mimeType?: string;
            filename?: string;
            body?: { data?: string; attachmentId?: string };
            parts?: {
              mimeType?: string;
              filename?: string;
              body?: { data?: string; attachmentId?: string };
              parts?: any[];
            }[];
          }) => {
            const mimeType = String(part.mimeType ?? "").toLowerCase();
            const filename = String(part.filename ?? "").trim();
            const bodyData = part.body?.data;
            const attachmentId = part.body?.attachmentId;

            let decoded = bodyData ? decodeGmailBase64UrlToUtf8(bodyData) : "";
            if (!decoded && attachmentId) {
              decoded = await fetchAttachmentTextIfNeeded(attachmentId, mimeType);
            }

            if (mimeType === "text/plain" && decoded) {
              plainTexts.push(decoded);
            } else if (mimeType === "text/html" && decoded) {
              const text = stripHtmlToText(decoded);
              if (text) htmlTexts.push(text);
            }

            if (
              filename &&
              (mimeType.startsWith("application/pdf") ||
                mimeType.startsWith("image/") ||
                mimeType.startsWith("application/octet-stream"))
            ) {
              attachmentHints.push(`Attachment: ${filename} (${mimeType || "file"})`);
            }

            const children = part.parts ?? [];
            for (const child of children) {
              await walkParts(child);
            }
          };

          if (detail.payload) {
            await walkParts(detail.payload);
          }

          let bodyText = [plainTexts.join("\n\n"), htmlTexts.join("\n\n"), attachmentHints.join("\n")]
            .filter((s) => s && s.trim().length > 0)
            .join("\n\n")
            .trim();
          if (!bodyText && detail.payload?.body?.data) {
            bodyText = decodeGmailBase64UrlToUtf8(detail.payload.body.data);
          }
          const snippetText = (detail.snippet ?? "").trim();
          if (!bodyText) {
            bodyText = snippetText;
          } else if (snippetText && !bodyText.includes(snippetText)) {
            bodyText = `${bodyText}\n\nSnippet: ${snippetText}`;
          }

          return {
            id: msg.id,
            threadId: detail.threadId,
            subject,
            from,
            date: dateHeader,
            internalDate: detail.internalDate,
            // Keep enough text for totals/IVA that appear late in HTML invoices (was 6000 → often €0).
            bodyText: bodyText.slice(0, 24_000),
            snippet: detail.snippet ?? "",
          };
        }

        const batchSize = 15;
        const details: NonNullable<Awaited<ReturnType<typeof fetchOneMessage>>>[] = [];
        for (let i = 0; i < messages.length; i += batchSize) {
          const chunk = messages.slice(i, i + batchSize);
          const batch = await Promise.all(chunk.map((msg) => fetchOneMessage(msg)));
          for (const d of batch) {
            if (d) details.push(d);
          }
        }

        const result: GmailFetchResult = {
          messages: details,
          nextPageToken: listData.nextPageToken,
        };
        gmailFetchCache.set(cacheKey, {
          expiresAt: Date.now() + GMAIL_FETCH_CACHE_MS,
          result,
        });
        return result;
        })();

        gmailFetchInflight.set(cacheKey, task);
        try {
          return await task;
        } finally {
          gmailFetchInflight.delete(cacheKey);
        }
      }),

    /** Remove "preparing" label and add "complete" after Sheets export (needs gmail.modify scope). */
    gmailRelabelMessage: publicProcedure
      .input(
        z.object({
          accessToken: z.string(),
          messageId: z.string(),
          threadId: z.string().optional(),
          removeLabelName: z.string().optional(),
          addLabelName: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const { accessToken, messageId, threadId, removeLabelName, addLabelName } = input;
        const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!listRes.ok) {
          throw new Error(`Gmail labels list failed: ${await listRes.text()}`);
        }
        const listJson = (await listRes.json()) as { labels?: { id: string; name: string }[] };
        const labels = listJson.labels?.map((l) => ({ id: l.id, name: l.name })) ?? [];

        const resolveId = (name: string | undefined): string | undefined => {
          const t = name?.trim() ?? "";
          if (!t) return undefined;
          const exact = labels.find((l) => l.name === t);
          if (exact) return exact.id;
          const lower = t.toLowerCase();
          return labels.find((l) => l.name.toLowerCase() === lower)?.id;
        };

        const addLabelIds: string[] = [];
        const removeLabelIds: string[] = [];
        if (addLabelName?.trim()) {
          const id = resolveId(addLabelName);
          if (!id) {
            throw new Error(`Gmail label not found: "${addLabelName.trim()}"`);
          }
          addLabelIds.push(id);
        }
        if (removeLabelName?.trim()) {
          const id = resolveId(removeLabelName);
          if (!id) {
            throw new Error(`Gmail label not found: "${removeLabelName.trim()}"`);
          }
          removeLabelIds.push(id);
        }

        // Gmail rejects requests that add and remove the same label id.
        const addSet = new Set(addLabelIds);
        const dedupedRemoveLabelIds = removeLabelIds.filter((id) => !addSet.has(id));
        if (dedupedRemoveLabelIds.length !== removeLabelIds.length) {
          console.warn(
            `[Gmail] Skipping removeLabel because it resolves to the same label as addLabel. add="${addLabelName ?? ""}" remove="${removeLabelName ?? ""}"`,
          );
        }

        if (addLabelIds.length === 0 && dedupedRemoveLabelIds.length === 0) {
          return { success: true, skipped: true as const };
        }

        const modifyBody = JSON.stringify({ addLabelIds, removeLabelIds: dedupedRemoveLabelIds });
        if (threadId?.trim()) {
          const threadRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}/modify`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: modifyBody,
            },
          );
          if (threadRes.ok) {
            return { success: true, skipped: false as const, scope: "thread" as const };
          }
          const threadErr = await threadRes.text();
          console.warn(`[Gmail] Thread relabel failed, falling back to message modify: ${threadErr}`);

          if (dedupedRemoveLabelIds.length > 0) {
            try {
              const threadGetRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=minimal`,
                {
                  headers: { Authorization: `Bearer ${accessToken}` },
                },
              );
              if (threadGetRes.ok) {
                const threadJson = (await threadGetRes.json()) as {
                  messages?: Array<{ id?: string }>;
                };
                const threadMessageIds = (threadJson.messages ?? [])
                  .map((m) => String(m.id ?? "").trim())
                  .filter(Boolean);
                for (const mid of threadMessageIds) {
                  const removeOnlyRes = await fetch(
                    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}/modify`,
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ addLabelIds: [], removeLabelIds: dedupedRemoveLabelIds }),
                    },
                  );
                  if (!removeOnlyRes.ok) {
                    console.warn(
                      `[Gmail] Thread fallback remove failed for message ${mid}: ${await removeOnlyRes.text()}`,
                    );
                  }
                }
              } else {
                console.warn(`[Gmail] Thread fetch for fallback remove failed: ${await threadGetRes.text()}`);
              }
            } catch (threadFetchErr) {
              console.warn("[Gmail] Thread fallback remove fetch failed:", threadFetchErr);
            }
          }
        }

        const modRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: modifyBody,
          },
        );
        if (!modRes.ok) {
          throw new Error(`Gmail modify failed: ${await modRes.text()}`);
        }
        return { success: true, skipped: false as const, scope: "message" as const };
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
        const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(TRACKER + "!A:N")}`;
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
        const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(TRACKER + "!A:N")}`;
        const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!readRes.ok) throw new Error(`Read failed: ${await readRes.text()}`);
        const readData = await readRes.json() as { values?: string[][] };
        const rows = readData.values ?? [];

        let foundRowIndex = -1;
        let existingImageUrl = "";
        let existingMeatJson = "";
        for (let i = 1; i < rows.length; i++) {
          const rowInvNum = rows[i][1]?.trim() ?? "";
          const rowVendor  = rows[i][2]?.trim() ?? "";
          if (originalInvoiceNumber?.trim() && rowInvNum && rowInvNum === originalInvoiceNumber.trim()) {
            foundRowIndex = i + 1;
            existingImageUrl = rows[i][11] ?? "";
            existingMeatJson = rows[i][13] != null && rows[i][13] !== "" ? String(rows[i][13]) : "";
            break;
          }
          if (!originalInvoiceNumber?.trim() && rowVendor.toLowerCase() === originalVendor.toLowerCase()) {
            foundRowIndex = i + 1;
            existingImageUrl = rows[i][11] ?? "";
            existingMeatJson = rows[i][13] != null && rows[i][13] !== "" ? String(rows[i][13]) : "";
            break;
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
          existingMeatJson,
        ];

        const range = `${TRACKER}!A${foundRowIndex}:N${foundRowIndex}`;
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
          /** Must match server `RESET_ALL_DATA_PASSWORD` or default `2026`. */
          resetPassword: z.string().optional().default(""),
        })
      )
      .mutation(async ({ input }) => {
        /** When unset, default is 2026 so reset is never allowed with an empty password. */
        const required =
          process.env.RESET_ALL_DATA_PASSWORD?.trim() || "2026";
        const got = input.resetPassword?.trim() ?? "";
        if (got !== required) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Reset is protected: wrong or missing password.",
          });
        }
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
            range: `'${mainSheetName}'!A2:N`,
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
        const meatSheets = [
          "Meat_Line_Items",
          "Meat_Orders",
          "Meat_Cut_Summary",
          "Meat_Monthly_Summary",
          "Meat_Monthly",
          "Meat_Quarterly",
          "Meat_Analysis",
          "Meat_Detail",
        ];
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
