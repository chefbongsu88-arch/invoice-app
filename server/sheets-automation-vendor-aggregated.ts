import { isMeatCategory } from "../shared/invoice-types";
import { receiptImageSheetsFormula } from "../shared/sheets-defaults";
import {
  applyBoldTextFormatToGridRange,
  applyThinTextFormatToGridRange,
  encodeValuesRange,
  ensureSheetExists,
  getSheetIdByTitle,
  TRACKER_COLUMN_COUNT,
} from "./sheets-automation";

/** Per-vendor lines are noisy in Railway; set VERBOSE_SHEETS_AGG_LOG=1 to enable. */
const verboseSheetsAggLog =
  process.env.VERBOSE_SHEETS_AGG_LOG === "1" ||
  process.env.NODE_ENV === "development";

export interface SheetAutomationConfig {
  spreadsheetId: string;
  accessToken: string;
  invoiceData?: any[];
}

/**
 * Get month name from date string (supports DD/MM/YYYY, YYYY-MM-DD formats)
 */
function getMonthFromDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim().replace(/^'+/, "");
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];

  // DD/MM/YYYY — group 1=day, group 2=month, group 3=year
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const monthIndex = parseInt(m1[2], 10) - 1;
    return months[monthIndex] || null;
  }

  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return months[parseInt(m2[2], 10) - 1] || null;

  const d = new Date(s);
  if (!isNaN(d.getTime())) return months[d.getMonth()] || null;
  return null;
}

/**
 * Get quarter from date string (supports DD/MM/YYYY, YYYY-MM-DD, and "2026. 3. 25" formats)
 */
function getQuarterFromDate(dateStr: string): string {
  try {
    let date: Date;
    const cleanStr = String(dateStr).trim().replace(/^'+/, "");
    
    // Try DD/MM/YYYY format first
    const ddmmyyyyMatch = cleanStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddmmyyyyMatch) {
      const day = parseInt(ddmmyyyyMatch[1], 10);
      const month = parseInt(ddmmyyyyMatch[2], 10) - 1; // 0-indexed
      const year = parseInt(ddmmyyyyMatch[3], 10);
      date = new Date(year, month, day);
    }
    // YYYY-MM-DD — use local y/m/d (avoid new Date(iso) UTC vs local month shift)
    else if (/^(\d{4})-(\d{2})-(\d{2})$/.test(cleanStr)) {
      const m = cleanStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        date = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
      } else {
        return "";
      }
    }
    // Try "2026. 3. 25" format
    else if (cleanStr.includes(".")) {
      const parts = cleanStr.replace(/\./g, "").split(/\s+/);
      if (parts.length >= 3) {
        date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      } else {
        return "";
      }
    } else {
      date = new Date(cleanStr);
    }
    
    const month = date.getMonth() + 1;
    const quarter = Math.ceil(month / 3);
    return `Q${quarter}`;
  } catch {
    return "";
  }
}

/**
 * Key for merging the same business across months in a quarter (and month tabs) even when
 * spelling/case/punctuation differs: "MERCADONA, S.A." vs "MERCADONA S.A." vs "mercadona s.a.".
 */
function vendorAggregateKey(vendor: string): string {
  const s = String(vendor ?? "Unknown")
    .trim()
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || "unknown";
}

/** Pick newer-looking date string for aggregated row (ISO or DD/MM/YYYY). */
function pickNewerDateString(a: unknown, b: unknown): string {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (!sa) return sb;
  if (!sb) return sa;
  const toSort = (s: string) => {
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
    const eu = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (eu) return `${eu[3]}${eu[2].padStart(2, "0")}${eu[1].padStart(2, "0")}`;
    return s;
  };
  return toSort(sb) >= toSort(sa) ? sb : sa;
}

/**
 * Aggregate invoices by vendor (normalized name so Q1–Q4 sums one row per business across 3 months).
 */
