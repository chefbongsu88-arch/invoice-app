/**
 * Image Upload Handler using Manus Platform Storage
 * Uploads receipt images to the platform's built-in storage and returns public URLs
 * This is the safe, recommended approach - no external API configuration needed
 */

import { storagePut } from "./storage";

/**
 * Upload image to platform storage and return public URL
 * @param imageBase64 - Base64 encoded image data
 * @param fileName - Name of the file (e.g., "receipt-2026-03-28.jpg")
 * @returns Public URL that can be embedded in Google Sheets
 */
export async function uploadImageToStorage(
  imageBase64: string,
  fileName: string
): Promise<string> {
  try {
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(imageBase64, "base64");

    // Create a unique path for the image
    // Format: invoices/{timestamp}-{random}/{fileName}
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const storagePath = `invoices/${timestamp}-${random}/${fileName}`;

    // Upload to platform storage
    const { url } = await storagePut(storagePath, imageBuffer, "image/jpeg");

    console.log(`[Image Upload] Successfully uploaded: ${fileName} -> ${url}`);
    return url;
  } catch (error) {
    console.error("[Image Upload] Error uploading image:", error);
    // Return empty string if upload fails - the export will still work with empty image URL
    return "";
  }
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
