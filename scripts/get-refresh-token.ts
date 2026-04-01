/**
 * get-refresh-token.ts
 *
 * Script to obtain a Google OAuth Refresh Token.
 *
 * Usage:
 *   npx ts-node scripts/get-refresh-token.ts
 *
 * Steps:
 *   1. Open the URL printed in the terminal in your browser
 *   2. Sign in with your Google account and grant permissions
 *   3. Copy the `code=` parameter value from the redirected URL
 *   4. Paste it into the terminal → the Refresh Token will be printed
 */

import * as http from "http";

// ─── Config ────────────────────────────────────────────────────────────────────
// Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as env vars, or paste them directly
// below (never commit these values to Git).
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI  = "http://localhost:3001/oauth2callback";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.");
    console.error("   Example:");
    console.error("   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npx ts-node scripts/get-refresh-token.ts");
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
  console.log("\nAfter login you will be redirected to localhost:3001. Please wait...\n");

  // 2. Receive code via local server
  const code = await waitForCode();

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

    server.listen(3001, () => {
      // Waiting for redirect...
    });

    server.on("error", reject);
  });
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
