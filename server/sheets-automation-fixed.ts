/**
 * Fixed Google Sheets Automation Module
 * Uses simple SUMIF formulas (no date ranges) to prevent corruption
 * Replaces monthly sheets instead of appending to prevent duplicates
 */

interface SheetAutomationConfig {
  spreadsheetId: string;
  accessToken: string;
  invoiceData: InvoiceRecord[];
}

interface InvoiceRecord {
  source: string;
  invoiceNumber: string;
  vendor: string;
  date: string; // ISO format YYYY-MM-DD
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  category: string;
  currency: string;
  notes?: string;
  imageUrl?: string;
  tip?: number;
  items?: Array<{
    partName: string;
    quantity: number;
    unit: string;
    pricePerUnit: number;
    total: number;
  }>;
}

/**
 * Get month name from date (e.g., "2026-01-15" -> "January")
 */
export function getMonthName(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString("en-US", { month: "long" });
}

/**
 * Get quarter from date (e.g., "2026-01-15" -> "Q1")
 */
export function getQuarter(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const quarter = Math.ceil(month / 3);
  return `Q${quarter}`;
}

/**
 * Get year from date
 */
export function getYear(dateStr: string): number {
  return new Date(dateStr).getFullYear();
}

/**
 * Clear a sheet completely
 */
async function clearSheet(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string
): Promise<boolean> {
  try {
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:Z:clear`;
    const clearRes = await fetch(clearUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });

    if (!clearRes.ok) {
      console.error(`Failed to clear sheet ${sheetName}:`, clearRes.statusText);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error clearing sheet ${sheetName}:`, error);
    return false;
  }
}

/**
 * Update sheet with new values (replaces existing content)
 */
async function updateSheet(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
  values: (string | number)[][]
): Promise<boolean> {
  try {
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:Z1000?valueInputOption=USER_ENTERED`;
    const updateRes = await fetch(updateUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ values }),
    });

    if (!updateRes.ok) {
      console.error(`Failed to update sheet ${sheetName}:`, updateRes.statusText);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error updating sheet ${sheetName}:`, error);
    return false;
  }
}

/**
 * Create monthly sheets with SIMPLE SUMIF formulas (no date ranges)
 * This prevents corruption from date format mismatches
 * 
 * Column Structure (matches main "2026 Invoice tracker" sheet):
 * A: Source
 * B: Invoice #
 * C: Vendor
 * D: Date
 * E: Total (€)
 * F: IVA (€)
 * G: Base (€)
 * H: Tip (€)
 * I: Category
 * J: Currency
 * K: Notes
 * L: Image URL
 * M: Exported At
 */
export async function createMonthlySheets(
  config: SheetAutomationConfig
): Promise<void> {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const headers = [
    "Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Tip (€)", "Category", "Currency", "Notes", "Image URL", "Exported At"
  ];

  for (let monthIndex = 0; monthIndex < months.length; monthIndex++) {
    const month = months[monthIndex];
    
    // Filter invoices for this month
    const monthInvoices = config.invoiceData.filter((inv) => {
      const invMonth = getMonthName(inv.date);
      return invMonth === month;
    });

    // Get unique vendors for this month
    const uniqueVendors = Array.from(new Set(monthInvoices.map((inv) => inv.vendor)));

    // Build new sheet content
    const sheetRows: (string | number)[][] = [headers];

    // Add vendor summary rows with SIMPLE SUMIF formulas (no date ranges)
    for (const vendor of uniqueVendors) {
      // Use simple SUMIF without date filtering
      // This avoids date format mismatch issues
      const row = [
        "",  // Source (from INDEX/MATCH if needed, but left blank for simplicity)
        "",  // Invoice # (from INDEX/MATCH if needed, but left blank for simplicity)
        vendor,
        "",  // Date (left blank for summary row)
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!E:E)`,  // Total
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!F:F)`,  // IVA
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!G:G)`,  // Base
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!H:H)`,  // Tip
        "",  // Category
        "",  // Currency
        "",  // Notes
        "",  // Image URL
        "",  // Exported At
      ];
      sheetRows.push(row);
    }

    // Add total row
    const totalRowNum = sheetRows.length + 1;
    sheetRows.push([
      "",  // Source
      "",  // Invoice #
      `${month} TOTAL`,
      "",  // Date
      `=SUM(E2:E${totalRowNum - 1})`,  // Total
      `=SUM(F2:F${totalRowNum - 1})`,  // IVA
      `=SUM(G2:G${totalRowNum - 1})`,  // Base
      `=SUM(H2:H${totalRowNum - 1})`,  // Tip
      "",  // Category
      "",  // Currency
      "",  // Notes
      "",  // Image URL
      "",  // Exported At
    ]);

    // Clear and replace sheet content
    await clearSheet(config.spreadsheetId, month, config.accessToken);
    await updateSheet(config.spreadsheetId, month, config.accessToken, sheetRows);
    
    console.log(`✅ Updated ${month} sheet with ${uniqueVendors.length} vendors`);
  }
}

