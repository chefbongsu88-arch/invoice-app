/**
 * fix-source-column.ts
 *
 * In the "2026 Invoice tracker" main sheet, fixes any value in column A (Source)
 * that is not "Camera" or "Email" (e.g. PDF filenames) by replacing it with "Email".
 *
 * Usage:
 *   1. Paste the service account JSON into SERVICE_ACCOUNT_JSON below,
 *      or set the GOOGLE_SERVICE_ACCOUNT_JSON environment variable.
 *   2. npx ts-node scripts/fix-source-column.ts
 */

import { createSign } from "crypto";

// ─── Config ────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const SHEET_NAME     = "2026 Invoice tracker";

// Paste the service account JSON here or use the environment variable.
const SERVICE_ACCOUNT_JSON = "";

// ─── Auth ──────────────────────────────────────────────────────────────────────

async function generateJWT(sa: any): Promise<string> {
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now,
  };
  const body           = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${header}.${body}`;
  const sign           = createSign("RSA-SHA256");
  sign.update(signatureInput);
  return `${signatureInput}.${sign.sign(sa.private_key, "base64url")}`;
}

async function getAccessToken(sa: any): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  await generateJWT(sa),
    }),
  });
  if (!res.ok) throw new Error(`Token error: ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawJson = SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    console.error("❌ No service account JSON found.\n   Paste it into SERVICE_ACCOUNT_JSON or set the environment variable.");
    process.exit(1);
  }

  const sa = JSON.parse(rawJson);

  console.log("🔐 Authenticating with Google...");
  const accessToken = await getAccessToken(sa);
  console.log("✅ Authenticated\n");

  // 1. Read all values in column A
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME + "!A:A")}`;
  const readRes = await fetch(readUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!readRes.ok) throw new Error(`Read failed: ${await readRes.text()}`);

  const readData = await readRes.json() as { values?: string[][] };
  const rows = readData.values ?? [];

  console.log(`📋 Total rows: ${rows.length} (including header)\n`);

  // 2. Find rows that need fixing (skip header row[0], start from row[1])
  const updates: { row: number; oldValue: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cellValue = rows[i]?.[0] ?? "";
    if (cellValue !== "Camera" && cellValue !== "Email") {
      updates.push({ row: i + 1, oldValue: cellValue }); // row is 1-indexed
    }
  }

  if (updates.length === 0) {
    console.log("✅ Nothing to fix. All Source values are correct.");
    return;
  }

  console.log(`🔧 ${updates.length} row(s) to fix:`);
  updates.forEach(u => console.log(`   Row ${u.row}: "${u.oldValue}" → "Email"`));
  console.log();

  // 3. Batch update all at once
  const batchData = updates.map(u => ({
    range:  `${SHEET_NAME}!A${u.row}`,
    values: [["Email"]],
  }));

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`;
  const batchRes = await fetch(batchUrl, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: batchData,
    }),
  });

  if (!batchRes.ok) throw new Error(`Update failed: ${await batchRes.text()}`);

  console.log(`✅ ${updates.length} cell(s) updated!`);
  console.log(`   Sheet: "${SHEET_NAME}" > Column A`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
