import { canonicalVendorDisplayName } from "./vendor-canonical";

export type InvoiceSource = "camera" | "email";

/** UI / prompts: treat row as meat when the user (or model) set category to Meat. */
export function isMeatCategory(
  category: InvoiceCategory | string | undefined | null,
): boolean {
  return String(category ?? "").trim().toLowerCase() === "meat";
}

/**
 * True when vendor matches the butcher suppliers we track in meat tabs (La Portenia, Es Cuco),
 * including common OCR / receipt spelling variants (see vendor-canonical).
 */
export function isTrackedMeatSupplierVendor(vendor: string | undefined | null): boolean {
  const c = canonicalVendorDisplayName(String(vendor ?? "").trim());
  return c === "La Portenia" || c === "Es Cuco";
}

/**
 * Structural check: row has a non-empty `items` array (shape used for column N JSON).
 * Does not mean the invoice is meat-related — use {@link shouldIncludeInvoiceInMeatLineSheets} for that.
 */
export function hasMeatLineItems(items: unknown): boolean {
  return Array.isArray(items) && items.length > 0;
}

/**
 * Meat_* sheets and column N should only include line-item JSON when the invoice is meat-related:
 * category Meat, or a known meat supplier (so La Portenia / Es Cuco still work if category is wrong).
 * Stops supermarket / sports-store email line items from filling Meat_Line_Items.
 */
export function shouldIncludeInvoiceInMeatLineSheets(invoice: {
  items?: unknown;
  category?: string | null;
  vendor?: string | null;
}): boolean {
  if (!hasMeatLineItems(invoice.items)) return false;
  return isMeatCategory(invoice.category) || isTrackedMeatSupplierVendor(invoice.vendor);
}

/**
 * When to run tracker automation merges for meat tabs (duplicate-only export, Gmail scheduling, etc.):
 * category Meat (even if items are empty in this payload — column N may exist on Sheets), or
 * meat line items that qualify for meat sheets.
 */
export function shouldTriggerMeatTrackerAutomationMerge(row: {
  items?: unknown;
  category?: string | null;
  vendor?: string | null;
}): boolean {
  if (isMeatCategory(row.category)) return true;
  return shouldIncludeInvoiceInMeatLineSheets(row);
}

/**
 * Spanish albaranes (e.g. Es Cuco) print traceability rows under cuts:
 * "LOTE: 05 EAPV ORIGEN: ESPAÑA" — not a product line; models often duplicate or split amounts onto them.
 */
export function isMeatLotOrigenTraceabilityLine(description: string): boolean {
  const s = String(description ?? "").trim().replace(/\s+/g, " ");
  if (!s) return false;
  const lower = s.toLowerCase();
  if (/\bLOTE\s*:/i.test(s)) return true;
  if (/\bN[ºo°]?\s*\.?\s*lote\b/i.test(s)) return true;
  if (/\bnum(?:ero)?\.?\s*lote\b/i.test(lower)) return true;
  if (/^\s*origen\s*:/i.test(s)) return true;
  if (/\bpa[ií]s\s+de\s+origen\s*:/i.test(s)) return true;
  if (/\btrazabilidad\b/i.test(lower)) return true;
  if (/\blot\s*(?:no\.?|#)?\s*:/i.test(s)) return true;
  return false;
}

export type InvoiceCategory =
  | "Meat"
  | "Mercadona"
  | "Seafood"
  | "Vegetables"
  | "Restaurant"
  | "Gas Station"
  | "Water"
  | "Other"
  | "Asian Market"
  | "Caviar"
  | "Truffle"
  | "Organic Farm"
  | "Beverages"
  | "Hardware Store"
  | string; // Allow custom categories

export interface MeatItem {
  partName: string; // e.g., "Quinta Costilla Angus"
  quantity: number; // in kg
  unit: string; // "kg"
  /** €/kg including VAT when known (P.V.P.); matches line Importe ÷ kg after reconciliation. */
  pricePerUnit: number;
  total: number; // line Importe (incl. VAT)
  /** Line IVA % when printed (e.g. 10 on Spanish albaranes). Used for ex-VAT €/kg in Sheets. */
  ivaPercent?: number;
  /** When true, `total` is base (ex IVA); reconcile grosses up to match main Total (€) column. */
  totalIsNet?: boolean;
  lineTotalIsNet?: boolean;
  totalIncludesVat?: boolean;
}

export interface Invoice {
  id: string;
  source: InvoiceSource;
  invoiceNumber: string;
  vendor: string;
  date: string; // ISO date string
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  currency: string;
  category: InvoiceCategory;
  notes?: string;
  tip?: number; // tip amount (e.g., for restaurants)
  imageUri?: string; // for camera receipts
  emailId?: string; // for email invoices
  emailSubject?: string;
  items?: MeatItem[]; // for meat vendors (La Portenia, Es Cuco)
  exportedToSheets: boolean;
  exportedAt?: string;
  createdAt: string;
}

export interface DashboardStats {
  totalInvoices: number;
  totalAmount: number;
  totalIva: number;
  pendingExport: number;
  thisMonthCount: number;
  thisMonthAmount: number;
}
