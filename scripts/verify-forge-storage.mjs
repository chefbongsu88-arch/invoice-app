/**
 * Forge(Manus) 스토리지가 시트용 영수증 URL로 쓸 수 있는지 업로드 한 번으로 검증합니다.
 *
 * 사용:
 *   1) .env.example 을 참고해 .env.local 에 BUILT_IN_FORGE_API_URL, BUILT_IN_FORGE_API_KEY 설정
 *   2) pnpm run verify:forge
 *
 * Railway: Variables 에 동일 키를 넣은 뒤 로컬에서 같은 값으로 실행하거나,
 *          일시적으로 export BUILT_IN_FORGE_API_URL=... 등으로 실행합니다.
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

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey) {
  return String(relKey).replace(/^\/+/, "");
}

function buildUploadUrl(baseUrl, relKey) {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

/** 1×1 PNG */
const MIN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function main() {
  console.log("=== Forge storage (Sheets receipt URL) check ===\n");

  const baseUrl =
    process.env.BUILT_IN_FORGE_API_URL?.trim().replace(/\/+$/, "") ||
    process.env.VITE_FRONTEND_FORGE_API_URL?.trim().replace(/\/+$/, "");
  const apiKey =
    process.env.BUILT_IN_FORGE_API_KEY?.trim() ||
    process.env.VITE_FRONTEND_FORGE_API_KEY?.trim();

  if (!baseUrl || !apiKey) {
    console.error(
      "FAIL: Set both URL and key — e.g. BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY, or Manus names VITE_FRONTEND_FORGE_API_URL + VITE_FRONTEND_FORGE_API_KEY.",
    );
    console.error("      Copy .env.example → .env.local (or Railway Variables).");
    process.exitCode = 1;
    return;
  }

  const buf = Buffer.from(MIN_PNG_B64, "base64");
  const storagePath = `invoices/forge-verify/${Date.now()}-probe.png`;
  const uploadUrl = buildUploadUrl(baseUrl, storagePath);

  console.log("Using base URL:", baseUrl);
  console.log("POST:", `${uploadUrl.origin}${uploadUrl.pathname}?path=…`);
  console.log(
    "Tip: the URL must be the Manus storage proxy API origin (from Application secrets Reveal), not the forge.manus.ai website unless that row shows exactly that.\n",
  );

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), "probe.png");

  let res;
  try {
    res = await fetch(uploadUrl.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    console.error("FAIL: network error calling Forge upload:", e);
    process.exitCode = 1;
    return;
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`FAIL: upload HTTP ${res.status}`);
    console.error(text.slice(0, 2000));
    process.exitCode = 1;
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("FAIL: response is not JSON:", text.slice(0, 500));
    process.exitCode = 1;
    return;
  }

  const publicUrl = json?.url;
  if (!publicUrl || typeof publicUrl !== "string" || !/^https?:\/\//i.test(publicUrl)) {
    console.error("FAIL: expected { url: \"https://...\" } from storage upload, got:", json);
    process.exitCode = 1;
    return;
  }

  console.log("OK: Upload succeeded.");
  console.log("    Public URL:", publicUrl);

  let getRes;
  try {
    getRes = await fetch(publicUrl, { method: "GET", redirect: "follow" });
  } catch (e) {
    console.error("FAIL: could not GET public URL:", e);
    process.exitCode = 1;
    return;
  }

  const ct = getRes.headers.get("content-type") || "";
  console.log(`OK: GET public URL → HTTP ${getRes.status}, Content-Type: ${ct || "(none)"}`);

  if (!getRes.ok) {
    console.error("FAIL: public URL did not return success (Sheets =IMAGE may not work).");
    process.exitCode = 1;
  }
}

main();
