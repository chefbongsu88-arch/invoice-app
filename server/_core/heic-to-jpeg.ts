// CJS package — no bundled types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const heicConvert = require("heic-convert") as (opts: {
  buffer: Buffer;
  format: "JPEG";
  quality?: number;
}) => Promise<ArrayBuffer | Uint8Array | Buffer>;

/**
 * ISO BMFF `ftyp` + HEIF/HEIC brands (iPhone photos are often HEIC).
 * Avoid matching unrelated `ftyp` (e.g. some MP4) by requiring image-like brands.
 */
export function isLikelyHeicOrHeifBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = buf.subarray(8, 12).toString("ascii").replace(/\0/g, "").toLowerCase();
  return /^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand);
}

/** Decode HEIC/HEIF to JPEG bytes so `sharp` (no libheif on Railway) can resize. */
export async function heicBufferToJpeg(buf: Buffer): Promise<Buffer> {
  const out = await heicConvert({
    buffer: buf,
    format: "JPEG",
    quality: 0.88,
  });
  if (Buffer.isBuffer(out)) return out;
  if (out instanceof ArrayBuffer) return Buffer.from(out);
  return Buffer.from(new Uint8Array(out));
}
