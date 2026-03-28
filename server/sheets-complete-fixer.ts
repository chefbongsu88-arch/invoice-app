/**
 * Complete Google Sheets Fixer
 * Fixes images, standardizes all 12 months, removes duplicates, applies SUMIF
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
 * Get January template structure
 */
async function getJanuaryTemplate(
  spreadsheetId: string,
  accessToken: string
): Promise<{
  headers: string[];
  totalRowFormulas: { [key: string]: string };
}> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/January!A1:M2`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch January template: ${res.statusText}`);
  }

  const data = await res.json() as any;
  const rows = data.values || [];
  const headers = rows[0] || [];
  const totalRow = rows[1] || [];

  const totalRowFormulas: { [key: string]: string } = {};
  ["E", "F", "G", "H"].forEach((col, idx) => {
    const cellValue = totalRow[4 + idx];
    if (typeof cellValue === "string" && cellValue.startsWith("=")) {
      totalRowFormulas[col] = cellValue;
    }
  });

  return { headers, totalRowFormulas };
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
    "E": "E", // Total
    "F": "F", // IVA
    "G": "G", // Base
    "H": "H", // Tip
  };

  const col = columnMap[column];
  if (!col) return "";

  // SUMIFS with date range
  return `=SUMIFS('2026 Invoice tracker'!${col}:${col},'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${dates.start}",'2026 Invoice tracker'!D:D,"<=${dates.end}")`;
}

/**
 * Build total row with formulas
 */
function buildTotalRow(template: { totalRowFormulas: { [key: string]: string } }): any[] {
  return [
    "", // A: Source
    "", // B: Invoice #
    "TOTAL", // C: Vendor
    "", // D: Date
    template.totalRowFormulas["E"] || "=SUM(E3:E1000)", // E: Total
    template.totalRowFormulas["F"] || "=SUM(F3:F1000)", // F: IVA
    template.totalRowFormulas["G"] || "=SUM(G3:G1000)", // G: Base
    template.totalRowFormulas["H"] || "=SUM(H3:H1000)", // H: Tip
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
  template: { headers: string[]; totalRowFormulas: { [key: string]: string } },
  accessToken: string
): Promise<{
  success: boolean;
  month: string;
  vendorCount: number;
  message: string;
}> {
  console.log(`[CompleteFix] Fixing ${monthName}...`);

  try {
    const dates = MONTH_DATES[monthName];
    if (!dates) {
      return { success: false, month: monthName, vendorCount: 0, message: "Invalid month" };
    }

    // Filter invoices for this month
    const monthInvoices = mainSheetData.slice(1).filter((row: any) => {
      const dateStr = row[3]; // Column D: Date
      if (!dateStr) return false;
      const date = new Date(dateStr);
      return date >= new Date(dates.start) && date <= new Date(dates.end);
    });

    console.log(`[CompleteFix] Found ${monthInvoices.length} invoices for ${monthName}`);

    // Aggregate by vendor
    const vendorMap = new Map<string, {
      category: string;
      currency: string;
      imageUrls: string[];
    }>();

    monthInvoices.forEach((row: any) => {
      const vendor = row[2]; // Column C: Vendor
      const category = row[8] || ""; // Column I: Category
      const currency = row[9] || "EUR"; // Column J: Currency
      const imageUrl = row[11] || ""; // Column L: Image URL

      if (vendor) {
        if (!vendorMap.has(vendor)) {
          vendorMap.set(vendor, {
            category,
            currency,
            imageUrls: [],
          });
        }
        const entry = vendorMap.get(vendor)!;
        if (imageUrl) {
          entry.imageUrls.push(imageUrl);
        }
      }
    });

    console.log(`[CompleteFix] Aggregated to ${vendorMap.size} unique vendors`);

    // Build new data rows with SUMIF formulas
    const newDataRows: any[] = [];

    vendorMap.forEach((data, vendor) => {
      const row = [
        "Camera", // A: Source
        "", // B: Invoice #
        vendor, // C: Vendor
        "", // D: Date
        buildSumifFormula(vendor, "E", monthName), // E: Total (SUMIF)
        buildSumifFormula(vendor, "F", monthName), // F: IVA (SUMIF)
        buildSumifFormula(vendor, "G", monthName), // G: Base (SUMIF)
        buildSumifFormula(vendor, "H", monthName), // H: Tip (SUMIF)
        data.category, // I: Category
        data.currency, // J: Currency
        "", // K: Notes
        data.imageUrls[0] || "", // L: Image URL (first image)
        new Date().toISOString(), // M: Exported At
      ];
      newDataRows.push(row);
    });

    // Build complete sheet data
    const completeData = [
      template.headers, // Headers
      buildTotalRow(template), // Total row
      ...newDataRows, // Data rows
    ];

    // Clear and write to sheet
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(monthName)}!A:M`;
    await fetch(clearUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

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

    console.log(`[CompleteFix] Successfully fixed ${monthName}`);

    return {
      success: true,
      month: monthName,
      vendorCount: vendorMap.size,
      message: `Fixed with ${vendorMap.size} vendors`,
    };
  } catch (error) {
    console.error(`[CompleteFix] Error fixing ${monthName}:`, error);
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
  console.log("[CompleteFix] Starting complete Google Sheets fix...");

  try {
    // Step 1: Get main sheet data
    console.log("[CompleteFix] Fetching main sheet data...");
    const mainSheetData = await getMainSheetData(spreadsheetId, accessToken);
    console.log(`[CompleteFix] Found ${mainSheetData.length - 1} total invoices`);

    // Step 2: Get January template
    console.log("[CompleteFix] Analyzing January template...");
    const template = await getJanuaryTemplate(spreadsheetId, accessToken);
    console.log("[CompleteFix] Template headers:", template.headers);

    // Step 3: Fix all 12 months
    const monthResults = [];
    let fixedMonths = 0;
    let totalVendors = 0;

    for (const monthName of MONTH_NAMES) {
      const result = await fixMonthSheet(
        spreadsheetId,
        monthName,
        mainSheetData,
        template,
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

    console.log("[CompleteFix] All fixes complete");

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
    console.error("[CompleteFix] Fatal error:", error);
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
