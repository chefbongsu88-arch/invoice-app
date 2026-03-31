/**
 * get-refresh-token.ts
 *
 * OAuth Refresh Token 발급 스크립트
 *
 * 실행 방법:
 *   npx ts-node scripts/get-refresh-token.ts
 *
 * 절차:
 *   1. 브라우저에서 출력된 URL 열기
 *   2. Google 계정 로그인 및 권한 허용
 *   3. 리디렉션된 URL에서 code= 파라미터 값 복사
 *   4. 터미널에 붙여넣기 → Refresh Token 출력
 */

import * as http from "http";
import * as readline from "readline";

// ─── 환경변수에서 읽기 ────────────────────────────────────────────────────────
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 환경변수를 설정하거나
// 아래 상수에 직접 입력하세요 (절대 Git에 커밋하지 마세요)
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI  = "http://localhost:3001/oauth2callback";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET 환경변수를 설정하세요.");
    console.error("   실행 예시:");
    console.error("   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npx ts-node scripts/get-refresh-token.ts");
    process.exit(1);
  }

  // 1. Authorization URL 생성
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id",     CLIENT_ID);
  authUrl.searchParams.set("redirect_uri",  REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope",         SCOPE);
  authUrl.searchParams.set("access_type",   "offline");
  authUrl.searchParams.set("prompt",        "consent"); // force refresh_token 발급

  console.log("\n📋 아래 URL을 브라우저에서 열고 Google 계정으로 로그인하세요:\n");
  console.log(authUrl.toString());
  console.log("\n로그인 후 localhost:3001로 리디렉션됩니다. 잠시 기다려 주세요...\n");

  // 2. 로컬 서버로 code 수신
  const code = await waitForCode();

  // 3. code → refresh_token 교환
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    console.error("❌ Token 교환 실패:", await tokenRes.text());
    process.exit(1);
  }

  const data = await tokenRes.json() as {
    access_token:  string;
    refresh_token?: string;
    expires_in:    number;
  };

  if (!data.refresh_token) {
    console.error("❌ refresh_token이 없습니다. 이미 허용된 앱일 수 있습니다.");
    console.error("   Google 계정 → 보안 → 앱 접근 권한에서 이 앱을 제거 후 재시도하세요.");
    process.exit(1);
  }

  console.log("\n✅ 완료! Railway Variables에 아래 값들을 추가하세요:\n");
  console.log(`GOOGLE_CLIENT_ID     = ${CLIENT_ID}`);
  console.log(`GOOGLE_CLIENT_SECRET = ${CLIENT_SECRET}`);
  console.log(`GOOGLE_REFRESH_TOKEN = ${data.refresh_token}`);
  console.log("\n(access_token은 저장 불필요 — 서버가 refresh_token으로 자동 갱신합니다)\n");
}

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost:3001");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end(`<h2>오류: ${error}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.end("<h2>✅ 인증 완료! 터미널로 돌아가세요.</h2>");
        server.close();
        resolve(code);
      } else {
        res.end("<h2>code 파라미터가 없습니다.</h2>");
      }
    });

    server.listen(3001, () => {
      // 서버 대기 중
    });

    server.on("error", reject);
  });
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
