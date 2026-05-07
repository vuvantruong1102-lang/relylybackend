import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.db.path), { recursive: true });
const db = new Database(config.db.path);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---- Schema ---------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,           -- Facebook post ID
  page_id       TEXT NOT NULL,
  title         TEXT NOT NULL,              -- First ~100 chars of message
  message       TEXT,                       -- Full post text
  shopee_link   TEXT,                       -- Extracted Shopee URL (nullable)
  permalink     TEXT,                       -- FB permalink
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_shopee ON posts(shopee_link);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK(type IN ('message','comment')),
  facebook_id     TEXT,                     -- mid for messages, comment_id for comments
  thread_id       TEXT,                     -- PSID for messages, post_id for comments
  customer_id     TEXT NOT NULL,
  customer_name   TEXT,
  post_id         TEXT,                     -- Linked post (FK posts.id, nullable)
  status          TEXT NOT NULL CHECK(status IN ('pending','replied','needs_review','failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conv_post ON conversations(post_id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);

CREATE TABLE IF NOT EXISTS messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id       TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK(role IN ('customer','ai','human')),
  text                  TEXT NOT NULL,
  metadata_json         TEXT,                -- JSON: confidence, buy_intent, link_sent, etc.
  facebook_message_id   TEXT,                -- FB mid after sending
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`);

// ---- Posts ----------------------------------------------------------------

export const Posts = {
  upsert({ id, pageId, title, message, shopeeLink, permalink }) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO posts (id, page_id, title, message, shopee_link, permalink, created_at, updated_at)
      VALUES (@id, @pageId, @title, @message, @shopeeLink, @permalink, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        message = excluded.message,
        shopee_link = excluded.shopee_link,
        permalink = excluded.permalink,
        updated_at = excluded.updated_at
    `).run({ id, pageId, title, message, shopeeLink, permalink, now });
    return Posts.get(id);
  },

  get(id) {
    return db.prepare("SELECT * FROM posts WHERE id = ?").get(id) || null;
  },

  list({ limit = 100 } = {}) {
    return db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(limit);
  },

  update(id, fields) {
    const now = Date.now();
    const allowed = ["title", "shopee_link"];
    const sets = [];
    const params = { id, now };
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = fields[k];
      }
    }
    if (!sets.length) return Posts.get(id);
    sets.push("updated_at = @now");
    db.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return Posts.get(id);
  },

  remove(id) {
    db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  },
};

// ---- Conversations --------------------------------------------------------

export const Conversations = {
  create({ id, type, facebookId, threadId, customerId, customerName, postId, status = "pending" }) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO conversations
        (id, type, facebook_id, thread_id, customer_id, customer_name, post_id, status, created_at, updated_at)
      VALUES
        (@id, @type, @facebookId, @threadId, @customerId, @customerName, @postId, @status, @now, @now)
    `).run({ id, type, facebookId, threadId, customerId, customerName, postId, status, now });
    return Conversations.get(id);
  },

  get(id) {
    const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    if (!conv) return null;
    conv.messages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC").all(id);
    return conv;
  },

  // Find an existing open conversation for a given customer (used to thread DMs)
  findOpenByCustomerAndType({ customerId, type, withinMs = 1000 * 60 * 60 * 24 }) {
    const cutoff = Date.now() - withinMs;
    return db.prepare(`
      SELECT * FROM conversations
      WHERE customer_id = ? AND type = ? AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(customerId, type, cutoff);
  },

  setStatus(id, status) {
    db.prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  },

  setPost(id, postId) {
    db.prepare("UPDATE conversations SET post_id = ?, updated_at = ? WHERE id = ?").run(postId, Date.now(), id);
  },

  list({ status, type, limit = 50 } = {}) {
    let sql = "SELECT * FROM conversations WHERE 1=1";
    const params = [];
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (type)   { sql += " AND type = ?";   params.push(type); }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    // Attach last message preview
    const stmt = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1");
    return rows.map(r => ({ ...r, last_message: stmt.get(r.id) || null }));
  },
};

// ---- Messages -------------------------------------------------------------

export const Messages = {
  add({ conversationId, role, text, metadata, facebookMessageId }) {
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO messages (conversation_id, role, text, metadata_json, facebook_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversationId, role, text, metadata ? JSON.stringify(metadata) : null, facebookMessageId || null, now);
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
    return { id: result.lastInsertRowid, conversationId, role, text, metadata, createdAt: now };
  },

  byConversation(conversationId) {
    return db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC").all(conversationId);
  },
};

// ---- Settings (key-value) -------------------------------------------------

export const Settings = {
  get(key) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  },

  set(key, value) {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    const now = Date.now();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, v, now);
  },

  all() {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  },
};

// ---- Bootstrap default settings -------------------------------------------

if (!Settings.get("page_name")) {
  Settings.set("page_name", "Tiệm của bạn");
  Settings.set("business_desc", "Mô tả ngắn về cửa hàng, sản phẩm, chính sách ship/đổi trả.");
  Settings.set("tone", "friendly");
  Settings.set("custom_instructions", "");
}

export default db;
