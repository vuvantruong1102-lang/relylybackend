import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Railway Postgres dùng SSL nội bộ, không cần config thêm
  ssl: config.nodeEnv === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

// Helper: query với log lỗi
export async function query(sql, params = []) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error("[db] Query failed:", sql.slice(0, 100), err.message);
    throw err;
  }
}

// ---- Schema migration -----------------------------------------------------

export async function initSchema() {
  console.log("[db] Initializing schema...");

  await query(`
    CREATE TABLE IF NOT EXISTS pages (
      id                    SERIAL PRIMARY KEY,
      facebook_page_id      TEXT NOT NULL UNIQUE,
      display_name          TEXT NOT NULL,
      access_token_enc      TEXT NOT NULL,
      verify_token          TEXT NOT NULL,
      default_shopee_link   TEXT,
      status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','token_expired','disabled','error')),
      token_expires_at      BIGINT,
      last_error            TEXT,
      created_at            BIGINT NOT NULL,
      updated_at            BIGINT NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS posts (
      id            TEXT PRIMARY KEY,
      page_id       TEXT NOT NULL,
      title         TEXT NOT NULL,
      message       TEXT,
      shopee_link   TEXT,
      permalink     TEXT,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_posts_page ON posts(page_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_posts_shopee ON posts(shopee_link);`);

  await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id              TEXT PRIMARY KEY,
      page_id         TEXT NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('message','comment')),
      facebook_id     TEXT,
      thread_id       TEXT,
      customer_id     TEXT NOT NULL,
      customer_name   TEXT,
      post_id         TEXT,
      status          TEXT NOT NULL CHECK(status IN ('pending','replied','needs_review','failed','skipped_duplicate')),
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_conv_page ON conversations(page_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conv_post ON conversations(post_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);`);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id                    SERIAL PRIMARY KEY,
      conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role                  TEXT NOT NULL CHECK(role IN ('customer','ai','human')),
      text                  TEXT NOT NULL,
      metadata_json         TEXT,
      facebook_message_id   TEXT,
      created_at            BIGINT NOT NULL
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);`);

  // Settings là per-page (vì mỗi page có tone, business desc khác nhau)
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      page_id     TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  BIGINT NOT NULL,
      PRIMARY KEY (page_id, key)
    );
  `);

  console.log("[db] Schema ready.");
}
