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
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

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
 * Create monthly sheets with vendor aggregation (January - December)
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

    if (monthInvoices.length === 0) continue;

    // Sort by date
    monthInvoices.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Format data rows for individual transactions
    const transactionRows = monthInvoices.map((inv) => [
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

    // Add transaction rows first
    if (transactionRows.length > 0) {
      await appendToSheet(config.spreadsheetId, month, config.accessToken, transactionRows);
    }

    // Calculate monthly total
    const monthTotal = monthInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    // Group by vendor and calculate totals (consolidate multiple entries per vendor)
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

    // Build summary section with consolidated vendor data
    const summaryRows: (string | number)[][] = [
      ["", "", "", "", "", "", "", "", "", "", ""],  // Blank row
      ["MONTHLY SUMMARY", "", "", "", "", "", "", "", "", "", ""],
      ["Vendor", "Total (€)", "% of Month", "Count", "Avg Amount (€)", "", "", "", "", "", ""],
    ];

    // Add vendor summary rows (one row per vendor with consolidated totals)
    Object.entries(vendorTotals)
      .sort((a, b) => b[1].total - a[1].total)  // Sort by total descending
      .forEach(([vendor, data]) => {
        const percentage = ((data.total / monthTotal) * 100).toFixed(1);
        summaryRows.push([
          vendor,
          data.total.toFixed(2),
          `${percentage}%`,
          data.count,
          (data.total / data.count).toFixed(2),
          "", "", "", "", "", ""
        ]);
      });

    // Add total row
    summaryRows.push([
      "TOTAL",
      monthTotal.toFixed(2),
      "100%",
      monthInvoices.length,
      (monthTotal / monthInvoices.length).toFixed(2),
      "", "", "", "", "", ""
    ]);

    // Add summary section after transaction rows
    if (summaryRows.length > 0) {
      await appendToSheet(config.spreadsheetId, month, config.accessToken, summaryRows);
    }
  }
}

/**
 * Create quarterly summary sheets by aggregating monthly summaries (Q1 - Q4)
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

    // Group by vendor and calculate totals (aggregate all invoices in the quarter)
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

    // Calculate quarter totals
    const quarterTotal = quarterInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const quarterIva = quarterInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
    const quarterBase = quarterInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);

    // Format data rows with percentages (one row per vendor)
    const rows = Object.entries(vendorTotals)
      .sort((a, b) => b[1].total - a[1].total)  // Sort by total descending
      .map(([vendor, data]) => {
        const percentage = ((data.total / quarterTotal) * 100).toFixed(1);
        return [
          vendor,
          data.total.toFixed(2),
          data.iva.toFixed(2),
          data.base.toFixed(2),
          `${percentage}%`,
          data.count,
          (data.total / data.count).toFixed(2),
        ];
      });

    // Add quarter total row (only one total row at the end)
    rows.push([
      `${quarter} TOTAL`,
      quarterTotal.toFixed(2),
      quarterIva.toFixed(2),
      quarterBase.toFixed(2),
      "100%",
      quarterInvoices.length,
      (quarterTotal / quarterInvoices.length).toFixed(2),
    ]);

    if (rows.length > 0) {
      await appendToSheet(config.spreadsheetId, quarter, config.accessToken, rows);
    }
  }
}

/**
 * Create meat-specific tracking sheets with aggregation
 */
