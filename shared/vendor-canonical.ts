/**
 * Normalize vendor names that appear differently on receipts (OCR / print variants)
 * so Sheets and meat tabs group under one label. Heuristics match duplicate-key bucketing.
 */
export function canonicalVendorDisplayName(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  const compact = t.toLowerCase().replace(/[\s'".,;:()_-]+/g, "");

  if (compact.includes("porteni") || compact.includes("rapolteni") || compact.includes("lapolteni")) {
    return "La Portenia";
  }
  if (compact.includes("cuco") || compact.includes("coco") || compact.includes("escoco")) {
    return "Es Cuco";
  }
  if (compact.includes("mercadona")) {
    return "Mercadona S.A.";
  }

  return t;
}
