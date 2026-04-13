/**
 * Invoice numbers that must never be written to Google Sheets (e.g. your own company’s number
 * mis-read from a vendor receipt).
 */

function normalizeInvoiceNumberKeyForBlock(invoiceNumber: string): string {
  return String(invoiceNumber ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/.:]+/g, "");
}

/** Normalized digits/letters that must not appear as the exported invoice # (substring match). */
const DEFAULT_BLOCKED_SUBSTRINGS = ["b56819451"] as const;

/**
 * True if this invoice number must not be exported to the main tracker (exact or contains blocked token).
 * Extra values: set `BLOCKED_INVOICE_NUMBERS_EXPORT` to comma-separated raw numbers (same normalization).
 */
export function isInvoiceNumberBlockedFromSheetsExport(invoiceNumber: string): boolean {
  const key = normalizeInvoiceNumberKeyForBlock(invoiceNumber);
  if (!key) return false;

  for (const sub of DEFAULT_BLOCKED_SUBSTRINGS) {
    if (key.includes(sub)) return true;
  }

  const raw = process.env.BLOCKED_INVOICE_NUMBERS_EXPORT?.trim();
  if (raw) {
    for (const part of raw.split(/[,;|]+/)) {
      const p = normalizeInvoiceNumberKeyForBlock(part);
      if (p.length >= 4 && (key === p || key.includes(p))) return true;
    }
  }

  return false;
}
