import AsyncStorage from "@react-native-async-storage/async-storage";

import { PRODUCTION_API_ORIGIN } from "@/constants/receipt-api-origin";

export const GMAIL_TOKEN_KEY = "gmail_oauth_token";
export const GMAIL_EMAIL_KEY = "gmail_email_address";

/** Must match server redirect (`scheme://gmail-auth?...`). */
export const GMAIL_OAUTH_RETURN_HOST = "gmail-auth";

export function parseGmailAuthReturnUrl(url: string): {
  token?: string;
  email?: string;
  error?: string;
  detail?: string;
} {
  const q = url.includes("?") ? url.split("?").slice(1).join("?").split("#")[0] : "";
  const sp = new URLSearchParams(q);
  return {
    token: sp.get("token") ?? undefined,
    email: sp.get("email") ?? undefined,
    error: sp.get("error") ?? undefined,
    detail: sp.get("detail") ?? undefined,
  };
}

export async function persistGmailOAuthFromParsed(p: {
  token?: string;
  email?: string;
  error?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (p.error) return { ok: false, error: p.error };
  if (!p.token) return { ok: false };
  await AsyncStorage.setItem(GMAIL_TOKEN_KEY, p.token);
  if (p.email) await AsyncStorage.setItem(GMAIL_EMAIL_KEY, p.email);
  return { ok: true };
}

/**
 * Base URL for Gmail OAuth `redirect_uri` only (must match Google Cloud + `/auth/gmail/callback` on that host).
 *
 * Always use {@link PRODUCTION_API_ORIGIN} — the deployment that serves the HTML page which opens
 * `manus://gmail-auth?token=…`. The legacy host `app-production-18c0…` (without `invoice-app-`) often ends on
 * plain text (“Authentication complete…”) so the in-app browser never returns a token to JS.
 *
 * tRPC / API traffic still uses {@link getApiBaseUrl}; this is intentionally separate.
 *
 * Override: `EXPO_PUBLIC_GMAIL_OAUTH_REDIRECT_BASE` (full origin, no trailing slash).
 */
export function getGmailOAuthRedirectBaseUrl(): string {
  const fallback = PRODUCTION_API_ORIGIN.replace(/\/$/, "");
  const explicit = process.env.EXPO_PUBLIC_GMAIL_OAUTH_REDIRECT_BASE?.trim().replace(/\/$/, "");
  if (explicit && /^https:\/\//i.test(explicit)) {
    // Never send Gmail OAuth to legacy Railway host (plain-text success page, no manus:// handoff).
    if (
      /app-production-18c0\.up\.railway\.app/i.test(explicit) &&
      !/invoice-app-production/i.test(explicit)
    ) {
      return fallback;
    }
    return explicit;
  }
  return fallback;
}
