import { PRODUCTION_API_ORIGIN } from "../../constants/receipt-api-origin";

/** Base URL for links Sheets can fetch (IMAGE/HYPERLINK), e.g. https://xxx.up.railway.app */
export function getPublicServerBaseUrl(): string {
  const explicit = process.env.RECEIPT_IMAGE_PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const u = process.env.PUBLIC_SERVER_URL?.trim();
  if (u) return u.replace(/\/+$/, "");
  const d = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (d) return `https://${d}`;
  const staticUrl = process.env.RAILWAY_STATIC_URL?.trim();
  if (staticUrl) {
    try {
      const o = new URL(staticUrl.startsWith("http") ? staticUrl : `https://${staticUrl}`);
      return o.origin;
    } catch {
      /* ignore */
    }
  }
  // Same host as constants/receipt-api-origin (native app fallback). Override with PUBLIC_SERVER_URL
  // or RECEIPT_IMAGE_PUBLIC_BASE_URL if you deploy under a different domain.
  // Railway sometimes omits NODE_ENV=production — treat any non-dev, non-test runtime as deployed.
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    return PRODUCTION_API_ORIGIN;
  }
  return "";
}

/**
 * Prefer client-provided API origin (same host as /api/receipt-share) when Railway env is empty.
 */
export function resolvePublicBaseForReceiptImages(clientBaseUrl?: string | null): string {
  const c = clientBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (c && /^https?:\/\//i.test(c)) {
    return c;
  }
  const fromEnv = getPublicServerBaseUrl();
  if (fromEnv) return fromEnv;
  // Last resort: same origin as native PRODUCTION_API_FALLBACK (Sheets =IMAGE requires HTTPS)
  if (process.env.NODE_ENV !== "development") {
    return PRODUCTION_API_ORIGIN;
  }
  // Railway can mis-set NODE_ENV; still need a public HTTPS base for /api/receipt-share
  if (process.env.RAILWAY_ENVIRONMENT?.trim() || process.env.RAILWAY_PROJECT_ID?.trim()) {
    return PRODUCTION_API_ORIGIN;
  }
  return "";
}

/** Default off: Google Sheets export uses in-memory /api/receipt-share. Set to "1" to try Forge after share fails. */
export function useForgeForSheetsExport(): boolean {
  return process.env.USE_FORGE_FOR_SHEETS_EXPORT === "1";
}

/** True when Forge storage env vars are set (may still fail at runtime if invalid). */
export function isForgeStorageConfigured(): boolean {
  return (
    Boolean(process.env.BUILT_IN_FORGE_API_URL?.trim()) &&
    Boolean(process.env.BUILT_IN_FORGE_API_KEY?.trim())
  );
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  /** Direct Anthropic API — used for receipt vision when set (preferred over Forge/Gemini). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Vision-capable Claude id — see https://docs.anthropic.com/en/docs/about-claude/models */
  anthropicReceiptModel:
    process.env.ANTHROPIC_RECEIPT_MODEL ?? "claude-sonnet-4-20250514",
  /** Google AI Studio — bypasses Forge when set. https://aistudio.google.com/apikey */
  googleGeminiApiKey: process.env.GOOGLE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  /** e.g. gemini-1.5-flash, gemini-2.0-flash */
  googleGeminiModel: process.env.GOOGLE_GEMINI_MODEL ?? "gemini-1.5-flash",
};