function aggregateByVendor(invoices: any[]) {
  const vendorMap = new Map<string, any>();

  for (const invoice of invoices) {
    const rawVendor = String(invoice.vendor ?? "Unknown").trim() || "Unknown";
    const key = vendorAggregateKey(rawVendor);

    if (verboseSheetsAggLog) {
      console.log(
        `Processing invoice: ${rawVendor}, totalAmount=${invoice.totalAmount} (type: ${typeof invoice.totalAmount})`,
      );
    }

    if (!vendorMap.has(key)) {
      vendorMap.set(key, {
        source: invoice.source,
        invoiceNumber: invoice.invoiceNumber,
        vendor: rawVendor,
        date: invoice.date,
        totalAmount: 0,
        ivaAmount: 0,
        baseAmount: 0,
        tip: 0,
        category: invoice.category,
        currency: invoice.currency,
        notes: invoice.notes,
        imageUrl: invoice.imageUrl,
        _mergeCount: 0,
      });
    }

    const vendorData = vendorMap.get(key)!;
    vendorData._mergeCount += 1;
    vendorData.totalAmount += parseAmount(invoice.totalAmount);
    vendorData.ivaAmount += parseAmount(invoice.ivaAmount);
    vendorData.baseAmount += parseAmount(invoice.baseAmount);
    vendorData.tip += parseAmount(invoice.tip);
    vendorData.date = pickNewerDateString(vendorData.date, invoice.date);
    // Prefer the longest display name (often the fuller legal name on the ticket).
    if (rawVendor.length > String(vendorData.vendor).length) {
      vendorData.vendor = rawVendor;
    }
    const img = String(invoice.imageUrl ?? "").trim();
    if (img && !String(vendorData.imageUrl ?? "").trim()) {
      vendorData.imageUrl = invoice.imageUrl;
    }

    if (verboseSheetsAggLog) {
      console.log(`After aggregation: ${vendorData.vendor} total=${vendorData.totalAmount}`);
    }
  }

  for (const v of vendorMap.values()) {
    if (v._mergeCount > 1) {
      v.invoiceNumber = "";
    }
    delete v._mergeCount;
  }

  return Array.from(vendorMap.values());
}

/**
 * Parse any amount value to a plain number (strips currency symbols, handles strings)
 */
function parseAmount(value: any): number {
  if (typeof value === "number") return isNaN(value) ? 0 : value;
  if (!value) return 0;
  const cleaned = String(value).replace(/[€$£¥₩,\s]/g, "");
  return parseFloat(cleaned) || 0;
}

/** L column: keep Sheets formulas; wrap bare https URLs for =IMAGE */
function receiptCellForAggregatedSheet(imageUrl: string | undefined): string {
  const s = String(imageUrl ?? "").trim();
  if (!s) return "";
  if (s.startsWith("=")) return s;
  if (/^https?:\/\//i.test(s)) {
    return receiptImageSheetsFormula(s);
  }
  return s;
}

/**
 * Format currency for Google Sheets — returns plain number, not a string
 */
function formatCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
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
      "Source", "Invoice #", "Vendor", "Date", "Total (€)", "VAT (€)", "Base (€)", "Tip (€)",
      "Category", "Currency", "Notes", "Receipt", "Exported At"
    ];

    const ok = await ensureSheetExists(spreadsheetId, month, accessToken, header);
    if (!ok) {
      console.warn(`⚠️ Could not ensure sheet "${month}" — skipping`);
      continue;
    }

    const sheetRows: any[] = [header];

    // Calculate TOTAL
    const totalAmount = aggregated.reduce((sum, v) => sum + v.totalAmount, 0);
    const totalIva = aggregated.reduce((sum, v) => sum + v.ivaAmount, 0);
    const totalBase = aggregated.reduce((sum, v) => sum + v.baseAmount, 0);
    const totalTip = aggregated.reduce((sum, v) => sum + v.tip, 0);

    // Always add TOTAL row with SUM formulas for automatic calculation
    const totalRow = [
      "", "", `${month} TOTAL`, "",
      "=SUM(E3:E1000)",      // E: Total (€) - auto sum
      "=SUM(F3:F1000)",      // F: VAT (€) - auto sum
      "=SUM(G3:G1000)",      // G: Base (€) - auto sum
      "=SUM(H3:H1000)",      // H: Tip (€) - auto sum
      "", "", "", "", ""
    ];
    sheetRows.push(totalRow);

    // Add vendor rows (aggregated)
    for (const vendor of aggregated) {
      const row = [
        vendor.source?.toLowerCase() === "camera" ? "Camera" : "Email", // A: Source
        vendor.invoiceNumber,    // B: Invoice #
        vendor.vendor,           // C: Vendor
        vendor.date,             // D: Date
        vendor.totalAmount,      // E: Total (€) - as number, not string!
        vendor.ivaAmount,        // F: VAT (€) - as number, not string!
        vendor.baseAmount,       // G: Base (€) - as number, not string!
        vendor.tip ?? 0,         // H: Tip (€) - as number, not string!
        vendor.category,         // I: Category
        vendor.currency,         // J: Currency
        vendor.notes,            // K: Notes
        receiptCellForAggregatedSheet(vendor.imageUrl), // L: same formula as main tracker when possible
        ""                       // M: Exported At
      ];
      sheetRows.push(row);
    }

    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(month, "A:M")}:clear`;
    await fetch(clearUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });

    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(month, `A1:M${sheetRows.length}`)}?valueInputOption=USER_ENTERED`;
    await fetch(updateUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: sheetRows })
    });

    const monthSheetId = await getSheetIdByTitle(spreadsheetId, month, accessToken);
    if (monthSheetId != null && sheetRows.length > 0) {
      await applyBoldTextFormatToGridRange(spreadsheetId, accessToken, monthSheetId, {
        startRowIndex: 0,
        endRowIndex: Math.min(2, sheetRows.length),
        startColumnIndex: 0,
        endColumnIndex: TRACKER_COLUMN_COUNT,
      });
      if (sheetRows.length > 2) {
        await applyThinTextFormatToGridRange(spreadsheetId, accessToken, monthSheetId, {
          startRowIndex: 2,
          endRowIndex: sheetRows.length,
          startColumnIndex: 0,
          endColumnIndex: TRACKER_COLUMN_COUNT,
        });
      }
    }

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

    const header = [
      "Source", "Invoice #", "Vendor", "Date", "Total (€)", "VAT (€)", "Base (€)", "Tip (€)",
      "Category", "Currency", "Notes", "Receipt", "Exported At"
    ];

    const ok = await ensureSheetExists(spreadsheetId, quarter, accessToken, header);
    if (!ok) {
      console.warn(`⚠️ Could not ensure sheet "${quarter}" — skipping`);
      continue;
    }

    const sheetRows: any[] = [header];

    // Calculate TOTAL
    const totalAmount = aggregated.reduce((sum, v) => sum + v.totalAmount, 0);
    const totalIva = aggregated.reduce((sum, v) => sum + v.ivaAmount, 0);
    const totalBase = aggregated.reduce((sum, v) => sum + v.baseAmount, 0);
    const totalTip = aggregated.reduce((sum, v) => sum + v.tip, 0);

    // Always add TOTAL row with SUM formulas for automatic calculation
    const totalRow = [
      "", "", "QUARTERLY TOTAL", "",
      "=SUM(E3:E1000)",      // E: Total (€) - auto sum
      "=SUM(F3:F1000)",      // F: VAT (€) - auto sum
      "=SUM(G3:G1000)",      // G: Base (€) - auto sum
      "=SUM(H3:H1000)",      // H: Tip (€) - auto sum
      "", "", "", "", ""
    ];
    sheetRows.push(totalRow);

    // Add vendor rows (aggregated)
    for (const vendor of aggregated) {
      const row = [
        vendor.source?.toLowerCase() === "camera" ? "Camera" : "Email", // A: Source
        vendor.invoiceNumber,    // B: Invoice #
        vendor.vendor,           // C: Vendor
        vendor.date,             // D: Date
        vendor.totalAmount,      // E: Total (€) - as number, not string!
        vendor.ivaAmount,        // F: VAT (€) - as number, not string!
        vendor.baseAmount,       // G: Base (€) - as number, not string!
        vendor.tip ?? 0,         // H: Tip (€) - as number, not string!
        vendor.category,         // I: Category
        vendor.currency,         // J: Currency
        vendor.notes,            // K: Notes
        receiptCellForAggregatedSheet(vendor.imageUrl),
        ""                       // M: Exported At
      ];
      sheetRows.push(row);
    }

    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(quarter, "A:M")}:clear`;
    await fetch(clearUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });

    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(quarter, `A1:M${sheetRows.length}`)}?valueInputOption=USER_ENTERED`;
    await fetch(updateUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: sheetRows })
    });

    const quarterSheetId = await getSheetIdByTitle(spreadsheetId, quarter, accessToken);
    if (quarterSheetId != null && sheetRows.length > 0) {
      await applyBoldTextFormatToGridRange(spreadsheetId, accessToken, quarterSheetId, {
        startRowIndex: 0,
        endRowIndex: Math.min(2, sheetRows.length),
        startColumnIndex: 0,
        endColumnIndex: TRACKER_COLUMN_COUNT,
      });
      if (sheetRows.length > 2) {
        await applyThinTextFormatToGridRange(spreadsheetId, accessToken, quarterSheetId, {
          startRowIndex: 2,
          endRowIndex: sheetRows.length,
          startColumnIndex: 0,
          endColumnIndex: TRACKER_COLUMN_COUNT,
        });
      }
    }

    console.log(`✅ Updated ${quarter} sheet: ${aggregated.length} vendors`);
  }
}

