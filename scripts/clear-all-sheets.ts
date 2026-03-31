/**
 * clear-all-sheets.ts
 *
 * 모든 시트의 헤더(1행)는 유지하고 데이터 행(2행~)을 전부 삭제합니다.
 * 대상 시트: 메인 시트, January~December, Q1~Q4, Meat_Monthly, Meat_Quarterly
 *
 * 실행 방법:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
 *     npx ts-node scripts/clear-all-sheets.ts
 */

// ─── 설정 ─────────────────────────────────────────────────────────────────────

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

// ─── 인증 (OAuth Refresh Token) ───────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.error("❌ 환경변수가 없습니다. 아래 3개를 설정해주세요:");
    console.error("   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN");
    console.error("   (먼저 npx ts-node scripts/get-refresh-token.ts 실행)");
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

// ─── Sheets 헬퍼 ──────────────────────────────────────────────────────────────

async function readFirstRow(token: string, sheetName: string): Promise<any[]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + "!A1:AZ1")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.warn(`   ⚠️  헤더 읽기 실패 (${sheetName}): ${await res.text()}`);
    return [];
  }
  const data = await res.json() as { values?: any[][] };
  return data.values?.[0] ?? [];
}

async function clearDataRows(token: string, sheetName: string): Promise<void> {
  // 2행부터 끝까지 clear
  const range = `${sheetName}!A2:AZ`;
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:clear`;
  const res   = await fetch(url, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Clear 실패 (${sheetName}): ${await res.text()}`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔐 인증 중...");
  const token = await getAccessToken();
  console.log("✅ 인증 완료\n");

  console.log(`🗑️  ${ALL_SHEETS.length}개 시트 데이터 초기화 시작...\n`);

  let successCount = 0;
  let skipCount    = 0;

  for (const sheet of ALL_SHEETS) {
    try {
      // 헤더 확인 (존재 여부 체크용)
      const header = await readFirstRow(token, sheet);

      if (header.length === 0) {
        console.log(`   ⏭️  [SKIP] ${sheet} — 헤더 없음 또는 시트 없음`);
        skipCount++;
        continue;
      }

      await clearDataRows(token, sheet);
      console.log(`   ✅ ${sheet} — 헤더 유지, 데이터 삭제 완료 (헤더: ${header.length}열)`);
      successCount++;
    } catch (err: any) {
      console.error(`   ❌ ${sheet} — 오류: ${err.message}`);
    }
  }

  console.log(`\n✅ 완료: ${successCount}개 시트 초기화, ${skipCount}개 스킵`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
