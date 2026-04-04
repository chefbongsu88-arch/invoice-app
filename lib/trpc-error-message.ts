import { isTRPCClientError } from "@trpc/client";

/** User-visible message from a failed tRPC mutation (or generic fallback). */
export function getTrpcMutationMessage(err: unknown, fallback: string): string {
  if (isTRPCClientError(err)) {
    const m = err.message?.trim();
    if (m) return m;
  }
  if (err instanceof Error && err.message?.trim()) return err.message.trim();
  return fallback;
}
