import { createSign } from "crypto";

const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) {
  console.error("Service Account JSON not set");
  process.exit(1);
}

const serviceAccount = JSON.parse(serviceAccountJson);
console.log("Service Account Email:", serviceAccount.client_email);
console.log("Private Key exists:", !!serviceAccount.private_key);
console.log("Private Key length:", serviceAccount.private_key?.length);

// Test JWT generation
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

try {
  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");
  const jwt = `${signatureInput}.${signature}`;
  console.log("\n✅ JWT generated successfully!");
  console.log("JWT length:", jwt.length);
  console.log("JWT preview:", jwt.substring(0, 50) + "...");
} catch (error) {
  console.error("\n❌ JWT generation failed:", error.message);
}
