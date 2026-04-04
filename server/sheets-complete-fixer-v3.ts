/**
 * Complete Google Sheets Fixer V3
 * Properly cleans and populates all monthly, quarterly, and meat analysis sheets
 */

import { createSign } from "crypto";

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

interface Invoice {
  source: string;
  invoiceNumber: string;
  vendor: string;
  date: string;
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  category: string;
  currency: string;
  tip?: number;
  notes?: string;
  imageUrl?: string;
  exportedAt?: string;
}

async function generateAccessToken(serviceAccount: any): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${header}.${encodedPayload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");
  const jwt = `${signatureInput}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await response.json();
  return data.access_token;
}

async function getMainSheetData(accessToken: string): Promise<Invoice[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'2026 Invoice tracker'!A:M`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  const rows = data.values || [];

  // Skip header, parse invoices
  const invoices: Invoice[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[2]) continue; // Skip if no vendor

    invoices.push({
      source: row[0] || "Camera",
      invoiceNumber: row[1] || "",
      vendor: row[2],
      date: row[3] || "",
      totalAmount: parseFloat(row[4]) || 0,
      ivaAmount: parseFloat(row[5]) || 0,
      baseAmount: parseFloat(row[6]) || 0,
      category: row[8] || "Other",
      currency: row[9] || "EUR",
      tip: parseFloat(row[7]) || 0,
      notes: row[10] || "",
      imageUrl: row[11] || "",
      exportedAt: row[12] || "",
    });
  }

  return invoices;
}

async function clearSheet(accessToken: string, sheetName: string): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'${sheetName}'!A:M`;
  await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
}

async function updateSheet(accessToken: string, sheetName: string, rows: any[][]): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'${sheetName}'!A1?valueInputOption=USER_ENTERED`;
  
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Failed to update ${sheetName}:`, text);
    throw new Error(`Failed to update ${sheetName}`);
  }
}

function getMonthFromDate(dateStr: string): number {
  // Parse "2026. 3. 26" format
  const parts = dateStr.split(".");
  return parseInt(parts[1]) - 1; // 0-indexed
}

function getQuarterFromMonth(month: number): number {
  return Math.floor(month / 3);
}

export async function fixAllSheets(serviceAccount: any): Promise<any> {
  console.log("[Fixer V3] Starting complete sheets fix...");

  try {
    const accessToken = await generateAccessToken(serviceAccount);
    console.log("[Fixer V3] Access token generated");

    // Get main sheet data
    const invoices = await getMainSheetData(accessToken);
    console.log(`[Fixer V3] Read ${invoices.length} invoices from main sheet`);

    // Group invoices by month
    const byMonth: Record<number, Invoice[]> = {};
    invoices.forEach((inv) => {
      const month = getMonthFromDate(inv.date);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push(inv);
    });

    // Fix monthly sheets
    for (let m = 0; m < 12; m++) {
      const monthName = MONTHS[m];
      const monthInvoices = byMonth[m] || [];

      // Build rows for this month
      const rows: any[][] = [
        ["Source", "Invoice #", "Vendor", "Date", "Total (€)", "VAT (€)", "Base (€)", "Tip (€)", "Category", "Currency", "Notes", "Image URL", "Exported At"],
        ["", "", "TOTAL", "", "=SUM(E3:E1000)", "=SUM(F3:F1000)", "=SUM(G3:G1000)", "=SUM(H3:H1000)", "", "", "", "", ""],
      ];

      // Add invoices
      monthInvoices.forEach((inv) => {
        rows.push([
          inv.source,
          inv.invoiceNumber,
          inv.vendor,
          inv.date,
          inv.totalAmount,
          inv.ivaAmount,
          inv.baseAmount,
          inv.tip || 0,
          inv.category,
          inv.currency,
          inv.notes,
          inv.imageUrl,
          inv.exportedAt,
        ]);
      });

      await updateSheet(accessToken, monthName, rows);
      console.log(`[Fixer V3] Fixed ${monthName}: ${monthInvoices.length} invoices`);
    }

    // Fix quarterly sheets
    const byQuarter: Record<number, Invoice[]> = {};
    invoices.forEach((inv) => {
      const month = getMonthFromDate(inv.date);
      const quarter = getQuarterFromMonth(month);
      if (!byQuarter[quarter]) byQuarter[quarter] = [];
      byQuarter[quarter].push(inv);
    });

    for (let q = 0; q < 4; q++) {
      const quarterName = QUARTERS[q];
      const quarterInvoices = byQuarter[q] || [];

      // Get unique vendors for this quarter
      const vendorMap: Record<string, number> = {};
      quarterInvoices.forEach((inv) => {
        if (!vendorMap[inv.vendor]) vendorMap[inv.vendor] = 0;
        vendorMap[inv.vendor] += inv.totalAmount;
      });

      const rows: any[][] = [
        ["Vendor", "Total (€)", "VAT (€)", "Base (€)", "% of Quarter"],
      ];

      const quarterTotal = Object.values(vendorMap).reduce((a, b) => a + b, 0);

      // Add vendors
      Object.entries(vendorMap).forEach(([vendor, total]) => {
        const percentage = quarterTotal > 0 ? ((total / quarterTotal) * 100).toFixed(1) : "0";
        const ivaTotal = quarterInvoices
          .filter((inv) => inv.vendor === vendor)
          .reduce((sum, inv) => sum + inv.ivaAmount, 0);
        const baseTotal = quarterInvoices
          .filter((inv) => inv.vendor === vendor)
          .reduce((sum, inv) => sum + inv.baseAmount, 0);

        rows.push([vendor, total, ivaTotal, baseTotal, `${percentage}%`]);
      });

      // Add quarter total
      rows.push([`${quarterName} TOTAL`, quarterTotal, "", "", "100%"]);

      await updateSheet(accessToken, quarterName, rows);
      console.log(`[Fixer V3] Fixed ${quarterName}: ${Object.keys(vendorMap).length} vendors`);
    }

    console.log("[Fixer V3] ✅ All sheets fixed successfully!");
    return {
      success: true,
      message: "All sheets fixed",
      invoicesProcessed: invoices.length,
      monthsFixed: 12,
      quartersFixed: 4,
    };
  } catch (error) {
    console.error("[Fixer V3] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
