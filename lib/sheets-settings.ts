import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_MAIN_TRACKER_SHEET_NAME,
  DEFAULT_SPREADSHEET_ID,
} from "@/shared/sheets-defaults";

const SETTINGS_KEY = "app_settings_v1";

export type SheetsExportTarget = {
  spreadsheetId: string;
  sheetName: string;
};

/** Resolved spreadsheet + tab for export (Settings with sensible defaults for the 2026 tracker workbook). */
export async function getSheetsExportTarget(): Promise<SheetsExportTarget> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as { spreadsheetId?: string; sheetName?: string })
      : {};
    const spreadsheetId = parsed.spreadsheetId?.trim() || DEFAULT_SPREADSHEET_ID;
    let sheetName = parsed.sheetName?.trim() || DEFAULT_MAIN_TRACKER_SHEET_NAME;
    // Older app builds defaulted the tab to "Invoices"; main workbook uses the 2026 tracker tab.
    if (sheetName === "Invoices") {
      sheetName = DEFAULT_MAIN_TRACKER_SHEET_NAME;
    }
    return { spreadsheetId, sheetName };
  } catch {
    return {
      spreadsheetId: DEFAULT_SPREADSHEET_ID,
      sheetName: DEFAULT_MAIN_TRACKER_SHEET_NAME,
    };
  }
}
