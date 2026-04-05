import * as Linking from "expo-linking";
import * as ReactNative from "react-native";

import { PRODUCTION_API_ORIGIN } from "@/constants/receipt-api-origin";

/** When set (e.g. from Settings or startup fix), overrides EXPO_PUBLIC_API_BASE_URL. */
let runtimeApiBaseOverride: string | null = null;

export function setRuntimeApiBaseOverride(url: string | null) {
  const raw = url == null ? "" : String(url);
  const t = raw.trim().replace(/\/$/, "");
  runtimeApiBaseOverride = t.length > 0 ? t : null;
}

// Extract scheme from bundle ID (last segment timestamp, prefixed with "manus")
// e.g., "space.manus.my.app.t20240115103045" -> "manus20240115103045"
const bundleId = "space.manus.invoice.tracker.t20260325194257";
const timestamp = bundleId.split(".").pop()?.replace(/^t/, "") ?? "";
const schemeFromBundleId = `manus${timestamp}`;

/** Used when EXPO_PUBLIC_API_BASE_URL is unset (production device builds). */
const PRODUCTION_API_FALLBACK = PRODUCTION_API_ORIGIN;

const env = {
  portal: process.env.EXPO_PUBLIC_OAUTH_PORTAL_URL ?? "",
  server: process.env.EXPO_PUBLIC_OAUTH_SERVER_URL ?? "",
  appId: process.env.EXPO_PUBLIC_APP_ID ?? "",
  ownerId: process.env.EXPO_PUBLIC_OWNER_OPEN_ID ?? "",
  ownerName: process.env.EXPO_PUBLIC_OWNER_NAME ?? "",
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
  deepLinkScheme: schemeFromBundleId,
};

export const OAUTH_PORTAL_URL = env.portal;
export const OAUTH_SERVER_URL = env.server;
export const APP_ID = env.appId;
export const OWNER_OPEN_ID = env.ownerId;
export const OWNER_NAME = env.ownerName;
export const API_BASE_URL = env.apiBaseUrl;

/** Reject truncated / pasted garbage so a bad saved URL does not block startup. */
export function isValidApiBaseUrl(s: string): boolean {
  const t = s.trim().replace(/\/$/, "");
  if (t.length < 8) return false;
  if (/\.\.\.|…/.test(t)) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname;
    if (!host || host.length < 4) return false;
    if (/\.{3,}/.test(host)) return false;
    if (host !== "localhost" && !host.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Baked-in builds sometimes point at legacy Railway hostname; optional user override in app_settings_v1. */
export function applyApiUrlFromAppSettings(parsed: { apiBaseUrlOverride?: unknown } | null) {
  const o = parsed?.apiBaseUrlOverride;
  const custom = typeof o === "string" ? o.trim().replace(/\/$/, "") : "";
  if (custom) {
    if (isValidApiBaseUrl(custom)) {
      setRuntimeApiBaseOverride(custom);
      return;
    }
    console.warn("[oauth] Ignoring invalid apiBaseUrlOverride:", custom);
  }
  if (
    API_BASE_URL &&
    /app-production-18c0\.up\.railway\.app/i.test(API_BASE_URL) &&
    !/invoice-app-production/i.test(API_BASE_URL)
  ) {
    setRuntimeApiBaseOverride(PRODUCTION_API_ORIGIN.replace(/\/$/, ""));
  } else {
    setRuntimeApiBaseOverride(null);
  }
}

type TrpcRecreateHandler = () => void;
const trpcRecreateHandlers: TrpcRecreateHandler[] = [];

export function onTrpcClientShouldRecreate(handler: TrpcRecreateHandler) {
  trpcRecreateHandlers.push(handler);
  return () => {
    const i = trpcRecreateHandlers.indexOf(handler);
    if (i >= 0) trpcRecreateHandlers.splice(i, 1);
  };
}

export function requestTrpcClientRecreate() {
  trpcRecreateHandlers.forEach((h) => h());
}

/** Force API host to production Railway (ignores user override until next apply). */
export function forceProductionApiBase() {
  setRuntimeApiBaseOverride(PRODUCTION_API_ORIGIN.replace(/\/$/, ""));
}

/**
 * Get the API base URL, deriving from current hostname if not set.
 * Metro runs on 8081, API server runs on 3000.
 *
 * On a physical phone, relative `/api/trpc` is invalid. If `EXPO_PUBLIC_API_BASE_URL`
 * is unset, iOS/Android use the deployed Railway host (including dev client + Metro).
 */
export function getApiBaseUrl(): string {
  if (runtimeApiBaseOverride) {
    return runtimeApiBaseOverride;
  }
  if (API_BASE_URL) {
    return API_BASE_URL.replace(/\/$/, "");
  }

  if (ReactNative.Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    const { protocol, hostname } = window.location;
    const apiHostname = hostname.replace(/^8081-/, "3000-");
    if (apiHostname !== hostname) {
      return `${protocol}//${apiHostname}`;
    }
  }

  if (ReactNative.Platform.OS === "ios" || ReactNative.Platform.OS === "android") {
    return PRODUCTION_API_FALLBACK;
  }

  return "";
}

export const SESSION_TOKEN_KEY = "app_session_token";
export const USER_INFO_KEY = "manus-runtime-user-info";

const encodeState = (value: string) => {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(value);
  }
  const BufferImpl = (globalThis as Record<string, any>).Buffer;
  if (BufferImpl) {
    return BufferImpl.from(value, "utf-8").toString("base64");
  }
  return value;
};

/**
 * Get the redirect URI for OAuth callback.
 * - Web: uses API server callback endpoint
 * - Native: uses deep link scheme
 */
export const getRedirectUri = () => {
  if (ReactNative.Platform.OS === "web") {
    return `${getApiBaseUrl()}/api/oauth/callback`;
  } else {
    return Linking.createURL("/oauth/callback", {
      scheme: env.deepLinkScheme,
    });
  }
};

export const getLoginUrl = () => {
  const redirectUri = getRedirectUri();
  const state = encodeState(redirectUri);

  const url = new URL(`${OAUTH_PORTAL_URL}/app-auth`);
  url.searchParams.set("appId", APP_ID);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};

/**
 * Start OAuth login flow.
 *
 * On native platforms (iOS/Android), open the system browser directly so
 * the OAuth callback returns via deep link to the app.
 *
 * On web, this simply redirects to the login URL.
 *
 * @returns Always null, the callback is handled via deep link.
 */
export async function startOAuthLogin(): Promise<string | null> {
  const loginUrl = getLoginUrl();

  if (ReactNative.Platform.OS === "web") {
    // On web, just redirect
    if (typeof window !== "undefined") {
      window.location.href = loginUrl;
    }
    return null;
  }

  const supported = await Linking.canOpenURL(loginUrl);
  if (!supported) {
    console.warn("[OAuth] Cannot open login URL: URL scheme not supported");
    return null;
  }

  try {
    await Linking.openURL(loginUrl);
  } catch (error) {
    console.error("[OAuth] Failed to open login URL:", error);
  }

  // The OAuth callback will reopen the app via deep link.
  return null;
}