export async function createMeatTrackingSheets(
  config: SheetAutomationConfig,
  meatVendors: string[] = ["La portenia", "es cuco"]
): Promise<void> {
  // Meat_Monthly sheet
  const meatMonthlyHeaders = [
    "Month", "Vendor", "Total (€)", "% of Month", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)"
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
      return invMonth === month;
    });

    const meatInvoices = monthInvoices.filter((inv) =>
      meatVendors.some(vendor => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
    );

    if (meatInvoices.length === 0) continue;

    const monthTotal = monthInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    const vendorTotals: Record<string, {
      total: number;
      iva: number;
      base: number;
      count: number;
    }> = {};

    meatInvoices.forEach((inv) => {
      if (!vendorTotals[inv.vendor]) {
        vendorTotals[inv.vendor] = { total: 0, iva: 0, base: 0, count: 0 };
      }
      vendorTotals[inv.vendor].total += inv.totalAmount;
      vendorTotals[inv.vendor].iva += inv.ivaAmount;
      vendorTotals[inv.vendor].base += inv.baseAmount;
      vendorTotals[inv.vendor].count += 1;
    });

    Object.entries(vendorTotals).forEach(([vendor, data]) => {
      const percentage = ((data.total / monthTotal) * 100).toFixed(1);
      meatMonthlyRows.push([
        month,
        vendor,
        data.total.toFixed(2),
        `${percentage}%`,
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
    "Quarter", "Vendor", "Total (€)", "% of Quarter", "IVA (€)", "Base (€)", "Count", "Avg Amount (€)"
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
      return quarterMonths[quarter].includes(month);
    });

    const meatInvoices = quarterInvoices.filter((inv) =>
      meatVendors.some(vendor => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
    );

    if (meatInvoices.length === 0) continue;

    const quarterTotal = quarterInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

    const vendorTotals: Record<string, {
      total: number;
      iva: number;
      base: number;
      count: number;
    }> = {};

    meatInvoices.forEach((inv) => {
      if (!vendorTotals[inv.vendor]) {
        vendorTotals[inv.vendor] = { total: 0, iva: 0, base: 0, count: 0 };
      }
      vendorTotals[inv.vendor].total += inv.totalAmount;
      vendorTotals[inv.vendor].iva += inv.ivaAmount;
      vendorTotals[inv.vendor].base += inv.baseAmount;
      vendorTotals[inv.vendor].count += 1;
    });

    Object.entries(vendorTotals).forEach(([vendor, data]) => {
      const percentage = ((data.total / quarterTotal) * 100).toFixed(1);
      meatQuarterlyRows.push([
        quarter,
        vendor,
        data.total.toFixed(2),
        `${percentage}%`,
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
  const meatAnalysisHeaders = ["Metric", "Value"];
  await ensureSheetExists(config.spreadsheetId, "Meat_Analysis", config.accessToken, meatAnalysisHeaders);

  const allMeatInvoices = config.invoiceData.filter((inv) =>
    meatVendors.some(vendor => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
  );

  const totalMeat = allMeatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalMeatIva = allMeatInvoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalMeatBase = allMeatInvoices.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const totalMeatCount = allMeatInvoices.length;
  const avgMeatAmount = totalMeatCount > 0 ? totalMeat / totalMeatCount : 0;
  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = totalSpending > 0 ? (totalMeat / totalSpending * 100).toFixed(2) : 0;

  const meatAnalysisRows = [
    ["MEAT SPENDING ANALYSIS", ""],
    ["Total Meat Spending (€)", totalMeat.toFixed(2)],
    ["Total IVA on Meat (€)", totalMeatIva.toFixed(2)],
    ["Total Base (Meat) (€)", totalMeatBase.toFixed(2)],
    ["Total Purchases", totalMeatCount],
    ["Average per Purchase (€)", avgMeatAmount.toFixed(2)],
    ["% of Total Spending", `${meatPercentage}%`],
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

  const meatInvoices = config.invoiceData.filter((inv) =>
    meatVendors.some(vendor => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
  );
  const meatSpending = meatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = totalSpending > 0 ? (meatSpending / totalSpending * 100).toFixed(2) : 0;

  const dashboardRows = [
    ["OVERALL STATISTICS", ""],
    ["Total Spending (€)", totalSpending.toFixed(2)],
    ["Total IVA (€)", totalIva.toFixed(2)],
    ["Total Base (€)", totalBase.toFixed(2)],
    ["Total Invoices", totalInvoices],
    ["Average per Invoice (€)", avgAmount.toFixed(2)],
    ["", ""],
    ["MEAT TRACKING (La portenia + es cuco)", ""],
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
 * Create Executive Summary sheet for investor reporting
 */
export async function createExecutiveSummarySheet(
  config: SheetAutomationConfig,
  meatVendors?: string[]
): Promise<void> {
  const summaryHeaders = ["Metric", "Value"];
  await ensureSheetExists(config.spreadsheetId, "Executive_Summary", config.accessToken, summaryHeaders);

  // Calculate all metrics
  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalIva = config.invoiceData.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalBase = config.invoiceData.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const totalInvoices = config.invoiceData.length;
  const avgAmount = totalInvoices > 0 ? totalSpending / totalInvoices : 0;

  // Meat spending
  const meatVendorsList = meatVendors || ["La portenia", "es cuco"];
  const meatInvoices = config.invoiceData.filter((inv) =>
    meatVendorsList.some(vendor => inv.vendor.toLowerCase().includes(vendor.toLowerCase()))
  );
  const meatSpending = meatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = totalSpending > 0 ? (meatSpending / totalSpending * 100).toFixed(2) : "0";

  // Get unique vendors
  const uniqueVendors = new Set(config.invoiceData.map((inv) => inv.vendor));
  const vendorCount = uniqueVendors.size;

  // Group by vendor for TOP vendors
  const vendorTotals: Record<string, number> = {};
  config.invoiceData.forEach((inv) => {
    if (!vendorTotals[inv.vendor]) {
      vendorTotals[inv.vendor] = 0;
    }
    vendorTotals[inv.vendor] += inv.totalAmount;
  });

  // Sort vendors by spending and get top 3
  const topVendors = Object.entries(vendorTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  // Get date range
  const dates = config.invoiceData.map((inv) => new Date(inv.date).getTime()).sort((a, b) => a - b);
  const startDate = dates.length > 0 ? new Date(dates[0]).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "N/A";
  const endDate = dates.length > 0 ? new Date(dates[dates.length - 1]).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "N/A";

  // Get quarter from first invoice
  const quarter = config.invoiceData.length > 0 ? getQuarter(config.invoiceData[0].date) : "N/A";
  const year = config.invoiceData.length > 0 ? getYear(config.invoiceData[0].date) : "N/A";

  // Monthly breakdown
  const monthlyTotals: Record<string, number> = {};
  config.invoiceData.forEach((inv) => {
    const month = getMonthName(inv.date);
    if (!monthlyTotals[month]) {
      monthlyTotals[month] = 0;
    }
    monthlyTotals[month] += inv.totalAmount;
  });

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  // Build summary rows
  const summaryRows: (string | number)[][] = [
    ["EXECUTIVE SUMMARY", ""],
    ["Analysis Period", `${quarter} ${year} (${startDate} - ${endDate})`],
    ["", ""],
    ["CORE METRICS", ""],
    ["Total Spending (€)", totalSpending.toFixed(2)],
    ["Total IVA (€)", totalIva.toFixed(2)],
    ["Total Base (€)", totalBase.toFixed(2)],
    ["Total Invoices", totalInvoices],
    ["Average per Invoice (€)", avgAmount.toFixed(2)],
    ["Unique Vendors", vendorCount],
    ["", ""],
    ["MEAT SPENDING", ""],
    ["Meat Total (€)", meatSpending.toFixed(2)],
    ["Meat % of Total", `${meatPercentage}%`],
    ["Meat Invoices", meatInvoices.length],
    ["Meat Average (€)", meatInvoices.length > 0 ? (meatSpending / meatInvoices.length).toFixed(2) : "0"],
    ["", ""],
    ["TOP 3 VENDORS", ""],
  ];

  // Add top vendors
  topVendors.forEach(([vendor, amount], index) => {
    const percentage = totalSpending > 0 ? ((amount / totalSpending) * 100).toFixed(2) : "0";
    summaryRows.push([`${index + 1}. ${vendor}`, `€${amount.toFixed(2)} (${percentage}%)`]);
  });

  summaryRows.push(["", ""]);
  summaryRows.push(["MONTHLY TREND", ""]);

  // Add monthly breakdown
  months.forEach((month) => {
    const monthTotal = monthlyTotals[month] || 0;
    if (monthTotal > 0) {
      summaryRows.push([month, monthTotal.toFixed(2)]);
    }
  });

  if (summaryRows.length > 0) {
    await appendToSheet(config.spreadsheetId, "Executive_Summary", config.accessToken, summaryRows);
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

    // Create monthly sheets with vendor aggregation
    console.log("Creating monthly sheets with vendor aggregation...");
    await createMonthlySheets(config);

    // Create quarterly summary sheets with percentages
    console.log("Creating quarterly summary sheets with percentages...");
    await createQuarterlySummarySheets(config);

    // Create meat tracking sheets
    console.log("Creating meat tracking sheets...");
    await createMeatTrackingSheets(config, meatVendors);

    // Create dashboard sheet
    console.log("Creating dashboard sheet...");
    await createDashboardSheet(config, meatVendors);

    // Create executive summary sheet
    console.log("Creating executive summary sheet...");
    await createExecutiveSummarySheet(config, meatVendors);

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
