/** Google Sheets workbook ID used when Settings is empty (override in app Settings). */
export const DEFAULT_SPREADSHEET_ID =
  "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";

/**
 * Main tracker tab — must match the sheet tab title in Google Sheets exactly.
 * If your tab is named in Korean or otherwise, set "Sheet Name (Tab)" in Settings to that exact title.
 */
export const DEFAULT_MAIN_TRACKER_SHEET_NAME = "2026 Invoice tracker";

/**
 * Google Sheets: mode 4 = fixed pixel size (mode 1 fits cell → tiny).
 * HYPERLINK(..., IMAGE(...)) = same preview, but clicking opens the image URL in the browser (full size).
 * @see https://support.google.com/docs/answer/3093313 (HYPERLINK)
 * @see https://support.google.com/docs/answer/3093333 (IMAGE)
 */
const RECEIPT_IMAGE_SHEETS_HEIGHT_PX = 520;
const RECEIPT_IMAGE_SHEETS_WIDTH_PX = 400;

/** Column L: clickable preview — click opens the receipt image in a new browser context (zoom with browser). */
export function receiptImageSheetsFormula(httpsUrl: string): string {
  const safe = String(httpsUrl ?? "").trim().replace(/"/g, '""');
  const img = `IMAGE("${safe}", 4, ${RECEIPT_IMAGE_SHEETS_HEIGHT_PX}, ${RECEIPT_IMAGE_SHEETS_WIDTH_PX})`;
  return `=HYPERLINK("${safe}",${img})`;
}

/** PDFs are not reliable in Sheets =IMAGE(); use a link that opens the hosted file in the browser. */
export function receiptPdfSheetsHyperlinkFormula(httpsUrl: string): string {
  const safe = String(httpsUrl ?? "").trim().replace(/"/g, '""');
  return `=HYPERLINK("${safe}","Open receipt (PDF)")`;
}
