// ENDPOINT TẠMG THỜI - dùng để migrate page từ env vào DB qua HTTP
// XÓA SAU KHI MIGRATE XONG để tránh ai gọi nhầm
// Truy cập: GET https://<v2-domain>/api/migrate-from-env?key=<DASHBOARD_PASSWORD>

import express from "express";
import * as Pages from "./pages.js";
import { config } from "./config.js";
import crypto from "node:crypto";

export const migrateRouter = express.Router();

migrateRouter.get("/migrate-from-env", async (req, res) => {
  // Auth: dùng DASHBOARD_PASSWORD qua query param
  const provided = String(req.query.key || "");
  const expected = config.auth.password;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid key" });
  }

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
      next_steps: [
        "1. Lấy verify_token từ Postgres tab Data",
        "2. Update webhook URL + verify token trên Facebook Developer",
        "3. Test webhook hoạt động",
        "4. XÓA endpoint /api/migrate-from-env khỏi code (xóa file migrate.js + import trong server.js)",
        "5. Xóa env: FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FB_VERIFY_TOKEN",
      ],
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

// Endpoint phụ để xem verify_token (cần để config webhook FB)
migrateRouter.get("/get-verify-token", async (req, res) => {
  const provided = String(req.query.key || "");
  const expected = config.auth.password;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid key" });
  }

  const { query } = await import("./db.js");
  const result = await query(
    `SELECT id, facebook_page_id, display_name, verify_token FROM pages ORDER BY id`
  );

  res.json({
    pages: result.rows,
    instructions: "Copy verify_token của page muốn config → paste vào Facebook Developer → Webhooks → Edit Subscription → Verify Token",
  });
});
