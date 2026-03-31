/**
 * rebuild-meat-monthly.ts
 *
 * Meat_Monthly 시트를 영어 피벗 테이블 형식으로 재구성합니다.
 *
 * 레이아웃:
 *   행1: "Meat Monthly Purchase — La Portenia / Es Cuco"
 *   행2: Vendor | January | February | ... | December | Annual Total
 *   행3: La Portenia (€)
 *   행4: La Portenia (Count)
 *   행5: Es Cuco (€)
 *   행6: Es Cuco (Count)
 *   행7: Meat Total (€)
 *
 * 실행: GOOGLE_SERVICE_ACCOUNT_JSON='...' npx ts-node scripts/rebuild-meat-monthly.ts
 */

import { createSign } from "crypto";

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const SHEET_NAME     = "Meat_Monthly";
const TRACKER_SHEET  = "2026 Invoice tracker";
const LA_PORTENIA    = "La Portenia";
const ES_CUCO        = "Es Cuco";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SERVICE_ACCOUNT_JSON = "";

// ─── 인증 ─────────────────────────────────────────────────────────────────────

async function generateJWT(sa: any): Promise<string> {
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const si   = `${header}.${body}`;
  const sign = createSign("RSA-SHA256");
  sign.update(si);
  return `${si}.${sign.sign(sa.private_key, "base64url")}`;
}

async function getAccessToken(sa: any): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await generateJWT(sa),
    }),
  });
  if (!res.ok) throw new Error(`Token error: ${await res.text()}`);
  return ((await res.json()) as any).access_token;
}

// ─── Sheets 헬퍼 ──────────────────────────────────────────────────────────────

async function readRange(token: string, range: string): Promise<any[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Read error: ${await res.text()}`);
  return ((await res.json()) as any).values ?? [];
}

async function clearRange(token: string, range: string): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:clear`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Clear error: ${await res.text()}`);
}

async function writeRange(token: string, range: string, values: any[][]): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`Write error: ${await res.text()}`);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawJson = SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    console.error("❌ 서비스 계정 JSON이 없습니다.");
    process.exit(1);
  }
  const sa = JSON.parse(rawJson);

  console.log("🔐 인증 중...");
  const token = await getAccessToken(sa);
  console.log("✅ 인증 완료\n");

  // 1. 메인 시트에서 데이터 읽기 (A2:M)
  console.log(`📋 "${TRACKER_SHEET}" 데이터 읽는 중...`);
  const rows = await readRange(token, `${TRACKER_SHEET}!A2:M`);
  console.log(`   ${rows.length}행 로드됨\n`);

  // 2. 월별 × 업체별 집계
  // monthData[monthIndex][vendorKey] = { total, count }
  const monthData: Record<number, Record<string, { total: number; count: number }>> = {};
  for (let m = 0; m < 12; m++) {
    monthData[m] = {
      [LA_PORTENIA]: { total: 0, count: 0 },
      [ES_CUCO]:     { total: 0, count: 0 },
    };
  }

  const parseCurrency = (v: any) => {
    if (!v) return 0;
    const n = parseFloat(String(v).replace(/[€,\s]/g, ""));
    return isNaN(n) ? 0 : n;
  };

  const normalizeVendor = (v: string): string | null => {
    const lv = v.toLowerCase().trim();
    if (lv.includes("porteni") || lv.includes("portenia")) return LA_PORTENIA;
    if (lv.includes("cuco") || lv.includes("cuco"))        return ES_CUCO;
    return null;
  };

  for (const row of rows) {
    const vendorRaw   = row[2] || "";
    const dateRaw     = row[3] || "";
    const totalAmount = parseCurrency(row[4]);

    const vendor = normalizeVendor(vendorRaw);
    if (!vendor) continue;

    // 날짜에서 월 추출 (DD/MM/YYYY 또는 YYYY-MM-DD)
    const s  = String(dateRaw).replace(/^'+|'+$/g, "").trim();
    const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let monthIndex = -1;
    if (m1) monthIndex = parseInt(m1[2], 10) - 1;
    else if (m2) monthIndex = parseInt(m2[2], 10) - 1;
    if (monthIndex < 0 || monthIndex > 11) continue;

    monthData[monthIndex][vendor].total += totalAmount;
    monthData[monthIndex][vendor].count += 1;
  }

  // 3. 시트 데이터 구성
  const headerRow = ["Vendor", ...MONTHS, "Annual Total"];

  // La Portenia (€)
  const lpEur: any[] = [LA_PORTENIA + " (€)"];
  for (let m = 0; m < 12; m++) lpEur.push(Math.round(monthData[m][LA_PORTENIA].total * 100) / 100);
  lpEur.push(Math.round(lpEur.slice(1).reduce((a: number, b: number) => a + b, 0) * 100) / 100);

  // La Portenia (Count)
  const lpCnt: any[] = [LA_PORTENIA + " (Count)"];
  for (let m = 0; m < 12; m++) lpCnt.push(monthData[m][LA_PORTENIA].count);
  lpCnt.push(lpCnt.slice(1).reduce((a: number, b: number) => a + b, 0));

  // Es Cuco (€)
  const ecEur: any[] = [ES_CUCO + " (€)"];
  for (let m = 0; m < 12; m++) ecEur.push(Math.round(monthData[m][ES_CUCO].total * 100) / 100);
  ecEur.push(Math.round(ecEur.slice(1).reduce((a: number, b: number) => a + b, 0) * 100) / 100);

  // Es Cuco (Count)
  const ecCnt: any[] = [ES_CUCO + " (Count)"];
  for (let m = 0; m < 12; m++) ecCnt.push(monthData[m][ES_CUCO].count);
  ecCnt.push(ecCnt.slice(1).reduce((a: number, b: number) => a + b, 0));

  // Meat Total (€)
  const meatTotal: any[] = ["Meat Total (€)"];
  for (let m = 0; m < 12; m++) {
    meatTotal.push(Math.round((monthData[m][LA_PORTENIA].total + monthData[m][ES_CUCO].total) * 100) / 100);
  }
  meatTotal.push(Math.round(meatTotal.slice(1).reduce((a: number, b: number) => a + b, 0) * 100) / 100);

  const sheetData = [
    ["Meat Monthly Purchase — La Portenia / Es Cuco"],
    headerRow,
    lpEur,
    lpCnt,
    ecEur,
    ecCnt,
    meatTotal,
  ];

  // 4. 시트 업데이트
  console.log(`🔄 "${SHEET_NAME}" 시트 초기화 중...`);
  await clearRange(token, `${SHEET_NAME}!A:Z`);

  console.log(`✏️  데이터 쓰는 중...`);
  await writeRange(token, `${SHEET_NAME}!A1`, sheetData);

  console.log(`\n✅ "${SHEET_NAME}" 시트 재구성 완료!`);
  console.log(`   레이아웃: 1행=제목, 2행=헤더, 3~7행=데이터`);
  console.log(`   집계된 업체: La Portenia, Es Cuco`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
