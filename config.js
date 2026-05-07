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

  facebook: {
    appSecret: required("FB_APP_SECRET"),
    verifyToken: required("FB_VERIFY_TOKEN"),
    pageAccessToken: required("FB_PAGE_ACCESS_TOKEN"),
    pageId: required("FB_PAGE_ID"),
    graphVersion: optional("FB_GRAPH_VERSION", "v21.0"),
  },

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
  },

  db: {
    path: optional("DB_PATH", "./data/replyly.db"),
  },

  behavior: {
    confidenceThreshold: parseFloat(optional("CONFIDENCE_THRESHOLD", "0.7")),
    autoReplyEnabled: bool("AUTO_REPLY_ENABLED", true),
    autoSendShopeeLink: bool("AUTO_SEND_SHOPEE_LINK", true),
    defaultShopeeLink: optional("DEFAULT_SHOPEE_LINK", ""),
  },
};

export const graphApiUrl = (path) =>
  `https://graph.facebook.com/${config.facebook.graphVersion}${path.startsWith("/") ? "" : "/"}${path}`;
