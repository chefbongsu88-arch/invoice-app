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
    const monthNum = monthIndex + 1;
    const startDate = `2026-${String(monthNum).padStart(2, "0")}-01`;
    const endDate = `2026-${String(monthNum + 1).padStart(2, "0")}-01`;
    
    await ensureSheetExists(config.spreadsheetId, month, config.accessToken, headers);

    // Filter invoices for this month
    const monthInvoices = config.invoiceData.filter((inv) => {
      const invMonth = getMonthName(inv.date);
      return invMonth === month;
    });

    if (monthInvoices.length === 0) continue;

    // Get unique vendors for this month
    const uniqueVendors = Array.from(new Set(monthInvoices.map((inv) => inv.vendor)));
    
    // Create vendor summary rows with SUMIF formulas
    const summaryRows: (string | number)[][] = [];
    
    for (const vendor of uniqueVendors) {
      // Create row with SUMIF formulas for dynamic calculation
      // Use INDEX/MATCH to get the first matching value for this vendor from the main sheet
      const sourceFormula = `=IFERROR(INDEX('2026 Invoice tracker'!A:A,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const invoiceNumberFormula = `=IFERROR(INDEX('2026 Invoice tracker'!B:B,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const dateFormula = `=IFERROR(INDEX('2026 Invoice tracker'!D:D,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const categoryFormula = `=IFERROR(INDEX('2026 Invoice tracker'!I:I,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const currencyFormula = `=IFERROR(INDEX('2026 Invoice tracker'!J:J,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const notesFormula = `=IFERROR(INDEX('2026 Invoice tracker'!K:K,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const imageUrlFormula = `=IFERROR(INDEX('2026 Invoice tracker'!L:L,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const exportedAtFormula = `=IFERROR(INDEX('2026 Invoice tracker'!M:M,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      
      // SUMIF formulas for aggregation
      const totalFormula = `=SUMIFS('2026 Invoice tracker'!E:E,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      const ivaFormula = `=SUMIFS('2026 Invoice tracker'!F:F,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      const baseFormula = `=SUMIFS('2026 Invoice tracker'!G:G,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      const tipFormula = `=SUMIFS('2026 Invoice tracker'!H:H,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      
      const row = [
        sourceFormula,
        invoiceNumberFormula,
        vendor,
        dateFormula,
        totalFormula,
        ivaFormula,
        baseFormula,
        tipFormula,
        categoryFormula,
        currencyFormula,
        notesFormula,
        imageUrlFormula,
        exportedAtFormula,
      ];
      
      summaryRows.push(row);
    }

    // Add total row
    const totalRowNum = summaryRows.length + 2; // +2 because row 1 is headers, row 2 starts data
    summaryRows.push([
      "",  // No Source for total row
      "",  // No Invoice # for total row
      `${month} TOTAL`,
      "",  // No Date for total row
      `=SUM(E2:E${totalRowNum - 1})`,
      `=SUM(F2:F${totalRowNum - 1})`,
      `=SUM(G2:G${totalRowNum - 1})`,
      `=SUM(H2:H${totalRowNum - 1})`,
      "",  // No Category for total row
      "",  // No Currency for total row
      "",  // No Notes for total row
      "",  // No Image URL for total row
      "",  // No Exported At for total row
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
    "Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Tip (€)", "Category", "Currency", "Notes", "Image URL", "Exported At"
  ];

  for (const quarter of quarters) {
    const monthNums = quarterMonths[quarter];
    const startDate = `2026-${String(monthNums[0]).padStart(2, "0")}-01`;
    const endDate = `2026-${String(monthNums[2] + 1).padStart(2, "0")}-01`;

    await ensureSheetExists(config.spreadsheetId, quarter, config.accessToken, headers);

    // Filter invoices for this quarter
    const quarterInvoices = config.invoiceData.filter((inv) => {
      const invMonth = new Date(inv.date).getMonth() + 1;
      return monthNums.includes(invMonth);
    });

    if (quarterInvoices.length === 0) continue;

    // Get unique vendors for this quarter
    const uniqueVendors = Array.from(new Set(quarterInvoices.map((inv) => inv.vendor)));

    // Create vendor summary rows with SUMIF formulas
    const summaryRows: (string | number)[][] = [];

    for (const vendor of uniqueVendors) {
      const sourceFormula = `=IFERROR(INDEX('2026 Invoice tracker'!A:A,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const invoiceNumberFormula = `=IFERROR(INDEX('2026 Invoice tracker'!B:B,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const dateFormula = `=IFERROR(INDEX('2026 Invoice tracker'!D:D,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const categoryFormula = `=IFERROR(INDEX('2026 Invoice tracker'!I:I,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const currencyFormula = `=IFERROR(INDEX('2026 Invoice tracker'!J:J,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const notesFormula = `=IFERROR(INDEX('2026 Invoice tracker'!K:K,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const imageUrlFormula = `=IFERROR(INDEX('2026 Invoice tracker'!L:L,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;
      const exportedAtFormula = `=IFERROR(INDEX('2026 Invoice tracker'!M:M,MATCH("${vendor}",'2026 Invoice tracker'!C:C,0)),"")`;

      const totalFormula = `=SUMIFS('2026 Invoice tracker'!E:E,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      const ivaFormula = `=SUMIFS('2026 Invoice tracker'!F:F,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      const baseFormula = `=SUMIFS('2026 Invoice tracker'!G:G,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;
      const tipFormula = `=SUMIFS('2026 Invoice tracker'!H:H,'2026 Invoice tracker'!C:C,"${vendor}",'2026 Invoice tracker'!D:D,">=${startDate}",'2026 Invoice tracker'!D:D,"<${endDate}")`;

      const row = [
        sourceFormula,
        invoiceNumberFormula,
        vendor,
        dateFormula,
        totalFormula,
        ivaFormula,
        baseFormula,
        tipFormula,
        categoryFormula,
        currencyFormula,
        notesFormula,
        imageUrlFormula,
        exportedAtFormula,
      ];

      summaryRows.push(row);
    }

    // Add total row
    const totalRowNum = summaryRows.length + 2;
    summaryRows.push([
      "",
      "",
      `${quarter} TOTAL`,
      "",
      `=SUM(E2:E${totalRowNum - 1})`,
      `=SUM(F2:F${totalRowNum - 1})`,
      `=SUM(G2:G${totalRowNum - 1})`,
      `=SUM(H2:H${totalRowNum - 1})`,
      "",
      "",
      "",
      "",
      "",
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

    const uniqueMeatVendors = Array.from(new Set(
      monthInvoices.map((inv) => inv.vendor)
    ));

    const monthTotal = monthInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    for (const vendor of uniqueMeatVendors) {
      const vendorInvoices = monthInvoices.filter((inv) => inv.vendor === vendor);
      const count = vendorInvoices.length;
      const vendorTotal = vendorInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
      const vendorIva = vendorInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
      const vendorBase = vendorInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
      const avgAmount = vendorTotal / count;
      const percentage = ((vendorTotal / monthTotal) * 100).toFixed(1);

      meatMonthlyRows.push([
        month,
        vendor,
        vendorTotal.toFixed(2),
        `${percentage}%`,
        vendorIva.toFixed(2),
        vendorBase.toFixed(2),
        count,
        avgAmount.toFixed(2),
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

  if (allMeatInvoices.length === 0) return;

  const uniqueMeatVendors = Array.from(new Set(allMeatInvoices.map((inv) => inv.vendor)));
  const totalSpending = allMeatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

  const meatAnalysisRows: (string | number)[][] = [];

  for (const vendor of uniqueMeatVendors) {
    const vendorInvoices = allMeatInvoices.filter((inv) => inv.vendor === vendor);
    const count = vendorInvoices.length;
    const vendorTotal = vendorInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const vendorIva = vendorInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
    const vendorBase = vendorInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
    const avgAmount = vendorTotal / count;
    const percentage = ((vendorTotal / totalSpending) * 100).toFixed(1);

    meatAnalysisRows.push([
      vendor,
      vendorTotal.toFixed(2),
      vendorIva.toFixed(2),
      vendorBase.toFixed(2),
      count,
      avgAmount.toFixed(2),
      `${percentage}%`,
    ]);
  }

  if (meatAnalysisRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Analysis", config.accessToken, meatAnalysisRows);
  }
}

/**
 * Create meat detail sheet with cut-level breakdown
 */
export async function createMeatDetailSheet(
  config: SheetAutomationConfig,
  meatVendors: string[] = ["La portenia", "es cuco"]
): Promise<void> {
  const meatDetailHeaders = [
    "Date", "Vendor", "Part Name", "Quantity (kg)", "Price/kg (€)", "Total (€)", "Month"
  ];
  await ensureSheetExists(config.spreadsheetId, "Meat_Detail", config.accessToken, meatDetailHeaders);

  const meatDetailRows: (string | number)[][] = [];

  // Process all invoices with meat items
  for (const invoice of config.invoiceData) {
    // Check if this is a meat vendor and has items
    const isMeatVendor = meatVendors.some((vendor) => invoice.vendor.toLowerCase().includes(vendor.toLowerCase()));
    if (isMeatVendor && invoice.items && invoice.items.length > 0) {
      const monthName = getMonthName(invoice.date);
      
      // Add a row for each meat item
      for (const item of invoice.items) {
        meatDetailRows.push([
          invoice.date,
          invoice.vendor,
          item.partName,
          item.quantity.toFixed(2),
          item.pricePerUnit.toFixed(2),
          item.total.toFixed(2),
          monthName,
        ]);
      }
    }
  }

  if (meatDetailRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Detail", config.accessToken, meatDetailRows);
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

    // Create meat detail sheet with cut-level breakdown
    console.log("Creating meat detail sheet...");
    await createMeatDetailSheet(config, meatVendors);

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
