import { isMeatCategory } from "../shared/invoice-types";
import { receiptImageSheetsFormula } from "../shared/sheets-defaults";
import {
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
      await applyThinTextFormatToGridRange(spreadsheetId, accessToken, monthSheetId, {
        startRowIndex: 0,
        endRowIndex: sheetRows.length,
        startColumnIndex: 0,
        endColumnIndex: TRACKER_COLUMN_COUNT,
      });
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
      await applyThinTextFormatToGridRange(spreadsheetId, accessToken, quarterSheetId, {
        startRowIndex: 0,
        endRowIndex: sheetRows.length,
        startColumnIndex: 0,
        endColumnIndex: TRACKER_COLUMN_COUNT,
      });
    }

    console.log(`✅ Updated ${quarter} sheet: ${aggregated.length} vendors`);
  }
}

// ─── Meat Monthly Sheet ───────────────────────────────────────────────────────

const MEAT_VENDORS = ["La Portenia", "Es Cuco"];
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function isMeatVendor(vendor: string): boolean {
  const lv = vendor.toLowerCase();
  return lv.includes("porteni") || lv.includes("cuco");
}

function normalizeMeatVendor(vendor: string): string {
  const lv = vendor.toLowerCase();
  if (lv.includes("porteni")) return "La Portenia";
  if (lv.includes("cuco"))    return "Es Cuco";
  return vendor;
}

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

/**
 * Build the Meat_Monthly pivot table header row
 * Vendor | Cut Name | Jan(kg) | Jan(€) | Feb(kg) | Feb(€) | ... | Total(kg) | Total(€)
 */
function buildMeatHeader(): string[] {
  const cols: string[] = ["Vendor", "Cut Name"];
  for (const abbr of MONTH_ABBR) {
    cols.push(`${abbr}(kg)`, `${abbr}(€)`);
  }
  cols.push("Total(kg)", "Total(€)");
  return cols;
}

interface MeatAggKey { vendor: string; cutName: string }
interface MeatMonthData { kg: number; eur: number }

/**
 * Update (incremental) the Meat_Monthly sheet with new invoice items.
 * Reads the existing sheet, merges new data, and rewrites.
 */
export async function updateMeatMonthlySheet(
  accessToken: string,
  spreadsheetId: string,
  newInvoices: any[]  // invoices that may have items[]
): Promise<void> {
  const SHEET = "Meat_Monthly";

  // Line items only when vendor is meat and category is Meat (exclude veg receipts from same store)
  const meatInvoices = newInvoices.filter(
    (inv) =>
      inv.items &&
      inv.items.length > 0 &&
      isMeatVendor(inv.vendor || "") &&
      isMeatCategory(inv.category),
  );
  if (meatInvoices.length === 0) {
    console.log("ℹ️  No meat invoices with items — Meat_Monthly not updated");
    return;
  }

  const meatHeader = buildMeatHeader();
  const ensured = await ensureSheetExists(spreadsheetId, SHEET, accessToken, meatHeader);
  if (!ensured) {
    console.warn("⚠️  Meat_Monthly sheet could not be created; skipping meat pivot update");
    return;
  }

  // ── 1. Read existing sheet data ────────────────────────────────────────────
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(SHEET, "A:AZ")}`;
  const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  let existingRows: any[][] = [];
  if (readRes.ok) {
    const data = await readRes.json() as { values?: any[][] };
    existingRows = data.values ?? [];
  }

  // ── 2. Build aggregation map from existing data ────────────────────────────
  // map key: `${vendor}|||${cutName}` → monthData[0..11]
  const aggMap = new Map<string, MeatMonthData[]>();

  const existingHeader = existingRows[0] ?? [];
  const isValidHeader = existingHeader[0] === "Vendor" && existingHeader[1] === "Cut Name";

  if (isValidHeader && existingRows.length > 1) {
    for (let r = 1; r < existingRows.length; r++) {
      const row = existingRows[r];
      const vendor  = String(row[0] ?? "").trim();
      const cutName = String(row[1] ?? "").trim();
      if (!vendor || !cutName) continue;

      const key = `${vendor}|||${cutName}`;
      const months: MeatMonthData[] = [];
      for (let m = 0; m < 12; m++) {
        const kg  = parseFloat(String(row[2 + m * 2] ?? "0")) || 0;
        const eur = parseFloat(String(row[3 + m * 2] ?? "0")) || 0;
        months.push({ kg, eur });
      }
      aggMap.set(key, months);
    }
  }

  // ── 3. Merge new invoice items into aggMap ─────────────────────────────────
  for (const inv of meatInvoices) {
    const vendor   = normalizeMeatVendor(inv.vendor || "");
    const monthIdx = getMonthIndexFromDate(inv.date || "");
    if (monthIdx < 0 || monthIdx > 11) continue;

    for (const item of (inv.items || [])) {
      const cutName = String(item.partName || "").trim();
      if (!cutName) continue;

      const key = `${vendor}|||${cutName}`;
      if (!aggMap.has(key)) {
        aggMap.set(key, Array.from({ length: 12 }, () => ({ kg: 0, eur: 0 })));
      }
      const months = aggMap.get(key)!;
      months[monthIdx].kg  += parseAmount(item.quantity);
      months[monthIdx].eur += parseAmount(item.total);
    }
  }

  // ── 4. Build sheet rows ────────────────────────────────────────────────────
  const headerRow = buildMeatHeader();
  const dataRows: any[][] = [];

  // Sort: La Portenia first, then Es Cuco; alphabetical within vendor
  const sortedKeys = Array.from(aggMap.keys()).sort((a, b) => {
    const [vA, cA] = a.split("|||");
    const [vB, cB] = b.split("|||");
    const vendorOrder = (v: string) => v === "La Portenia" ? 0 : 1;
    if (vendorOrder(vA) !== vendorOrder(vB)) return vendorOrder(vA) - vendorOrder(vB);
    return cA.localeCompare(cB);
  });

  for (const key of sortedKeys) {
    const [vendor, cutName] = key.split("|||");
    const months = aggMap.get(key)!;
    const row: any[] = [vendor, cutName];
    let totalKg = 0, totalEur = 0;
    for (const m of months) {
      row.push(Math.round(m.kg * 1000) / 1000);
      row.push(Math.round(m.eur * 100) / 100);
      totalKg  += m.kg;
      totalEur += m.eur;
    }
    row.push(Math.round(totalKg * 1000) / 1000);
    row.push(Math.round(totalEur * 100) / 100);
    dataRows.push(row);
  }

  const sheetData = [headerRow, ...dataRows];

  // ── 5. Clear and rewrite sheet ─────────────────────────────────────────────
  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(SHEET, "A:AZ")}:clear`;
  await fetch(clearUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });

  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(SHEET, "A1")}?valueInputOption=USER_ENTERED`;
  const writeRes = await fetch(writeUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: sheetData }),
  });
  if (!writeRes.ok) throw new Error(`Meat_Monthly write error: ${await writeRes.text()}`);

  const meatSheetId = await getSheetIdByTitle(spreadsheetId, SHEET, accessToken);
  if (meatSheetId != null && sheetData.length > 0) {
    const nCols = sheetData.reduce((m, r) => Math.max(m, r.length), 0);
    await applyThinTextFormatToGridRange(spreadsheetId, accessToken, meatSheetId, {
      startRowIndex: 0,
      endRowIndex: sheetData.length,
      startColumnIndex: 0,
      endColumnIndex: Math.max(nCols, 1),
    });
  }

  console.log(`✅ Meat_Monthly updated: ${dataRows.length} cut rows across ${meatInvoices.length} invoices`);
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
