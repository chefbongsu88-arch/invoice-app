/**
 * Short-lived public receipt images for Google Sheets =IMAGE().
 * Forge/Manus storage is preferred; this is an in-memory fallback when those env vars are unset.
 * Tokens are unguessable; anyone with the link can view until expiry (or server restart clears RAM).
 */

import crypto from "node:crypto";

const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_ENTRIES = 250;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB per image

type Entry = { buffer: Buffer; mime: string; expiresAt: number };

const store = new Map<string, Entry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

function enforceCap(): void {
  while (store.size > MAX_ENTRIES) {
    const first = store.keys().next().value;
    if (first) store.delete(first);
    else break;
  }
}

export function putReceiptShareImage(buffer: Buffer, mime: string): string | null {
  if (!buffer?.length || buffer.length > MAX_BYTES) return null;
  pruneExpired();
  enforceCap();
  const token = crypto.randomBytes(24).toString("hex");
  const m = mime?.trim() || "image/jpeg";
  store.set(token, { buffer, mime: m, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function getReceiptShareImage(
  token: string,
): { buffer: Buffer; mime: string } | null {
  if (!/^[a-f0-9]{48}$/i.test(token)) return null;
  pruneExpired();
  const e = store.get(token);
  if (!e || e.expiresAt <= Date.now()) {
    if (e) store.delete(token);
    return null;
  }
  return { buffer: e.buffer, mime: e.mime };
}

export function detectMimeFromBuffer(buf: Buffer): string {
  if (buf.length >= 4) {
    const h = buf.slice(0, 4);
    if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return "image/png";
    if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
    if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return "image/gif";
    if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) {
      if (buf.length >= 12) {
        const w = buf.slice(8, 12);
        if (w[0] === 0x57 && w[1] === 0x45 && w[2] === 0x42 && w[3] === 0x50) return "image/webp";
      }
    }
  }
  return "image/jpeg";
}
