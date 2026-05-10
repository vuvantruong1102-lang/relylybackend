// ENDPOINT TẠM THỜI - dùng để migrate page và debug verify_token
// XÓA SAU KHI MIGRATE XONG

import express from "express";
import * as Pages from "./pages.js";
import { config } from "./config.js";
import crypto from "node:crypto";

export const migrateRouter = express.Router();

function checkAuth(req, res) {
  const provided = String(req.query.key || "");
  const expected = config.auth.password;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Invalid key" });
    return false;
  }
  return true;
}

// ---- Migrate page từ env vào DB -----------------------------------------

migrateRouter.get("/migrate-from-env", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const facebookPageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const displayName = process.env.LEGACY_PAGE_NAME || "Yokool B2B";
  const defaultShopeeLink = process.env.DEFAULT_SHOPEE_LINK || null;

  if (!facebookPageId || !accessToken) {
    return res.status(400).json({
      error: "Missing FB_PAGE_ID hoặc FB_PAGE_ACCESS_TOKEN trong env vars",
    });
  }

  try {
    const existing = await Pages.getPageByFacebookId(facebookPageId);
    if (existing) {
      return res.json({
        status: "skipped",
        message: "Page đã tồn tại trong DB",
        page: {
          id: existing.id,
          facebook_page_id: existing.facebook_page_id,
          display_name: existing.display_name,
        },
      });
    }

    const page = await Pages.createPage({
      displayName,
      facebookPageId,
      accessToken,
      defaultShopeeLink,
    });

    return res.json({
      status: "success",
      message: "Page đã được import vào DB và subscribe webhook",
      page: {
        id: page.id,
        facebook_page_id: page.facebook_page_id,
        display_name: page.display_name,
        status: page.status,
        days_until_expiry: page.days_until_expiry,
      },
    });
  } catch (err) {
    console.error("[migrate] Failed:", err);
    return res.status(500).json({
      status: "error",
      error: err.message,
      facebookError: err.facebookError || null,
    });
  }
});

// ---- Lấy verify_token --------------------------------------------------

migrateRouter.get("/get-verify-token", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { query } = await import("./db.js");
  const result = await query(
    `SELECT id, facebook_page_id, display_name, verify_token, length(verify_token) as token_length
     FROM pages ORDER BY id`
  );

  res.json({
    pages: result.rows,
    instructions: "Copy verify_token chính xác (không có khoảng trắng) → paste vào Facebook Webhooks Verify Token",
  });
});

// ---- Reset verify_token thành chuỗi cố định để dễ debug ---------------
// Dùng: GET /api/set-verify-token?key=<PASS>&pageId=<FB_PAGE_ID>&token=<CHUOI_MOI>

migrateRouter.get("/set-verify-token", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { pageId, token } = req.query;

  if (!pageId || !token) {
    return res.status(400).json({
      error: "Can truyen pageId (Facebook Page ID) va token (chuoi moi)",
      example: "/api/set-verify-token?key=<PASS>&pageId=27544...&token=mytoken123",
    });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    return res.status(400).json({
      error: "Token chi duoc chua chu, so, dau _ va -",
    });
  }

  if (token.length < 10 || token.length > 100) {
    return res.status(400).json({
      error: "Token phai dai 10-100 ky tu",
    });
  }

  const { query } = await import("./db.js");
  const result = await query(
    `UPDATE pages SET verify_token = $1, updated_at = $2 WHERE facebook_page_id = $3 RETURNING id, facebook_page_id, display_name, verify_token`,
    [token, Date.now(), pageId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Page not found" });
  }

  res.json({
    status: "success",
    message: "Verify token da duoc update. Gio dung token nay khi config webhook tren Facebook.",
    page: result.rows[0],
  });
});

// ---- Test webhook verify truc tiep (khong can Facebook) ---------------
// Dung: GET /api/test-webhook-verify?key=<PASS>&token=<TOKEN_TEST>

migrateRouter.get("/test-webhook-verify", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: "Can truyen token" });
  }

  const { query } = await import("./db.js");
  const result = await query(
    `SELECT id, facebook_page_id, display_name FROM pages WHERE verify_token = $1`,
    [String(token)]
  );

  if (result.rows.length === 0) {
    const all = await query(`SELECT facebook_page_id, verify_token, length(verify_token) as len FROM pages`);
    return res.json({
      match: false,
      message: "Token khong khop voi page nao",
      debug: {
        tokenSent: token,
        tokenSentLength: token.length,
        pagesInDb: all.rows.map(r => ({
          page_id: r.facebook_page_id,
          token_starts_with: r.verify_token.slice(0, 8) + "...",
          token_length: r.len,
        })),
      },
    });
  }

  res.json({
    match: true,
    page: result.rows[0],
    message: "Token khop! Co the dung de verify webhook tren Facebook.",
  });
});