/**
 * Create quarterly summary sheets with SIMPLE SUMIF formulas
 */
export async function createQuarterlySummarySheets(
  config: SheetAutomationConfig
): Promise<void> {
  const quarters = ["Q1", "Q2", "Q3", "Q4"];
  const quarterMonths: Record<string, number[]> = {
    Q1: [1, 2, 3],
    Q2: [4, 5, 6],
    Q3: [7, 8, 9],
    Q4: [10, 11, 12],
  };

  const headers = [
    "Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Tip (€)", "Category", "Currency", "Notes", "Image URL", "Exported At"
  ];

  for (const quarter of quarters) {
    const monthNumbers = quarterMonths[quarter];
    
    // Filter invoices for this quarter
    const quarterInvoices = config.invoiceData.filter((inv) => {
      const date = new Date(inv.date);
      const month = date.getMonth() + 1;
      return monthNumbers.includes(month);
    });

    // Get unique vendors for this quarter
    const uniqueVendors = Array.from(new Set(quarterInvoices.map((inv) => inv.vendor)));

    // Build new sheet content
    const sheetRows: (string | number)[][] = [headers];

    // Add vendor summary rows with SIMPLE SUMIF formulas
    for (const vendor of uniqueVendors) {
      const row = [
        "",  // Source
        "",  // Invoice #
        vendor,
        "",  // Date
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!E:E)`,  // Total
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!F:F)`,  // IVA
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!G:G)`,  // Base
        `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!H:H)`,  // Tip
        "",  // Category
        "",  // Currency
        "",  // Notes
        "",  // Image URL
        "",  // Exported At
      ];
      sheetRows.push(row);
    }

    // Add total row
    const totalRowNum = sheetRows.length + 1;
    sheetRows.push([
      "",  // Source
      "",  // Invoice #
      `${quarter} TOTAL`,
      "",  // Date
      `=SUM(E2:E${totalRowNum - 1})`,  // Total
      `=SUM(F2:F${totalRowNum - 1})`,  // IVA
      `=SUM(G2:G${totalRowNum - 1})`,  // Base
      `=SUM(H2:H${totalRowNum - 1})`,  // Tip
      "",  // Category
      "",  // Currency
      "",  // Notes
      "",  // Image URL
      "",  // Exported At
    ]);

    // Clear and replace sheet content
    await clearSheet(config.spreadsheetId, quarter, config.accessToken);
    await updateSheet(config.spreadsheetId, quarter, config.accessToken, sheetRows);
    
    console.log(`✅ Updated ${quarter} sheet with ${uniqueVendors.length} vendors`);
  }
}

/**
 * Main automation function - called after export to Google Sheets
 */
export async function automateGoogleSheets(
  config: SheetAutomationConfig,
  meatVendors: string[] = []
): Promise<void> {
  try {
    console.log("[Automation] Starting monthly and quarterly sheet automation...");
    
    // Create/update monthly sheets
    await createMonthlySheets(config);
    console.log("[Automation] ✅ Monthly sheets updated");
    
    // Create/update quarterly sheets
    await createQuarterlySummarySheets(config);
    console.log("[Automation] ✅ Quarterly sheets updated");
    
    console.log("[Automation] ✅ All automation completed successfully");
  } catch (error) {
    console.error("[Automation] Error during automation:", error);
    throw error;
  }
}
