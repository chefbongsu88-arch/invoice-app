/**
 * Google Sheets Automation Module
 * Handles monthly, quarterly, and meat-specific sheet creation and management
 */

// Note: This module is imported dynamically in routers.ts

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
 * Build encoded `Sheet!A1` segment for `/values/{range}` URLs.
 * Wrap the title in single quotes (with '' for embedded quotes) so names like `Meat_Monthly`
 * or `2026 Invoice tracker` parse reliably — avoids Google 400 "Unable to parse range".
 */
export function encodeValuesRange(sheetName: string, a1: string): string {
  const title = String(sheetName).trim();
  const quoted = `'${title.replace(/'/g, "''")}'`;
  return encodeURIComponent(`${quoted}!${a1}`);
}

/** Columns A–N for tracker-style sheets (13 core + Meat line items JSON in N). */
export const TRACKER_COLUMN_COUNT = 14;
/** Shared backoff for cosmetic repeatCell batchUpdate calls (bold/thin/date) — same Sheets write quota bucket. */
let sheetsCosmeticBatchBackoffUntilMs = 0;

/** 0-based column index from A1 letters (A=0, …, Z=25, AA=26, …). */
export function a1ColumnLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    if (ch < "A" || ch > "Z") return 0;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/**
 * Parse a value append `updatedRange` like `'Sheet Name'!A12:M14` into grid indices (endRowIndex exclusive).
 */
export function parseAppendUpdatedRangeToGridRange(updatedRange: string): {
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
} | null {
  const bang = updatedRange.lastIndexOf("!");
  const coords = bang === -1 ? updatedRange : updatedRange.slice(bang + 1);
  const m = coords.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
  if (!m) return null;
  const startRow1 = parseInt(m[2], 10);
  const endRow1 = parseInt(m[4], 10);
  const startCol = a1ColumnLettersToIndex(m[1]);
  const endCol = a1ColumnLettersToIndex(m[3]);
  return {
    startRowIndex: startRow1 - 1,
    endRowIndex: endRow1,
    startColumnIndex: startCol,
    endColumnIndex: endCol + 1,
  };
}

export async function getSheetIdByTitle(
  spreadsheetId: string,
  sheetTitle: string,
  accessToken: string,
): Promise<number | null> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    sheets?: Array<{ properties: { title: string; sheetId: number } }>;
  };
  const sheet = data.sheets?.find((s) => s.properties.title === sheetTitle);
  return sheet?.properties.sheetId ?? null;
}

/**
 * Normal weight, slightly smaller Roboto — reads “thinner” than default bold headers in Sheets.
 */
export async function applyThinTextFormatToGridRange(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  range: {
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  },
): Promise<void> {
  const now = Date.now();
  if (sheetsCosmeticBatchBackoffUntilMs > now) {
    return;
  }
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: { sheetId, ...range },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    bold: false,
                    fontSize: 10,
                    fontFamily: "Roboto",
                  },
                },
              },
              fields: "userEnteredFormat.textFormat",
            },
          },
        ],
      }),
    },
  );
  if (!batchRes.ok) {
    const errText = await batchRes.text();
    // Avoid log storms + repeated 429 calls (Google write quota per minute/user).
    if (
      batchRes.status === 429 ||
      /RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|write requests per minute per user/i.test(errText)
    ) {
      sheetsCosmeticBatchBackoffUntilMs = Date.now() + 5 * 60 * 1000;
      console.log(
        "[Sheets] cosmetic format (thin) skipped for 5m due to Sheets write quota (429).",
      );
      return;
    }
    console.warn(
      "[Sheets] applyThinTextFormatToGridRange failed:",
      errText,
    );
  }
}

export async function applyBoldTextFormatToGridRange(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  range: {
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  },
): Promise<void> {
  const now = Date.now();
  if (sheetsCosmeticBatchBackoffUntilMs > now) {
    return;
  }
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: { sheetId, ...range },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    bold: true,
                    fontSize: 10,
                    fontFamily: "Roboto",
                  },
                },
              },
              fields: "userEnteredFormat.textFormat",
            },
          },
        ],
      }),
    },
  );
  if (!batchRes.ok) {
    const errText = await batchRes.text();
    if (
      batchRes.status === 429 ||
      /RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|write requests per minute per user/i.test(errText)
    ) {
      sheetsCosmeticBatchBackoffUntilMs = Date.now() + 5 * 60 * 1000;
      console.log(
        "[Sheets] cosmetic format (bold) skipped for 5m due to Sheets write quota (429).",
      );
      return;
    }
    console.warn(
      "[Sheets] applyBoldTextFormatToGridRange failed:",
      errText.length > 220 ? `${errText.slice(0, 220)}...` : errText,
    );
  }
}

