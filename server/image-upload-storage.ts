/**
 * Image Upload Handler using Manus Platform Storage
 * Uploads receipt images to the platform's built-in storage and returns public URLs
 * Requires BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY (Railway) for public HTTPS URLs in Sheets.
 */

import { ENV } from "./_core/env";
import { storagePut } from "./storage";

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
  if (!ENV.forgeApiUrl?.trim() || !ENV.forgeApiKey?.trim()) {
    console.warn(
      `[Image Upload] Skipped (${fileName}): set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY on the server for hosted receipt image links in Google Sheets. Rows still export; the image column will be empty.`,
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

      // Detect MIME type from buffer signature (magic bytes)
      let mimeType = "image/jpeg"; // default
      if (imageBuffer.length >= 4) {
        const header = imageBuffer.slice(0, 4);
        // PNG: 89 50 4E 47
        if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
          mimeType = "image/png";
        }
        // JPEG: FF D8 FF
        else if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
          mimeType = "image/jpeg";
        }
        // GIF: 47 49 46 38
        else if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) {
          mimeType = "image/gif";
        }
        // WebP: RIFF...WEBP
        else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
          if (imageBuffer.length >= 12) {
            const webpCheck = imageBuffer.slice(8, 12);
            if (webpCheck[0] === 0x57 && webpCheck[1] === 0x45 && webpCheck[2] === 0x42 && webpCheck[3] === 0x50) {
              mimeType = "image/webp";
            }
          }
        }
      }

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
