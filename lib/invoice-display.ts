/**
 * User-facing invoice number label (English).
 * Auto-generated placeholders are not shown as real numbers.
 */
export function displayInvoiceNumber(invoiceNumber: string | undefined | null): string {
  const s = String(invoiceNumber ?? "").trim();
  if (!s) return "No invoice number";
  if (/^AUTO-\d+$/i.test(s) || /^MANUAL-\d+$/i.test(s)) return "No invoice number";
  return s;
}

/** Prefix with # when there is a real number to show */
export function displayInvoiceNumberWithHash(invoiceNumber: string | undefined | null): string {
  const label = displayInvoiceNumber(invoiceNumber);
  return label === "No invoice number" ? label : `#${label}`;
}
