/**
 * Google Sheets Auto-Fix System
 * Analyzes January as template and applies structure to all other months
 */

import { encodeValuesRange } from "./sheets-automation";

export interface MonthlySheetTemplate {
  sheetName: string;
  headers: string[];
  totalRowFormulas: {
    [columnLetter: string]: string;
  };
  dataStructure: {
    vendorColumn: number;
    totalColumn: number;
    ivaColumn: number;
    baseColumn: number;
    tipColumn: number;
  };
  issues: string[];
}

/**
 * Fetch sheet data using Google Sheets API
 */
async function getSheetData(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string
): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A:M")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${sheetName}: ${res.statusText}`);
  }

  const data = await res.json() as any;
  return data.values || [];
}

/**
 * Analyze January sheet as template
 */
export async function analyzeJanuaryTemplate(
  spreadsheetId: string,
  accessToken: string
): Promise<MonthlySheetTemplate> {
  console.log("[AutoFix] Analyzing January sheet as template...");

  const rows = await getSheetData(spreadsheetId, "January", accessToken);
  const headers = rows[0] || [];
  const totalRow = rows[1] || [];
  const dataRows = rows.slice(2);

  // Identify column positions
  const vendorColumn = headers.indexOf("Vendor");
  const totalColumn = Math.max(
    headers.indexOf("Total (€) inc IVA"),
    headers.indexOf("Total (€)"),
  );
  const ivaColumn =
    headers.indexOf("VAT (€)") >= 0 ? headers.indexOf("VAT (€)") : headers.indexOf("IVA (€)");
  const baseColumn = headers.indexOf("Base (€)");
  const tipColumn = headers.indexOf("Tip (€)");

  // Extract formulas from total row
  const totalRowFormulas: { [key: string]: string } = {};
  const columnLetters = ["E", "F", "G", "H"]; // Money columns E–H (IVA, Base, Tip, Total when using current header)
  columnLetters.forEach((col, idx) => {
    const cellValue = totalRow[4 + idx];
    if (typeof cellValue === "string" && cellValue.startsWith("=")) {
      totalRowFormulas[col] = cellValue;
    }
  });

  const issues: string[] = [];

  // Check for issues
  if (dataRows.length === 0) {
    issues.push("No data rows found");
  }

  // Check for TOTAL rows in data
  const totalRowsInData = dataRows.filter(
    (row: any) => row[vendorColumn]?.toUpperCase?.()?.includes("TOTAL")
  );
  if (totalRowsInData.length > 0) {
    issues.push(`Found ${totalRowsInData.length} TOTAL rows in data (should be removed)`);
  }

  // Check for duplicates
  const vendors = new Map<string, number>();
  dataRows.forEach((row: any) => {
    const vendor = row[vendorColumn];
    if (vendor) {
      vendors.set(vendor, (vendors.get(vendor) || 0) + 1);
    }
  });

  vendors.forEach((count, vendor) => {
    if (count > 1) {
      issues.push(`Vendor "${vendor}" appears ${count} times (should be aggregated)`);
    }
  });

  console.log("[AutoFix] January template analysis complete");
  console.log("[AutoFix] Headers:", headers);
  console.log("[AutoFix] Total row formulas:", totalRowFormulas);
  console.log("[AutoFix] Issues found:", issues);

  return {
    sheetName: "January",
    headers: headers as string[],
    totalRowFormulas,
    dataStructure: {
      vendorColumn,
      totalColumn,
      ivaColumn,
      baseColumn,
      tipColumn,
    },
    issues,
  };
}

/**
 * Compare other months with January template
 */