/** Same display as main tracker date column: dd/mm/yyyy (values are usually =DATE(…) formulas). */
/**
 * Amber background + brown text on specific data rows (e.g. amount mismatch). Does not alter header row.
 * `flags.length` = number of data rows; row `i` maps to grid rows `startDataRowIndex + i` (default startDataRowIndex=1 below header).
 */
export async function applyWarningHighlightToDataRows(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  flags: boolean[],
  columnCount: number,
  opts?: { startDataRowIndex?: number },
): Promise<void> {
  const startDataRowIndex = opts?.startDataRowIndex ?? 1;
  const now = Date.now();
  if (sheetsCosmeticBatchBackoffUntilMs > now) {
    return;
  }
  const requests: Array<{ repeatCell: Record<string, unknown> }> = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: startDataRowIndex + i,
          endRowIndex: startDataRowIndex + i + 1,
          startColumnIndex: 0,
          endColumnIndex: Math.max(columnCount, 1),
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 0.94, blue: 0.75 },
            textFormat: {
              foregroundColor: { red: 0.5, green: 0.22, blue: 0.1 },
            },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor",
      },
    });
  }
  if (requests.length === 0) return;

  const chunkSize = 35;
  for (let offset = 0; offset < requests.length; offset += chunkSize) {
    const chunk = requests.slice(offset, offset + chunkSize);
    const batchRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ requests: chunk }),
      },
    );
    if (!batchRes.ok) {
      const errText = await batchRes.text();
      if (
        batchRes.status === 429 ||
        /RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|write requests per minute per user/i.test(errText)
      ) {
        sheetsCosmeticBatchBackoffUntilMs = Date.now() + 5 * 60 * 1000;
        console.log(
          "[Sheets] warning highlight (mismatch rows) skipped for 5m due to Sheets write quota (429).",
        );
        return;
      }
      console.warn(
        "[Sheets] applyWarningHighlightToDataRows failed:",
        errText.length > 220 ? `${errText.slice(0, 220)}...` : errText,
      );
      return;
    }
  }
}

export async function applyDateDisplayFormatDdMmYyyy(
  spreadsheetId: string,
  accessToken: string,
  sheetId: number,
  range: {
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  },
): Promise<void> {
  const now = Date.now();
  if (sheetsCosmeticBatchBackoffUntilMs > now) {
    return;
  }
  const batchRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: { sheetId, ...range },
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "DATE",
                    pattern: "dd/mm/yyyy",
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          },
        ],
      }),
    },
  );
  if (!batchRes.ok) {
    const errText = await batchRes.text();
    if (
      batchRes.status === 429 ||
      /RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|write requests per minute per user/i.test(errText)
    ) {
      sheetsCosmeticBatchBackoffUntilMs = Date.now() + 5 * 60 * 1000;
      console.log(
        "[Sheets] cosmetic format (date display) skipped for 5m due to Sheets write quota (429).",
      );
      return;
    }
    console.warn(
      "[Sheets] applyDateDisplayFormatDdMmYyyy failed:",
      errText.length > 220 ? `${errText.slice(0, 220)}...` : errText,
    );
  }
}

/** True when batchUpdate addSheet failed because a tab with that title already exists (any locale). */
export function isSheetsDuplicateTabError(body: string): boolean {
  return (
    /already exists|duplicate.*sheet|duplicate sheet|DUPLICATE_SHEET_NAME/i.test(body) ||
    /이미 있습니다|다른 이름을 입력/i.test(body)
  );
}

