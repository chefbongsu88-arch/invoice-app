/**
 * Complete Google Sheets Fixer V2
 * Properly fixes all monthly sheets to match January template structure
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const MONTH_DATES: { [key: string]: { start: string; end: string } } = {
  "January": { start: "2026-01-01", end: "2026-01-31" },
  "February": { start: "2026-02-01", end: "2026-02-28" },
  "March": { start: "2026-03-01", end: "2026-03-31" },
  "April": { start: "2026-04-01", end: "2026-04-30" },
  "May": { start: "2026-05-01", end: "2026-05-31" },
  "June": { start: "2026-06-01", end: "2026-06-30" },
  "July": { start: "2026-07-01", end: "2026-07-31" },
  "August": { start: "2026-08-01", end: "2026-08-31" },
  "September": { start: "2026-09-01", end: "2026-09-30" },
  "October": { start: "2026-10-01", end: "2026-10-31" },
  "November": { start: "2026-11-01", end: "2026-11-30" },
  "December": { start: "2026-12-01", end: "2026-12-31" },
};

/**
 * Fetch all data from main sheet
 */
async function getMainSheetData(
  spreadsheetId: string,
  accessToken: string
): Promise<any[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'2026 Invoice tracker'!A:M`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch main sheet: ${res.statusText}`);
  }

  const data = await res.json() as any;
  return data.values || [];
}

/**
 * Get unique vendors for a month
 */
function getVendorsForMonth(
  mainSheetData: any[][],
  monthName: string
): Set<string> {
  const dates = MONTH_DATES[monthName];
  if (!dates) return new Set();

  const vendors = new Set<string>();
  
  mainSheetData.slice(1).forEach((row: any) => {
    const dateStr = row[3]; // Column D: Date
    const vendor = row[2]; // Column C: Vendor
    
    if (!dateStr || !vendor) return;
    
    // Parse date - handle both "2026-03-26" and "2026. 3. 26" formats
    let date: Date;
    if (dateStr.includes('.')) {
      // Format: "2026. 3. 26"
      const parts = dateStr.split('.').map((p: string) => p.trim());
      date = new Date(`${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`);
    } else {
      date = new Date(dateStr);
    }
    
    const startDate = new Date(dates.start);
    const endDate = new Date(dates.end);
    
    if (date >= startDate && date <= endDate) {
      vendors.add(vendor);
    }
  });

  return vendors;
}

/**
 * Build SUMIF formula for a vendor in a specific month
 */
