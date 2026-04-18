import {
  isMeatLotOrigenTraceabilityLine,
  shouldIncludeInvoiceInMeatLineSheets,
} from "../shared/invoice-types";
import {
  DEFAULT_MEAT_LINE_IVA_PERCENT,
  parseMoney,
  reconcileMeatLineItemsForInvoice,
} from "../shared/meat-line-reconcile";
import { canonicalVendorDisplayName } from "../shared/vendor-canonical";
import { receiptSheetsReceiptUrlCell } from "../shared/sheets-defaults";
import {
  applyBoldTextFormatToGridRange,
  applyDateDisplayFormatDdMmYyyy,
  applyThinTextFormatToGridRange,
  applyWarningHighlightToDataRows,
  encodeValuesRange,
  ensureSheetExists,
  fetchSheetsApiWithRetry,
  getSheetIdByTitle,
  sleepMs,
  TRACKER_COLUMN_COUNT,
} from "./sheets-automation";

/** Max |round2(kg×€/kg) − Importe| in €; avoids false warnings when €/kg is rounded for display. */
const LINE_QTY_PRICE_EPS = 0.07;
/** Main Total vs sum of meat line Importe (€); slightly loose for sheet float + cent rounding. */
const HEADER_VS_LINES_EPS = 0.12;
/** When main sheet total is gross (IVA incl.) but N column line totals are net/ex-VAT — allow ~10% gap. */
const HEADER_NET_VS_GROSS_IVA_EPS = 0.18;

/**
 * Main tracker "Total" is often the amount **to pay** (IVA included). Column N may store line totals as
 * **net / subtotal before invoice IVA** (e.g. La Portenia IMPORTE 81,07 vs TOTAL 89,18). Treat that as consistent.
 */
function headerMatchesMeatLineSumAllowingNetVsGross(
  sumLines: number,
  header: number,
  lines: Array<{ ivaPercent: number | "" }>,
): boolean {
  if (header <= 0 || sumLines <= 0) return false;
  if (Math.abs(sumLines - header) <= HEADER_VS_LINES_EPS) return true;
  const ivas = lines.map((l) => l.ivaPercent).filter((x): x is number => typeof x === "number" && x > 0);
  const ratePct = ivas.length > 0 ? ivas[0] : DEFAULT_MEAT_LINE_IVA_PERCENT;
  const grossFromNet = sumLines * (1 + ratePct / 100);
  const netFromGross = header / (1 + ratePct / 100);
  if (Math.abs(grossFromNet - header) <= HEADER_NET_VS_GROSS_IVA_EPS) return true;
  if (Math.abs(netFromGross - sumLines) <= HEADER_NET_VS_GROSS_IVA_EPS) return true;
  return false;
}

/** Per-vendor lines are noisy in Railway; set VERBOSE_SHEETS_AGG_LOG=1 to enable. */
const verboseSheetsAggLog =
  process.env.VERBOSE_SHEETS_AGG_LOG === "1" ||
  process.env.NODE_ENV === "development";
const MEAT_SHEET_WRITE_GAP_MS = 3000;

export interface SheetAutomationConfig {
  spreadsheetId: string;
  accessToken: string;
  invoiceData?: any[];
}

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Google Sheets date serial → ISO YYYY-MM-DD (UTC calendar day).
 * Same origin as Sheets: 1899-12-30 + whole days.
 */
export function googleSheetsSerialToIsoYmd(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(Math.abs(serial));
  if (whole < 20000 || whole > 120000) return null;
  const MS_PER_DAY = 86400000;
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + whole * MS_PER_DAY);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2050) return null;
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Normalize main-tracker column D when automation reads `valueRenderOption=FORMULA`:
 * `=DATE(…)`, DD/MM/YYYY text, YYYY. M. D text, ISO, or numeric serial
 * (Sheets often returns serial for date cells).
 */
export function parseMainTrackerDateCellToIso(val: unknown): string {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number" && Number.isFinite(val)) {
    return googleSheetsSerialToIsoYmd(val) ?? "";
  }
  const s = String(val).replace(/^'+|'+$/g, "").trim();
  if (!s) return "";
  const formula = s.match(/^=DATE\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})\)$/i);
  if (formula) {
    return `${formula[1]}-${formula[2].padStart(2, "0")}-${formula[3].padStart(2, "0")}`;
  }
  const numericOnly = /^-?\d+\.?\d*$/.test(s);
  if (numericOnly) {
    const iso = googleSheetsSerialToIsoYmd(Number(s));
    if (iso) return iso;
  }
  const mEu = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mEu) return `${mEu[3]}-${mEu[2].padStart(2, "0")}-${mEu[1].padStart(2, "0")}`;
  const mDot = s.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})$/);
  if (mDot) return `${mDot[1]}-${mDot[2].padStart(2, "0")}-${mDot[3].padStart(2, "0")}`;
  const isoHead = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoHead) return `${isoHead[1]}-${isoHead[2]}-${isoHead[3]}`;
  return s;
}