// ─── Meat Item Sheets ─────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function getMonthIndexFromDate(dateStr: string): number {
  if (!dateStr) return -1;
  const s = String(dateStr).trim().replace(/^'+|'+$/g, "");
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return parseInt(m1[2], 10) - 1;
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return parseInt(m2[2], 10) - 1;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getMonth();
  return -1;
}

function normalizeMeatVendorName(vendor: string): string {
  return String(vendor ?? "").trim().replace(/\s+/g, " ") || "Unknown";
}

function normalizeMeatCutName(cutName: string): string {
  return String(cutName ?? "").trim().replace(/\s+/g, " ") || "Unknown Cut";
}

type MeatItemRow = {
  month: string;
  monthIndex: number;
  date: string;
  vendor: string;
  invoiceNumber: string;
  cutName: string;
  quantityKg: number;
  pricePerKg: number;
  totalEur: number;
  source: string;
};

function buildMeatLineItems(invoices: any[]): MeatItemRow[] {
  const rows: MeatItemRow[] = [];
  for (const inv of invoices) {
    if (!isMeatCategory(inv.category) || !Array.isArray(inv.items) || inv.items.length === 0) {
      continue;
    }
    const vendor = normalizeMeatVendorName(inv.vendor);
    const monthIndex = getMonthIndexFromDate(inv.date || "");
    if (monthIndex < 0 || monthIndex > 11) continue;
    const month = MONTH_ABBR[monthIndex];
    for (const item of inv.items) {
      const cutName = normalizeMeatCutName(item?.partName);
      const quantityKg = parseAmount(item?.quantity);
      const pricePerKg = parseAmount(item?.pricePerUnit);
      const totalEur = parseAmount(item?.total);
      if (!cutName || quantityKg <= 0 || totalEur <= 0) continue;
      rows.push({
        month,
        monthIndex,
        date: String(inv.date ?? "").trim(),
        vendor,
        invoiceNumber: String(inv.invoiceNumber ?? "").trim(),
        cutName,
        quantityKg: Math.round(quantityKg * 1000) / 1000,
        pricePerKg: Math.round((pricePerKg > 0 ? pricePerKg : totalEur / quantityKg) * 100) / 100,
        totalEur: Math.round(totalEur * 100) / 100,
        source: String(inv.source ?? "").toLowerCase() === "camera" ? "Camera" : "Email",
      });
    }
  }
  rows.sort((a, b) => {
    if (a.monthIndex !== b.monthIndex) return a.monthIndex - b.monthIndex;
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
    return a.cutName.localeCompare(b.cutName);
  });
  return rows;
}

