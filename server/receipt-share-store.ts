/**
 * Short-lived public receipt images for Google Sheets (plain HTTPS links).
 * Forge/Manus storage is preferred for links that survive deploys and multiple replicas.
 *
 * Disk fallback:
 * - RECEIPT_SHARE_DISK_DIR: explicit directory (use a Railway volume mount for durability).
 * - On Railway (RAILWAY_ENVIRONMENT set), defaults to cwd/.data/receipt-share so GET works after
 *   process restarts on the same filesystem (still not shared across replicas without a volume).
 * - RECEIPT_SHARE_DISK_OFF=1: never use implicit disk (memory only, except explicit RECEIPT_SHARE_DISK_DIR).
 *
 * Tokens are unguessable; anyone with the link can view until expiry.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_ENTRIES = 250;
const MAX_BYTES = 20 * 1024 * 1024; // 20 MiB per receipt (PDF/image)

type Entry = { buffer: Buffer; mime: string; expiresAt: number };

const store = new Map<string, Entry>();

let implicitDiskDirLogged = false;

function receiptShareDiskDir(): string | null {
  const explicit = process.env.RECEIPT_SHARE_DISK_DIR?.trim();
  if (explicit) return explicit;
  if (process.env.RECEIPT_SHARE_DISK_OFF === "1") return null;
  if (process.env.RAILWAY_ENVIRONMENT?.trim()) {
    const dir = path.join(process.cwd(), ".data", "receipt-share");
    if (!implicitDiskDirLogged) {
      implicitDiskDirLogged = true;
      console.log(
        `[receipt-share] Persisting under ${dir} (same instance / restarts). For deploy-safe links set BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY.`,
      );
    }
    return dir;
  }
  return null;
}

function diskMetaPath(token: string, dir: string): string {
  return path.join(dir, `${token}.json`);
}

function diskBinPath(token: string, dir: string): string {
  return path.join(dir, token);
}

function readReceiptFromDisk(token: string): Entry | null {
  const dir = receiptShareDiskDir();
  if (!dir) return null;
  const metaPath = diskMetaPath(token, dir);
  const binPath = diskBinPath(token, dir);
  try {
    if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { mime?: string; expiresAt?: number };
    const expiresAt = Number(meta?.expiresAt ?? 0);
    const mime = String(meta?.mime ?? "image/jpeg").trim() || "image/jpeg";
    if (!expiresAt || expiresAt <= Date.now()) {
      try {
        fs.unlinkSync(metaPath);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(binPath);
      } catch {
        /* ignore */
      }
      return null;
    }
    const buffer = fs.readFileSync(binPath);
    if (!buffer.length) return null;
    return { buffer, mime, expiresAt };
  } catch {
    return null;
  }
}

function writeReceiptToDisk(token: string, buffer: Buffer, mime: string, expiresAt: number): void {
  const dir = receiptShareDiskDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(diskBinPath(token, dir), buffer);
    fs.writeFileSync(diskMetaPath(token, dir), JSON.stringify({ mime, expiresAt }));
  } catch (err) {
    console.error("[receipt-share] disk persist failed:", err);
  }
}

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
  const expiresAt = Date.now() + TTL_MS;
  store.set(token, { buffer, mime: m, expiresAt });
  writeReceiptToDisk(token, buffer, m, expiresAt);
  return token;
}

export function getReceiptShareImage(
  token: string,
): { buffer: Buffer; mime: string } | null {
  if (!/^[a-f0-9]{48}$/i.test(token)) return null;
  pruneExpired();
  const e = store.get(token);
  if (e && e.expiresAt > Date.now()) {
    return { buffer: e.buffer, mime: e.mime };
  }
  if (e) store.delete(token);

  const fromDisk = readReceiptFromDisk(token);
  if (fromDisk) {
    store.set(token, fromDisk);
    return { buffer: fromDisk.buffer, mime: fromDisk.mime };
  }
  return null;
}

export function detectMimeFromBuffer(buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf.slice(0, 4).toString("ascii") === "%PDF") return "application/pdf";
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
