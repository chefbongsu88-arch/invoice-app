/**
 * Enhanced Google Sheets Automation Module
 * Handles monthly, quarterly, and meat-specific sheet creation with vendor aggregation and percentages
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
 * Create or update a sheet with headers
 */
export async function ensureSheetExists(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
  headers: string[]
): Promise<boolean> {
  try {
    const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:Z1`;
    const checkRes = await fetch(checkUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!checkRes.ok) {
      // Sheet might not exist, try to create it
      const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
      const createRes = await fetch(batchUpdateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                },
              },
            },
          ],
        }),
      });

      if (!createRes.ok) {
        console.error("Failed to create sheet:", sheetName);
        return false;
      }
    }

    // Add headers if they don't exist
    const checkData = await checkRes.json() as { values?: string[][] };
    if (!checkData.values || checkData.values.length === 0) {
      const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:Z1?valueInputOption=RAW`;
      await fetch(headerUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ values: [headers] }),
      });
    }

    return true;
  } catch (error) {
    console.error("Error ensuring sheet exists:", error);
    return false;
  }
}

/**
 * Append data to a sheet
 */
export async function appendToSheet(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string,
  rows: (string | number)[][]
): Promise<boolean> {
  try {
    const range = `${sheetName}!A:Z`;
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const appendRes = await fetch(appendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ values: rows }),
    });

    if (!appendRes.ok) {
      const errText = await appendRes.text();
      console.error("Append error:", errText);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error appending to sheet:", error);
    return false;
  }
}

/**
 * Create monthly sheets with SUMIF formulas for vendor aggregation
 * 
 * Structure:
 * 1. Vendor Summary Section (unique vendors with SUMIF formulas)
 * 2. Individual Transaction Rows (all transactions from main tracker)
 */
export async function createMonthlySheets(
  config: SheetAutomationConfig
): Promise<void> {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const headers = [
    "Vendor", "Total (€)", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)", "% of Month"
  ];

  for (const month of months) {
    await ensureSheetExists(config.spreadsheetId, month, config.accessToken, headers);

    // Filter invoices for this month
    const monthInvoices = config.invoiceData.filter((inv) => {
      const invMonth = getMonthName(inv.date);
      return invMonth === month;
    });

    if (monthInvoices.length === 0) continue;

    // Get unique vendors for this month
    const uniqueVendors = Array.from(new Set(monthInvoices.map((inv) => inv.vendor)));
    
    // Calculate month total for percentage calculation
    const monthTotal = monthInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    // Create vendor summary rows with SUMIF formulas
    const summaryRows: (string | number)[][] = [];
    
    for (const vendor of uniqueVendors) {
      // Count invoices for this vendor in this month
      const vendorInvoices = monthInvoices.filter((inv) => inv.vendor === vendor);
      const count = vendorInvoices.length;
      
      // Calculate totals from actual data (for reference)
      const vendorTotal = vendorInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
      const vendorIva = vendorInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
      const vendorBase = vendorInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
      const avgAmount = vendorTotal / count;
      const percentage = ((vendorTotal / monthTotal) * 100).toFixed(1);

      // Create row with SUMIF formulas for dynamic calculation
      // Format: Vendor | SUMIF formula for total | SUMIF formula for IVA | etc.
      const row = [
        vendor,
        `=SUMIFS('2026 Invoice tracker'!E:E,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=2026-01-01",'2026 Invoice tracker'!D:D,"<2026-02-01")`,
        `=SUMIFS('2026 Invoice tracker'!F:F,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=2026-01-01",'2026 Invoice tracker'!D:D,"<2026-02-01")`,
        `=SUMIFS('2026 Invoice tracker'!G:G,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=2026-01-01",'2026 Invoice tracker'!D:D,"<2026-02-01")`,
        count,
        avgAmount.toFixed(2),
        `${percentage}%`,
      ];
      
      summaryRows.push(row);
    }

    // Add total row
    summaryRows.push([
      `${month} TOTAL`,
      `=SUM(B2:B${summaryRows.length + 1})`,
      `=SUM(C2:C${summaryRows.length + 1})`,
      `=SUM(D2:D${summaryRows.length + 1})`,
      monthInvoices.length,
      (monthTotal / monthInvoices.length).toFixed(2),
      "100%",
    ]);

    // Append vendor summary rows
    if (summaryRows.length > 0) {
      await appendToSheet(config.spreadsheetId, month, config.accessToken, summaryRows);
    }
  }
}

