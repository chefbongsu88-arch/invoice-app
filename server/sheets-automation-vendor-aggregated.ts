export interface SheetAutomationConfig {
  spreadsheetId: string;
  accessToken: string;
  invoiceData?: any[];
}

/**
 * Get month name from date string
 */
function getMonthFromDate(dateStr: string): string {
  try {
    let date: Date;
    if (dateStr.includes(".")) {
      // Format: "2026. 3. 25"
      const parts = dateStr.replace(/\./g, "").split(/\s+/);
      if (parts.length >= 3) {
        date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      } else {
        return "";
      }
    } else {
      // Format: "2026-03-25" or "'2026-03-25"
      const cleanDate = dateStr.replace(/'/g, "").trim();
      date = new Date(cleanDate);
    }
    return date.toLocaleString("en-US", { month: "long" });
  } catch {
    return "";
  }
}

/**
 * Get quarter from date string
 */
function getQuarterFromDate(dateStr: string): string {
  try {
    let date: Date;
    if (dateStr.includes(".")) {
      const parts = dateStr.replace(/\./g, "").split(/\s+/);
      if (parts.length >= 3) {
        date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      } else {
        return "";
      }
    } else {
      const cleanDate = dateStr.replace(/'/g, "").trim();
      date = new Date(cleanDate);
    }
    const month = date.getMonth() + 1;
    const quarter = Math.ceil(month / 3);
    return `Q${quarter}`;
  } catch {
    return "";
  }
}

/**
 * Aggregate invoices by vendor
 */
function aggregateByVendor(invoices: any[]) {
  const vendorMap = new Map<string, any>();

  for (const invoice of invoices) {
    const vendor = invoice.vendor || "Unknown";
    
    console.log(`Processing invoice: ${vendor}, totalAmount=${invoice.totalAmount} (type: ${typeof invoice.totalAmount})`);
    
    if (!vendorMap.has(vendor)) {
      vendorMap.set(vendor, {
        source: invoice.source,
        invoiceNumber: invoice.invoiceNumber,
        vendor: vendor,
        date: invoice.date,
        totalAmount: 0,
        ivaAmount: 0,
        baseAmount: 0,
        tip: 0,
        category: invoice.category,
        currency: invoice.currency,
        notes: invoice.notes,
        imageUrl: invoice.imageUrl,
      });
    }

    const vendorData = vendorMap.get(vendor)!;
    vendorData.totalAmount += invoice.totalAmount;
    vendorData.ivaAmount += invoice.ivaAmount;
    vendorData.baseAmount += invoice.baseAmount;
    vendorData.tip += invoice.tip;
    
    console.log(`After aggregation: ${vendor} total=${vendorData.totalAmount}`);
  }

  return Array.from(vendorMap.values());
}

/**
 * Format currency for Google Sheets
 */
function formatCurrency(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

/**
 * Create monthly sheets with vendor aggregation
 */
async function createMonthlySheets(
  accessToken: string,
  spreadsheetId: string,
  invoiceData: any[]
): Promise<void> {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  // Group invoices by month
  const invoicesByMonth: { [key: string]: any[] } = {};
  for (const month of months) {
    invoicesByMonth[month] = [];
  }

  for (const invoice of invoiceData) {
    const month = getMonthFromDate(invoice.date);
    if (month && invoicesByMonth[month]) {
      invoicesByMonth[month].push(invoice);
    }
  }

  // Create/update each month sheet
  for (const month of months) {
    const monthInvoices = invoicesByMonth[month];
    const aggregated = aggregateByVendor(monthInvoices);

    // Build sheet rows
    const header = [
      "Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Tip (€)",
      "Category", "Currency", "Notes", "Image URL", "Exported At"
    ];

    const sheetRows: any[] = [header];

    // Calculate TOTAL
    const totalAmount = aggregated.reduce((sum, v) => sum + v.totalAmount, 0);
    const totalIva = aggregated.reduce((sum, v) => sum + v.ivaAmount, 0);
    const totalBase = aggregated.reduce((sum, v) => sum + v.baseAmount, 0);
    const totalTip = aggregated.reduce((sum, v) => sum + v.tip, 0);

    // Always add TOTAL row with SUM formulas for automatic calculation
    const totalRow = [
      "", "", `${month} TOTAL`, "",
      "=SUM(E3:E)",      // E: Total (€) - auto sum
      "=SUM(F3:F)",      // F: IVA (€) - auto sum
      "=SUM(G3:G)",      // G: Base (€) - auto sum
      "=SUM(H3:H)",      // H: Tip (€) - auto sum
      "", "", "", "", ""
    ];
    sheetRows.push(totalRow);

    // Add vendor rows (aggregated)
    for (const vendor of aggregated) {
      const row = [
        vendor.source,           // A: Source
        vendor.invoiceNumber,    // B: Invoice #
        vendor.vendor,           // C: Vendor
        vendor.date,             // D: Date
        formatCurrency(vendor.totalAmount),  // E: Total (€)
        formatCurrency(vendor.ivaAmount),    // F: IVA (€)
        formatCurrency(vendor.baseAmount),   // G: Base (€)
        formatCurrency(vendor.tip),          // H: Tip (€)
        vendor.category,         // I: Category
        vendor.currency,         // J: Currency
        vendor.notes,            // K: Notes
        vendor.imageUrl,         // L: Image URL
        ""                       // M: Exported At
      ];
      sheetRows.push(row);
    }

    // Clear sheet
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(month + "!A:M")}`;
    await fetch(clearUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    // Update sheet
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(month + "!A1:M" + sheetRows.length)}?valueInputOption=USER_ENTERED`;
    await fetch(updateUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: sheetRows })
    });

    console.log(`✅ Updated ${month} sheet: ${aggregated.length} vendors`);
  }
}

