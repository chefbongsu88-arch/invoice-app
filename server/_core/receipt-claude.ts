import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

import { ENV } from "./env";
import {
  heicBufferToJpeg,
  isLibvipsHeifDecodeError,
  isLikelyHeicOrHeifBuffer,
} from "./heic-to-jpeg";

/** Anthropic hard limit is 5_242_880 bytes decoded; stay clearly under. */
const CLAUDE_IMAGE_BYTE_TARGET = 4_000_000;
const ANTHROPIC_IMAGE_MAX_BYTES = 5_242_880;

function looksLikeJpegBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Decode HEIC if needed, then always re-encode with sharp to baseline JPEG.
 * Anthropic often returns "Could not process image" for HEIC-convert output or exotic PNG/WebP
 * if we skip this step — even when the file is under 4 MiB.
 */
async function shrinkImageForClaudeIfNeeded(
  normalizedBase64: string,
  mimeType: string,
): Promise<{ data: string; mediaType: "image/jpeg" }> {
  let raw = Buffer.from(normalizedBase64, "base64");
  if (!raw.length) {
    throw new Error("Receipt image decoded to an empty buffer.");
  }

  const mtLower = mimeType.toLowerCase();
  let preconvertedHeic = false;
  if (mtLower === "image/heic" || mtLower === "image/heif" || isLikelyHeicOrHeifBuffer(raw)) {
    try {
      raw = Buffer.from(await heicBufferToJpeg(raw));
      preconvertedHeic = true;
    } catch (e) {
      console.error("[OCR] HEIC→JPEG failed (iPhone photos are often HEIC):", e);
      throw new Error(
        "Could not read this photo (HEIC). In Photos, duplicate as JPEG or take a new picture after Settings → Camera → Formats → Most Compatible.",
      );
    }
  }

  async function normalizeToWorkingJpeg(input: Buffer): Promise<Buffer> {
    return sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  let working: Buffer;
  try {
    working = await normalizeToWorkingJpeg(raw);
  } catch (e) {
    if (!preconvertedHeic && isLibvipsHeifDecodeError(e)) {
      console.warn("[OCR] sharp cannot decode HEIF (no libheif on server); using heic-convert");
      try {
        const original = Buffer.from(normalizedBase64, "base64");
        raw = Buffer.from(await heicBufferToJpeg(original));
        working = await normalizeToWorkingJpeg(raw);
      } catch (e2) {
        console.error("[OCR] heic-convert after sharp HEIF failure:", e2);
        throw new Error(
          "Could not read this photo (HEIC). In Photos, duplicate as JPEG or use Settings → Camera → Formats → Most Compatible.",
        );
      }
    } else {
      console.error("[OCR] sharp normalize (→JPEG) failed for Claude:", e);
      throw new Error(
        "Could not prepare the receipt image for OCR. Try a smaller or clearer photo.",
      );
    }
  }

  if (!looksLikeJpegBuffer(working)) {
    console.warn("[OCR] post-normalize buffer is not JPEG; forcing HEIC→JPEG");
    try {
      raw = Buffer.from(await heicBufferToJpeg(Buffer.from(normalizedBase64, "base64")));
      preconvertedHeic = true;
      working = await normalizeToWorkingJpeg(raw);
    } catch (e) {
      console.error("[OCR] forced HEIC→JPEG failed:", e);
      throw new Error(
        "Could not read this photo (HEIC). In Photos, duplicate as JPEG or use Settings → Camera → Formats → Most Compatible.",
      );
    }
  }

  if (working.length <= CLAUDE_IMAGE_BYTE_TARGET) {
    return { data: working.toString("base64"), mediaType: "image/jpeg" };
  }

  let quality = 76;
  let maxWidth = 1600;

  async function resizeOnce(w: Buffer, mw: number, q: number): Promise<Buffer> {
    return sharp(w, { failOn: "none" })
      .resize({ width: mw, height: mw, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  async function recoverWorkingFromHeicOriginal(): Promise<void> {
    const original = Buffer.from(normalizedBase64, "base64");
    raw = Buffer.from(await heicBufferToJpeg(original));
    preconvertedHeic = true;
    working = await normalizeToWorkingJpeg(raw);
  }

  for (let attempt = 0; attempt < 22; attempt++) {
    let out: Buffer;
    try {
      out = await resizeOnce(working, maxWidth, quality);
    } catch (e) {
      if (isLibvipsHeifDecodeError(e)) {
        console.warn("[OCR] sharp resize hit HEIF/libvips issue; re-encoding via heic-convert");
        try {
          await recoverWorkingFromHeicOriginal();
          out = await resizeOnce(working, maxWidth, quality);
        } catch (e2) {
          console.error("[OCR] sharp failed while resizing receipt for Claude:", e2);
          throw new Error(
            "Could not prepare the receipt image for OCR. Try a smaller or clearer photo.",
          );
        }
      } else {
        console.error("[OCR] sharp failed while resizing receipt for Claude:", e);
        throw new Error(
          "Could not prepare the receipt image for OCR. Try a smaller or clearer photo.",
        );
      }
    }

    if (out.length <= CLAUDE_IMAGE_BYTE_TARGET) {
      return { data: out.toString("base64"), mediaType: "image/jpeg" };
    }

    quality = Math.max(26, quality - 4);
    maxWidth = Math.max(480, Math.floor(maxWidth * 0.86));
  }

  let last: Buffer;
  try {
    last = await resizeOnce(working, 480, 26);
  } catch (e) {
    if (isLibvipsHeifDecodeError(e)) {
      console.warn("[OCR] sharp final resize hit HEIF/libvips issue; re-encoding via heic-convert");
      await recoverWorkingFromHeicOriginal();
      last = await resizeOnce(working, 480, 26);
    } else {
      console.error("[OCR] sharp final resize failed for Claude:", e);
      throw new Error(
        "Could not prepare the receipt image for OCR. Try a smaller or clearer photo.",
      );
    }
  }

  if (last.length > ANTHROPIC_IMAGE_MAX_BYTES) {
    throw new Error(
      "Receipt image is still too large after compression. Try cropping the receipt or a lower camera resolution.",
    );
  }

  return { data: last.toString("base64"), mediaType: "image/jpeg" };
}

/**
 * Read receipt image with Claude vision. Returns raw assistant text (should be JSON).
 */
export async function parseReceiptWithClaude(
  normalizedBase64: string,
  mimeType: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const key = ENV.anthropicApiKey?.trim();
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const client = new Anthropic({ apiKey: key });
  const model = ENV.anthropicReceiptModel?.trim() || "claude-sonnet-4-20250514";
  const { data: imageData, mediaType } = await shrinkImageForClaudeIfNeeded(normalizedBase64, mimeType);

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageData,
            },
          },
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ],
  });

  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  const text = parts.join("").trim();
  if (!text) {
    throw new Error("Claude returned an empty response for this image.");
  }
  return text;
}
