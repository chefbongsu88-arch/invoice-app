/**
 * Image Upload Handler using Manus Platform Storage
 * Uploads receipt images to the platform's built-in storage and returns public URLs
 * Requires BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY (Railway) for public HTTPS URLs in Sheets.
 */

import { isForgeStorageConfigured } from "./_core/env";
import { detectMimeFromBuffer } from "./receipt-share-store";
import { storagePut } from "./storage";

function extensionForReceiptMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "bin";
}

/** Prefer magic bytes so Gmail wrong Content-Type does not mis-label PDFs as JPEG. */
function resolveReceiptMimeForUpload(buffer: Buffer, hintMime: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "application/pdf";
  }
  const magic = detectMimeFromBuffer(buffer);
  const h = hintMime.trim().toLowerCase();
  if (h.startsWith("image/") && magic.startsWith("image/")) return magic;
  if (h === "application/pdf" || h === "application/x-pdf") return h;
  return magic || h || "application/octet-stream";
}

/**
 * Upload receipt bytes to Forge/Manus storage when configured.
 * Returns a stable HTTPS URL suitable for Google Sheets =IMAGE() (Google fetches later, often from a different host than the export request).
 */
export async function uploadReceiptBinaryToForgeIfConfigured(
  buffer: Buffer,
  hintMime: string,
  fileLabel: string,
): Promise<string> {
  if (!isForgeStorageConfigured() || !buffer?.length) return "";

  const mime = resolveReceiptMimeForUpload(buffer, hintMime);
  const ext = extensionForReceiptMime(mime);
  const slug = String(fileLabel ?? "receipt")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "receipt";
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  const storagePath = `invoices/sheets-receipt/${timestamp}-${random}/${slug}.${ext}`;

  try {
    const { url } = await storagePut(storagePath, buffer, mime);
    if (url?.trim()) {
      console.log(`[Image Upload] Sheets receipt (Forge): ${mime} ${slug}`);
    }
    return url?.trim() ?? "";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Image Upload] Forge upload for Sheets receipt failed (${slug}):`, msg);
    return "";
  }
}

/**
 * Upload image to platform storage and return public URL
 * @param imageBase64 - Base64 encoded image data (with or without data URL prefix)
 * @param fileName - Name of the file (e.g., "receipt-2026-03-28.jpg")
 * @param maxRetries - Number of retry attempts (default: 3)
 * @returns Public URL that can be embedded in Google Sheets
 */
export async function uploadImageToStorage(
  imageBase64: string,
  fileName: string,
  maxRetries = 3
): Promise<string> {
  if (!isForgeStorageConfigured()) {
    console.warn(
      `[Image Upload] Skipped (${fileName}): Forge storage not configured (BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY). Sheets =IMAGE() previews are most reliable with Forge (persistent URL); without it the server falls back to /api/receipt-share (RAM unless RECEIPT_SHARE_DISK_DIR is set).`,
    );
    return "";
  }

  // Validate inputs
  if (!imageBase64 || imageBase64.trim().length === 0) {
    console.error("[Image Upload] Error: Empty image data");
    return "";
  }

  if (!fileName || fileName.trim().length === 0) {
    console.error("[Image Upload] Error: Empty file name");
    return "";
  }

  // Retry logic
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Image Upload] Attempt ${attempt}/${maxRetries}: Uploading ${fileName}`);

      // Convert base64 to buffer
      let cleanBase64 = imageBase64;
      
      // Remove data URL prefix if present (data:image/jpeg;base64,xxx)
      if (imageBase64.includes(",")) {
        cleanBase64 = imageBase64.split(",")[1];
      }

      // Validate base64
      if (!cleanBase64 || cleanBase64.trim().length === 0) {
        throw new Error("Invalid base64 data after cleaning");
      }

      const imageBuffer = Buffer.from(cleanBase64, "base64");

      // Validate buffer size (max 50MB)
      if (imageBuffer.length > 50 * 1024 * 1024) {
        throw new Error(`Image too large: ${imageBuffer.length} bytes`);
      }

      let mimeType = resolveReceiptMimeForUpload(imageBuffer, "");
      if (mimeType === "application/octet-stream") mimeType = "image/jpeg";

      console.log(`[Image Upload] Detected MIME type: ${mimeType}`);

      // Create a unique path for the image
      // Format: invoices/{timestamp}-{random}/{fileName}
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 8);
      const storagePath = `invoices/${timestamp}-${random}/${fileName}`;

      // Upload to platform storage with detected MIME type
      const { url } = await storagePut(storagePath, imageBuffer, mimeType);

      // Validate URL
      if (!url || url.trim().length === 0) {
        throw new Error("Upload returned empty URL");
      }

      console.log(`[Image Upload] ✅ Successfully uploaded: ${fileName}`);
      console.log(`[Image Upload] URL: ${url}`);
      return url;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Image Upload] ❌ Attempt ${attempt} failed:`, msg);
      if (msg.includes("Storage proxy credentials missing")) {
        break;
      }
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        console.log(`[Image Upload] Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error(`[Image Upload] ❌ Failed to upload ${fileName} after ${maxRetries} attempts`);
  return "";
}

/**
 * Convert local file path to base64 (for server-side processing if needed)
 * Note: This is mainly for reference - images come from client as base64
 */
export async function filePathToBase64(filePath: string): Promise<string> {
  try {
    const fs = await import("fs");
    const data = fs.readFileSync(filePath);
    return data.toString("base64");
  } catch (error) {
    console.error("[Image Upload] Error reading file:", error);
    throw new Error("Failed to read image file");
  }
}
