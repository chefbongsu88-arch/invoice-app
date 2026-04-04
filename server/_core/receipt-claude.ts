import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

import { ENV } from "./env";

/** Anthropic hard limit is 5_242_880 bytes decoded; stay clearly under. */
const CLAUDE_IMAGE_BYTE_TARGET = 4_000_000;
const ANTHROPIC_IMAGE_MAX_BYTES = 5_242_880;

function mimeToAnthropicMediaType(mime: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (mime === "image/png") return "image/png";
  if (mime === "image/webp") return "image/webp";
  if (mime === "image/gif") return "image/gif";
  return "image/jpeg";
}

/**
 * Downscale / re-encode to JPEG so decoded size stays under Anthropic's 5 MiB cap.
 * Always runs through sharp when the decoded buffer is large or non-JPEG, so we never send a 5.4MB+ payload by mistake.
 */
async function shrinkImageForClaudeIfNeeded(
  normalizedBase64: string,
  mimeType: string,
): Promise<{ data: string; mediaType: ReturnType<typeof mimeToAnthropicMediaType> }> {
  const raw = Buffer.from(normalizedBase64, "base64");
  if (!raw.length) {
    throw new Error("Receipt image decoded to an empty buffer.");
  }

  if (raw.length <= CLAUDE_IMAGE_BYTE_TARGET) {
    return { data: normalizedBase64, mediaType: mimeToAnthropicMediaType(mimeType) };
  }

  let quality = 76;
  let maxWidth = 1600;

  for (let attempt = 0; attempt < 22; attempt++) {
    let out: Buffer;
    try {
      out = await sharp(raw, { failOn: "none" })
        .rotate()
        .resize({ width: maxWidth, height: maxWidth, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
    } catch (e) {
      console.error("[OCR] sharp failed while resizing receipt for Claude:", e);
      throw new Error(
        "Could not prepare the receipt image for OCR. Try a smaller or clearer photo.",
      );
    }

    if (out.length <= CLAUDE_IMAGE_BYTE_TARGET) {
      return { data: out.toString("base64"), mediaType: "image/jpeg" };
    }

    quality = Math.max(26, quality - 4);
    maxWidth = Math.max(480, Math.floor(maxWidth * 0.86));
  }

  const last = await sharp(raw, { failOn: "none" })
    .rotate()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 26, mozjpeg: true })
    .toBuffer();

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
  const model = ENV.anthropicReceiptModel?.trim() || "claude-3-5-sonnet-20241022";
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
