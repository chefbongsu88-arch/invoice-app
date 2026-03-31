/**
 * fix-source-column.ts
 *
 * "2026 Invoice tracker" 메인 시트의 A열(Source)에서
 * "Camera" 또는 "Email" 이 아닌 값(PDF 파일명 등)을 모두 "Email" 로 수정합니다.
 *
 * 실행 방법:
 *   1. 아래 SERVICE_ACCOUNT_JSON 에 서비스 계정 JSON 붙여넣기
 *      또는 환경변수 GOOGLE_SERVICE_ACCOUNT_JSON 설정
 *   2. npx ts-node scripts/fix-source-column.ts
 */

import { createSign } from "crypto";

// ─── 설정 ─────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const SHEET_NAME     = "2026 Invoice tracker";

// 여기에 서비스 계정 JSON을 직접 붙여넣거나 환경변수를 사용하세요.
const SERVICE_ACCOUNT_JSON = "";

// ─── 인증 ─────────────────────────────────────────────────────────────────────

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

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawJson = SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    console.error("❌ 서비스 계정 JSON이 없습니다.\n   SERVICE_ACCOUNT_JSON 상수에 붙여넣거나 환경변수를 설정하세요.");
    process.exit(1);
  }

  const sa = JSON.parse(rawJson);

  console.log("🔐 Google 인증 중...");
  const accessToken = await getAccessToken(sa);
  console.log("✅ 인증 완료\n");

  // 1. 시트 전체 데이터 읽기 (A열 포함)
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME + "!A:A")}`;
  const readRes = await fetch(readUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!readRes.ok) throw new Error(`읽기 실패: ${await readRes.text()}`);

  const readData = await readRes.json() as { values?: string[][] };
  const rows = readData.values ?? [];

  console.log(`📋 전체 행 수: ${rows.length} (헤더 포함)\n`);

  // 2. 수정이 필요한 행 찾기 (헤더 row[0] 제외, row[1] 부터)
  const updates: { row: number; oldValue: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cellValue = rows[i]?.[0] ?? "";
    if (cellValue !== "Camera" && cellValue !== "Email") {
      updates.push({ row: i + 1, oldValue: cellValue }); // row는 1-indexed
    }
  }

  if (updates.length === 0) {
    console.log("✅ 수정이 필요한 행이 없습니다. 모든 Source 값이 올바릅니다.");
    return;
  }

  console.log(`🔧 수정 대상 ${updates.length}건:`);
  updates.forEach(u => console.log(`   행 ${u.row}: "${u.oldValue}" → "Email"`));
  console.log();

  // 3. batchUpdate 로 한번에 수정
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

  if (!batchRes.ok) throw new Error(`업데이트 실패: ${await batchRes.text()}`);

  console.log(`✅ ${updates.length}개 셀 업데이트 완료!`);
  console.log(`   시트: "${SHEET_NAME}" > A열`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
