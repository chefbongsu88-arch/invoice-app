/**
 * update-sheet-headers.ts
 *
 * Updates headers for all monthly (January~December) and quarterly (Q1~Q4)
 * sheets in the Google Spreadsheet to English, in the correct column order.
 *
 * Usage:
 *   1. Set GOOGLE_SERVICE_ACCOUNT_JSON environment variable, OR
 *      paste the JSON directly into the SERVICE_ACCOUNT_JSON constant below.
 *   2. Run: npx ts-node scripts/update-sheet-headers.ts
 */

import { createSign } from "crypto";
import { MAIN_TRACKER_HEADER_ROW } from "../shared/sheets-tracker-columns";

// ─── Config ──────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";

// Paste your service account JSON here if you're not using an env variable.
// Leave as "" to use the GOOGLE_SERVICE_ACCOUNT_JSON environment variable.
const SERVICE_ACCOUNT_JSON = "";

// ─── Header definition ───────────────────────────────────────────────────────

/** Main tab A–N — same as server `MAIN_TRACKER_HEADER_ROW` (Total after Tip, before Category). */
const MAIN_TRACKER_HEADER = [...MAIN_TRACKER_HEADER_ROW];

/** Monthly / quarterly tabs (no column N). Total (€) is column H, after Tip. */
const HEADER = [
  "Source",
  "Invoice #",
  "Vendor",
  "Date",
  "IVA (€)",
  "Base (€)",
  "Tip (€)",
  "Total (€)",
  "Category",
  "Currency",
  "Notes",
  "Image URL",
  "Exported At",
];

const MAIN_TRACKER_SHEET =
  process.env.GOOGLE_MAIN_SHEET_NAME ?? "2026 Invoice tracker";

const MONTHLY_SHEETS = [
  "January", "February", "March", "April",
  "May", "June", "July", "August",
  "September", "October", "November", "December",
];

const QUARTERLY_SHEETS = ["Q1", "Q2", "Q3", "Q4"];

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function generateJWT(serviceAccount: any): Promise<string> {
  const jwtHeader = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${jwtHeader}.${encodedPayload}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");

  return `${signatureInput}.${signature}`;
}

async function getAccessToken(serviceAccount: any): Promise<string> {
  const jwt = await generateJWT(serviceAccount);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get access token: ${err}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ─── Sheets helpers ───────────────────────────────────────────────────────────

function colLetterForLastHeader(len: number): string {
  if (len <= 0) return "A";
  let n = len;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function updateSheetHeaderRow(
  sheetName: string,
  accessToken: string,
  headers: string[],
): Promise<void> {
  const end = colLetterForLastHeader(headers.length);
  const range = encodeURIComponent(`${sheetName}!A1:${end}1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?valueInputOption=RAW`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [headers] }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`  ✗ ${sheetName}: ${err}`);
    return;
  }

  console.log(`  ✓ ${sheetName}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Resolve service account credentials
  const rawJson = SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    console.error(
      "ERROR: No service account JSON found.\n" +
      "  Set GOOGLE_SERVICE_ACCOUNT_JSON env variable, or paste the JSON into\n" +
      "  the SERVICE_ACCOUNT_JSON constant at the top of this script."
    );
    process.exit(1);
  }

  let serviceAccount: any;
  try {
    serviceAccount = JSON.parse(rawJson);
  } catch {
    console.error("ERROR: Invalid JSON in service account credentials.");
    process.exit(1);
  }

  console.log("🔐 Authenticating with Google...");
  const accessToken = await getAccessToken(serviceAccount);
  console.log("✅ Access token obtained.\n");

  console.log("📋 Updating main tracker header (fixes VAT → IVA, Receipt, column N)...");
  await updateSheetHeaderRow(MAIN_TRACKER_SHEET, accessToken, MAIN_TRACKER_HEADER);

  console.log("\n📋 Updating monthly sheet headers...");
  for (const sheet of MONTHLY_SHEETS) {
    await updateSheetHeaderRow(sheet, accessToken, HEADER);
  }

  console.log("\n📋 Updating quarterly sheet headers...");
  for (const sheet of QUARTERLY_SHEETS) {
    await updateSheetHeaderRow(sheet, accessToken, HEADER);
  }

  console.log("\n✅ All headers updated successfully!");
  console.log(`   Main (${MAIN_TRACKER_SHEET}): ${MAIN_TRACKER_HEADER.length} columns`);
  console.log(`   Month/Q: ${HEADER.join(" | ")}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
