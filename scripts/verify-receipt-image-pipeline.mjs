/**
 * Run: node scripts/verify-receipt-image-pipeline.mjs
 * Or:  pnpm run verify:receipt-image
 *
 * Sanity-checks in-memory receipt-share + public base URL without Google/Forge.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load compiled TS output is awkward; use dynamic import of .ts via tsx in package script instead.
// This script uses require from dist if present, else tells user to run tsx.

const distEnv = path.join(__dirname, "..", "dist", "index.mjs");

async function main() {
  console.log("=== Receipt image pipeline check ===\n");

  const markers = await import("node:fs/promises").then((fs) =>
    fs.readFile(distEnv, "utf8").catch(() => ""),
  );
  if (!markers.includes("image_pipeline=receipt-plain-url-v1")) {
    console.error("FAIL: dist/index.mjs missing image_pipeline=receipt-plain-url-v1");
    console.error("      Run: pnpm run build:server");
    process.exitCode = 1;
    return;
  }
  if (markers.includes("Image uploaded for") && markers.includes("fileName=")) {
    console.error("FAIL: dist still contains old Forge export log pattern");
    process.exitCode = 1;
    return;
  }
  console.log("OK: dist/index.mjs contains receipt-plain-url-v1 export marker");
  console.log("OK: dist does not contain old 'Image uploaded for ... fileName=' pattern\n");

  // Run vitest subset
  const { execSync } = await import("node:child_process");
  try {
    execSync(
      "pnpm exec vitest run server/__tests__/receipt-share-pipeline.test.ts",
      {
        cwd: path.join(__dirname, ".."),
        stdio: "inherit",
        shell: true,
      },
    );
  } catch {
    process.exitCode = 1;
  }
}

main();
