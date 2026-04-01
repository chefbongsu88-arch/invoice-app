/**
 * clear-all-sheets.ts
 *
 * Clears all data rows (row 2 onward) from every sheet while keeping headers (row 1).
 * Target sheets: main sheet, January–December, Q1–Q4, Meat_Monthly, Meat_Quarterly
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
 *     npx ts-node scripts/clear-all-sheets.ts
 */

// ─── Config ────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";

const ALL_SHEETS = [
  "2026 Invoice tracker",
  "January", "February", "March", "April",
  "May", "June", "July", "August",
  "September", "October", "November", "December",
  "Q1", "Q2", "Q3", "Q4",
  "Meat_Monthly",
  "Meat_Quarterly",
];

// ─── Auth (OAuth Refresh Token) ────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.error("❌ Missing env vars. Please set all three:");
    console.error("   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN");
    console.error("   (Run npx ts-node scripts/get-refresh-token.ts first)");
    process.exit(1);
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token error: ${await res.text()}`);
  return ((await res.json()) as any).access_token;
}

// ─── Sheets helpers ────────────────────────────────────────────────────────────

async function readFirstRow(token: string, sheetName: string): Promise<any[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + "!A1:AZ1")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.warn(`   ⚠️  Failed to read header (${sheetName}): ${await res.text()}`);
    return [];
  }
  const data = await res.json() as { values?: any[][] };
  return data.values?.[0] ?? [];
}

async function clearDataRows(token: string, sheetName: string): Promise<void> {
  // Clear from row 2 to end
  const range = `${sheetName}!A2:AZ`;
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:clear`;
  const res   = await fetch(url, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Clear failed (${sheetName}): ${await res.text()}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔐 Authenticating...");
  const token = await getAccessToken();
  console.log("✅ Authenticated\n");

  console.log(`🗑️  Clearing data from ${ALL_SHEETS.length} sheets...\n`);

  let successCount = 0;
  let skipCount    = 0;

  for (const sheet of ALL_SHEETS) {
    try {
      // Check header to confirm sheet exists
      const header = await readFirstRow(token, sheet);

      if (header.length === 0) {
        console.log(`   ⏭️  [SKIP] ${sheet} — no header or sheet not found`);
        skipCount++;
        continue;
      }

      await clearDataRows(token, sheet);
      console.log(`   ✅ ${sheet} — header kept, data cleared (${header.length} columns)`);
      successCount++;
    } catch (err: any) {
      console.error(`   ❌ ${sheet} — error: ${err.message}`);
    }
  }

  console.log(`\n✅ Done: ${successCount} sheet(s) cleared, ${skipCount} skipped`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
