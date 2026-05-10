import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function optional(name, fallback) {
  return process.env[name] ?? fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),
  nodeEnv: optional("NODE_ENV", "development"),

  // App-level Facebook credentials (chung cho tất cả page)
  facebook: {
    appId: required("FB_APP_ID"),
    appSecret: required("FB_APP_SECRET"),
    graphVersion: optional("FB_GRAPH_VERSION", "v21.0"),
  },

  // AES-256-GCM key để encrypt page access token trong DB
  // Generate: openssl rand -hex 32
  encryptionKey: required("ENCRYPTION_KEY"),

  // Postgres connection string từ Railway
  databaseUrl: required("DATABASE_URL"),

  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
  },

  behavior: {
    confidenceThreshold: parseFloat(optional("CONFIDENCE_THRESHOLD", "0.7")),
    autoReplyEnabled: bool("AUTO_REPLY_ENABLED", true),
    autoSendShopeeLink: bool("AUTO_SEND_SHOPEE_LINK", true),
  },

  // Mật khẩu chung cho dashboard (gửi qua header X-Auth-Password)
  // Frontend lưu trong localStorage sau khi login
  auth: {
    password: required("DASHBOARD_PASSWORD"),
  },

  frontendUrl: optional("FRONTEND_URL", "*"),
};

export const graphApiUrl = (path) =>
  `https://graph.facebook.com/${config.facebook.graphVersion}${path.startsWith("/") ? "" : "/"}${path}`;

// Validate ENCRYPTION_KEY format
if (!/^[0-9a-f]{64}$/i.test(config.encryptionKey)) {
  console.error("[config] ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32");
  process.exit(1);
}
