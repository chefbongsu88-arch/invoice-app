/**
 * Google Drive Image Upload Handler
 * Uploads receipt images to Google Drive and returns public URLs
 */

/**
 * Upload image to Google Drive using the Service Account
 * Returns a public URL that can be embedded in Google Sheets
 */
export async function uploadImageToDrive(
  imageBase64: string,
  fileName: string,
  accessToken: string,
  folderId?: string
): Promise<string> {
  try {
    // Create metadata for the file
    const metadata = {
      name: fileName,
      mimeType: "image/jpeg",
      ...(folderId && { parents: [folderId] }),
    };

    // Create multipart body
    const boundary = "===============7330845974216740156==";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    // Convert base64 to binary
    const binaryString = Buffer.from(imageBase64, "base64");

    const multipartBody = 
      delimiter +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      delimiter +
      `Content-Type: image/jpeg\r\n\r\n` +
      binaryString.toString("binary") +
      closeDelimiter;

    // Upload to Google Drive
    const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary="${boundary}"`,
        Authorization: `Bearer ${accessToken}`,
      },
      body: multipartBody,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error("Drive upload error:", errText);
      throw new Error("Failed to upload image to Google Drive");
    }

    const uploadData = await uploadRes.json() as { id: string };
    const fileId = uploadData.id;

    // Make file public
    await makeFilePublic(fileId, accessToken);

    // Return public URL
    const publicUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
    return publicUrl;
  } catch (error) {
    console.error("Error uploading image to Drive:", error);
    throw new Error("Failed to upload image to Google Drive");
  }
}

/**
 * Make a Google Drive file publicly accessible
 */
async function makeFilePublic(fileId: string, accessToken: string): Promise<void> {
  try {
    const permissionUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`;
    const permissionRes = await fetch(permissionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        role: "reader",
        type: "anyone",
      }),
    });

    if (!permissionRes.ok) {
      const errText = await permissionRes.text();
      console.error("Permission error:", errText);
      throw new Error("Failed to make file public");
    }
  } catch (error) {
    console.error("Error making file public:", error);
    throw new Error("Failed to set file permissions");
  }
}

/**
 * Get or create the Invoice Tracker folder in Google Drive
 */
export async function getOrCreateInvoiceFolder(accessToken: string): Promise<string> {
  try {
    const folderName = "Invoice Tracker - Receipt Images";

    // Search for existing folder
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (searchRes.ok) {
      const searchData = await searchRes.json() as { files?: Array<{ id: string }> };
      if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
      }
    }

    // Create new folder if not found
    const createUrl = "https://www.googleapis.com/drive/v3/files";
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error("Folder creation error:", errText);
      throw new Error("Failed to create folder");
    }

    const createData = await createRes.json() as { id: string };
    const folderId = createData.id;

    // Make folder public
    await makeFilePublic(folderId, accessToken);

    return folderId;
  } catch (error) {
    console.error("Error getting/creating folder:", error);
    throw new Error("Failed to manage Google Drive folder");
  }
}
