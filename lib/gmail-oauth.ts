import AsyncStorage from "@react-native-async-storage/async-storage";

import { PRODUCTION_API_ORIGIN } from "@/constants/receipt-api-origin";

export const GMAIL_TOKEN_KEY = "gmail_oauth_token";
export const GMAIL_EMAIL_KEY = "gmail_email_address";
/** Display name from Google Sign-In, used to label "Uploaded By" in Sheets when no useAuth() user exists. */
export const GMAIL_NAME_KEY = "gmail_display_name";

/** Must match server redirect (`scheme://gmail-auth?...`). */
export const GMAIL_OAUTH_RETURN_HOST = "gmail-auth";

export function parseGmailAuthReturnUrl(url: string): {
  token?: string;
  email?: string;
  name?: string;
  error?: string;
  detail?: string;
} {
  const q = url.includes("?") ? url.split("?").slice(1).join("?").split("#")[0] : "";
  const sp = new URLSearchParams(q);
  return {
    token: sp.get("token") ?? undefined,
    email: sp.get("email") ?? undefined,
    name: sp.get("name") ?? undefined,
    error: sp.get("error") ?? undefined,
    detail: sp.get("detail") ?? undefined,
  };
}

export async function persistGmailOAuthFromParsed(p: {
  token?: string;
  email?: string;
  name?: string;
  error?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (p.error) return { ok: false, error: p.error };
  if (!p.token) return { ok: false };
  await AsyncStorage.setItem(GMAIL_TOKEN_KEY, p.token);
  if (p.email) await AsyncStorage.setItem(GMAIL_EMAIL_KEY, p.email);
  if (p.name && p.name.trim().length > 0) {
    await AsyncStorage.setItem(GMAIL_NAME_KEY, p.name.trim());
  }
  return { ok: true };
}

/** Best-effort uploader label (name preferred, else email). Falls back to "" — caller decides default. */
export async function getStoredUploaderLabel(): Promise<string> {
  try {
    const [name, email] = await Promise.all([
      AsyncStorage.getItem(GMAIL_NAME_KEY),
      AsyncStorage.getItem(GMAIL_EMAIL_KEY),
    ]);
    const n = name?.trim();
    if (n) return n;
    const e = email?.trim();
    if (e) return e;
    return "";
  } catch {
    return "";
  }
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
