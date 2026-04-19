import { COOKIE_NAME, ONE_YEAR_MS } from "../../shared/const.js";
import type { Express, Request, Response } from "express";
import { getUserByOpenId, upsertUser } from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

async function syncUser(userInfo: {
  openId?: string | null;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  platform?: string | null;
}) {
  if (!userInfo.openId) {
    throw new Error("openId missing from user info");
  }

  const lastSignedIn = new Date();
  await upsertUser({
    openId: userInfo.openId,
    name: userInfo.name || null,
    email: userInfo.email ?? null,
    loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
    lastSignedIn,
  });
  const saved = await getUserByOpenId(userInfo.openId);
  return (
    saved ?? {
      openId: userInfo.openId,
      name: userInfo.name,
      email: userInfo.email,
      loginMethod: userInfo.loginMethod ?? null,
      lastSignedIn,
    }
  );
}

function buildUserResponse(
  user:
    | Awaited<ReturnType<typeof getUserByOpenId>>
    | {
        openId: string;
        name?: string | null;
        email?: string | null;
        loginMethod?: string | null;
        lastSignedIn?: Date | null;
      },
) {
  return {
    id: (user as any)?.id ?? null,
    openId: user?.openId ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    loginMethod: user?.loginMethod ?? null,
    lastSignedIn: (user?.lastSignedIn ?? new Date()).toISOString(),
  };
}

type GmailCallbackState = {
  scheme: string;
  redirectUri?: string;
};

