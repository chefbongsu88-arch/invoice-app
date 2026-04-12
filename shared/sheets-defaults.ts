/** Google Sheets workbook ID used when Settings is empty (override in app Settings). */
export const DEFAULT_SPREADSHEET_ID =
  "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";

/**
 * Main tracker tab — must match the sheet tab title in Google Sheets exactly.
 * If your tab is named in Korean or otherwise, set "Sheet Name (Tab)" in Settings to that exact title.
 */
export const DEFAULT_MAIN_TRACKER_SHEET_NAME = "2026 Invoice tracker";

/**
 * Column L (Receipt): plain HTTPS URL only.
 * Google Sheets turns `https://…` into a clickable link; no in-cell =IMAGE() preview (stays readable, opens full size in the browser).
 */
export function receiptSheetsReceiptUrlCell(httpsUrl: string): string {
  return String(httpsUrl ?? "").trim();
}

/**
 * @deprecated Alias for {@link receiptSheetsReceiptUrlCell} — older name when we used =IMAGE() inside HYPERLINK.
 */
export function receiptImageSheetsFormula(httpsUrl: string): string {
  return receiptSheetsReceiptUrlCell(httpsUrl);
}

/** Same as {@link receiptSheetsReceiptUrlCell}; kept for callers that branch on “PDF vs image”. */
export function receiptPdfSheetsHyperlinkFormula(httpsUrl: string): string {
  return receiptSheetsReceiptUrlCell(httpsUrl);
}