/**
 * Same storage as main tracker column D (`=DATE(y,m,d)`), from any value parseMainTrackerDateCellToIso accepts.
 * Keeps monthly / quarterly / meat Date columns aligned with the main sheet display and sorting.
 */
export function trackerDateToSheetsDateCell(raw: unknown): string {
  const iso = parseMainTrackerDateCellToIso(raw);
  if (!iso) return String(raw ?? "").trim();
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return iso;
  return `=DATE(${y},${mo},${d})`;
}

/**
 * Get month name from date string (supports DD/MM/YYYY, YYYY-MM-DD, =DATE(), Sheets serial)
 */
function getMonthFromDate(dateStr: string): string | null {
  const iso = parseMainTrackerDateCellToIso(String(dateStr ?? ""));
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const monthIndex = parseInt(m[2], 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return MONTH_LONG[monthIndex];
}

/**
 * Get quarter from date string (supports DD/MM/YYYY, YYYY-MM-DD, and "2026. 3. 25" formats)
 */
function getQuarterFromDate(dateStr: string): string {
  try {
    const iso = parseMainTrackerDateCellToIso(String(dateStr ?? "").trim());
    if (iso) {
      const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const month = parseInt(m[2], 10);
        return `Q${Math.ceil(month / 3)}`;
      }
    }
    let date: Date;
    const cleanStr = String(dateStr).trim().replace(/^'+/, "");
    // Try "2026. 3. 25" format
    if (cleanStr.includes(".")) {
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
    if (Number.isNaN(date.getTime())) return "";
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
    v.date = parseMainTrackerDateCellToIso(v.date) || String(v.date ?? "").trim();
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

/** L column: plain https URLs stay clickable; preserve existing =… formulas if any */
function receiptCellForAggregatedSheet(imageUrl: string | undefined): string {
  const s = String(imageUrl ?? "").trim();
  if (!s) return "";
  if (s.startsWith("=")) return s;
  if (/^https?:\/\//i.test(s)) {
    return receiptSheetsReceiptUrlCell(s);
  }
  return s;
}

/**
 * Format currency for Google Sheets — returns plain number, not a string
 */
function formatCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function toQuotedA1Range(sheetTitle: string, a1: string): string {
  return `'${String(sheetTitle).replace(/'/g, "''")}'!${a1}`;
}

function parseSheetTitleFromA1Range(range: string): string {
  const raw = String(range ?? "").trim();
  const bang = raw.indexOf("!");
  const left = bang >= 0 ? raw.slice(0, bang).trim() : raw;
  if (!left) return "";
  if (left.startsWith("'") && left.endsWith("'") && left.length >= 2) {
    return left.slice(1, -1).replace(/''/g, "'");
  }
  return left;
}

async function batchGetSheetValuesByTitle(
  accessToken: string,
  spreadsheetId: string,
  rangesByTitle: Record<string, string>,
): Promise<Record<string, unknown[][]>> {
  const entries = Object.entries(rangesByTitle);
  if (entries.length === 0) return {};

  const query = new URLSearchParams();
  for (const [sheetTitle, a1] of entries) {
    query.append("ranges", toQuotedA1Range(sheetTitle, a1));
  }
  query.set("valueRenderOption", "FORMULA");
  query.set("majorDimension", "ROWS");

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${query.toString()}`;
  const res = await fetchSheetsApiWithRetry(
    url,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    "batchGet values",
  );
  if (!res.ok) {
    throw new Error(`batchGet values error: ${await res.text()}`);
  }
  const payload = (await res.json()) as {
    valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
  };
  const byTitle = new Map<string, unknown[][]>();
  for (const vr of payload.valueRanges ?? []) {
    const title = parseSheetTitleFromA1Range(String(vr.range ?? ""));
    if (title) byTitle.set(title, vr.values ?? []);
  }
  const out: Record<string, unknown[][]> = {};
  for (const [sheetTitle] of entries) {
    out[sheetTitle] = byTitle.get(sheetTitle) ?? [];
  }
  return out;
}

async function rewriteAggregatedTrackerSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  sheetRows: any[][],
  existingValues?: unknown[][],
): Promise<"updated" | "unchanged"> {
  const nCols = Math.max(
    1,
    sheetRows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0),
  );
  const endCol = toA1ColumnLabel(nCols);
  const compareRows = existingValues ?? [];
  if (areSheetRowsEquivalent(compareRows, sheetRows)) {
    return "unchanged";
  }

  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetTitle, `A:${endCol}`)}:clear`;
  const clearRes = await fetchSheetsApiWithRetry(
    clearUrl,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    },
    `${sheetTitle} values.clear`,
  );
  if (!clearRes.ok) {
    throw new Error(`${sheetTitle} clear error: ${await clearRes.text()}`);
  }

  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetTitle, "A1")}?valueInputOption=USER_ENTERED`;
  const updateRes = await fetchSheetsApiWithRetry(
    updateUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: sheetRows }),
    },
    `${sheetTitle} values.update`,
  );
  if (!updateRes.ok) {
    throw new Error(`${sheetTitle} update error: ${await updateRes.text()}`);
  }

  const sheetId = await getSheetIdByTitle(spreadsheetId, sheetTitle, accessToken);
  if (sheetId != null && sheetRows.length > 0) {
    await applyBoldTextFormatToGridRange(spreadsheetId, accessToken, sheetId, {
      startRowIndex: 0,
      endRowIndex: Math.min(2, sheetRows.length),
      startColumnIndex: 0,
      endColumnIndex: TRACKER_COLUMN_COUNT,
    });
    if (sheetRows.length > 2) {
      await applyThinTextFormatToGridRange(spreadsheetId, accessToken, sheetId, {
        startRowIndex: 2,
        endRowIndex: sheetRows.length,
        startColumnIndex: 0,
        endColumnIndex: TRACKER_COLUMN_COUNT,
      });
      await applyDateDisplayFormatDdMmYyyy(spreadsheetId, accessToken, sheetId, {
        startRowIndex: 2,
        endRowIndex: sheetRows.length,
        startColumnIndex: 3,
        endColumnIndex: 4,
      });
    }
  }

  return "updated";
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

  let excludedByUnparsedDate = 0;
  const unparsedDateSamples: string[] = [];
  for (const invoice of invoiceData) {
    const month = getMonthFromDate(invoice.date);
    if (month && invoicesByMonth[month]) {
      invoicesByMonth[month].push(invoice);
    } else {
      excludedByUnparsedDate += 1;
      if (unparsedDateSamples.length < 5) {
        unparsedDateSamples.push(String(invoice.date ?? "").trim());
      }
    }
  }
  if (excludedByUnparsedDate > 0) {
    console.warn(
      `[Sheets] Monthly: skipped ${excludedByUnparsedDate} row(s) with unparsed dates. Samples: ${unparsedDateSamples.join(" | ")}`,
    );
  }

  const header = [
    "Source", "Invoice #", "Vendor", "Date", "IVA (€)", "Base (€)", "Tip (€)", "Total (€) inc IVA",
    "Category", "Currency", "Notes", "Receipt", "Exported At"
  ];

  // Even when a month has no rows, keep the header visible so the tab is not blank.
  for (const month of months) {
    const ok = await ensureSheetExists(spreadsheetId, month, accessToken, header);
    if (!ok) {
      console.warn(`⚠️ Could not ensure sheet "${month}" — skipping`);
    }
  }
  const readRanges: Record<string, string> = {};
  for (const month of months) {
    readRanges[month] = `A1:${toA1ColumnLabel(header.length)}`;
  }
  const existingByMonth = await batchGetSheetValuesByTitle(accessToken, spreadsheetId, readRanges);

  // Always refresh every month tab (header + TOTAL row). Previously only `activeMonths` were
  // updated, so November/December often kept an old layout or missed the TOTAL row when empty.
  for (const month of months) {
    const monthInvoices = invoicesByMonth[month];
    const aggregated = aggregateByVendor(monthInvoices);

    const sheetRows: any[] = [header];

    // Always add TOTAL row with SUM formulas for automatic calculation
    const totalRow = [
      "", "", `${month} TOTAL`, "",
      "=SUM(E3:E1000)",      // E: IVA (€) - auto sum
      "=SUM(F3:F1000)",      // F: Base (€) - auto sum
      "=SUM(G3:G1000)",      // G: Tip (€) - auto sum
      "=SUM(H3:H1000)",      // H: Total (€) - auto sum
      "", "", "", "", ""
    ];
    sheetRows.push(totalRow);

    // Add vendor rows (aggregated)
    for (const vendor of aggregated) {
      const row = [
        vendor.source?.toLowerCase() === "camera" ? "Camera" : "Email", // A: Source
        vendor.invoiceNumber,    // B: Invoice #
        vendor.vendor,           // C: Vendor
        trackerDateToSheetsDateCell(vendor.date), // D: Date (=DATE like main tracker)
        vendor.ivaAmount,        // E: IVA (€) - as number, not string!
        vendor.baseAmount,       // F: Base (€) - as number, not string!
        vendor.tip ?? 0,         // G: Tip (€) - as number, not string!
        vendor.totalAmount,      // H: Total (€) - as number, not string!
        vendor.category,         // I: Category
        vendor.currency,         // J: Currency
        vendor.notes,            // K: Notes
        receiptCellForAggregatedSheet(vendor.imageUrl), // L: same formula as main tracker when possible
        ""                       // M: Exported At
      ];
      sheetRows.push(row);
    }

    const status = await rewriteAggregatedTrackerSheet(
      accessToken,
      spreadsheetId,
      month,
      sheetRows,
      existingByMonth[month],
    );
    if (status === "unchanged") {
      console.log(`ℹ️  ${month} sheet unchanged: skipped clear/update (${aggregated.length} vendors)`);
    } else {
      console.log(`✅ Updated ${month} sheet: ${aggregated.length} vendors`);
    }
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

  const header = [
    "Source", "Invoice #", "Vendor", "Date", "IVA (€)", "Base (€)", "Tip (€)", "Total (€) inc IVA",
    "Category", "Currency", "Notes", "Receipt", "Exported At"
  ];

  // Even when a quarter has no rows, keep the header visible so the tab is not blank.
  for (const quarter of quarters) {
    const ok = await ensureSheetExists(spreadsheetId, quarter, accessToken, header);
    if (!ok) {
      console.warn(`⚠️ Could not ensure sheet "${quarter}" — skipping`);
    }
  }
  const readRanges: Record<string, string> = {};
  for (const quarter of quarters) {
    readRanges[quarter] = `A1:${toA1ColumnLabel(header.length)}`;
  }
  const existingByQuarter = await batchGetSheetValuesByTitle(accessToken, spreadsheetId, readRanges);

  // Always refresh all quarter tabs so Q4 (Oct–Dec) gets the same header + TOTAL template even when empty.
  for (const quarter of quarters) {
    const quarterInvoices = invoicesByQuarter[quarter];
    const aggregated = aggregateByVendor(quarterInvoices);

    const sheetRows: any[] = [header];

    // Always add TOTAL row with SUM formulas for automatic calculation
    const totalRow = [
      "", "", "QUARTERLY TOTAL", "",
      "=SUM(E3:E1000)",      // E: IVA (€) - auto sum
      "=SUM(F3:F1000)",      // F: Base (€) - auto sum
      "=SUM(G3:G1000)",      // G: Tip (€) - auto sum
      "=SUM(H3:H1000)",      // H: Total (€) - auto sum
      "", "", "", "", ""
    ];
    sheetRows.push(totalRow);

    // Add vendor rows (aggregated)
    for (const vendor of aggregated) {
      const row = [
        vendor.source?.toLowerCase() === "camera" ? "Camera" : "Email", // A: Source
        vendor.invoiceNumber,    // B: Invoice #
        vendor.vendor,           // C: Vendor
        trackerDateToSheetsDateCell(vendor.date), // D: Date (=DATE like main tracker)
        vendor.ivaAmount,        // E: IVA (€) - as number, not string!
        vendor.baseAmount,       // F: Base (€) - as number, not string!
        vendor.tip ?? 0,         // G: Tip (€) - as number, not string!
        vendor.totalAmount,      // H: Total (€) - as number, not string!
        vendor.category,         // I: Category
        vendor.currency,         // J: Currency
        vendor.notes,            // K: Notes
        receiptCellForAggregatedSheet(vendor.imageUrl),
        ""                       // M: Exported At
      ];
      sheetRows.push(row);
    }

    const status = await rewriteAggregatedTrackerSheet(
      accessToken,
      spreadsheetId,
      quarter,
      sheetRows,
      existingByQuarter[quarter],
    );
    if (status === "unchanged") {
      console.log(`ℹ️  ${quarter} sheet unchanged: skipped clear/update (${aggregated.length} vendors)`);
    } else {
      console.log(`✅ Updated ${quarter} sheet: ${aggregated.length} vendors`);
    }
  }
}

// ─── Meat Item Sheets ─────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Human-readable reason when column N cannot be turned into meat line items (rebuild / debug).
 */
export function meatItemsColumnNDiagnostic(val: unknown): string | null {
  if (val === null || val === undefined) return "N열이 비어 있습니다.";
  let s = String(val).replace(/^\uFEFF/, "").trim();
  if (!s || s === "FALSE" || s === "TRUE") return "N열이 비어 있거나 불린입니다.";
  if (!s.startsWith("[")) {
    return `N열은 JSON 배열이어야 하며 [ 로 시작해야 합니다. 앞부분: ${JSON.stringify(s.slice(0, 36))}${s.length > 36 ? "…" : ""}`;
  }
  try {
    JSON.parse(s);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `JSON 문법 오류: ${msg} (따옴표/쉼표/대괄호를 다시 확인하세요)`;
  }
  const items = parseTrackerMeatItemsJsonCell(val);
  if (items?.length) return null;
  return "JSON은 읽혔지만 유효한 고기 줄이 없습니다. partName·quantity(>0)·total(>0)이 있는지, LOTE/추적 전용 줄만 있지 않은지 확인하세요.";
}

/** Column N on main tracker: JSON array of meat line items (optional ivaPercent, net total flags). */
export function parseTrackerMeatItemsJsonCell(val: unknown):
  | Array<{
      partName: string;
      quantity: number;
      unit: string;
      pricePerUnit: number;
      total: number;
      ivaPercent?: number;
      totalIsNet?: boolean;
      lineTotalIsNet?: boolean;
      totalIncludesVat?: boolean;
    }>
  | undefined {
  if (val === null || val === undefined) return undefined;
  const s = String(val).replace(/^\uFEFF/, "").trim();
  if (!s || s === "FALSE" || s === "TRUE") return undefined;
  if (!s.startsWith("[")) return undefined;
  try {
    const arr = JSON.parse(s) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const out: Array<{
      partName: string;
      quantity: number;
      unit: string;
      pricePerUnit: number;
      total: number;
      ivaPercent?: number;
      totalIsNet?: boolean;
      lineTotalIsNet?: boolean;
      totalIncludesVat?: boolean;
    }> = [];
    for (const el of arr) {
      if (!el || typeof el !== "object") continue;
      const o = el as Record<string, unknown>;
      const partName = String(o.partName ?? "").trim();
      if (isMeatLotOrigenTraceabilityLine(partName)) continue;
      const quantity = Number(o.quantity);
      const unit = String(o.unit ?? "kg").trim() || "kg";
      const pricePerUnit = Number(o.pricePerUnit);
      const total = Number(o.total);
      if (!partName || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(total) || total <= 0) {
        continue;
      }
      const pp = Number.isFinite(pricePerUnit) && pricePerUnit > 0 ? pricePerUnit : total / quantity;
      const ivaRaw = Number(o.ivaPercent ?? o.iva);
      const row: (typeof out)[number] = {
        partName,
        quantity: Math.round(quantity * 1000) / 1000,
        unit,
        pricePerUnit: Math.round(pp * 100) / 100,
        total: Math.round(total * 100) / 100,
      };
      if (Number.isFinite(ivaRaw) && ivaRaw > 0 && ivaRaw <= 30) {
        row.ivaPercent = Math.round(ivaRaw * 100) / 100;
      }
      if (o.totalIsNet === true) row.totalIsNet = true;
      if (o.lineTotalIsNet === true) row.lineTotalIsNet = true;
      if (o.totalIncludesVat === false) row.totalIncludesVat = false;
      out.push(row);
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function getMonthIndexFromDate(dateStr: string): number {
  const iso = parseMainTrackerDateCellToIso(String(dateStr ?? ""));
  if (!iso) return -1;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return -1;
  const idx = parseInt(m[2], 10) - 1;
  return idx >= 0 && idx <= 11 ? idx : -1;
}

function normalizeMeatVendorName(vendor: string): string {
  const c = canonicalVendorDisplayName(String(vendor ?? "").trim());
  return c || String(vendor ?? "").trim().replace(/\s+/g, " ") || "Unknown";
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
  /** Internal only (net vs gross heuristic). Not written as its own column. */
  ivaPercent: number | "";
  pricePerKgExVat: number | "";
  pricePerKgIncVat: number;
  /** Line gross total (IVA included), same idea as main column E. */
  totalEur: number;
  /** Line IVA amount (€), same idea as main column F. */
  ivaAmountEur: number | "";
  /** Line net / base (€), same idea as main column G. */
  baseEur: number | "";
  source: string;
  /** True: 줄 합계 ≠ 메인 시트 총액, 또는 kg×€/kg ≠ Importe (수동 확인 권장). */
  highlightWarning: boolean;
};

function roundMeatMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Split a VAT-**inclusive** line total (Importe) into base + cuota IVA (Spain).
 * For 10% general rate: IVA = gross × 10/110 (not gross × 10%), so Base + IVA = Total exactly.
 */
function lineBaseAndIvaFromGross(
  gross: number,
  ivaPct: number | null,
): { baseEur: number | ""; ivaAmountEur: number | "" } {
  if (!(gross > 0)) return { baseEur: "", ivaAmountEur: "" };
  if (ivaPct == null || ivaPct <= 0) {
    return { baseEur: roundMeatMoney(gross), ivaAmountEur: "" };
  }
  const base = roundMeatMoney(gross / (1 + ivaPct / 100));
  const iva = roundMeatMoney(gross - base);
  return { baseEur: base, ivaAmountEur: iva };
}

export function buildMeatLineItems(invoices: any[]): MeatItemRow[] {
  const rows: MeatItemRow[] = [];
  for (const inv of invoices) {
    if (
      !shouldIncludeInvoiceInMeatLineSheets({
        items: inv.items,
        category: inv.category,
        vendor: inv.vendor,
      })
    ) {
      continue;
    }
    const vendor = normalizeMeatVendorName(inv.vendor);
    const monthIndex = getMonthIndexFromDate(inv.date || "");
    if (monthIndex < 0 || monthIndex > 11) continue;
    const month = MONTH_ABBR[monthIndex];
    const reconciled = reconcileMeatLineItemsForInvoice(inv.items, {
      totalAmount: parseMoney(inv.totalAmount),
      vendor: String(inv.vendor ?? ""),
    });
    const chunk: MeatItemRow[] = [];
    const headerTotalMain = parseMoney(inv.totalAmount);
    for (const item of reconciled) {
      const cutName = normalizeMeatCutName(item.partName);
      if (isMeatLotOrigenTraceabilityLine(cutName)) continue;
      const quantityKg = item.quantity;
      const totalEur = item.total;
      const inc = item.pricePerKgIncVat;
      if (!cutName || quantityKg <= 0 || totalEur <= 0) continue;
      const iva = item.ivaPercentResolved;
      const ex = item.pricePerKgExVat;
      const { baseEur, ivaAmountEur } = lineBaseAndIvaFromGross(totalEur, iva);
      chunk.push({
        month,
        monthIndex,
        date: String(inv.date ?? "").trim(),
        vendor,
        invoiceNumber: String(inv.invoiceNumber ?? "").trim(),
        cutName,
        quantityKg: Math.round(quantityKg * 1000) / 1000,
        ivaPercent: iva != null ? iva : "",
        pricePerKgExVat: ex != null ? Math.round(ex * 100) / 100 : "",
        pricePerKgIncVat: Math.round(inc * 100) / 100,
        totalEur: Math.round(totalEur * 100) / 100,
        ivaAmountEur,
        baseEur,
        source: String(inv.source ?? "").toLowerCase() === "camera" ? "Camera" : "Email",
        highlightWarning: false,
      });
    }
    const sumChunk = roundMeatMoney(chunk.reduce((s, r) => s + r.totalEur, 0));
    const headerMismatch =
      headerTotalMain > 0 &&
      !headerMatchesMeatLineSumAllowingNetVsGross(sumChunk, headerTotalMain, chunk);
    for (const r of chunk) {
      const impliedFromDisplayed = roundMeatMoney(r.quantityKg * r.pricePerKgIncVat);
      const lineGap = Math.abs(impliedFromDisplayed - r.totalEur);
      r.highlightWarning = headerMismatch || lineGap > LINE_QTY_PRICE_EPS;
    }
    rows.push(...chunk);
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
    .sort(
      (a, b) =>
        MONTH_ABBR.indexOf(a.month) - MONTH_ABBR.indexOf(b.month) || a.vendor.localeCompare(b.vendor),
    )
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
    .sort(
      (a, b) =>
        MONTH_ABBR.indexOf(a.month) - MONTH_ABBR.indexOf(b.month) || a.cutName.localeCompare(b.cutName),
    )
    .map((entry) => [
      entry.month,
      entry.cutName,
      Math.round(entry.totalKg * 1000) / 1000,
      Math.round(entry.totalEur * 100) / 100,
      entry.totalKg > 0 ? Math.round((entry.totalEur / entry.totalKg) * 100) / 100 : 0, // avg €/kg inc IVA (= spend / kg)
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
  existingValues?: unknown[][],
): Promise<void> {
  const sheetData = [headerRow, ...dataRows];
  const clearEndColumnLetter = toA1ColumnLabel(Math.max(headerRow.length, 1));
  const compareRows = existingValues ?? [];
  if (areSheetRowsEquivalent(compareRows, sheetData)) {
    console.log(`ℹ️  ${sheetTitle}: unchanged — skipped clear/update`);
    return;
  }

  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetTitle, `A1:${clearEndColumnLetter}${sheetData.length}`)}?valueInputOption=USER_ENTERED`;
  const writeRes = await fetchSheetsApiWithRetry(
    writeUrl,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: sheetData }),
    },
    `${sheetTitle} values.update`,
  );
  if (!writeRes.ok) throw new Error(`${sheetTitle} write error: ${await writeRes.text()}`);

  const prevRows = normalizeSheetRows(compareRows).length;
  if (prevRows > sheetData.length) {
    const staleStart = sheetData.length + 1;
    const staleEnd = prevRows;
    const staleClearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetTitle, `A${staleStart}:${clearEndColumnLetter}${staleEnd}`)}:clear`;
    const staleClearRes = await fetchSheetsApiWithRetry(
      staleClearUrl,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      },
      `${sheetTitle} values.clear(stale-tail)`,
    );
    if (!staleClearRes.ok) {
      throw new Error(`${sheetTitle} stale-tail clear error: ${await staleClearRes.text()}`);
    }
  }

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

/** 1-based column index -> A1 column label (1=A, 27=AA). */
function toA1ColumnLabel(columnIndex: number): string {
  const safe = Math.max(1, Math.floor(columnIndex));
  let n = safe;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function normalizeSheetRows(rows: unknown): string[][] {
  if (!Array.isArray(rows)) return [];
  const normalized = rows.map((rawRow) => {
    const row = Array.isArray(rawRow) ? rawRow : [];
    const normalizedRow = row.map((cell) => normalizeSheetCell(cell));
    let lastNonEmpty = normalizedRow.length - 1;
    while (lastNonEmpty >= 0 && normalizedRow[lastNonEmpty] === "") {
      lastNonEmpty -= 1;
    }
    return normalizedRow.slice(0, lastNonEmpty + 1);
  });
  let lastNonEmptyRow = normalized.length - 1;
  while (lastNonEmptyRow >= 0 && normalized[lastNonEmptyRow].length === 0) {
    lastNonEmptyRow -= 1;
  }
  return normalized.slice(0, lastNonEmptyRow + 1);
}

function normalizeSheetCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (Object.is(value, -0)) return "0";
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  return String(value);
}

function areSheetRowsEquivalent(left: unknown, right: unknown): boolean {
  const leftRows = normalizeSheetRows(left);
  const rightRows = normalizeSheetRows(right);
  if (leftRows.length !== rightRows.length) return false;
  for (let i = 0; i < leftRows.length; i += 1) {
    const a = leftRows[i];
    const b = rightRows[i];
    if (a.length !== b.length) return false;
    for (let j = 0; j < a.length; j += 1) {
      if (a[j] !== b[j]) return false;
    }
  }
  return true;
}

export async function updateMeatSheets(
  accessToken: string,
  spreadsheetId: string,
  invoices: any[]
): Promise<void> {
  /** Source first; last column is line gross (IVA included), matching main tracker Total (€). */
  /** No separate €/kg ex column — derivable from €/kg inc IVA and IVA % (or from Base ÷ kg). */
  const lineItemHeader = [
    "Source",
    "Month",
    "Date",
    "Vendor",
    "Invoice #",
    "Cut Name",
    "Quantity (kg)",
    "€/kg inc IVA (P.V.P.)",
    "Base (€)",
    "IVA (€)",
    "Total (€) inc IVA",
  ];
  const meatLineColumnCount = lineItemHeader.length;
  const ordersHeader = ["Month", "Vendor", "Order Count", "Total Meat Kg", "Total Meat Spend (€) inc IVA"];
  const cutSummaryHeader = [
    "Month",
    "Cut Name",
    "Total Kg",
    "Total Spend (€) inc IVA",
    "Avg €/kg inc IVA",
  ];
  const monthlySummaryHeader = [
    "Month",
    "Total Meat Kg",
    "Total Meat Spend (€) inc IVA",
    "Invoice Count",
    "Vendor Count",
  ];

  // Keep meat tabs visible with headers even when there are no meat rows yet.
  await ensureSheetExists(spreadsheetId, "Meat_Line_Items", accessToken, lineItemHeader);
  await ensureSheetExists(spreadsheetId, "Meat_Orders", accessToken, ordersHeader);
  await ensureSheetExists(spreadsheetId, "Meat_Cut_Summary", accessToken, cutSummaryHeader);
  await ensureSheetExists(spreadsheetId, "Meat_Monthly_Summary", accessToken, monthlySummaryHeader);
  const meatReadRanges: Record<string, string> = {
    Meat_Line_Items: `A1:${toA1ColumnLabel(lineItemHeader.length)}`,
    Meat_Orders: `A1:${toA1ColumnLabel(ordersHeader.length)}`,
    Meat_Cut_Summary: `A1:${toA1ColumnLabel(cutSummaryHeader.length)}`,
    Meat_Monthly_Summary: `A1:${toA1ColumnLabel(monthlySummaryHeader.length)}`,
  };
  const existingMeatBySheet = await batchGetSheetValuesByTitle(
    accessToken,
    spreadsheetId,
    meatReadRanges,
  );

  const meatItems = buildMeatLineItems(invoices);
  if (meatItems.length === 0) {
    console.log("ℹ️  No meat line items found — meat sheets not updated");
    return;
  }
  const lineItemRows = meatItems.map((item) => [
    item.source,
    item.month,
    trackerDateToSheetsDateCell(item.date),
    item.vendor,
    item.invoiceNumber,
    item.cutName,
    item.quantityKg,
    item.pricePerKgIncVat,
    item.baseEur,
    item.ivaAmountEur,
    item.totalEur,
  ]);
  await rewriteMeatSheet(
    accessToken,
    spreadsheetId,
    "Meat_Line_Items",
    lineItemHeader,
    lineItemRows,
    existingMeatBySheet.Meat_Line_Items,
  );
  const meatLineItemsSheetId = await getSheetIdByTitle(spreadsheetId, "Meat_Line_Items", accessToken);
  if (meatLineItemsSheetId != null && lineItemRows.length > 0) {
    /** Format entire Date column (C) for many rows so older lines also show dd/mm/yyyy after one rebuild. */
    const dateFormatEndRow = Math.max(lineItemRows.length + 1, 1001);
    await applyDateDisplayFormatDdMmYyyy(spreadsheetId, accessToken, meatLineItemsSheetId, {
      startRowIndex: 1,
      endRowIndex: dateFormatEndRow,
      startColumnIndex: 2,
      endColumnIndex: 3,
    });
    const nFlag = meatItems.filter((r) => r.highlightWarning).length;
    if (nFlag > 0) {
      console.log(
        `⚠️  Meat_Line_Items: ${nFlag} row(s) highlighted (amount ≠ main total or kg×€/kg ≠ line total — review colors)`,
      );
    }
    await applyWarningHighlightToDataRows(
      spreadsheetId,
      accessToken,
      meatLineItemsSheetId,
      meatItems.map((m) => m.highlightWarning),
      meatLineColumnCount,
    );
  }
  /** Space out meat tab writes — same 60 writes/min bucket as monthly/Q automation above. */
  await sleepMs(MEAT_SHEET_WRITE_GAP_MS);
  const ordersRows = buildMeatOrdersRows(meatItems);
  await rewriteMeatSheet(
    accessToken,
    spreadsheetId,
    "Meat_Orders",
    ordersHeader,
    ordersRows,
    existingMeatBySheet.Meat_Orders,
  );
  await sleepMs(MEAT_SHEET_WRITE_GAP_MS);
  const cutSummaryRows = buildMeatCutSummaryRows(meatItems);
  await rewriteMeatSheet(
    accessToken,
    spreadsheetId,
    "Meat_Cut_Summary",
    cutSummaryHeader,
    cutSummaryRows,
    existingMeatBySheet.Meat_Cut_Summary,
  );
  await sleepMs(MEAT_SHEET_WRITE_GAP_MS);
  const monthlySummaryRows = buildMeatMonthlySummaryRows(meatItems);
  await rewriteMeatSheet(
    accessToken,
    spreadsheetId,
    "Meat_Monthly_Summary",
    monthlySummaryHeader,
    monthlySummaryRows,
    existingMeatBySheet.Meat_Monthly_Summary,
  );

  console.log(`✅ Meat sheets updated: ${meatItems.length} line items`);
}

/**
 * Main automation function
 */
export async function automateGoogleSheets(config: SheetAutomationConfig): Promise<void> {
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
