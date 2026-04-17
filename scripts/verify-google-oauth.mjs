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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

for (const name of [".env.local", ".env"]) {
  const p = path.join(root, name);
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
  }
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

async function main() {
  console.log("=== Google OAuth (Sheets + Drive) check ===\n");

  const accessToken = await refreshAccessToken();
  if (!accessToken) return;

  console.log("1) Refresh token → access token: OK\n");

  console.log("2) Drive API (drive.file 스코프 + Drive API 사용 설정 확인)…");
  const aboutRes = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=user/emailAddress,user/displayName",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!aboutRes.ok) {
    const t = await aboutRes.text();
    console.error("FAIL:", aboutRes.status, t);
    if (aboutRes.status === 403) {
      console.error(
        "      → drive.file 스코프가 refresh token에 없거나, 동의 화면에 반영 안 됐을 수 있습니다.\n" +
          "      → Google Cloud 에서 Drive API 사용 설정 여부를 확인하세요.",
      );
    }
    process.exitCode = 1;
    return;
  }
  const about = await aboutRes.json();
  const email = about.user?.emailAddress ?? "(unknown)";
  console.log("   OK — Drive 계정:", email);
  if (about.user?.displayName) {
    console.log("              이름:", about.user.displayName);
  }

  const folderId = process.env.GOOGLE_DRIVE_RECEIPTS_FOLDER_ID?.trim();
  if (folderId) {
    console.log("\n3) 영수증 폴더 GOOGLE_DRIVE_RECEIPTS_FOLDER_ID …");
    const fRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!fRes.ok) {
      console.error("FAIL:", fRes.status, await fRes.text());
      console.error(
        "      → 폴더 ID가 맞는지, 이 Google 계정으로 해당 폴더에 접근 가능한지 확인하세요.",
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
      "\n3) GOOGLE_DRIVE_RECEIPTS_FOLDER_ID 없음 — 영수증 Drive 업로드는 설정 후 가능 (선택).",
    );
  }

  console.log("\n=== 통과: 로컬/Railway에 넣은 토큰으로 Drive까지 동작합니다 ===\n");
  console.log(
    "실제 앱에서는 시트 내보내기 시 영수증 이미지가 이 폴더에 올라가는지 한 번 더 확인하면 됩니다.\n",
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
