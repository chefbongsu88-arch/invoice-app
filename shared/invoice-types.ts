export type InvoiceSource = "camera" | "email";

export type InvoiceCategory =
  | "Office Supplies"
  | "Travel & Transport"
  | "Meals & Entertainment"
  | "Utilities"
  | "Professional Services"
  | "Software & Subscriptions"
  | "Equipment"
  | "Marketing"
  | "Other";

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
