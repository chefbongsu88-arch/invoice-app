/**
 * Apply fixes to Google Sheets
 * Standardizes all monthly sheets to match January template
 */

import { resolveMainTrackerMoneyColumnIndices } from "../shared/sheets-tracker-columns";

/**
 * Clear and rebuild a sheet with correct structure
 */
export async function fixMonthlySheet(
  spreadsheetId: string,
  monthName: string,
  accessToken: string,
  januaryTemplate: {
    headers: string[];
    totalRowFormulas: { [key: string]: string };
  }
): Promise<{
  success: boolean;
  message: string;
  rowsFixed: number;
}> {
  console.log(`[Fix] Starting to fix ${monthName} sheet...`);

  try {
    // Step 1: Get all data from main sheet
    const trackerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent("2026 Invoice tracker")}!A1:L`;
    const trackerRes = await fetch(trackerUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!trackerRes.ok) {
      throw new Error(`Failed to fetch main sheet: ${trackerRes.statusText}`);
    }

    const trackerData = await trackerRes.json() as any;
    const allRows = trackerData.values || [];
    const money = resolveMainTrackerMoneyColumnIndices(allRows[0] ?? []);
    const allInvoices = allRows.slice(1);

    // Step 2: Filter invoices for this month
    const monthNumber = getMonthNumber(monthName);
    const monthInvoices = allInvoices.filter((row: any) => {
      const dateStr = row[3]; // Column D: Date
      if (!dateStr) return false;
      const date = new Date(dateStr);
      return date.getMonth() + 1 === monthNumber;
    });

    console.log(`[Fix] Found ${monthInvoices.length} invoices for ${monthName}`);

    // Step 3: Aggregate by vendor using SUMIF
    const vendorMap = new Map<string, { total: number; iva: number; base: number; tip: number }>();

    monthInvoices.forEach((row: any) => {
      const vendor = row[2]; // Column C: Vendor
      const total = parseFloat(row[money.total]) || 0;
      const iva = parseFloat(row[money.iva]) || 0;
      const base = parseFloat(row[money.base]) || 0;
      const tip = parseFloat(row[money.tip]) || 0;

      if (vendor) {
        const existing = vendorMap.get(vendor) || { total: 0, iva: 0, base: 0, tip: 0 };
        vendorMap.set(vendor, {
          total: existing.total + total,
          iva: existing.iva + iva,
          base: existing.base + base,
          tip: existing.tip + tip,
        });
      }
    });

    console.log(`[Fix] Aggregated to ${vendorMap.size} unique vendors`);

    // Step 4: Build new data rows with SUMIF formulas
    const newDataRows: any[] = [];

    vendorMap.forEach((amounts, vendor) => {
      const row = [
        "Camera", // Source
        "", // Invoice # (will use SUMIF)
        vendor, // Vendor
        "", // Date
        `=SUMIFS('2026 Invoice tracker'!E:E,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${monthStart(monthNumber)}",...)`, // IVA - SUMIF
        `=SUMIFS('2026 Invoice tracker'!F:F,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${monthStart(monthNumber)}",...)`, // Base - SUMIF
        `=SUMIFS('2026 Invoice tracker'!G:G,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${monthStart(monthNumber)}",...)`, // Tip - SUMIF
        `=SUMIFS('2026 Invoice tracker'!H:H,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${monthStart(monthNumber)}",...)`, // Total - SUMIF
        monthInvoices.find((r: any) => r[2] === vendor)?.[8] || "Meat", // Category
        "EUR", // Currency
        "", // Notes
        "", // Image URL
        new Date().toISOString(), // Exported At
      ];
      newDataRows.push(row);
    });

    // Step 5: Build complete sheet data
    const completeData = [
      januaryTemplate.headers, // Headers
      buildTotalRow(januaryTemplate.totalRowFormulas), // Total row
      ...newDataRows, // Data rows
    ];

    // Step 6: Clear and write to sheet
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(monthName)}!A:M`;
    const clearRes = await fetch(clearUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!clearRes.ok) {
      console.warn(`[Fix] Warning: Could not clear sheet: ${clearRes.statusText}`);
    }

    // Write new data
    const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(monthName)}!A1`;
    const writeRes = await fetch(writeUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: completeData,
      }),
    });

    if (!writeRes.ok) {
      throw new Error(`Failed to write data: ${writeRes.statusText}`);
    }

    console.log(`[Fix] Successfully fixed ${monthName} sheet`);

    return {
      success: true,
      message: `Fixed ${monthName} with ${vendorMap.size} vendors`,
      rowsFixed: vendorMap.size,
    };
  } catch (error) {
    console.error(`[Fix] Error fixing ${monthName}:`, error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
      rowsFixed: 0,
    };
  }
}

/**
 * Fix all monthly sheets
 */
export async function fixAllMonthlySheets(
  spreadsheetId: string,
  accessToken: string,
  januaryTemplate: {
    headers: string[];
    totalRowFormulas: { [key: string]: string };
  }
): Promise<{
  results: Array<{
    month: string;
    success: boolean;
    message: string;
    rowsFixed: number;
  }>;
  summary: {
    totalMonths: number;
    successfulFixes: number;
    totalRowsFixed: number;
  };
}> {
  console.log("[Fix] Starting to fix all monthly sheets...");

  const monthNames = ["February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const results = [];
  let successfulFixes = 0;
  let totalRowsFixed = 0;

  for (const monthName of monthNames) {
    const result = await fixMonthlySheet(spreadsheetId, monthName, accessToken, januaryTemplate);
    results.push({
      month: monthName,
      ...result,
    });

    if (result.success) {
      successfulFixes++;
      totalRowsFixed += result.rowsFixed;
    }

    // Add delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("[Fix] All fixes complete");

  return {
    results,
    summary: {
      totalMonths: monthNames.length,
      successfulFixes,
      totalRowsFixed,
    },
  };
}

/**
 * Helper: Get month number from name
 */
function getMonthNumber(monthName: string): number {
  const months: { [key: string]: number } = {
    January: 1,
    February: 2,
    March: 3,
    April: 4,
    May: 5,
    June: 6,
    July: 7,
    August: 8,
    September: 9,
    October: 10,
    November: 11,
    December: 12,
  };
  return months[monthName] || 0;
}

/**
 * Helper: Get month start date
 */
function monthStart(monthNumber: number): string {
  return `2026-${String(monthNumber).padStart(2, "0")}-01`;
}

/**
 * Helper: Build total row with formulas
 */
function buildTotalRow(formulas: { [key: string]: string }): any[] {
  return [
    "", // Source
    "", // Invoice #
    "TOTAL", // Vendor
    "", // Date
    formulas["E"] || "=SUM(E3:E100)", // Total
    formulas["F"] || "=SUM(F3:F100)", // IVA
    formulas["G"] || "=SUM(G3:G100)", // Base
    formulas["H"] || "=SUM(H3:H100)", // Tip
    "", // Category
    "", // Currency
    "", // Notes
    "", // Image URL
    "", // Exported At
  ];
}
