import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { webhookRouter } from "./webhook.js";
import { adminRouter } from "./admin.js";
import "./db.js"; // ensure DB is initialized at boot

const app = express();

// Trust the platform's reverse proxy (Railway/Render terminate TLS upstream)
app.set("trust proxy", 1);

// CORS: if FRONTEND_URL is set, restrict to that origin; otherwise allow all
// (handy for local/curl testing). Multiple origins can be comma-separated.
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
}));

// IMPORTANT: webhook needs RAW body (Buffer) for HMAC signature verification.
// Mount webhook BEFORE express.json() and use express.raw on it.
app.use("/webhook", express.raw({ type: "*/*", limit: "2mb" }), webhookRouter);

// All other routes use parsed JSON
app.use(express.json({ limit: "1mb" }));

// Admin / dashboard API
app.use("/api", adminRouter);

// Root + health (Railway/Render hit this to verify the service is alive)
app.get("/", (_req, res) => {
  res.json({
    name: "Replyly backend",
    status: "ok",
    webhook: "/webhook",
    api: "/api",
    events: "/api/events",
  });
});
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Bind to 0.0.0.0 so the platform's load balancer can reach the container
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`[server] Listening on 0.0.0.0:${config.port}`);
  console.log(`[server] Webhook path: /webhook`);
  console.log(`[server] Verify token: ${config.facebook.verifyToken}`);
  console.log(`[server] Page ID: ${config.facebook.pageId}`);
  console.log(`[server] Auto-reply: ${config.behavior.autoReplyEnabled ? "ON" : "OFF"}`);
  console.log(`[server] CORS allowed: ${allowedOrigins.length ? allowedOrigins.join(", ") : "all origins"}`);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`\n[server] Received ${signal}, shutting down...`);
  server.close(() => {
    console.log("[server] HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
});
