/**
 * Google OAuth refresh token + Drive scope 검증
 *
 * 사용:
 *   .env.local 에 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN 설정 후
 *   pnpm run verify:google
 *
 * Railway 값과 동일한지 로컬에서 확인할 때도 동일하게 실행합니다.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Base .env first, then .env.local with override — so local always wins (fixes "3rd try" when .env had old GOOGLE_REFRESH_TOKEN).
const envDefault = path.join(root, ".env");
const envLocal = path.join(root, ".env.local");
if (fs.existsSync(envDefault)) {
  dotenv.config({ path: envDefault });
}
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal, override: true });
}
if (fs.existsSync(envDefault) && fs.existsSync(envLocal)) {
  console.log("(Loaded .env then .env.local — local wins for duplicate keys.)\n");
}

async function refreshAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      "FAIL: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN 가 필요합니다.\n" +
        "       .env.local (또는 Railway Variables와 같은 값)을 설정하세요.",
    );
    process.exitCode = 1;
    return null;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("FAIL: refresh token 교환 실패:", res.status, text);
    console.error(
      "      invalid_grant → 토큰 만료/철회. get-refresh-token.ts 로 새로 발급하세요.\n" +
        "      invalid_client → CLIENT_ID / SECRET 이 OAuth 클라이언트와 일치하는지 확인하세요.",
    );
    process.exitCode = 1;
    return null;
  }

  const data = await res.json();
  return data.access_token;
}

/** What scopes this access token actually has (source of truth). */
async function tokenInfoScopes(accessToken) {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString());
  if (!res.ok) {
    return { ok: false, error: await res.text() };
  }
  const j = await res.json();
  const scopeStr = typeof j.scope === "string" ? j.scope : "";
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  return { ok: true, scopes, raw: j };
}

async function main() {
  console.log("=== Google OAuth (Sheets + Drive) check ===\n");

  const accessToken = await refreshAccessToken();
  if (!accessToken) return;

  console.log("1) Refresh token → access token: OK\n");

  console.log("2) 토큰에 붙은 OAuth scope 확인 (tokeninfo)…");
  const info = await tokenInfoScopes(accessToken);
  if (!info.ok) {
    console.error("FAIL: tokeninfo:", info.error);
    process.exitCode = 1;
    return;
  }
  console.log("   이 토큰의 scope 목록:");
  for (const s of info.scopes) {
    console.log("   -", s);
  }

  if (!info.scopes.includes(DRIVE_FILE_SCOPE)) {
    console.error("\nFAIL: 이 refresh token에는 `drive.file` 스코프가 없습니다.");
    console.error(
      "      → Google 계정 → 보안 → 타사 앱에서 이 앱 연결을 제거한 뒤,\n" +
        "      → pnpm exec tsx scripts/get-refresh-token.ts 로 다시 발급하고\n" +
        "      → 나온 GOOGLE_REFRESH_TOKEN 을 .env.local 과 Railway 에 모두 넣으세요.\n" +
        "      → 동의 화면(데이터 액세스)에 drive.file 이 체크돼 있는지도 확인하세요.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\n   OK — drive.file 이 토큰에 포함되어 있습니다.\n");

  const folderId = process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_ID?.trim();
  if (folderId) {
    console.log("3) 영수증 폴더 GOOGLE_DRIVE_RECEIPTS_FOLDER_ID (files.get — 업로드와 동일 API)…");
    const fRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!fRes.ok) {
      const t = await fRes.text();
      console.error("FAIL:", fRes.status, t);
      console.error(
        "      → 폴더 ID가 맞는지, 로그인한 계정이 그 폴더에 접근 가능한지 확인하세요.",
      );
      process.exitCode = 1;
      return;
    }
    const file = await fRes.json();
    if (file.mimeType !== "application/vnd.google-apps.folder") {
      console.warn("   WARN: 이 ID는 폴더가 아닙니다 (mimeType:", file.mimeType + ")");
    }
    console.log("   OK — 폴더 이름:", file.name);
    console.log("         폴더 ID:", file.id);
  } else {
    console.log(
      "3) GOOGLE_DRIVE_RECEIPTS_FOLDER_ID 없음 — Railway 에 폴더 ID를 넣으면 영수증이 그 안으로 올라갑니다.",
    );
  }

  console.log("\n=== 통과: drive.file 이 토큰에 있고, 필요 시 폴더 접근도 됩니다 ===\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
