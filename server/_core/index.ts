import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { ENV } from "./env";

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
    res.json({ ok: true, timestamp: Date.now() });
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // Serve Expo web app static files from dist/
  const webDist = path.join(process.cwd(), "dist");
  app.use(express.static(webDist));

  // SPA fallback — return index.html for any non-API route
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) res.status(404).send("Not found");
    });
  });

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`[api] server listening on port ${port}`);
    console.log(
      `[boot] Receipt OCR keys: ANTHROPIC_API_KEY=${ENV.anthropicApiKey?.trim() ? "set" : "MISSING"} | GOOGLE_GEMINI_API_KEY=${ENV.googleGeminiApiKey?.trim() ? "set" : "MISSING"} | BUILT_IN_FORGE_API_KEY=${ENV.forgeApiKey?.trim() ? "set" : "MISSING"}`,
    );
    console.log(
      "[boot] Order used: Claude first (if Anthropic set) → then Google Gemini direct (if Gemini key set) → else Forge. If you see invokeLLM errors, Forge is running — add/fix ANTHROPIC or GOOGLE_GEMINI on Railway.",
    );
  });
}

startServer().catch(console.error);
