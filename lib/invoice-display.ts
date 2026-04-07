const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize stored invoice date: empty or invalid → today (ISO). */
export function coerceInvoiceDateIsoForStorage(raw: string | undefined | null): string {
  const t = String(raw ?? "").trim();
  if (ISO_DATE_RE.test(t)) {
    const d = new Date(`${t}T12:00:00`);
    if (!Number.isNaN(d.getTime())) return t;
  }
  return new Date().toISOString().split("T")[0];
}

/** Long label for detail screens (e.g. receipt detail). */
export function formatInvoiceDateLongEn(iso: string | undefined | null): string {
  const t = String(iso ?? "").trim();
  if (!ISO_DATE_RE.test(t)) return "Date unavailable";
  const d = new Date(`${t}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "Date unavailable";
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

/** Short label for list rows. */
export function formatInvoiceDateShortEn(iso: string | undefined | null): string {
  const t = String(iso ?? "").trim();
  if (!ISO_DATE_RE.test(t)) return "Date unavailable";
  const d = new Date(`${t}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "Date unavailable";
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

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