/**
 * Create quarterly summary sheets by aggregating 3-month data with SUMIF formulas (Q1 - Q4)
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
    "Vendor", "Total (€)", "IVA (€)", "Base (€)", "% of Quarter", "Count", "Avg Amount (€)"
  ];

  for (const quarter of quarters) {
    await ensureSheetExists(config.spreadsheetId, quarter, config.accessToken, headers);

    // Filter invoices for this quarter (3 months)
    const quarterInvoices = config.invoiceData.filter((inv) => {
      const date = new Date(inv.date);
      const month = date.getMonth() + 1;
      return quarterMonths[quarter].includes(month);
    });

    if (quarterInvoices.length === 0) continue;

    // Get unique vendors for this quarter
    const uniqueVendors = Array.from(new Set(quarterInvoices.map((inv) => inv.vendor)));
    
    // Calculate quarter total for percentage calculation
    const quarterTotal = quarterInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    // Create vendor summary rows with SUMIF formulas
    const summaryRows: (string | number)[][] = [];
    
    for (const vendor of uniqueVendors) {
      // Count invoices for this vendor in this quarter
      const vendorInvoices = quarterInvoices.filter((inv) => inv.vendor === vendor);
      const count = vendorInvoices.length;
      
      // Calculate totals from actual data (for reference)
      const vendorTotal = vendorInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
      const vendorIva = vendorInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
      const vendorBase = vendorInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
      const avgAmount = vendorTotal / count;
      const percentage = ((vendorTotal / quarterTotal) * 100).toFixed(1);

      // Get date range for this quarter
      const monthStart = quarterMonths[quarter][0];
      const monthEnd = quarterMonths[quarter][2];
      const startDate = `2026-${String(monthStart).padStart(2, "0")}-01`;
      const endDate = `2026-${String(monthEnd + 1).padStart(2, "0")}-01`;

      // Create row with SUMIF formulas for dynamic calculation
      const row = [
        vendor,
        `=SUMIFS('2026 Invoice tracker'!E:E,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`,
        `=SUMIFS('2026 Invoice tracker'!F:F,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`,
        `=SUMIFS('2026 Invoice tracker'!G:G,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`,
        `${percentage}%`,
        count,
        avgAmount.toFixed(2),
      ];
      
      summaryRows.push(row);
    }

    // Add total row (only one total row at the end)
    summaryRows.push([
      `${quarter} TOTAL`,
      `=SUM(B2:B${summaryRows.length + 1})`,
      `=SUM(C2:C${summaryRows.length + 1})`,
      `=SUM(D2:D${summaryRows.length + 1})`,
      "100%",
      quarterInvoices.length,
      (quarterTotal / quarterInvoices.length).toFixed(2),
    ]);

    if (summaryRows.length > 0) {
      await appendToSheet(config.spreadsheetId, quarter, config.accessToken, summaryRows);
    }
  }
}

/**
 * Create meat-specific tracking sheets with SUMIF formulas for aggregation
 */
