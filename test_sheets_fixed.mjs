import { createSign } from "crypto";

const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const spreadsheetId = "1-6DV0NCrWGRityQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const sheetName = "Invoice Tracker";

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

// Get access token
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

const tokenData = await tokenRes.json();
const accessToken = tokenData.access_token;

console.log("✅ Access token obtained");
console.log("\nTesting Sheets API append with FIXED URL...");

// FIXED: Correct format - range should NOT have colon at the end before :append
const range = `${sheetName}!A:K`;
const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

console.log("Append URL:", appendUrl);

const testData = [
  ["Camera", "TEST-001", "Test Vendor", "2026-03-27", "100.00", "21.00", "79.00", "Office Supplies", "EUR", "Test note", new Date().toISOString()]
];

const appendRes = await fetch(appendUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ values: testData }),
});

console.log("Response status:", appendRes.status);
const responseText = await appendRes.text();
console.log("Response body:", responseText);

if (appendRes.ok) {
  console.log("\n✅ Data appended successfully!");
} else {
  console.log("\n❌ Append failed!");
}
