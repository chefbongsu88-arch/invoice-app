import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

// Google OAuth configuration
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID"; // Will be set via environment
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  accessToken: string;
}

/**
 * Initialize Google OAuth discovery
 */
export async function initializeGoogleAuth() {
  try {
    await WebBrowser.warmUpAsync();
    return true;
  } catch (error) {
    console.error("Failed to initialize Google Auth:", error);
    return false;
  }
}

/**
 * Get stored Google Sheets config
 */
export async function getGoogleSheetsConfig(): Promise<GoogleSheetsConfig | null> {
  try {
    const stored = await SecureStore.getItemAsync("google_sheets_config");
    if (stored) {
      return JSON.parse(stored);
    }
    return null;
  } catch (error) {
    console.error("Failed to get Google Sheets config:", error);
    return null;
  }
}

/**
 * Save Google Sheets config
 */
export async function saveGoogleSheetsConfig(config: GoogleSheetsConfig): Promise<boolean> {
  try {
    await SecureStore.setItemAsync("google_sheets_config", JSON.stringify(config));
    return true;
  } catch (error) {
    console.error("Failed to save Google Sheets config:", error);
    return false;
  }
}

/**
 * Clear Google Sheets config
 */
export async function clearGoogleSheetsConfig(): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync("google_sheets_config");
    return true;
  } catch (error) {
    console.error("Failed to clear Google Sheets config:", error);
    return false;
  }
}

/**
 * Export invoice to Google Sheets
 */
export async function exportInvoiceToSheets(
  invoiceData: {
    source: string;
    invoiceNumber: string;
    vendor: string;
    date: string;
    totalAmount: number;
    ivaAmount: number;
    baseAmount: number;
    category: string;
    currency: string;
    tip?: number;
    notes?: string;
    imageUrl?: string;
  },
  config: GoogleSheetsConfig,
  apiUrl: string
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(`${apiUrl}/api/trpc/sheets.exportInvoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        json: {
          spreadsheetId: config.spreadsheetId,
          invoiceData,
          accessToken: config.accessToken,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Export failed:", error);
      throw new Error("Failed to export invoice");
    }

    const result = await response.json();
    return {
      success: true,
      message: "Invoice exported successfully to Google Sheets",
    };
  } catch (error) {
    console.error("Export error:", error);
    return {
      success: false,
      message: "Could not export to Google Sheets. Check your connection and spreadsheet ID.",
    };
  }
}
