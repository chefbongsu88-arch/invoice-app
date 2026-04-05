// CJS package — must use dynamic import so `node dist/index.mjs` (ESM) never hits `require()`.
type HeicConvertFn = (opts: {
  buffer: Buffer;
  format: "JPEG";
  quality?: number;
}) => Promise<ArrayBuffer | Uint8Array | Buffer>;

let heicConvertCached: HeicConvertFn | null = null;

async function getHeicConvert(): Promise<HeicConvertFn> {
  if (heicConvertCached) return heicConvertCached;
  const mod = await import("heic-convert");
  const fn = (mod as { default?: HeicConvertFn }).default ?? (mod as unknown as HeicConvertFn);
  heicConvertCached = fn;
  return fn;
}

/**
 * ISO BMFF `ftyp` + HEIF/HEIC brands (iPhone photos are often HEIC).
 * Avoid matching unrelated `ftyp` (e.g. some MP4) by requiring image-like brands.
 */
export function isLikelyHeicOrHeifBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii").replace(/\0/g, "").toLowerCase();
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1|hevx|hevm)/.test(brand)) return true;
  }
  // Some devices put a different primary brand; scan header for HEIF identifiers
  const sniff = buf.subarray(0, Math.min(128, buf.length)).toString("latin1");
  if (/mif1|msf1|heic|heix|hevx/i.test(sniff)) return true;

  // Exif wrapper or other prefix before the first `ftyp` box — scan first 16 KiB
  const scanLen = Math.min(buf.length, 16384);
  for (let i = 0; i <= scanLen - 12; i++) {
    if (
      buf[i] === 0x66 &&
      buf[i + 1] === 0x74 &&
      buf[i + 2] === 0x79 &&
      buf[i + 3] === 0x70
    ) {
      const brand = buf.subarray(i + 8, i + 12).toString("ascii").replace(/\0/g, "").toLowerCase();
      if (/^(heic|heix|hevc|heim|heis|mif1|msf1|hevx|hevm)/.test(brand)) return true;
    }
  }
  return false;
}

/** libvips/sharp on Linux (Railway) is often built without HEIF — this matches that failure. */
export function isLibvipsHeifDecodeError(err: unknown): boolean {
  const parts: string[] = [];
  let e: unknown = err;
  let depth = 0;
  while (e != null && depth < 10) {
    if (e instanceof Error) {
      parts.push(e.message, e.stack ?? "");
      e = (e as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(e));
      break;
    }
    depth++;
  }
  const s = parts.join(" ");
  return /heif|heic|No decoding plugin|compression format|bad seek|source: bad seek/i.test(s);
}

/** Decode HEIC/HEIF to JPEG bytes so `sharp` (no libheif on Railway) can resize. */
export async function heicBufferToJpeg(buf: Buffer, quality = 0.88): Promise<Buffer> {
  const heicConvert = await getHeicConvert();
  const out = await heicConvert({
    buffer: buf,
    format: "JPEG",
    quality,
  });
  if (Buffer.isBuffer(out)) return out;
  if (out instanceof ArrayBuffer) return Buffer.from(out);
  return Buffer.from(new Uint8Array(out));
}