async function valuesRangeHasHeaderRow(
  res: Response,
): Promise<{ ok: boolean; hasHeader: boolean }> {
  if (!res.ok) return { ok: false, hasHeader: false };
  const checkData = (await res.json()) as { values?: string[][] };
  return {
    ok: true,
    hasHeader: !!(checkData.values && checkData.values.length > 0),
  };
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
    const summarizeSheetsError = (raw: string): string => {
      if (/RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|quota/i.test(raw)) {
        return "Google Sheets write quota reached. Wait a minute and try again.";
      }
      return raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
    };

    const topLeft = "A1:Z1";
    const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, topLeft)}`;
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    const checkRes = await fetch(checkUrl, { headers: authHeaders });

    let hasHeaderRow = false;

    if (checkRes.ok) {
      const parsed = await valuesRangeHasHeaderRow(checkRes);
      hasHeaderRow = parsed.hasHeader;
    } else {
      // values.get can fail (e.g. 429) even when the tab exists — do not addSheet until we know.
      const existingId = await getSheetIdByTitle(spreadsheetId, sheetName, accessToken);
      if (existingId !== null) {
        const retry = await fetch(checkUrl, { headers: authHeaders });
        const parsed = await valuesRangeHasHeaderRow(retry);
        hasHeaderRow = parsed.hasHeader;
        if (!retry.ok) {
          console.warn(
            `[Sheets] ensureSheetExists: tab "${sheetName}" exists but values read failed; skipping header write this run.`,
          );
          return true;
        }
      } else {
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
          const createText = await createRes.text();
          if (!isSheetsDuplicateTabError(createText)) {
            console.error("Failed to create sheet:", sheetName, summarizeSheetsError(createText));
            return false;
          }
        }

        const afterCreate = await fetch(checkUrl, { headers: authHeaders });
        const parsed = await valuesRangeHasHeaderRow(afterCreate);
        hasHeaderRow = parsed.hasHeader;
      }
    }

    if (!hasHeaderRow) {
      const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeValuesRange(sheetName, topLeft)}?valueInputOption=RAW`;
      const putRes = await fetch(headerUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ values: [headers] }),
      });
      if (!putRes.ok) {
        console.error(
          "Failed to write headers to",
          sheetName,
          summarizeSheetsError(await putRes.text()),
        );
        return false;
      }
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
  meatVendors?: string[]
): Promise<void> {
  const vendors = meatVendors || ["La portenia", "es cuco"];
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
      return invMonth === month && vendors.includes(inv.vendor);
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
      return quarterMonths[quarter].includes(month) && vendors.includes(inv.vendor);
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
    vendors.includes(inv.vendor)
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
  meatVendors?: string[]
): Promise<void> {
  const vendors = meatVendors || ["La portenia", "es cuco"];
  const dashboardHeaders = ["Metric", "Value"];
  await ensureSheetExists(config.spreadsheetId, "Dashboard", config.accessToken, dashboardHeaders);

  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalIva = config.invoiceData.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalBase = config.invoiceData.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const totalInvoices = config.invoiceData.length;
  const avgAmount = totalInvoices > 0 ? totalSpending / totalInvoices : 0;

  const meatInvoices = config.invoiceData.filter((inv) => vendors.includes(inv.vendor));
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
 * Create Executive Summary sheet for investor reporting
 */
export async function createExecutiveSummarySheet(
  config: SheetAutomationConfig,
  meatVendors?: string[],
  companyName: string = "Company"
): Promise<void> {
  const vendors = meatVendors || ["La portenia", "es cuco"];
  const summaryHeaders = ["Metric", "Value"];
  await ensureSheetExists(config.spreadsheetId, "Executive_Summary", config.accessToken, summaryHeaders);

  // Calculate all metrics
  const totalSpending = config.invoiceData.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalIva = config.invoiceData.reduce((sum, inv) => sum + inv.ivaAmount, 0);
  const totalBase = config.invoiceData.reduce((sum, inv) => sum + inv.baseAmount, 0);
  const totalInvoices = config.invoiceData.length;
  const avgAmount = totalInvoices > 0 ? totalSpending / totalInvoices : 0;

  // Meat spending
  const meatInvoices = config.invoiceData.filter((inv) => vendors.includes(inv.vendor));
  const meatSpending = meatInvoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const meatPercentage = totalSpending > 0 ? (meatSpending / totalSpending * 100).toFixed(2) : 0;

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
    ["=== EXECUTIVE SUMMARY ===", ""],
    ["Company", companyName],
    ["Analysis Period", `${quarter} ${year} (${startDate} - ${endDate})`],
    ["", ""],
    ["=== CORE METRICS ===", ""],
    ["Total Spending (€)", totalSpending.toFixed(2)],
    ["Total IVA (€)", totalIva.toFixed(2)],
    ["Total Base (€)", totalBase.toFixed(2)],
    ["Total Invoices", totalInvoices],
    ["Average per Invoice (€)", avgAmount.toFixed(2)],
    ["Unique Vendors", vendorCount],
    ["", ""],
    ["=== MEAT SPENDING ===", ""],
    ["Meat Total (€)", meatSpending.toFixed(2)],
    ["Meat % of Total", `${meatPercentage}%`],
    ["Meat Invoices", meatInvoices.length],
    ["Meat Average (€)", meatInvoices.length > 0 ? (meatSpending / meatInvoices.length).toFixed(2) : "0"],
    ["", ""],
    ["=== TOP 3 VENDORS ===", ""],
  ];

  // Add top vendors
  topVendors.forEach(([vendor, amount], index) => {
    const percentage = ((amount / totalSpending) * 100).toFixed(2);
    summaryRows.push([`${index + 1}. ${vendor}`, `€${amount.toFixed(2)} (${percentage}%)`]);
  });

  summaryRows.push(["", ""]);
  summaryRows.push(["=== MONTHLY TREND ===", ""]);

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
  meatVendors?: string[],
  companyName?: string
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

    // Create executive summary sheet
    console.log("Creating executive summary sheet...");
    await createExecutiveSummarySheet(config, meatVendors, companyName || "Company");

    console.log("Google Sheets automation completed successfully!");
  } catch (error) {
    console.error("Error during Google Sheets automation:", error);
    throw error;
  }
}
