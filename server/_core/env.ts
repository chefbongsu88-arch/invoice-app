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
 * Always ends with a non-empty HTTPS origin for sheet export (defaults to PRODUCTION_API_ORIGIN).
 */
export function resolvePublicBaseForReceiptImages(clientBaseUrl?: string | null): string {
  const c = clientBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (c && /^https?:\/\//i.test(c)) {
    return c;
  }
  return getPublicServerBaseUrl() || PRODUCTION_API_ORIGIN;
}

/**
 * Manus WebDev often injects `VITE_FRONTEND_FORGE_*`; self-hosted Railway may use `BUILT_IN_FORGE_*`.
 * Accept either so the same values from Manus → Secrets can be copied to Railway.
 */
function resolveForgeApiUrl(): string {
  const raw =
    process.env.BUILT_IN_FORGE_API_URL?.trim() ||
    process.env.VITE_FRONTEND_FORGE_API_URL?.trim() ||
    "";
  return raw.replace(/\/+$/, "");
}

function resolveForgeApiKey(): string {
  return (
    process.env.BUILT_IN_FORGE_API_KEY?.trim() ||
    process.env.VITE_FRONTEND_FORGE_API_KEY?.trim() ||
    ""
  );
}

function parseEnvBool(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** True when Forge storage env vars are set (may still fail at runtime if invalid). */
export function isForgeStorageConfigured(): boolean {
  return Boolean(resolveForgeApiUrl()) && Boolean(resolveForgeApiKey());
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: resolveForgeApiUrl(),
  forgeApiKey: resolveForgeApiKey(),
  /** Direct Anthropic API — used for receipt vision when set (preferred over Forge/Gemini). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Vision-capable Claude id — see https://docs.anthropic.com/en/docs/about-claude/models */
  anthropicReceiptModel:
    process.env.ANTHROPIC_RECEIPT_MODEL ?? "claude-sonnet-4-20250514",
  /** Google AI Studio — bypasses Forge when set. https://aistudio.google.com/apikey */
  googleGeminiApiKey: process.env.GOOGLE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  /** e.g. gemini-2.0-flash (1.5 names often 404 on current v1beta) */
  googleGeminiModel: process.env.GOOGLE_GEMINI_MODEL ?? "gemini-2.0-flash",
  /**
   * When true, skip Google Gemini for receipt/image OCR and scanned-PDF Gemini path even if the key is set.
   * Set `OCR_SKIP_GEMINI=1` to test Claude-only or reduce Gemini 429 noise without deleting the key.
   */
  ocrSkipGemini: parseEnvBool(process.env.OCR_SKIP_GEMINI),
  /**
   * When both Anthropic and Gemini keys are set: try Gemini before Claude (legacy).
   * Default false → Claude first (fewer Gemini free-tier 429s; Anthropic 529 still falls back to Gemini).
   * Set OCR_GEMINI_FIRST=1 to restore Gemini-first for picky photos.
   */
  ocrGeminiFirstWhenBoth: parseEnvBool(process.env.OCR_GEMINI_FIRST),
};
