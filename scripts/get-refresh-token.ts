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
 */

import * as http from "http";
import * as readline from "readline";

// ─── Config ────────────────────────────────────────────────────────────────────
// Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as env vars, or paste them directly
// below (never commit these values to Git).
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI  = "http://localhost:3001/oauth2callback";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function parseAuthCodeFromUserInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty paste.");
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

  console.log("\n📋 Open this URL in your browser and sign in with Google:\n");
  console.log(authUrl.toString());

  let code: string;

  if (manual) {
    console.log(`
--- 수동 모드 (--manual) ---
브라우저에서 로그인한 뒤 "사이트에 연결할 수 없음"이 나와도 괜찮습니다.
주소창(위쪽)의 전체 주소를 보면 ...?code=4%2F0A... 같은 긴 코드가 붙어 있습니다.
그 주소 전체를 복사해서 아래에 붙여넣고 Enter 하세요.
`);
    const pasted = await promptLine("주소 전체 또는 code 값 붙여넣기: ");
    code = parseAuthCodeFromUserInput(pasted);
  } else {
    console.log("\n로컬 서버가 3001 포트에서 code를 기다립니다. 브라우저에서 허용하면 자동으로 진행됩니다.");
    console.log("(연결 거부가 나오면 터미널에서 Ctrl+C 후 같은 명령에 --manual 을 붙여 다시 실행하세요.)\n");
    try {
      code = await waitForCode();
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

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost:3001");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end(`<h2>Error: ${error}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.end("<h2>✅ Authentication complete! Return to the terminal.</h2>");
        server.close();
        resolve(code);
      } else {
        res.end("<h2>Missing code parameter.</h2>");
      }
    });

    server.listen(3001, "0.0.0.0", () => {
      // Waiting for redirect (all interfaces — avoids some localhost binding issues)
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
  });
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
