/**
 * Google Sheets Diagnostic API
 * Analyzes all sheets to identify and fix problems
 * Uses Google Sheets API via fetch (no external googleapis library needed)
 */

import { encodeValuesRange } from "./sheets-automation";

export interface SheetDiagnosis {
  sheetName: string;
  rowCount: number;
  issues: string[];
  structure: {
    headers: string[];
    dataRows: number;
    hasFormulas: boolean;
    duplicateCount: number;
    emptyImageUrls: number;
  };
}

export interface DiagnosisReport {
  spreadsheetId: string;
  totalSheets: number;
  sheets: SheetDiagnosis[];
  problems: string[];
  recommendations: string[];
}

/**
 * Diagnose all sheets in the Google Spreadsheet using fetch API
 */
export async function diagnoseSheetsComprehensive(
  spreadsheetId: string,
  accessToken: string
): Promise<DiagnosisReport> {
  try {
    // Get spreadsheet metadata
    const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    const metadataRes = await fetch(metadataUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metadataRes.ok) {
      throw new Error(`Failed to get spreadsheet metadata: ${metadataRes.statusText}`);
    }

    const spreadsheet = await metadataRes.json() as any;
    const sheetNames = spreadsheet.sheets?.map((s: any) => s.properties?.title).filter(Boolean) as string[];
    
    console.log(`[Diagnosis] Found ${sheetNames.length} sheets:`, sheetNames);

    const diagnosis: SheetDiagnosis[] = [];
    const allProblems: Set<string> = new Set();

    // Analyze each sheet
    for (const sheetName of sheetNames) {
      console.log(`[Diagnosis] Analyzing sheet: ${sheetName}`);

      const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A:M")}`;
      const valuesRes = await fetch(valuesUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!valuesRes.ok) {
        console.warn(`[Diagnosis] Failed to read sheet ${sheetName}`);
        continue;
      }

      const valuesData = await valuesRes.json() as any;
      const rows = valuesData.values || [];
      const headers = rows[0] || [];
      const dataRows = rows.slice(1);

      // Analyze issues
      const issues: string[] = [];
      let duplicateCount = 0;
      let emptyImageUrls = 0;
      let hasFormulas = false;

      // Check for duplicates (Invoice #)
      const invoiceNumbers = new Set<string>();

      dataRows.forEach((row: any, idx: number) => {
        const invoiceNum = row[1]; // Column B
        if (invoiceNum) {
          if (invoiceNumbers.has(invoiceNum)) {
            duplicateCount++;
            issues.push(`Row ${idx + 2}: Duplicate invoice #${invoiceNum}`);
          }
          invoiceNumbers.add(invoiceNum);
        }

        // Check for empty image URLs
        const imageUrl = row[11]; // Column L
        if (!imageUrl || imageUrl.trim() === "") {
          emptyImageUrls++;
        }

        // Check for formulas
        if (typeof row[4] === "string" && (row[4] as string).startsWith("=")) {
          hasFormulas = true;
        }
      });

      if (duplicateCount > 0) {
        issues.push(`Total duplicates: ${duplicateCount}`);
        allProblems.add(`[${sheetName}] Has ${duplicateCount} duplicate invoices`);
      }

      if (emptyImageUrls > 0) {
        issues.push(`Missing image URLs: ${emptyImageUrls}`);
        allProblems.add(`[${sheetName}] Has ${emptyImageUrls} rows without image URLs`);
      }

      // Check for "TOTAL" rows (should be removed)
      const totalRows = dataRows.filter((row: any) => row[2]?.toUpperCase?.()?.includes("TOTAL"));
      if (totalRows.length > 0) {
        issues.push(`Found ${totalRows.length} TOTAL rows (should be removed)`);
        allProblems.add(`[${sheetName}] Has ${totalRows.length} TOTAL rows that should be removed`);
      }

      // Check for duplicate amounts
      const vendorAmounts = new Map<string, number[]>();
      dataRows.forEach((row: any) => {
        const vendor = row[2]; // Column C
        const amount = parseFloat(row[4]); // Column E
        if (vendor && !isNaN(amount)) {
          if (!vendorAmounts.has(vendor)) {
            vendorAmounts.set(vendor, []);
          }
          vendorAmounts.get(vendor)!.push(amount);
        }
      });

      // Check if same vendor appears multiple times with same amount
      vendorAmounts.forEach((amounts: number[], vendor: string) => {
        const duplicateAmounts = amounts.filter((a, i) => amounts.indexOf(a) !== i);
        if (duplicateAmounts.length > 0) {
          issues.push(`Vendor "${vendor}" has duplicate amounts: ${duplicateAmounts.join(", ")}`);
          allProblems.add(`[${sheetName}] Vendor "${vendor}" has duplicate amounts`);
        }
      });

      diagnosis.push({
        sheetName,
        rowCount: rows.length,
        issues,
        structure: {
          headers: headers as string[],
          dataRows: dataRows.length,
          hasFormulas,
          duplicateCount,
          emptyImageUrls,
        },
      });
    }

    // Generate recommendations
    const recommendations: string[] = [
      "1. Remove all TOTAL rows from monthly sheets",
      "2. Remove duplicate invoices from all sheets",
      "3. Fix image URL generation to prevent folder paths",
      "4. Standardize all monthly sheets to match January-March structure",
      "5. Create SUMIF formulas for vendor aggregation",
      "6. Create Q1-Q4 quarterly summary sheets",
      "7. Organize Meat_Detail sheet by vendor and cut",
    ];

    return {
      spreadsheetId,
      totalSheets: sheetNames.length,
      sheets: diagnosis,
      problems: Array.from(allProblems),
      recommendations,
    };
  } catch (error) {
    console.error("[Diagnosis] Error:", error);
    throw error;
  }
}

/**
 * Get detailed analysis of a specific sheet
 */
export async function analyzeSheetStructure(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string
): Promise<{
  headers: string[];
  data: string[][];
  summary: {
    totalRows: number;
    uniqueVendors: string[];
    totalAmount: number;
    issues: string[];
  };
}> {
  try {
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, "A:M")}`;
    const valuesRes = await fetch(valuesUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!valuesRes.ok) {
      throw new Error(`Failed to read sheet: ${valuesRes.statusText}`);
    }

    const valuesData = await valuesRes.json() as any;
    const rows = valuesData.values || [];
    const headers = rows[0] || [];
    const data = rows.slice(1);

    // Calculate summary
    const vendors = new Set<string>();
    let totalAmount = 0;
    const issues: string[] = [];

    data.forEach((row: any) => {
      const vendor = row[2];
      const amount = parseFloat(row[4]);

      if (vendor) vendors.add(vendor);
      if (!isNaN(amount)) totalAmount += amount;
    });

    return {
      headers: headers as string[],
      data: data as string[][],
      summary: {
        totalRows: data.length,
        uniqueVendors: Array.from(vendors),
        totalAmount,
        issues,
      },
    };
  } catch (error) {
    console.error("[Analyze] Error:", error);
    throw error;
  }
}
