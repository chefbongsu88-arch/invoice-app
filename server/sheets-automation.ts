/**
 * Google Sheets Automation Module
 * Handles monthly, quarterly, and meat-specific sheet creation and management
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
 * Create monthly sheets (January - December)
 */
export async function createMonthlySheets(
  config: SheetAutomationConfig
): Promise<void> {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const headers = [
    "Date", "Invoice #", "Vendor", "Total (€)", "IVA (€)", "Base (€)",
    "Category", "Tip (€)", "Notes", "Image URL", "Exported At"
  ];

  for (const month of months) {
    await ensureSheetExists(config.spreadsheetId, month, config.accessToken, headers);

    // Filter invoices for this month
    const monthInvoices = config.invoiceData.filter((inv) => {
      const invMonth = getMonthName(inv.date);
      return invMonth === month;
    });

    // Sort by date
    monthInvoices.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Format data rows
    const rows = monthInvoices.map((inv) => [
      inv.date,
      inv.invoiceNumber,
      inv.vendor,
      inv.totalAmount,
      inv.ivaAmount,
      inv.baseAmount,
      inv.category,
      inv.tip ?? 0,
      inv.notes ?? "",
      inv.imageUrl ?? "",
      new Date().toISOString(),
    ]);

    if (rows.length > 0) {
      await appendToSheet(config.spreadsheetId, month, config.accessToken, rows);
    }
  }
}

/**
 * Create quarterly summary sheets (Q1 - Q4)
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
    "Vendor", "Total (€)", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)"
  ];

  for (const quarter of quarters) {
    await ensureSheetExists(config.spreadsheetId, quarter, config.accessToken, headers);

    // Filter invoices for this quarter
    const quarterInvoices = config.invoiceData.filter((inv) => {
      const date = new Date(inv.date);
      const month = date.getMonth() + 1;
      return quarterMonths[quarter].includes(month);
    });

    // Group by vendor and calculate totals
    const vendorTotals: Record<string, {
      total: number;
      iva: number;
      base: number;
      count: number;
    }> = {};

    quarterInvoices.forEach((inv) => {
      if (!vendorTotals[inv.vendor]) {
        vendorTotals[inv.vendor] = { total: 0, iva: 0, base: 0, count: 0 };
      }
      vendorTotals[inv.vendor].total += inv.totalAmount;
      vendorTotals[inv.vendor].iva += inv.ivaAmount;
      vendorTotals[inv.vendor].base += inv.baseAmount;
      vendorTotals[inv.vendor].count += 1;
    });

    // Format data rows
    const rows = Object.entries(vendorTotals).map(([vendor, data]) => [
      vendor,
      data.total.toFixed(2),
      data.iva.toFixed(2),
      data.base.toFixed(2),
      data.count,
      (data.total / data.count).toFixed(2),
    ]);

    // Add quarter total row
    const quarterTotal = quarterInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const quarterIva = quarterInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
    const quarterBase = quarterInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
    rows.push([
      `${quarter} Total`,
      quarterTotal.toFixed(2),
      quarterIva.toFixed(2),
      quarterBase.toFixed(2),
      quarterInvoices.length,
      (quarterTotal / quarterInvoices.length).toFixed(2),
    ]);

    if (rows.length > 0) {
      await appendToSheet(config.spreadsheetId, quarter, config.accessToken, rows);
    }
  }
}

/**
 * Create meat-specific tracking sheets
 */
