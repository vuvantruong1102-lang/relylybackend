import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initSchema, pool } from "./db.js";
import { adminRouter } from "./admin.js";
import { webhookRouter, rawBodyMiddleware, verifyWebhookSignature } from "./webhook.js";

const app = express();

// CORS - cho phép frontend gọi từ FRONTEND_URL
app.use(cors({
  origin: config.frontendUrl === "*" ? true : config.frontendUrl.split(",").map(s => s.trim()),
  credentials: true,
  exposedHeaders: ["Content-Type"],
}));

// Health (KHÔNG yêu cầu auth, dùng cho Railway healthcheck)
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), version: "2.0.0" });
});

// Webhook routes - cần raw body để verify HMAC, mount TRƯỚC express.json
app.use("/webhook", express.json({ verify: rawBodyMiddleware }), verifyWebhookSignature, webhookRouter);

// Admin/API routes
app.use("/api", adminRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ---- Bootstrap -----------------------------------------------------------

async function start() {
  try {
    await initSchema();
    console.log("[server] DB schema ready.");
  } catch (err) {
    console.error("[server] Failed to init DB schema:", err);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    console.log(`[server] Replyly backend listening on :${config.port} (${config.nodeEnv})`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[server] Received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      try {
        await pool.end();
        console.log("[server] DB pool closed. Exiting.");
        process.exit(0);
      } catch (err) {
        console.error("[server] Error closing pool:", err);
        process.exit(1);
      }
    });
    // Force exit sau 10s
    setTimeout(() => process.exit(1), 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
