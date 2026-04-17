/**
 * Main tracker ("2026 Invoice tracker") column names and money-column layout.
 * Preferred order: IVA, Base, Tip, then Total (Total immediately after Tip).
 * Legacy sheets may still have Total, IVA, Base, Tip — use resolveMainTrackerMoneyColumnIndices.
 */

export const MAIN_TRACKER_HEADER_ROW: readonly string[] = [
  "Source",
  "Invoice #",
  "Vendor",
  "Date",
  "IVA (€)",
  "Base (€)",
  "Tip (€)",
  "Total (€)",
  "Category",
  "Currency",
  "Notes",
  "Receipt",
  "Exported At",
  "Meat line items (JSON)",
];

export type MainTrackerMoneyIndices = {
  total: number;
  iva: number;
  base: number;
  tip: number;
};

/** Legacy: E=Total, F=IVA, G=Base, H=Tip */
const LEGACY_MONEY: MainTrackerMoneyIndices = {
  total: 4,
  iva: 5,
  base: 6,
  tip: 7,
};

/** Current: E=IVA, F=Base, G=Tip, H=Total */
const CURRENT_MONEY: MainTrackerMoneyIndices = {
  iva: 4,
  base: 5,
  tip: 6,
  total: 7,
};

/**
 * Map header row (row 1) to Total/IVA/Base/Tip column indices.
 * Supports legacy and IVA-first layouts; falls back to legacy if names missing.
 */
export function resolveMainTrackerMoneyColumnIndices(headerRow: unknown[]): MainTrackerMoneyIndices {
  const h = headerRow.map((x) => String(x ?? "").trim());
  const idx = (name: string) => h.indexOf(name);
  const t = idx("Total (€)");
  const i = idx("IVA (€)");
  const b = idx("Base (€)");
  const tip = idx("Tip (€)");
  if (t >= 0 && i >= 0 && b >= 0 && tip >= 0) {
    return { total: t, iva: i, base: b, tip };
  }
  if (h[4] === "IVA (€)" && h[7] === "Total (€)") return CURRENT_MONEY;
  if (h[4] === "Total (€)" && h[7] === "Tip (€)") return LEGACY_MONEY;
  return LEGACY_MONEY;
}