export async function createMeatTrackingSheets(
  config: SheetAutomationConfig,
  meatVendors: string[] = ["La portenia", "es cuco"]
): Promise<void> {
  // Meat_Monthly sheet - Monthly breakdown of meat vendors (each vendor 1 row per month)
  const meatMonthlyHeaders = [
    "Month", "Vendor", "Total (€)", "% of Month", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)"
  ];
  await ensureSheetExists(config.spreadsheetId, "Meat_Monthly", config.accessToken, meatMonthlyHeaders);

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const meatMonthlyRows: (string | number)[][] = [];

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const monthNum = monthNumbers[i];
    
    const monthInvoices = config.invoiceData.filter((inv) => 
      getMonthName(inv.date) === month && 
      meatVendors.some((vendor) => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
    );

    if (monthInvoices.length === 0) continue;

    const monthTotal = monthInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    // Get unique meat vendors for this month
    const uniqueVendors = Array.from(new Set(
      monthInvoices.map((inv) => inv.vendor)
    ));

    // Create rows for each vendor with SUMIF formulas
    for (const vendor of uniqueVendors) {
      const vendorInvoices = monthInvoices.filter((inv) => inv.vendor === vendor);
      const count = vendorInvoices.length;
      const vendorTotal = vendorInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
      const percentage = ((vendorTotal / monthTotal) * 100).toFixed(1);
      
      const startDate = `2026-${String(monthNum).padStart(2, "0")}-01`;
      const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
      const endDate = `2026-${String(nextMonth).padStart(2, "0")}-01`;

      meatMonthlyRows.push([
        month,
        vendor,
        `=SUMIFS('2026 Invoice tracker'!E:E,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`,
        `${percentage}%`,
        `=SUMIFS('2026 Invoice tracker'!F:F,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`,
        `=SUMIFS('2026 Invoice tracker'!G:G,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`,
        count,
        (vendorTotal / count).toFixed(2),
      ]);
    }
  }

  if (meatMonthlyRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Monthly", config.accessToken, meatMonthlyRows);
  }

  // Meat_Analysis sheet - Overall meat vendor summary (each vendor 1 row total)
  const meatAnalysisHeaders = [
    "Vendor", "Total (€)", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)", "% of Total"
  ];
  await ensureSheetExists(config.spreadsheetId, "Meat_Analysis", config.accessToken, meatAnalysisHeaders);

  // Get all meat invoices
  const allMeatInvoices = config.invoiceData.filter((inv) =>
    meatVendors.some((vendor) => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
  );

  if (allMeatInvoices.length === 0) {
    return;
  }

  const meatTotal = allMeatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const uniqueMeatVendors = Array.from(new Set(allMeatInvoices.map((inv) => inv.vendor)));

  const meatAnalysisRows: (string | number)[][] = [];

  // Create one row per meat vendor with SUMIF formulas
  for (const vendor of uniqueMeatVendors) {
    const vendorInvoices = allMeatInvoices.filter((inv) => inv.vendor === vendor);
    const count = vendorInvoices.length;
    const vendorTotal = vendorInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const vendorIva = vendorInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
    const vendorBase = vendorInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
    const percentage = ((vendorTotal / meatTotal) * 100).toFixed(1);

    meatAnalysisRows.push([
      vendor,
      `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!E:E)`,
      `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!F:F)`,
      `=SUMIF('2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!G:G)`,
      count,
      (vendorTotal / count).toFixed(2),
      `${percentage}%`,
    ]);
  }

  // Add total row
  meatAnalysisRows.push([
    "MEAT TOTAL",
    `=SUM(B2:B${meatAnalysisRows.length + 1})`,
    `=SUM(C2:C${meatAnalysisRows.length + 1})`,
    `=SUM(D2:D${meatAnalysisRows.length + 1})`,
    allMeatInvoices.length,
    (meatTotal / allMeatInvoices.length).toFixed(2),
    "100%",
  ]);

  if (meatAnalysisRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Analysis", config.accessToken, meatAnalysisRows);
  }
}

/**
 * Create dashboard sheet with key metrics and summaries
 */
