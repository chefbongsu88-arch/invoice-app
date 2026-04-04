import sharp from "sharp";

/**
 * Progressive JPEG ladder — unknown incoming size/format always lands on a bounded JPEG.
 * Each step shrinks further; Forge/Gemini often accepts only smaller inline images.
 */
export const FORGE_OCR_LADDER: readonly { maxEdge: number; quality: number }[] = [
  { maxEdge: 1280, quality: 76 },
  { maxEdge: 1024, quality: 72 },
  { maxEdge: 960, quality: 68 },
  { maxEdge: 768, quality: 64 },
  { maxEdge: 640, quality: 60 },
  { maxEdge: 512, quality: 56 },
  { maxEdge: 400, quality: 52 },
] as const;

/** Target decoded JPEG size — stay under typical inline-image / request limits */
const SOFT_MAX_BYTES = 750_000;

/**
 * Encode receipt image to JPEG at a specific ladder step (0 = largest acceptable default).
 * Callers retry with step+1 on Forge 400 "Could not process image".
 */
export async function encodeReceiptImageForForgeStep(
  normalizedBase64: string,
  hintedMime: string,
  step: number,
): Promise<{ base64: string; mimeType: string; jpegBytes: number; stepUsed: number }> {
  const idx = Math.min(Math.max(0, step), FORGE_OCR_LADDER.length - 1);
  const { maxEdge, quality } = FORGE_OCR_LADDER[idx];

  let raw: Buffer;
  try {
    raw = Buffer.from(normalizedBase64, "base64");
  } catch {
    throw new Error("Invalid base64 image data");
  }
  if (raw.length < 32) {
    throw new Error("Image data too small after decode");
  }

  try {
    const encode = async (edge: number, q: number) =>
      sharp(raw)
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer();

    let buf = await encode(maxEdge, quality);

    if (buf.length > SOFT_MAX_BYTES && idx < FORGE_OCR_LADDER.length - 1) {
      const tighter = Math.max(52, quality - 10);
      buf = await encode(Math.min(maxEdge, 768), tighter);
    }
    if (buf.length > SOFT_MAX_BYTES) {
      buf = await encode(512, 55);
    }

    const jpegBytes = buf.length;
    return {
      base64: buf.toString("base64"),
      mimeType: "image/jpeg",
      jpegBytes,
      stepUsed: idx,
    };
  } catch (err) {
    console.error("[OCR] sharp encode failed:", err);
    throw new Error(
      `Could not normalize receipt image (sharp): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