/** App scheme + optional redirect URI from Gmail OAuth state. */
function resolveGmailCallbackState(stateParam: string | undefined): GmailCallbackState {
  const fallback = process.env.GMAIL_OAUTH_APP_SCHEME ?? "manus20260325194257";
  if (!stateParam) return { scheme: fallback };
  try {
    const json = Buffer.from(stateParam, "base64").toString("utf8");
    const o = JSON.parse(json) as { scheme?: string; redirectUri?: string };
    const scheme =
      typeof o.scheme === "string" && /^[a-z][a-z0-9+.-]+$/i.test(o.scheme)
        ? o.scheme
        : fallback;
    const redirectUri =
      typeof o.redirectUri === "string" &&
      /^https:\/\/[^?#]+$/i.test(o.redirectUri) &&
      /\/auth\/gmail\/callback$/i.test(o.redirectUri)
        ? o.redirectUri
        : undefined;
    return { scheme, redirectUri };
  } catch {
    return { scheme: fallback };
  }
}

function resolveTokenExchangeRedirectUri(
  req: Request,
  stateRedirectUri: string | undefined,
): string {
  if (stateRedirectUri) {
    try {
      const stateUrl = new URL(stateRedirectUri);
      const reqUrl = new URL(getCallbackRedirectUri(req));
      if (
        stateUrl.protocol === "https:" &&
        stateUrl.hostname.toLowerCase() === reqUrl.hostname.toLowerCase() &&
        stateUrl.pathname === reqUrl.pathname
      ) {
        return stateUrl.toString();
      }
    } catch {
      // fallback below
    }
  }
  return getCallbackRedirectUri(req);
}

/**
 * Return HTML that navigates to the app custom scheme. Some proxies strip `Location: manus://…` on 302;
 * an in-page redirect is more reliable for ASWebAuthenticationSession to receive the callback URL.
 */
function gmailOAuthAppBouncePage(appUrl: string): string {
  const escAttr = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Invoice Tracker — return to app</title>
<meta http-equiv="refresh" content="0;url=${escAttr(appUrl)}"/>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:24px;max-width:420px;margin:0 auto;line-height:1.5;color:#111;-webkit-text-size-adjust:100%">
<p style="margin:0 0 8px;font-size:17px"><strong>Authentication complete</strong></p>
<p style="margin:0 0 16px;font-size:15px;color:#444">Opening the app… If nothing happens, tap the blue button (use your finger, not a mouse on a phone).</p>
<!-- iOS in-app Safari often ignores &lt;a href="custom:"&gt; taps; use &lt;button&gt; + location.href from a direct user gesture. -->
<button type="button" id="openBtn" style="display:block;width:100%;box-sizing:border-box;margin:0;padding:18px 20px;font-size:17px;font-weight:600;color:#fff;background:#0b57d0;border:none;border-radius:12px;cursor:pointer;-webkit-tap-highlight-color:rgba(0,0,0,0.15);touch-action:manipulation;min-height:52px">
Open Invoice Tracker
</button>
<p style="margin:16px 0 0;font-size:13px;color:#666">Tip: If the button still does nothing, tap <strong>Share</strong> (□↑) → <strong>Open in Safari</strong>, then tap the button again. Or close this sheet (X) and try Sign in from the app once more.</p>
<a id="openLink" href=${JSON.stringify(appUrl)} style="display:block;margin-top:14px;font-size:15px;font-weight:600;color:#0b57d0;text-align:center">Or tap this link</a>
<script>
(function(){
  var u = ${JSON.stringify(appUrl)};
  function go(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    try { window.location.replace(u); } catch (e1) {}
    try { window.location.href = u; } catch (e2) {}
  }
  function wire() {
    var btn = document.getElementById("openBtn");
    var link = document.getElementById("openLink");
    if (btn) {
      btn.addEventListener("click", go, { passive: false });
    }
    if (link) link.addEventListener("click", go, { passive: false });
  }
  wire();
  go();
  setTimeout(function(){ go(); }, 150);
  setTimeout(function(){ go(); }, 500);
})();
</script>
</body>
</html>`;
}

function getRailwayBaseUrl(req: Request): string {
  // Railway sets RAILWAY_PUBLIC_DOMAIN automatically
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  // Fallback: derive from request host
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:3000";
  return `${proto}://${host}`;
}

function getCallbackRedirectUri(req: Request): string {
  const baseUrl = getRailwayBaseUrl(req).replace(/\/$/, "");
  const callbackPath = req.path.startsWith("/") ? req.path : `/${req.path}`;
  return `${baseUrl}${callbackPath}`;
}

export function registerOAuthRoutes(app: Express) {
  // Gmail OAuth callback — exchanges code for access token, then HTML bounce to manus://gmail-auth?…
  app.get("/auth/gmail/callback", async (req: Request, res: Response) => {
    const state = getQueryParam(req, "state");
    const callbackState = resolveGmailCallbackState(state);
    const appScheme = callbackState.scheme;

    /** Google sends ?error=&error_description= when user cancels or consent fails — no `code`. */
    const oauthError = getQueryParam(req, "error");
    if (oauthError) {
      const appUrl = `${appScheme}://gmail-auth?error=${encodeURIComponent(oauthError)}`;
      console.warn("[Gmail OAuth] Google error param:", oauthError, getQueryParam(req, "error_description") ?? "");
      res.status(200).type("html").send(gmailOAuthAppBouncePage(appUrl));
      return;
    }

    const code = getQueryParam(req, "code");
    if (!code) {
      // Prefetch, double-open, or bad link — still return HTML so ASWebAuthenticationSession can close into the app.
      const appUrl = `${appScheme}://gmail-auth?error=${encodeURIComponent("missing_code")}`;
      console.warn("[Gmail OAuth] callback without code; path:", req.path, "query:", req.url);
      res.status(200).type("html").send(gmailOAuthAppBouncePage(appUrl));
      return;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      const appUrl = `${appScheme}://gmail-auth?error=${encodeURIComponent("server_misconfigured")}`;
      res.status(200).type("html").send(gmailOAuthAppBouncePage(appUrl));
      return;
    }

    // Use the URL Google actually called back to. This avoids token exchange failures when
    // a stale env redirect URI doesn't match the hostname/path used in the authorization step.
    const redirectUri = resolveTokenExchangeRedirectUri(req, callbackState.redirectUri);

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        console.error("[Gmail OAuth] Token exchange failed:", err, "redirect_uri used:", redirectUri);
        const appUrl =
          `${appScheme}://gmail-auth?error=${encodeURIComponent("token_exchange_failed")}` +
          `&detail=${encodeURIComponent(err.slice(0, 300))}`;
        res.status(200).type("html").send(gmailOAuthAppBouncePage(appUrl));
        return;
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };

      let email = "";
      let name = "";
      try {
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userRes.ok) {
          const userData = (await userRes.json()) as {
            email?: string;
            name?: string;
            given_name?: string;
            family_name?: string;
          };
          email = userData.email ?? "";
          const rawName = userData.name?.trim();
          const joined = [userData.given_name, userData.family_name]
            .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
            .join(" ")
            .trim();
          name = rawName && rawName.length > 0 ? rawName : joined;
        }
      } catch {
        // non-fatal — email/name are optional
      }

      const params = new URLSearchParams({ token: tokenData.access_token });
      if (email) params.set("email", email);
      if (name) params.set("name", name);
      // iOS ASWebAuthenticationSession only returns to the app with a custom URL scheme — not https
      // (unless Universal Links are configured). Redirect into the app so the token is delivered.
      const appLoc = `${appScheme}://gmail-auth?${params.toString()}`;
      res.status(200).type("html").send(gmailOAuthAppBouncePage(appLoc));
    } catch (err) {
      console.error("[Gmail OAuth] Callback error:", err);
      const appUrl = `${appScheme}://gmail-auth?error=${encodeURIComponent("server_error")}`;
      res.status(200).type("html").send(gmailOAuthAppBouncePage(appUrl));
    }
  });

  // Landing page that the app's openAuthSessionAsync intercepts (user often must tap browser "Done"/X)
  app.get("/auth/gmail/success", (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Done</title>
<style>
body{font-family:system-ui,sans-serif;padding:24px;max-width:420px;margin:0 auto;line-height:1.5;color:#111}
h1{font-size:1.1rem;margin:0 0 12px}
p{margin:0 0 10px;font-size:15px}
strong{color:#0b57d0}
</style>
</head>
<body>
<h1>Old sign-in page</h1>
<p>If you see this after Google login, the server is still using an old deploy. Redeploy the latest API so sign-in returns you to the app automatically.</p>
<p style="font-size:13px;color:#444">You can close this tab (X / Done). Then update Railway and try Gmail sign-in again.</p>
</body>
</html>`);
  });


  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      await syncUser(userInfo);
      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // Redirect to the frontend URL (Expo web on port 8081)
      // Cookie is set with parent domain so it works across both 3000 and 8081 subdomains
      const frontendUrl =
        process.env.EXPO_WEB_PREVIEW_URL ||
        process.env.EXPO_PACKAGER_PROXY_URL ||
        "http://localhost:8081";
      res.redirect(302, frontendUrl);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  app.get("/api/oauth/mobile", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      const user = await syncUser(userInfo);

      const sessionToken = await sdk.createSessionToken(userInfo.openId!, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({
        app_session_id: sessionToken,
        user: buildUserResponse(user),
      });
    } catch (error) {
      console.error("[OAuth] Mobile exchange failed", error);
      res.status(500).json({ error: "OAuth mobile exchange failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    res.json({ success: true });
  });

  // Get current authenticated user - works with both cookie (web) and Bearer token (mobile)
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const user = await sdk.authenticateRequest(req);
      res.json({ user: buildUserResponse(user) });
    } catch (error) {
      console.error("[Auth] /api/auth/me failed:", error);
      res.status(401).json({ error: "Not authenticated", user: null });
    }
  });

  // Establish session cookie from Bearer token
  // Used by iframe preview: frontend receives token via postMessage, then calls this endpoint
  // to get a proper Set-Cookie response from the backend (3000-xxx domain)
  app.post("/api/auth/session", async (req: Request, res: Response) => {
    try {
      // Authenticate using Bearer token from Authorization header
      const user = await sdk.authenticateRequest(req);

      // Get the token from the Authorization header to set as cookie
      const authHeader = req.headers.authorization || req.headers.Authorization;
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res.status(400).json({ error: "Bearer token required" });
        return;
      }
      const token = authHeader.slice("Bearer ".length).trim();

      // Set cookie for this domain (3000-xxx)
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.json({ success: true, user: buildUserResponse(user) });
    } catch (error) {
      console.error("[Auth] /api/auth/session failed:", error);
      res.status(401).json({ error: "Invalid token" });
    }
  });
}
