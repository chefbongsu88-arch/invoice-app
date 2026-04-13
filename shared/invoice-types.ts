export type InvoiceSource = "camera" | "email";

/** UI / prompts: treat row as meat when the user (or model) set category to Meat. */
export function isMeatCategory(
  category: InvoiceCategory | string | undefined | null,
): boolean {
  return String(category ?? "").trim().toLowerCase() === "meat";
}

/**
 * Meat line-item sheets (N column JSON, Meat_Line_Items, etc.) use this instead of category alone,
 * so La Portenia / Es Cuco rows still aggregate when the model mislabels category (e.g. Restaurant).
 */
export function hasMeatLineItems(items: unknown): boolean {
  return Array.isArray(items) && items.length > 0;
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
  pricePerUnit: number; // price per kg
  total: number; // total price for this item
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
