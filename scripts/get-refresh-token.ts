/**
 * get-refresh-token.ts
 *
 * Script to obtain a Google OAuth Refresh Token.
 *
 * Usage:
 *   pnpm exec tsx scripts/get-refresh-token.ts
 *
 * If the browser shows "connection refused" on localhost, use manual mode:
 *   pnpm exec tsx scripts/get-refresh-token.ts --manual
 * Then copy the FULL address from the browser bar (it still contains ?code=... even if the page errors).
 *
 * Windows PowerShell (paste breaks or Empty paste): pass the redirect URL without typing it at PS>:
 *   $env:GOOGLE_OAUTH_URL = 'http://localhost:3001/oauth2callback?code=...&scope=...'
 *   pnpm exec tsx scripts/get-refresh-token.ts --manual
 * Use single quotes so & is not treated as a command separator. Clear after: Remove-Item Env:GOOGLE_OAUTH_URL
 *
 * Or put the same single line in a file and run:
 *   pnpm exec tsx scripts/get-refresh-token.ts --manual --code-file=C:\Users\You\oauth-redirect.txt
 */

import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

/** Terminal line-wrap often breaks long OAuth URLs when pasted → Google says "response_type missing". */
function writeAuthUrlOneLineFile(url: string): string {
  const p = path.join(os.tmpdir(), "invoice-app-google-oauth-url.txt");
  fs.writeFileSync(p, url, "utf8");
  return p;
}

function tryOpenDefaultBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    } else if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    /* optional */
  }
}

// ─── Config ────────────────────────────────────────────────────────────────────
// Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as env vars, or paste them directly
// below (never commit these values to Git).
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI  = "http://localhost:3001/oauth2callback";

/** Sheets + per-file Drive access (upload receipts into a folder you pick). Re-consent after changing scopes. */
const SCOPE =
  "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";

function parseAuthCodeFromUserInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      "Empty input. On PowerShell do not paste at the PS> line (use the script prompt, or set GOOGLE_OAUTH_URL).",
    );
  }
  if (trimmed.includes("code=")) {
    try {
      const url = trimmed.startsWith("http")
        ? new URL(trimmed)
        : new URL("http://localhost/oauth2callback?" + trimmed.replace(/^[?]/, ""));
      const c = url.searchParams.get("code");
      if (c) return c;
    } catch {
      /* fall through */
    }
    const m = trimmed.match(/[?&]code=([^&]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return trimmed;
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Avoid interactive paste on Windows (PowerShell & readline issues). */
function readPresetOAuthRedirectFromEnvOrFile(): string | null {
  const fromEnv =
    process.env.GOOGLE_OAUTH_URL?.trim() ||
    process.env.GOOGLE_OAUTH_CODE?.trim() ||
    "";
  if (fromEnv) return fromEnv;

  const arg = process.argv.find((a) => a.startsWith("--code-file="));
  if (!arg) return null;
  let fp = arg.slice("--code-file=".length).trim();
  if ((fp.startsWith('"') && fp.endsWith('"')) || (fp.startsWith("'") && fp.endsWith("'"))) {
    fp = fp.slice(1, -1);
  }
  if (!fp || !fs.existsSync(fp)) {
    console.error(`❌ --code-file path not found: ${fp || "(empty)"}`);
    process.exit(1);
  }
  return fs.readFileSync(fp, "utf8").trim();
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const manual = process.argv.includes("--manual");

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.");
    console.error("   Example:");
    console.error("   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy pnpm exec tsx scripts/get-refresh-token.ts");
    process.exit(1);
  }

  // 1. Build authorization URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id",     CLIENT_ID);
  authUrl.searchParams.set("redirect_uri",  REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope",         SCOPE);
  authUrl.searchParams.set("access_type",   "offline");
  authUrl.searchParams.set("prompt",        "consent"); // force refresh_token to be issued

  const authUrlString = authUrl.toString();
  const urlBackupPath = writeAuthUrlOneLineFile(authUrlString);

  console.log("\n📋 Open this URL in your browser and sign in with Google:\n");
  console.log(authUrlString);
  console.log(
    "\n⚠️  “response_type missing” 오류 = 주소가 잘린 것입니다. 터미널에서 복사하지 말고 아래를 따르세요.\n" +
      `    → 전체 URL 한 줄 파일: ${urlBackupPath}\n` +
      "    → Windows: 메모장이 열리면 Ctrl+A → 복사 → 브라우저 주소창에 붙여넣기(한 줄인지 확인).\n",
  );
  if (process.platform === "win32") {
    try {
      spawn("notepad.exe", [urlBackupPath], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* optional */
    }
  }

  let code: string;

  if (manual) {
    const preset = readPresetOAuthRedirectFromEnvOrFile();
    if (preset) {
      console.log(
        "\n✓ Using GOOGLE_OAUTH_URL / GOOGLE_OAUTH_CODE / --code-file=... (skipping paste prompt).\n",
      );
      code = parseAuthCodeFromUserInput(preset);
    } else {
      console.log(`
--- 수동 모드 (--manual) ---
브라우저에서 로그인한 뒤 "사이트에 연결할 수 없음"이 나와도 괜찮습니다.
주소창의 전체 주소(...?code=...&scope=...)를 복사하세요.

Windows PowerShell에서 붙여넣기가 어렵면 이 창을 닫고:
  $env:GOOGLE_OAUTH_URL = '여기에_주소창_전체_한줄'
  pnpm exec tsx scripts/get-refresh-token.ts --manual
(작은따옴표 ' 로 감싸서 & 오류를 피하세요.)

또는 메모장에 주소 한 줄 저장 후:
  pnpm exec tsx scripts/get-refresh-token.ts --manual --code-file=C:\\경로\\oauth.txt
`);
      tryOpenDefaultBrowser(authUrlString);
      const pasted = await promptLine("주소 전체 또는 code 값 붙여넣기: ");
      code = parseAuthCodeFromUserInput(pasted);
    }
  } else {
    console.log(
      "\n로컬 서버를 먼저 띄운 뒤 브라우저가 열립니다 (localhost 연결 거부 방지).\n" +
        "로그인 후 허용하면 터미널로 돌아옵니다.\n",
    );
    try {
      code = await waitForCode(authUrlString);
    } catch (e) {
      console.error("\n❌ 로컬 서버 오류:", e);
      console.error("   다음으로 다시 실행해 보세요:\n   pnpm exec tsx scripts/get-refresh-token.ts --manual\n");
      process.exit(1);
    }
  }

  // 3. Exchange code for refresh_token
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
    console.error("❌ Token exchange failed:", await tokenRes.text());
    process.exit(1);
  }

  const data = await tokenRes.json() as {
    access_token:  string;
    refresh_token?: string;
    expires_in:    number;
  };

  if (!data.refresh_token) {
    console.error("❌ No refresh_token returned. The app may already be authorized.");
    console.error("   Go to Google Account → Security → Third-party app access, remove this app, then retry.");
    process.exit(1);
  }

  console.log("\n✅ Done! Add these values to your Railway Variables:\n");
  console.log(`GOOGLE_CLIENT_ID     = ${CLIENT_ID}`);
  console.log(`GOOGLE_CLIENT_SECRET = ${CLIENT_SECRET}`);
  console.log(`GOOGLE_REFRESH_TOKEN = ${data.refresh_token}`);
  console.log("\n(access_token does not need to be saved — the server refreshes it automatically)\n");
}

function waitForCode(authUrlString: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost:3001");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<h2>Error: ${error}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h2>OK — Authentication complete. You can close this tab and return to the terminal.</h2>");
        server.close();
        resolve(code);
      } else {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<h2>Missing code parameter.</h2>");
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            "Port 3001 is already in use. Close the other program or run: pnpm exec tsx scripts/get-refresh-token.ts --manual",
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(3001, "0.0.0.0", () => {
      console.log("✓ localhost:3001 listening — opening Google sign-in in your browser…\n");
      tryOpenDefaultBrowser(authUrlString);
    });
  });
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
