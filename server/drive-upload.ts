/**
 * Google Drive upload for receipt binaries (same OAuth user as Sheets).
 * Returns a public HTTPS URL suitable for Google Sheets =IMAGE() / links.
 */

/**
 * Upload receipt bytes to a Drive folder and return a view URL.
 * Returns null on failure (caller may fall back to Forge / receipt-share).
 */
export async function uploadReceiptToGoogleDrive(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  accessToken: string,
  folderId: string | undefined,
): Promise<string | null> {
  try {
    const id = await uploadMultipartToDrive(buffer, mimeType, fileName, accessToken, folderId);
    await makeFilePublic(id, accessToken);
    return `https://drive.google.com/uc?export=view&id=${id}`;
  } catch (error) {
    console.error("[Drive] Receipt upload failed:", error);
    return null;
  }
}

/**
 * Upload image to Google Drive (legacy JPEG/base64 API).
 * Returns a public URL that can be embedded in Google Sheets.
 */
export async function uploadImageToDrive(
  imageBase64: string,
  fileName: string,
  accessToken: string,
  folderId?: string,
): Promise<string> {
  const buf = Buffer.from(imageBase64, "base64");
  const url = await uploadReceiptToGoogleDrive(buf, "image/jpeg", fileName, accessToken, folderId);
  if (!url) {
    throw new Error("Failed to upload image to Google Drive");
  }
  return url;
}

async function uploadMultipartToDrive(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  accessToken: string,
  folderId: string | undefined,
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name: fileName,
    mimeType,
  };
  const trimmed = folderId?.trim();
  if (trimmed) {
    metadata.parents = [trimmed];
  }

  const boundary = "===============7330845974216740156==";
  // multipart/related: first part starts with --boundary (RFC 2387 / Drive samples)
  const partJson = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
  ]);
  const partMedia = Buffer.concat([
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const body = Buffer.concat([partJson, partMedia]);

  const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary="${boundary}"`,
      Authorization: `Bearer ${accessToken}`,
    },
    body,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error("[Drive] Upload error:", uploadRes.status, errText);
    if (
      uploadRes.status === 403 &&
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(errText)
    ) {
      console.error(
        "[Drive] Scope fix: GOOGLE_REFRESH_TOKEN was issued without drive.file. " +
          "Run pnpm exec tsx scripts/get-refresh-token.ts (includes drive.file), " +
          "put the NEW refresh token in Railway, redeploy, then export again.",
      );
    }
    throw new Error(`Failed to upload file to Google Drive (${uploadRes.status})`);
  }

  const uploadData = (await uploadRes.json()) as { id?: string };
  const id = uploadData.id;
  if (!id) {
    throw new Error("Drive upload response missing file id");
  }
  return id;
}

/**
 * Make a Google Drive file publicly accessible (anyone with link can view).
 */
async function makeFilePublic(fileId: string, accessToken: string): Promise<void> {
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
    console.error("[Drive] Permission error:", permissionRes.status, errText);
    if (
      permissionRes.status === 403 &&
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(errText)
    ) {
      console.error(
        "[Drive] Scope fix: same as upload — re-issue refresh token with drive.file (get-refresh-token.ts), update Railway.",
      );
    }
    throw new Error("Failed to make file public");
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
      const searchData = (await searchRes.json()) as { files?: Array<{ id: string }> };
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
      console.error("[Drive] Folder creation error:", errText);
      throw new Error("Failed to create folder");
    }

    const createData = (await createRes.json()) as { id: string };
    const folderId = createData.id;

    // Make folder public
    await makeFilePublic(folderId, accessToken);

    return folderId;
  } catch (error) {
    console.error("[Drive] Error getting/creating folder:", error);
    throw new Error("Failed to manage Google Drive folder");
  }
}