function buildSumifFormula(
  vendor: string,
  column: string,
  monthName: string
): string {
  const dates = MONTH_DATES[monthName];
  if (!dates) return "";

  const columnMap: { [key: string]: string } = {
    "E": "E", // IVA
    "F": "F", // Base
    "G": "G", // Tip
    "H": "H", // Total
  };

  const col = columnMap[column];
  if (!col) return "";

  // Escape vendor name for formula
  const escapedVendor = vendor.replace(/"/g, '""');

  // SUMIFS with date range
  return `=SUMIFS('2026 Invoice tracker'!${col}:${col},'2026 Invoice tracker'!C:C,"${escapedVendor}",'2026 Invoice tracker'!D:D,">=${dates.start}",'2026 Invoice tracker'!D:D,"<=${dates.end}")`;
}

/**
 * Build total row with SUM formulas
 */
function buildTotalRow(lastRow: number): any[] {
  return [
    "", // A: Source
    "", // B: Invoice #
    "TOTAL", // C: Vendor
    "", // D: Date
    `=SUM(E3:E${lastRow})`, // E: IVA
    `=SUM(F3:F${lastRow})`, // F: Base
    `=SUM(G3:G${lastRow})`, // G: Tip
    `=SUM(H3:H${lastRow})`, // H: Total
    "", // I: Category
    "", // J: Currency
    "", // K: Notes
    "", // L: Image URL
    "", // M: Exported At
  ];
}

/**
 * Fix a single month sheet
 */
async function fixMonthSheet(
  spreadsheetId: string,
  monthName: string,
  mainSheetData: any[][],
  accessToken: string
): Promise<{
  success: boolean;
  month: string;
  vendorCount: number;
  message: string;
}> {
  console.log(`[FixV2] Fixing ${monthName}...`);

  try {
    // Get unique vendors for this month
    const vendors = getVendorsForMonth(mainSheetData, monthName);
    console.log(`[FixV2] Found ${vendors.size} unique vendors for ${monthName}`);

    // Build headers
    const headers = [
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
      "Image URL",
      "Exported At",
    ];

    // Build data rows with SUMIF formulas
    const dataRows: any[] = [];
    vendors.forEach((vendor) => {
      const row = [
        "", // A: Source
        "", // B: Invoice #
        vendor, // C: Vendor
        "", // D: Date
        buildSumifFormula(vendor, "E", monthName), // E: IVA (SUMIF)
        buildSumifFormula(vendor, "F", monthName), // F: Base (SUMIF)
        buildSumifFormula(vendor, "G", monthName), // G: Tip (SUMIF)
        buildSumifFormula(vendor, "H", monthName), // H: Total (SUMIF)
        "", // I: Category
        "", // J: Currency
        "", // K: Notes
        "", // L: Image URL
        "", // M: Exported At
      ];
      dataRows.push(row);
    });

    // Build complete sheet data
    const lastDataRow = 2 + dataRows.length;
    const completeData = [
      headers, // Row 1: Headers
      buildTotalRow(lastDataRow), // Row 2: Total row
      ...dataRows, // Row 3+: Data rows
    ];

    console.log(`[FixV2] Built ${completeData.length} rows for ${monthName}`);

    // Clear sheet first
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(monthName)}!A:M`;
    await fetch(clearUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Write new data
    const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(monthName)}!A1?valueInputOption=RAW`;
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
      const errorData = await writeRes.json();
      throw new Error(`Failed to write data: ${writeRes.statusText} - ${JSON.stringify(errorData)}`);
    }

    console.log(`[FixV2] Successfully fixed ${monthName}`);

    return {
      success: true,
      month: monthName,
      vendorCount: vendors.size,
      message: `Fixed with ${vendors.size} vendors`,
    };
  } catch (error) {
    console.error(`[FixV2] Error fixing ${monthName}:`, error);
    return {
      success: false,
      month: monthName,
      vendorCount: 0,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Execute complete fix for all 12 months
 */
export async function executeCompleteSheetsFix(
  spreadsheetId: string,
  accessToken: string
): Promise<{
  success: boolean;
  summary: {
    totalMonths: number;
    fixedMonths: number;
    totalVendors: number;
    issues: string[];
  };
  monthResults: Array<{
    month: string;
    success: boolean;
    vendorCount: number;
    message: string;
  }>;
}> {
  console.log("[FixV2] Starting complete Google Sheets fix V2...");

  try {
    // Step 1: Get main sheet data
    console.log("[FixV2] Fetching main sheet data...");
    const mainSheetData = await getMainSheetData(spreadsheetId, accessToken);
    console.log(`[FixV2] Found ${mainSheetData.length - 1} total invoices`);

    // Step 2: Fix all 12 months
    const monthResults = [];
    let fixedMonths = 0;
    let totalVendors = 0;

    for (const monthName of MONTH_NAMES) {
      const result = await fixMonthSheet(
        spreadsheetId,
        monthName,
        mainSheetData,
        accessToken
      );
      monthResults.push(result);

      if (result.success) {
        fixedMonths++;
        totalVendors += result.vendorCount;
      }

      // Add delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log("[FixV2] All fixes complete");

    const issues: string[] = [];
    monthResults.forEach((result) => {
      if (!result.success) {
        issues.push(`${result.month}: ${result.message}`);
      }
    });

    return {
      success: fixedMonths === MONTH_NAMES.length,
      summary: {
        totalMonths: MONTH_NAMES.length,
        fixedMonths,
        totalVendors,
        issues,
      },
      monthResults,
    };
  } catch (error) {
    console.error("[FixV2] Fatal error:", error);
    return {
      success: false,
      summary: {
        totalMonths: MONTH_NAMES.length,
        fixedMonths: 0,
        totalVendors: 0,
        issues: [error instanceof Error ? error.message : "Unknown error"],
      },
      monthResults: [],
    };
  }
}
