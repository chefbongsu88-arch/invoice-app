export type InvoiceSource = "camera" | "email";

/** Line-item rows (e.g. Meat_Monthly) are only used when the category is meat. */
export function isMeatCategory(
  category: InvoiceCategory | string | undefined | null,
): boolean {
  return String(category ?? "").trim().toLowerCase() === "meat";
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
