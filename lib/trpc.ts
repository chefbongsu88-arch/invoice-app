import { createTRPCReact } from "@trpc/react-query";
import {
  createTRPCClient as createTrpcVanillaClient,
  httpBatchLink,
  httpLink,
} from "@trpc/client";
import superjson from "superjson";
import { Platform } from "react-native";
import type { AppRouter } from "@/server/routers";
import { getApiBaseUrl } from "@/constants/oauth";
import { PRODUCTION_API_ORIGIN } from "@/constants/receipt-api-origin";
import * as Auth from "@/lib/_core/auth";

/**
 * tRPC React client for type-safe API calls.
 *
 * IMPORTANT (tRPC v11): The `transformer` must be inside each link, not at the root createClient.
 */
export const trpc = createTRPCReact<AppRouter>();

export type CreateTrpcClientOptions = {
  /** Skip getApiBaseUrl() / overrides — last-resort bootstrap (dev client quirks). */
  pinnedBase?: string;
};

/** Strip zero-width / BOM so pasted URLs from chat don’t break fetch (RN Safari may still “work” on a clean URL). */
function sanitizeApiBase(s: string): string {
  return s
    .replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, "")
    .replace(/\/$/, "")
    .trim();
}

/**
 * Use `@trpc/client` createTRPCClient here (not `trpc.createClient`).
 * The react-query proxy's createClient can fail on some RN / dev-client bundles.
 */
export function createTRPCClient(opts?: CreateTrpcClientOptions) {
  let base = sanitizeApiBase(opts?.pinnedBase ?? getApiBaseUrl());
  if (!base && (Platform.OS === "ios" || Platform.OS === "android")) {
    base = sanitizeApiBase(PRODUCTION_API_ORIGIN);
  }
  const url = base ? `${base}/api/trpc` : "/api/trpc";

  const linkCommon = {
    url,
    transformer: superjson,
    async headers() {
      const token = await Auth.getSessionToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    fetch(reqUrl: string, options: RequestInit) {
      return fetch(reqUrl, {
        ...options,
        credentials: "include",
      });
    },
  };

  /** Prefer httpLink on native — httpBatchLink has caused init failures on some Hermes + dev-client builds. */
  const preferBatch = Platform.OS === "web";

  const tryCreate = (useBatch: boolean) =>
    createTrpcVanillaClient<AppRouter>({
      links: [useBatch ? httpBatchLink(linkCommon) : httpLink(linkCommon)],
    });

  try {
    const client = tryCreate(preferBatch);
    if (client == null) {
      throw new Error(`[trpc] createClient returned nullish (url=${url})`);
    }
    return client;
  } catch (first) {
    if (preferBatch) {
      try {
        const client = tryCreate(false);
        if (client == null) {
          throw new Error(`[trpc] createClient returned nullish (url=${url})`);
        }
        return client;
      } catch (second) {
        const a = first instanceof Error ? first.message : String(first);
        const b = second instanceof Error ? second.message : String(second);
        throw new Error(`[trpc] init failed (url=${url}). batch: ${a}; httpLink: ${b}`);
      }
    }
    try {
      const client = tryCreate(true);
      if (client == null) {
        throw new Error(`[trpc] createClient returned nullish (url=${url})`);
      }
      return client;
    } catch (second) {
      const a = first instanceof Error ? first.message : String(first);
      const b = second instanceof Error ? second.message : String(second);
      throw new Error(`[trpc] init failed (url=${url}). httpLink: ${a}; batch: ${b}`);
    }
  }
}
