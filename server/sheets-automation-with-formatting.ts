/**
 * Fixed Google Sheets Automation Module WITH FORMATTING
 * Uses simple SUMIF formulas (no date ranges) to prevent corruption
 * Applies currency formatting to ensure consistent display
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
  const date = new Date(dateStr);
  return date.getFullYear();
}

/**
 * Clear all content from a sheet
 */
async function clearSheet(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string
): Promise<boolean> {
  try {
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:Z?valueInputOption=RAW`;
    const clearRes = await fetch(clearUrl, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
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
 * Update sheet with values
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
 * Apply currency formatting to specific columns
 * Columns E, F, G, H (Total, IVA, Base, Tip) should be formatted as currency
 */
async function applyCurrencyFormatting(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
  lastRow: number
): Promise<boolean> {
  try {
    // Get sheet ID
    const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    const sheetsRes = await fetch(sheetsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const sheetsData = (await sheetsRes.json()) as any;
    const sheet = sheetsData.sheets.find((s: any) => s.properties.title === sheetName);
    if (!sheet) {
      console.warn(`Sheet ${sheetName} not found for formatting`);
      return false;
    }
    const sheetId = sheet.properties.sheetId;

    // Format columns E, F, G, H (indices 4, 5, 6, 7) as currency
    const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const batchRes = await fetch(batchUpdateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: lastRow,
                startColumnIndex: 4,
                endColumnIndex: 8, // Columns E-H
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "CURRENCY",
                    pattern: '"€"#,##0.00',
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          },
        ],
      }),
    });

    if (!batchRes.ok) {
      console.error(`Failed to apply formatting to ${sheetName}:`, batchRes.statusText);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error applying formatting to ${sheetName}:`, error);
    return false;
  }
}

/**
 * Create monthly sheets with SIMPLE SUMIF formulas and proper formatting
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

    // Build new sheet content with TOTAL at Row 2
    const sheetRows: (string | number)[][] = [headers];

    // Add TOTAL row at Row 2 (before data rows)
    // This will be updated with SUM formula after we add data rows
    const totalRowIndex = 1;  // Row 2 (0-indexed)
    sheetRows.push([
      "",  // Source
      "",  // Invoice #
      `${month} TOTAL`,
      "",  // Date
      "=SUM(E3:E1000)",  // Total - will sum all data rows
      "=SUM(F3:F1000)",  // IVA
      "=SUM(G3:G1000)",  // Base
      "=SUM(H3:H1000)",  // Tip
      "",  // Category
      "",  // Currency
      "",  // Notes
      "",  // Image URL
      "",  // Exported At
    ]);

    // Add all invoice data rows (not just vendor summaries)
    for (const invoice of monthInvoices) {
      const row = [
        invoice.source || "",
        invoice.invoiceNumber || "",
        invoice.vendor,
        invoice.date,
        invoice.totalAmount,
        invoice.ivaAmount,
        invoice.baseAmount,
        invoice.tip || 0,
        invoice.category || "",
        invoice.currency || "EUR",
        invoice.notes || "",
        invoice.imageUrl || "",
        "",  // Exported At
      ];
      sheetRows.push(row);
    }

    // Clear and replace sheet content
    await clearSheet(config.spreadsheetId, month, config.accessToken);
    await updateSheet(config.spreadsheetId, month, config.accessToken, sheetRows);
    
    console.log(`✅ Updated ${month} sheet: Header + TOTAL + ${monthInvoices.length} invoices`);
    
    // Apply currency formatting
    await applyCurrencyFormatting(config.spreadsheetId, month, config.accessToken, sheetRows.length);
    

  }
}

/**
 * Create quarterly summary sheets with SIMPLE SUMIF formulas and proper formatting
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

    // Build new sheet content with TOTAL at Row 2
    const sheetRows: (string | number)[][] = [headers];

    // Add TOTAL row at Row 2 (before data rows)
    sheetRows.push([
      "",  // Source
      "",  // Invoice #
      `${quarter} TOTAL`,
      "",  // Date
      "=SUM(E3:E1000)",  // Total - will sum all data rows
      "=SUM(F3:F1000)",  // IVA
      "=SUM(G3:G1000)",  // Base
      "=SUM(H3:H1000)",  // Tip
      "",  // Category
      "",  // Currency
      "",  // Notes
      "",  // Image URL
      "",  // Exported At
    ]);

    // Add all invoice data rows
    for (const invoice of quarterInvoices) {
      const row = [
        invoice.source || "",
        invoice.invoiceNumber || "",
        invoice.vendor,
        invoice.date,
        invoice.totalAmount,
        invoice.ivaAmount,
        invoice.baseAmount,
        invoice.tip || 0,
        invoice.category || "",
        invoice.currency || "EUR",
        invoice.notes || "",
        invoice.imageUrl || "",
        "",  // Exported At
      ];
      sheetRows.push(row);
    }

    // Clear and replace sheet content
    await clearSheet(config.spreadsheetId, quarter, config.accessToken);
    await updateSheet(config.spreadsheetId, quarter, config.accessToken, sheetRows);
    
    // Apply currency formatting
    await applyCurrencyFormatting(config.spreadsheetId, quarter, config.accessToken, sheetRows.length);
    
    console.log(`✅ Updated ${quarter} sheet: Header + TOTAL + ${quarterInvoices.length} invoices`);
  }
}

/**
 * Main automation function
 */
export async function automateGoogleSheets(
  config: SheetAutomationConfig,
  ignoredVendors?: string[]
): Promise<void> {
  console.log("[Automation] Starting monthly and quarterly sheet generation...");
  
  try {
    // Create monthly sheets
    await createMonthlySheets(config);
    
    // Create quarterly sheets
    await createQuarterlySummarySheets(config);
    
    console.log("[Automation] ✅ All sheets updated successfully with formatting!");
  } catch (error) {
    console.error("[Automation] Error during automation:", error);
    throw error;
  }
}
