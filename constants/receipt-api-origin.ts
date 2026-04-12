/**
 * Deployed API origin (no trailing slash).
 * Mirrors native fallback when EXPO_PUBLIC_API_BASE_URL is unset — server uses the same value
 * when PUBLIC_SERVER_URL / RAILWAY_* are missing so /api/receipt-share URLs work in Sheets.
 */
export const PRODUCTION_API_ORIGIN =
  "https://invoice-app-production-18c0.up.railway.app";

/**
 * Shown in GET /api/health as `sheetsExportBuild`.
 * If missing on production, the server is still running an old deploy (Forge-only sheet images).
 */
export const API_SHEETS_EXPORT_BUILD = "receipt-plain-url-v1";
