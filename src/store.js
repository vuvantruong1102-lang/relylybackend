import { query } from "./db.js";

// ---- Posts ----------------------------------------------------------------

export const Posts = {
  async upsert({ id, pageId, title, message, shopeeLink, permalink, fbCreatedTime, commentsCount, reactionsCount }) {
    const now = Date.now();
    await query(
      `INSERT INTO posts (id, page_id, title, message, shopee_link, permalink, fb_created_time, comments_count, reactions_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         message = EXCLUDED.message,
         shopee_link = COALESCE(EXCLUDED.shopee_link, posts.shopee_link),
         permalink = EXCLUDED.permalink,
         fb_created_time = COALESCE(EXCLUDED.fb_created_time, posts.fb_created_time),
         comments_count = EXCLUDED.comments_count,
         reactions_count = EXCLUDED.reactions_count,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        pageId,
        title,
        message,
        shopeeLink,
        permalink,
        fbCreatedTime || null,
        commentsCount ?? 0,
        reactionsCount ?? 0,
        now,
      ]
    );
    return Posts.get(id);
  },

  async get(id) {
    const r = await query(`SELECT * FROM posts WHERE id = $1`, [id]);
    return r.rows[0] || null;
  },

  async list({ pageId, hasShopeeLink, limit = 500 } = {}) {
    let sql = `SELECT * FROM posts WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (pageId) {
      sql += ` AND page_id = $${idx++}`;
      params.push(pageId);
    }
    if (hasShopeeLink === true) {
      sql += ` AND shopee_link IS NOT NULL AND shopee_link != ''`;
    } else if (hasShopeeLink === false) {
      sql += ` AND (shopee_link IS NULL OR shopee_link = '')`;
    }
    sql += ` ORDER BY COALESCE(fb_created_time, created_at) DESC LIMIT $${idx}`;
    params.push(limit);
    const r = await query(sql, params);
    return r.rows;
  },

  async count({ pageId } = {}) {
    if (pageId) {
      const r = await query(`SELECT COUNT(*) as cnt FROM posts WHERE page_id = $1`, [pageId]);
      return parseInt(r.rows[0]?.cnt || "0", 10);
    }
    const r = await query(`SELECT COUNT(*) as cnt FROM posts`);
    return parseInt(r.rows[0]?.cnt || "0", 10);
  },

  async update(id, fields) {
    const allowed = { title: "title", shopee_link: "shopee_link", shopeeLink: "shopee_link" };
    const sets = [];
    const params = [];
    let idx = 1;
    for (const [k, col] of Object.entries(allowed)) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = $${idx++}`);
        params.push(fields[k]);
      }
    }
    if (!sets.length) return Posts.get(id);
    sets.push(`updated_at = $${idx++}`);
    params.push(Date.now());
    params.push(id);
    await query(`UPDATE posts SET ${sets.join(", ")} WHERE id = $${idx}`, params);
    return Posts.get(id);
  },

  async remove(id) {
    await query(`DELETE FROM posts WHERE id = $1`, [id]);
  },

  async removeAllForPage(pageId) {
    await query(`DELETE FROM posts WHERE page_id = $1`, [pageId]);
  },
};

// ---- Conversations --------------------------------------------------------

export const Conversations = {
  async create({ id, pageId, type, facebookId, threadId, customerId, customerName, postId, status = "pending" }) {
    const now = Date.now();
    await query(
      `INSERT INTO conversations
        (id, page_id, type, facebook_id, thread_id, customer_id, customer_name, post_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [id, pageId, type, facebookId, threadId, customerId, customerName, postId, status, now]
    );
    return Conversations.get(id);
  },

  async get(id) {
    const r = await query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    if (!r.rows[0]) return null;
    const conv = r.rows[0];
    const msgs = await query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
      [id]
    );
    conv.messages = msgs.rows;
    return conv;
  },

  async findOpenByCustomerAndType({ pageId, customerId, type, withinMs = 1000 * 60 * 60 * 24 }) {
    const cutoff = Date.now() - withinMs;
    const r = await query(
      `SELECT * FROM conversations
       WHERE page_id = $1 AND customer_id = $2 AND type = $3 AND updated_at >= $4
       ORDER BY updated_at DESC LIMIT 1`,
      [pageId, customerId, type, cutoff]
    );
    return r.rows[0] || null;
  },

  async setStatus(id, status) {
    await query(
      `UPDATE conversations SET status = $1, updated_at = $2 WHERE id = $3`,
      [status, Date.now(), id]
    );
  },

  async setPost(id, postId) {
    await query(
      `UPDATE conversations SET post_id = $1, updated_at = $2 WHERE id = $3`,
      [postId, Date.now(), id]
    );
  },

  async list({ pageId, status, type, limit = 50 } = {}) {
    let sql = `SELECT * FROM conversations WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (pageId) { sql += ` AND page_id = $${idx++}`; params.push(pageId); }
    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    if (type)   { sql += ` AND type = $${idx++}`;   params.push(type); }
    sql += ` ORDER BY updated_at DESC LIMIT $${idx}`;
    params.push(limit);
    const r = await query(sql, params);

    // Attach last message preview cho mỗi conversation
    const out = [];
    for (const row of r.rows) {
      const lm = await query(
        `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
        [row.id]
      );
      out.push({ ...row, last_message: lm.rows[0] || null });
    }
    return out;
  },
};

// ---- Messages -------------------------------------------------------------

export const Messages = {
  async add({ conversationId, role, text, metadata, facebookMessageId }) {
    const now = Date.now();
    const r = await query(
      `INSERT INTO messages (conversation_id, role, text, metadata_json, facebook_message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [conversationId, role, text, metadata ? JSON.stringify(metadata) : null, facebookMessageId || null, now]
    );
    await query(
      `UPDATE conversations SET updated_at = $1 WHERE id = $2`,
      [now, conversationId]
    );
    return r.rows[0];
  },

  async byConversation(conversationId) {
    const r = await query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
      [conversationId]
    );
    return r.rows;
  },
};

// ---- Settings (per-page) --------------------------------------------------

export const Settings = {
  async get(pageId, key) {
    const r = await query(
      `SELECT value FROM settings WHERE page_id = $1 AND key = $2`,
      [pageId, key]
    );
    if (!r.rows[0]) return null;
    try { return JSON.parse(r.rows[0].value); } catch { return r.rows[0].value; }
  },

  async set(pageId, key, value) {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    const now = Date.now();
    await query(
      `INSERT INTO settings (page_id, key, value, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [pageId, key, v, now]
    );
  },

  async allForPage(pageId) {
    const r = await query(
      `SELECT key, value FROM settings WHERE page_id = $1`,
      [pageId]
    );
    const out = {};
    for (const row of r.rows) {
      try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
    }
    return out;
  },

  async ensureDefaults(pageId) {
    const existing = await Settings.allForPage(pageId);
    const defaults = {
      page_name: "Tiệm của bạn",
      business_desc: "Mô tả ngắn về cửa hàng, sản phẩm, chính sách ship/đổi trả.",
      tone: "friendly",
      custom_instructions: "",
      auto_reply_enabled: true,
      auto_send_shopee_link: true,
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (existing[k] === undefined) {
        await Settings.set(pageId, k, v);
      }
    }
  },
};