function buildMeatOrdersRows(items: MeatItemRow[]): any[][] {
  const byMonthVendor = new Map<string, { month: string; vendor: string; totalKg: number; totalEur: number; invoiceNumbers: Set<string> }>();
  for (const item of items) {
    const key = `${item.month}|||${item.vendor}`;
    if (!byMonthVendor.has(key)) {
      byMonthVendor.set(key, {
        month: item.month,
        vendor: item.vendor,
        totalKg: 0,
        totalEur: 0,
        invoiceNumbers: new Set<string>(),
      });
    }
    const entry = byMonthVendor.get(key)!;
    entry.totalKg += item.quantityKg;
    entry.totalEur += item.totalEur;
    if (item.invoiceNumber) entry.invoiceNumbers.add(item.invoiceNumber);
  }
  return Array.from(byMonthVendor.values())
    .sort((a, b) => a.month.localeCompare(b.month) || a.vendor.localeCompare(b.vendor))
    .map((entry) => [
      entry.month,
      entry.vendor,
      entry.invoiceNumbers.size,
      Math.round(entry.totalKg * 1000) / 1000,
      Math.round(entry.totalEur * 100) / 100,
    ]);
}

function buildMeatCutSummaryRows(items: MeatItemRow[]): any[][] {
  const byMonthCut = new Map<string, { month: string; cutName: string; totalKg: number; totalEur: number }>();
  for (const item of items) {
    const key = `${item.month}|||${item.cutName}`;
    if (!byMonthCut.has(key)) {
      byMonthCut.set(key, {
        month: item.month,
        cutName: item.cutName,
        totalKg: 0,
        totalEur: 0,
      });
    }
    const entry = byMonthCut.get(key)!;
    entry.totalKg += item.quantityKg;
    entry.totalEur += item.totalEur;
  }
  return Array.from(byMonthCut.values())
    .sort((a, b) => a.month.localeCompare(b.month) || a.cutName.localeCompare(b.cutName))
    .map((entry) => [
      entry.month,
      entry.cutName,
      Math.round(entry.totalKg * 1000) / 1000,
      Math.round(entry.totalEur * 100) / 100,
      entry.totalKg > 0 ? Math.round((entry.totalEur / entry.totalKg) * 100) / 100 : 0,
    ]);
}

function buildMeatMonthlySummaryRows(items: MeatItemRow[]): any[][] {
  const byMonth = new Map<string, { month: string; totalKg: number; totalEur: number; vendors: Set<string>; invoiceNumbers: Set<string> }>();
  for (const item of items) {
    if (!byMonth.has(item.month)) {
      byMonth.set(item.month, {
        month: item.month,
        totalKg: 0,
        totalEur: 0,
        vendors: new Set<string>(),
        invoiceNumbers: new Set<string>(),
      });
    }
    const entry = byMonth.get(item.month)!;
    entry.totalKg += item.quantityKg;
    entry.totalEur += item.totalEur;
    entry.vendors.add(item.vendor);
    if (item.invoiceNumber) entry.invoiceNumbers.add(item.invoiceNumber);
  }
  return Array.from(byMonth.values())
    .sort((a, b) => MONTH_ABBR.indexOf(a.month) - MONTH_ABBR.indexOf(b.month))
    .map((entry) => [
      entry.month,
      Math.round(entry.totalKg * 1000) / 1000,
      Math.round(entry.totalEur * 100) / 100,
      entry.invoiceNumbers.size,
      entry.vendors.size,
    ]);
}

