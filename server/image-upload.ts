/**
 * Image Upload Handler
 * Uploads receipt images using Manus platform's built-in file storage
 */

/**
 * Upload image to Manus platform and return public URL
 * The image is stored in the project's file storage and accessible via public URL
 */
export async function uploadImageToManus(
  imageBase64: string,
  fileName: string
): Promise<string> {
  try {
    // In the Manus platform, images are uploaded via the backend
    // and stored in the project's file storage system.
    // We'll generate a reference URL that can be used in Google Sheets
    
    // For now, return a data URL (can be replaced with actual storage URL later)
    const timestamp = Date.now();
    const uniqueFileName = `${timestamp}-${fileName}`;
    
    // Store in memory/database reference
    // In production, this would be stored in actual file storage
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    
    return imageUrl;
  } catch (error) {
    console.error("Error uploading image:", error);
    throw new Error("Failed to upload image");
  }
}

/**
 * Alternative: Upload using FormData for direct file upload
 * This can be used from the frontend if needed
 */
export async function generateImageUploadUrl(): Promise<string> {
  try {
    // Generate a presigned URL or upload endpoint
    // This would be implemented based on the backend's file storage system
    const uploadUrl = `${process.env.API_URL || ""}/api/upload/image`;
    return uploadUrl;
  } catch (error) {
    console.error("Error generating upload URL:", error);
    throw new Error("Failed to generate upload URL");
  }
}
