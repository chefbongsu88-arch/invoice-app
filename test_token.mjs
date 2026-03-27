import { createSign } from "crypto";

const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const serviceAccount = JSON.parse(serviceAccountJson);

// Generate JWT
const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: serviceAccount.client_email,
  scope: "https://www.googleapis.com/auth/spreadsheets",
  aud: "https://oauth2.googleapis.com/token",
  exp: now + 3600,
  iat: now,
};

const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signatureInput = `${header}.${encodedPayload}`;
const sign = createSign("RSA-SHA256");
sign.update(signatureInput);
const signature = sign.sign(serviceAccount.private_key, "base64url");
const jwt = `${signatureInput}.${signature}`;

console.log("Testing token exchange...");

// Exchange JWT for access token
const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  }),
});

console.log("Token response status:", tokenRes.status);
const tokenData = await tokenRes.json();

if (tokenRes.ok) {
  console.log("✅ Access token obtained!");
  console.log("Token type:", tokenData.token_type);
  console.log("Expires in:", tokenData.expires_in);
  console.log("Access token preview:", tokenData.access_token.substring(0, 50) + "...");
} else {
  console.error("❌ Token exchange failed!");
  console.error("Error:", tokenData.error);
  console.error("Error description:", tokenData.error_description);
}