export async function compareMonthWithTemplate(
  spreadsheetId: string,
  monthName: string,
  template: MonthlySheetTemplate,
  accessToken: string
): Promise<{
  monthName: string;
  differences: string[];
  issues: string[];
  needsFix: boolean;
}> {
  console.log(`[AutoFix] Comparing ${monthName} with January template...`);

  try {
    const rows = await getSheetData(spreadsheetId, monthName, accessToken);
    const headers = rows[0] || [];
    const totalRow = rows[1] || [];
    const dataRows = rows.slice(2);

    const differences: string[] = [];
    const issues: string[] = [];

    // Check headers
    if (JSON.stringify(headers) !== JSON.stringify(template.headers)) {
      differences.push("Headers don't match January");
      issues.push(`Headers: ${headers.join(", ")}`);
    }

    // Check total row formulas
    const columnLetters = ["E", "F", "G", "H"];
    columnLetters.forEach((col, idx) => {
      const cellValue = totalRow[4 + idx];
      const expectedFormula = template.totalRowFormulas[col];

      if (expectedFormula && cellValue !== expectedFormula) {
        differences.push(`Column ${col} formula doesn't match`);
        issues.push(`Expected: ${expectedFormula}, Got: ${cellValue}`);
      }
    });

    // Check for TOTAL rows in data
    const totalRowsInData = dataRows.filter(
      (row: any) => row[template.dataStructure.vendorColumn]?.toUpperCase?.()?.includes("TOTAL")
    );
    if (totalRowsInData.length > 0) {
      differences.push(`Has ${totalRowsInData.length} TOTAL rows (should be removed)`);
      issues.push("Remove TOTAL rows from data");
    }

    // Check for duplicate vendors
    const vendors = new Map<string, number>();
    dataRows.forEach((row: any) => {
      const vendor = row[template.dataStructure.vendorColumn];
      if (vendor) {
        vendors.set(vendor, (vendors.get(vendor) || 0) + 1);
      }
    });

    vendors.forEach((count, vendor) => {
      if (count > 1) {
        differences.push(`Vendor "${vendor}" appears ${count} times`);
        issues.push(`Aggregate vendor "${vendor}" into single row`);
      }
    });

    const needsFix = differences.length > 0;

    console.log(`[AutoFix] ${monthName} comparison complete`);
    console.log(`[AutoFix] Differences: ${differences.length}`);
    console.log(`[AutoFix] Needs fix: ${needsFix}`);

    return {
      monthName,
      differences,
      issues,
      needsFix,
    };
  } catch (error) {
    console.error(`[AutoFix] Error comparing ${monthName}:`, error);
    return {
      monthName,
      differences: ["Error reading sheet"],
      issues: [error instanceof Error ? error.message : "Unknown error"],
      needsFix: false,
    };
  }
}

/**
 * Generate comprehensive analysis report
 */
export async function generateAutoFixReport(
  spreadsheetId: string,
  accessToken: string
): Promise<{
  template: MonthlySheetTemplate;
  monthComparisons: Array<{
    monthName: string;
    differences: string[];
    issues: string[];
    needsFix: boolean;
  }>;
  summary: {
    totalMonths: number;
    monthsNeedingFix: number;
    recommendations: string[];
  };
}> {
  console.log("[AutoFix] Starting comprehensive auto-fix analysis...");

  // Analyze January as template
  const template = await analyzeJanuaryTemplate(spreadsheetId, accessToken);

  // Compare all other months
  const monthNames = ["February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthComparisons = [];

  for (const monthName of monthNames) {
    const comparison = await compareMonthWithTemplate(spreadsheetId, monthName, template, accessToken);
    monthComparisons.push(comparison);
  }

  // Generate summary
  const monthsNeedingFix = monthComparisons.filter((m) => m.needsFix).length;
  const recommendations: string[] = [
    "1. Remove all TOTAL rows from data sections",
    "2. Aggregate duplicate vendors into single rows with SUMIF",
    "3. Standardize headers across all months",
    "4. Apply January's total row formulas to all months",
    "5. Verify image URLs are present for all invoices",
    "6. Create Q1-Q4 quarterly summary sheets",
  ];

  console.log("[AutoFix] Analysis complete");
  console.log(`[AutoFix] Months needing fix: ${monthsNeedingFix}/${monthNames.length}`);

  return {
    template,
    monthComparisons,
    summary: {
      totalMonths: monthNames.length,
      monthsNeedingFix,
      recommendations,
    },
  };
}