/**
 * Create quarterly sheets with vendor aggregation
 */
async function createQuarterlySheets(
  accessToken: string,
  spreadsheetId: string,
  invoiceData: any[]
): Promise<void> {
  const quarters = ["Q1", "Q2", "Q3", "Q4"];

  // Group invoices by quarter
  const invoicesByQuarter: { [key: string]: any[] } = {};
  for (const quarter of quarters) {
    invoicesByQuarter[quarter] = [];
  }

  for (const invoice of invoiceData) {
    const quarter = getQuarterFromDate(invoice.date);
    if (quarter && invoicesByQuarter[quarter]) {
      invoicesByQuarter[quarter].push(invoice);
    }
  }

  // Create/update each quarter sheet
  for (const quarter of quarters) {
    const quarterInvoices = invoicesByQuarter[quarter];
    const aggregated = aggregateByVendor(quarterInvoices);

    // Build sheet rows
    const header = [
      "Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Tip (€)",
      "Category", "Currency", "Notes", "Image URL", "Exported At"
    ];

    const sheetRows: any[] = [header];

    // Calculate TOTAL
    const totalAmount = aggregated.reduce((sum, v) => sum + v.totalAmount, 0);
    const totalIva = aggregated.reduce((sum, v) => sum + v.ivaAmount, 0);
    const totalBase = aggregated.reduce((sum, v) => sum + v.baseAmount, 0);
    const totalTip = aggregated.reduce((sum, v) => sum + v.tip, 0);

    // Always add TOTAL row with SUM formulas for automatic calculation
    const totalRow = [
      "", "", `${quarter} TOTAL`, "",
      "=SUM(E3:E)",      // E: Total (€) - auto sum
      "=SUM(F3:F)",      // F: IVA (€) - auto sum
      "=SUM(G3:G)",      // G: Base (€) - auto sum
      "=SUM(H3:H)",      // H: Tip (€) - auto sum
      "", "", "", "", ""
    ];
    sheetRows.push(totalRow);

    // Add vendor rows (aggregated)
    for (const vendor of aggregated) {
      const row = [
        vendor.source,           // A: Source
        vendor.invoiceNumber,    // B: Invoice #
        vendor.vendor,           // C: Vendor
        vendor.date,             // D: Date
        formatCurrency(vendor.totalAmount),  // E: Total (€)
        formatCurrency(vendor.ivaAmount),    // F: IVA (€)
        formatCurrency(vendor.baseAmount),   // G: Base (€)
        formatCurrency(vendor.tip),          // H: Tip (€)
        vendor.category,         // I: Category
        vendor.currency,         // J: Currency
        vendor.notes,            // K: Notes
        vendor.imageUrl,         // L: Image URL
        ""                       // M: Exported At
      ];
      sheetRows.push(row);
    }

    // Clear sheet
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(quarter + "!A:M")}`;
    await fetch(clearUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    // Update sheet
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(quarter + "!A1:M" + sheetRows.length)}?valueInputOption=USER_ENTERED`;
    await fetch(updateUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: sheetRows })
    });

    console.log(`✅ Updated ${quarter} sheet: ${aggregated.length} vendors`);
  }
}

/**
 * Main automation function
 */
export async function automateGoogleSheets(
  config: SheetAutomationConfig,
  ignoredVendors?: string[]
): Promise<void> {
  if (!config.invoiceData || config.invoiceData.length === 0) {
    console.log("⚠️  No invoice data provided for automation");
    return;
  }

  console.log(`📊 Processing ${config.invoiceData.length} invoices for vendor aggregation...`);

  // Create monthly sheets
  await createMonthlySheets(config.accessToken, config.spreadsheetId, config.invoiceData);

  // Create quarterly sheets
  await createQuarterlySheets(config.accessToken, config.spreadsheetId, config.invoiceData);

  console.log("✅ Automation complete!");
}
