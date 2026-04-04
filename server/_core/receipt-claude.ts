import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

import { ENV } from "./env";

/** Anthropic vision limit is 5 MB per image (decoded); stay under with margin. */
const CLAUDE_IMAGE_BYTE_TARGET = 4_500_000;

function mimeToAnthropicMediaType(mime: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (mime === "image/png") return "image/png";
  if (mime === "image/webp") return "image/webp";
  if (mime === "image/gif") return "image/gif";
  return "image/jpeg";
}

/**
 * Downscale / re-encode to JPEG so the payload stays under Anthropic's 5 MB cap.
 */
async function shrinkImageForClaudeIfNeeded(
  normalizedBase64: string,
  mimeType: string,
): Promise<{ data: string; mediaType: ReturnType<typeof mimeToAnthropicMediaType> }> {
  const raw = Buffer.from(normalizedBase64, "base64");
  if (raw.length <= CLAUDE_IMAGE_BYTE_TARGET) {
    return { data: normalizedBase64, mediaType: mimeToAnthropicMediaType(mimeType) };
  }

  let quality = 82;
  let maxWidth = 2400;
  for (let attempt = 0; attempt < 16; attempt++) {
    const out = await sharp(raw)
      .rotate()
      .resize({ width: maxWidth, height: maxWidth, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= CLAUDE_IMAGE_BYTE_TARGET) {
      return { data: out.toString("base64"), mediaType: "image/jpeg" };
    }
    quality = Math.max(38, quality - 6);
    maxWidth = Math.max(720, Math.floor(maxWidth * 0.85));
  }

  const last = await sharp(raw)
    .rotate()
    .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 45, mozjpeg: true })
    .toBuffer();
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