export async function createMeatTrackingSheets(
  config: SheetAutomationConfig,
  meatVendors: string[] = ["La portenia", "es cuco"]
): Promise<void> {
  // Meat_Monthly sheet
  const meatMonthlyHeaders = [
    "Month", "Vendor", "Total (€)", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)"
  ];
  await ensureSheetExists(config.spreadsheetId, "Meat_Monthly", config.accessToken, meatMonthlyHeaders);

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const meatMonthlyRows: (string | number)[][] = [];

  for (const month of months) {
    const monthInvoices = config.invoiceData.filter((inv) => {
      const invMonth = getMonthName(inv.date);
      return invMonth === month && meatVendors.includes(inv.vendor);
    });

    if (monthInvoices.length === 0) continue;

    const vendorTotals: Record<string, {
      total: number;
      iva: number;
      base: number;
      count: number;
    }> = {};

    monthInvoices.forEach((inv) => {
      if (!vendorTotals[inv.vendor]) {
        vendorTotals[inv.vendor] = { total: 0, iva: 0, base: 0, count: 0 };
      }
      vendorTotals[inv.vendor].total += inv.totalAmount;
      vendorTotals[inv.vendor].iva += inv.ivaAmount;
      vendorTotals[inv.vendor].base += inv.baseAmount;
      vendorTotals[inv.vendor].count += 1;
    });

    Object.entries(vendorTotals).forEach(([vendor, data]) => {
      meatMonthlyRows.push([
        month,
        vendor,
        data.total.toFixed(2),
        data.iva.toFixed(2),
        data.base.toFixed(2),
        data.count,
        (data.total / data.count).toFixed(2),
      ]);
    });
  }

  if (meatMonthlyRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Monthly", config.accessToken, meatMonthlyRows);
  }

  // Meat_Quarterly sheet
  const meatQuarterlyHeaders = [
    "Quarter", "Vendor", "Total (€)", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)"
  ];
  await ensureSheetExists(config.spreadsheetId, "Meat_Quarterly", config.accessToken, meatQuarterlyHeaders);

  const quarters = ["Q1", "Q2", "Q3", "Q4"];
  const quarterMonths: Record<string, number[]> = {
    Q1: [1, 2, 3],
    Q2: [4, 5, 6],
    Q3: [7, 8, 9],
    Q4: [10, 11, 12],
  };

  const meatQuarterlyRows: (string | number)[][] = [];

  for (const quarter of quarters) {
    const quarterInvoices = config.invoiceData.filter((inv) => {
      const date = new Date(inv.date);
      const month = date.getMonth() + 1;
      return quarterMonths[quarter].includes(month) && meatVendors.includes(inv.vendor);
    });

    if (quarterInvoices.length === 0) continue;

    const vendorTotals: Record<string, {
      total: number;
      iva: number;
      base: number;
      count: number;
    }> = {};

    quarterInvoices.forEach((inv) => {
      if (!vendorTotals[inv.vendor]) {
        vendorTotals[inv.vendor] = { total: 0, iva: 0, base: 0, count: 0 };
      }
      vendorTotals[inv.vendor].total += inv.totalAmount;
      vendorTotals[inv.vendor].iva += inv.ivaAmount;
      vendorTotals[inv.vendor].base += inv.baseAmount;
      vendorTotals[inv.vendor].count += 1;
    });

    Object.entries(vendorTotals).forEach(([vendor, data]) => {
      meatQuarterlyRows.push([
        quarter,
        vendor,
        data.total.toFixed(2),
        data.iva.toFixed(2),
        data.base.toFixed(2),
        data.count,
        (data.total / data.count).toFixed(2),
      ]);
    });
  }

  if (meatQuarterlyRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Quarterly", config.accessToken, meatQuarterlyRows);
  }

  // Meat_Analysis sheet
  const meatAnalysisHeaders = [
    "Metric", "Value"
  ];
  await ensureSheetExists(config.spreadsheetId, "Meat_Analysis", config.accessToken, meatAnalysisHeaders);

  const allMeatInvoices = config.invoiceData.filter((inv) =>
    meatVendors.includes(inv.vendor)
  );

  const totalMeat = allMeatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalMeatIva = allMeatInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalMeatBase = allMeatInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const totalMeatCount = allMeatInvoices.length;
  const avgMeatAmount = totalMeatCount > 0 ? totalMeat / totalMeatCount : 0;
  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = totalSpending > 0 ? (totalMeat / totalSpending * 100).toFixed(2) : 0;

  const meatAnalysisRows = [
    ["Annual Total (€)", totalMeat.toFixed(2)],
    ["Annual IVA (€)", totalMeatIva.toFixed(2)],
    ["Annual Base (€)", totalMeatBase.toFixed(2)],
    ["Total Purchases", totalMeatCount],
    ["Average per Purchase (€)", avgMeatAmount.toFixed(2)],
    ["% of Total Spending", `${meatPercentage}%`],
    ["Monthly Average (€)", (totalMeat / 12).toFixed(2)],
  ];

  if (meatAnalysisRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Meat_Analysis", config.accessToken, meatAnalysisRows);
  }
}

/**
 * Create dashboard sheet with overall statistics
 */
export async function createDashboardSheet(
  config: SheetAutomationConfig,
  meatVendors: string[] = ["La portenia", "es cuco"]
): Promise<void> {
  const dashboardHeaders = ["Metric", "Value"];
  await ensureSheetExists(config.spreadsheetId, "Dashboard", config.accessToken, dashboardHeaders);

  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalIva = config.invoiceData.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalBase = config.invoiceData.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const totalInvoices = config.invoiceData.length;
  const avgAmount = totalInvoices > 0 ? totalSpending / totalInvoices : 0;

  const meatInvoices = config.invoiceData.filter((inv) => meatVendors.includes(inv.vendor));
  const meatSpending = meatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = totalSpending > 0 ? (meatSpending / totalSpending * 100).toFixed(2) : 0;

  const dashboardRows = [
    ["=== OVERALL STATISTICS ===", ""],
    ["Total Spending (€)", totalSpending.toFixed(2)],
    ["Total IVA (€)", totalIva.toFixed(2)],
    ["Total Base (€)", totalBase.toFixed(2)],
    ["Total Invoices", totalInvoices],
    ["Average per Invoice (€)", avgAmount.toFixed(2)],
    ["", ""],
    ["=== MEAT TRACKING (La portenia + es cuco) ===", ""],
    ["Meat Total (€)", meatSpending.toFixed(2)],
    ["Meat % of Total", `${meatPercentage}%`],
    ["Meat Invoices", meatInvoices.length],
    ["Meat Average (€)", meatInvoices.length > 0 ? (meatSpending / meatInvoices.length).toFixed(2) : "0"],
  ];

  if (dashboardRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Dashboard", config.accessToken, dashboardRows);
  }
}

/**
 * Main function to orchestrate all sheet creation
 */
export async function automateGoogleSheets(
  config: SheetAutomationConfig,
  meatVendors?: string[]
): Promise<void> {
  try {
    console.log("Starting Google Sheets automation...");

    // Create monthly sheets
    console.log("Creating monthly sheets...");
    await createMonthlySheets(config);

    // Create quarterly summary sheets
    console.log("Creating quarterly summary sheets...");
    await createQuarterlySummarySheets(config);

    // Create meat tracking sheets
    console.log("Creating meat tracking sheets...");
    await createMeatTrackingSheets(config, meatVendors);

    // Create dashboard sheet
    console.log("Creating dashboard sheet...");
    await createDashboardSheet(config, meatVendors);

    console.log("Google Sheets automation completed successfully!");
  } catch (error) {
    console.error("Error during Google Sheets automation:", error);
    throw error;
  }
}