export async function createDashboardSheet(
  config: SheetAutomationConfig,
  meatVendors: string[] = ["La portenia", "es cuco"]
): Promise<void> {
  const dashboardHeaders = [
    "Metric", "Value"
  ];
  
  await ensureSheetExists(config.spreadsheetId, "Dashboard", config.accessToken, dashboardHeaders);

  const totalInvoices = config.invoiceData.length;
  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalIva = config.invoiceData.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalBase = config.invoiceData.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const meatSpending = config.invoiceData
    .filter((inv) => meatVendors.some((vendor) => inv.vendor.toLowerCase().includes(vendor.toLowerCase())))
    .reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = ((meatSpending / totalSpending) * 100).toFixed(1);

  const dashboardRows = [
    ["Total Invoices", totalInvoices],
    ["Total Spending (€)", totalSpending.toFixed(2)],
    ["Total IVA (€)", totalIva.toFixed(2)],
    ["Total Base (€)", totalBase.toFixed(2)],
    ["Average per Invoice (€)", (totalSpending / totalInvoices).toFixed(2)],
    ["Meat Spending (€)", meatSpending.toFixed(2)],
    ["Meat % of Total", `${meatPercentage}%`],
  ];

  if (dashboardRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Dashboard", config.accessToken, dashboardRows);
  }
}

/**
 * Main automation function - orchestrates all sheet creation
 */
export async function automateGoogleSheets(
  config: SheetAutomationConfig,
  meatVendors?: string[]
): Promise<void> {
  try {
    console.log("Starting Google Sheets automation...");

    // Create monthly sheets with vendor aggregation
    console.log("Creating monthly sheets with vendor aggregation...");
    await createMonthlySheets(config);
    
    // Vendor totals and percentages are now included in transaction rows

    // Create quarterly summary sheets with percentages
    console.log("Creating quarterly summary sheets with percentages...");
    await createQuarterlySummarySheets(config);

    // Create meat tracking sheets
    console.log("Creating meat tracking sheets...");
    await createMeatTrackingSheets(config, meatVendors);

    // Create dashboard sheet
    console.log("Creating dashboard sheet...");
    await createDashboardSheet(config, meatVendors);

    // Executive_Summary removed - not needed

    console.log("Google Sheets automation completed successfully!");
  } catch (error) {
    console.error("Error during Google Sheets automation:", error);
    throw error;
  }
}


/**
 * Add charts to quarterly sheets for visual representation
 * Creates pie charts showing vendor distribution for each quarter
 */
export async function addChartsToQuarterlySheets(
  spreadsheetId: string,
  accessToken: string,
  invoiceData: InvoiceRecord[]
): Promise<void> {
  const quarters = ["Q1", "Q2", "Q3", "Q4"];
  const quarterMonths: Record<string, number[]> = {
    Q1: [1, 2, 3],
    Q2: [4, 5, 6],
    Q3: [7, 8, 9],
    Q4: [10, 11, 12],
  };

  for (const quarter of quarters) {
    try {
      // Get sheet ID for the quarter
      const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
      const sheetsRes = await fetch(sheetsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!sheetsRes.ok) {
        console.warn(`Failed to get sheet info for ${quarter}`);
        continue;
      }

      const sheetsData = await sheetsRes.json() as { sheets?: Array<{ properties: { sheetId: number; title: string } }> };
      const quarterSheet = sheetsData.sheets?.find((s) => s.properties.title === quarter);

      if (!quarterSheet) {
        console.warn(`Sheet ${quarter} not found`);
        continue;
      }

      const sheetId = quarterSheet.properties.sheetId;

      // Create pie chart request
      const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;

      const chartRequest = {
        requests: [
          {
            addChart: {
              chart: {
                chartType: "PIE_CHART",
                legendPosition: "BOTTOM_LEGEND",
                title: `${quarter} - Vendor Distribution by Spending`,
                pieChart: {
                  dataRange: {
                    sheetId: sheetId,
                    range: `${quarter}!A1:B100`,
                  },
                  series: [
                    {
                      dataRange: {
                        range: `${quarter}!B2:B100`,
                      },
                    },
                  ],
                  pieHole: 0.4, // Donut chart
                },
              },
            },
          },
        ],
      };

      const chartRes = await fetch(batchUpdateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(chartRequest),
      });

      if (!chartRes.ok) {
        console.warn(`Failed to add chart to ${quarter}:`, await chartRes.text());
      } else {
        console.log(`Pie chart added to ${quarter} sheet`);
      }
    } catch (error) {
      console.warn(`Error adding chart to ${quarter}:`, error);
    }
  }
}
