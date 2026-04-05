import "dotenv/config";
import fs from "fs";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { API_SHEETS_EXPORT_BUILD } from "../../constants/receipt-api-origin";
import { ENV, getPublicServerBaseUrl } from "./env";
import { getReceiptShareImage } from "../receipt-share-store";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Large tRPC JSON (e.g. base64 images) + slow mobile networks: avoid premature close behind proxies.
  // Node 18+: requestTimeout defaults can be tight for multi‑MB bodies; relax for invoice export/OCR.
  server.requestTimeout = 180_000; // 3 min
  server.headersTimeout = 185_000; // must be > requestTimeout (Node requirement)
  server.keepAliveTimeout = 75_000;

  // Enable CORS for all routes - reflect the request origin to support credentials
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerOAuthRoutes(app);

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      timestamp: Date.now(),
      sheetsExportBuild: API_SHEETS_EXPORT_BUILD,
    });
  });

  // Public receipt images for Google Sheets =IMAGE() when Forge upload is unavailable (in-memory fallback).
  app.get("/api/receipt-share/:token", (req, res) => {
    const got = getReceiptShareImage(String(req.params.token ?? ""));
    if (!got) {
      res.status(404).type("text/plain").send("Not found or expired");
      return;
    }
    res.setHeader("Content-Type", got.mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(got.buffer);
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // Serve Expo web app static files from dist/ (only if `pnpm build:web` was run)
  const webDist = path.join(process.cwd(), "dist");
  const webIndexPath = path.join(webDist, "index.html");

  // Railway often runs `build:server` only — no index.html. Root "/" would otherwise show plain "Not found".
  app.get("/", (_req, res, next) => {
    if (!fs.existsSync(webIndexPath)) {
      res.redirect(302, "/api/health");
      return;
    }
    next();
  });

  app.use(express.static(webDist));

  // SPA fallback — return index.html for any non-API route
  app.get("*", (_req, res) => {
    res.sendFile(webIndexPath, (err) => {
      if (err) {
        res
          .status(404)
          .type("text/plain")
          .send("Not found (no web build). Try GET /api/health for API status.");
      }
    });
  });

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  // Railway/Docker inject PORT — healthchecks hit that port only. Never substitute another port.
  const hasPlatformPort =
    process.env.PORT != null && String(process.env.PORT).trim() !== "";
  const port = hasPlatformPort
    ? preferredPort
    : await findAvailablePort(preferredPort);

  if (!hasPlatformPort && port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  const listenHost = "0.0.0.0";
  server.on("error", (err) => {
    console.error("[api] server listen error:", err);
    process.exit(1);
  });
  server.listen(port, listenHost, () => {
    console.log(`[api] server listening on ${listenHost}:${port}`);
    console.log(
      `[boot] Receipt OCR keys: ANTHROPIC_API_KEY=${ENV.anthropicApiKey?.trim() ? "set" : "MISSING"} | GOOGLE_GEMINI_API_KEY=${ENV.googleGeminiApiKey?.trim() ? "set" : "MISSING"} | BUILT_IN_FORGE_API_KEY=${ENV.forgeApiKey?.trim() ? "set" : "MISSING"}`,
    );
    console.log(
      "[boot] Receipt OCR order: Gemini first when both keys → else Claude / Gemini-only / Forge.",
    );
    const pub = getPublicServerBaseUrl();
    console.log(
      `[boot] Receipt =IMAGE base URL: ${pub || "NOT SET — set PUBLIC_SERVER_URL=https://<your-app-host> (Railway: RAILWAY_PUBLIC_DOMAIN often works)"}`,
    );
  });
}

startServer().catch(console.error);