async function rewriteMeatSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  headerRow: string[],
  dataRows: any[][],
): Promise<void> {
  const ensured = await ensureSheetExists(spreadsheetId, sheetTitle, accessToken, headerRow);
  if (!ensured) {
    throw new Error(`${sheetTitle} sheet could not be created`);
  }

  const sheetData = [headerRow, ...dataRows];
  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetTitle, "A:AZ")}:clear`;
  await fetch(clearUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });

  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetTitle, "A1")}?valueInputOption=USER_ENTERED`;
  const writeRes = await fetch(writeUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: sheetData }),
  });
  if (!writeRes.ok) throw new Error(`${sheetTitle} write error: ${await writeRes.text()}`);

  const sheetId = await getSheetIdByTitle(spreadsheetId, sheetTitle, accessToken);
  if (sheetId != null && sheetData.length > 0) {
    const nCols = sheetData.reduce((m, r) => Math.max(m, r.length), 0);
    await applyBoldTextFormatToGridRange(spreadsheetId, accessToken, sheetId, {
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: Math.max(nCols, 1),
    });
    if (sheetData.length > 1) {
      await applyThinTextFormatToGridRange(spreadsheetId, accessToken, sheetId, {
        startRowIndex: 1,
        endRowIndex: sheetData.length,
        startColumnIndex: 0,
        endColumnIndex: Math.max(nCols, 1),
      });
    }
  }
}

export async function updateMeatSheets(
  accessToken: string,
  spreadsheetId: string,
  invoices: any[]
): Promise<void> {
  const meatItems = buildMeatLineItems(invoices);
  if (meatItems.length === 0) {
    console.log("ℹ️  No meat line items found — meat sheets not updated");
    return;
  }

  const lineItemHeader = [
    "Month",
    "Date",
    "Vendor",
    "Invoice #",
    "Cut Name",
    "Quantity (kg)",
    "Price / kg (€)",
    "Total (€)",
    "Source",
  ];
  const lineItemRows = meatItems.map((item) => [
    item.month,
    item.date,
    item.vendor,
    item.invoiceNumber,
    item.cutName,
    item.quantityKg,
    item.pricePerKg,
    item.totalEur,
    item.source,
  ]);
  await rewriteMeatSheet(accessToken, spreadsheetId, "Meat_Line_Items", lineItemHeader, lineItemRows);

  const ordersHeader = ["Month", "Vendor", "Order Count", "Total Meat Kg", "Total Meat Spend (€)"];
  const ordersRows = buildMeatOrdersRows(meatItems);
  await rewriteMeatSheet(accessToken, spreadsheetId, "Meat_Orders", ordersHeader, ordersRows);

  const cutSummaryHeader = ["Month", "Cut Name", "Total Kg", "Total Spend (€)", "Avg Price / Kg (€)"];
  const cutSummaryRows = buildMeatCutSummaryRows(meatItems);
  await rewriteMeatSheet(accessToken, spreadsheetId, "Meat_Cut_Summary", cutSummaryHeader, cutSummaryRows);

  const monthlySummaryHeader = ["Month", "Total Meat Kg", "Total Meat Spend (€)", "Invoice Count", "Vendor Count"];
  const monthlySummaryRows = buildMeatMonthlySummaryRows(meatItems);
  await rewriteMeatSheet(accessToken, spreadsheetId, "Meat_Monthly_Summary", monthlySummaryHeader, monthlySummaryRows);

  console.log(`✅ Meat sheets updated: ${meatItems.length} line items`);
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

  await updateMeatSheets(config.accessToken, config.spreadsheetId, config.invoiceData);

  console.log("✅ Automation complete!");
}
