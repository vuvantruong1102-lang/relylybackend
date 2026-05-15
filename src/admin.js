import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import * as Pages from "./pages.js";
import { Posts, Conversations, Settings } from "./store.js";
import * as engine from "./replyEngine.js";
import { sseHandler } from "./sse.js";
import { invalidateTokenCache } from "./facebook.js";
import { requireAuth, loginHandler } from "./auth.js";
import { syncPagePosts } from "./postSync.js";

export const adminRouter = express.Router();
adminRouter.use(express.json());

// File upload chỉ trong memory (không lưu disk - bảo mật)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---- Auth (KHÔNG cần auth) ------------------------------------------------
adminRouter.post("/auth/login", loginHandler);

// ---- Tất cả endpoint dưới đây yêu cầu auth -------------------------------
adminRouter.use(requireAuth);

// ---- Real-time SSE -------------------------------------------------------
adminRouter.get("/events", sseHandler);

// ---- Pages CRUD ----------------------------------------------------------

adminRouter.get("/pages", async (req, res) => {
  try {
    const pages = await Pages.listPages();
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/pages", async (req, res) => {
  const { displayName, facebookPageId, accessToken, defaultShopeeLink } = req.body || {};
  try {
    const page = await Pages.createPage({
      displayName,
      facebookPageId,
      accessToken,
      defaultShopeeLink,
    });
    res.status(201).json(page);
  } catch (err) {
    console.error("[admin] Create page failed:", err.message);
    res.status(400).json({
      error: err.message,
      facebookError: err.facebookError || null,
    });
  }
});

adminRouter.patch("/pages/:id", async (req, res) => {
  try {
    const page = await Pages.updatePage(parseInt(req.params.id, 10), req.body || {});
    if (!page) return res.sendStatus(404);
    invalidateTokenCache(page.facebook_page_id);
    res.json(page);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.delete("/pages/:id", async (req, res) => {
  try {
    const deleted = await Pages.deletePage(parseInt(req.params.id, 10));
    if (!deleted) return res.sendStatus(404);
    invalidateTokenCache(deleted.facebook_page_id);
    res.json({ deleted: true, page_id: deleted.facebook_page_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Test gửi tin nhắn (debug) -------------------------------------------

adminRouter.post("/pages/:id/test-send", async (req, res) => {
  const { recipientPsid, text, mode = "message" } = req.body || {};
  if (!recipientPsid || !text) {
    return res.status(400).json({ error: "recipientPsid và text là bắt buộc" });
  }
  try {
    const page = await Pages.getPageById(parseInt(req.params.id, 10));
    if (!page) return res.sendStatus(404);

    const result = await Pages.testSendMessage({
      facebookPageId: page.facebook_page_id,
      recipientPsid,
      text,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, facebookError: err.facebookError });
  }
});

// ---- Sync Posts từ Facebook ---------------------------------------------
// Lưu ý: dùng facebookPageId (string) chứ KHÔNG dùng DB id (số),
// để khớp với cách frontend gọi /api/pages/:facebookPageId/sync-posts

adminRouter.post("/pages/:facebookPageId/sync-posts", async (req, res) => {
  const { facebookPageId } = req.params;

  // Validate page tồn tại trong DB
  const page = await Pages.getPageByFacebookId(facebookPageId);
  if (!page) {
    return res.status(404).json({ error: `Page ${facebookPageId} không tồn tại trong DB` });
  }

  try {
    const result = await syncPagePosts(facebookPageId, { maxPosts: 500 });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[admin] sync-posts failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Import Excel --------------------------------------------------------

adminRouter.post("/pages/import-excel", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Không có file upload" });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (rows.length === 0) {
      return res.status(400).json({ error: "File trống" });
    }
    if (rows.length > 50) {
      return res.status(400).json({ error: "Tối đa 50 page mỗi lần import" });
    }

    // Validate từng dòng song song
    const results = await Promise.all(
      rows.map(async (row, idx) => {
        const displayName = String(row.display_name || "").trim();
        const facebookPageId = String(row.page_id || "").trim();
        const accessToken = String(row.page_access_token || "").trim();
        const defaultShopeeLink = String(row.default_shopee_link || "").trim() || null;

        if (!displayName || !facebookPageId || !accessToken) {
          return {
            row: idx + 1,
            ok: false,
            error: "Thiếu trường bắt buộc",
            data: { displayName, facebookPageId },
          };
        }

        try {
          const page = await Pages.createPage({
            displayName,
            facebookPageId,
            accessToken,
            defaultShopeeLink,
          });
          return { row: idx + 1, ok: true, page };
        } catch (err) {
          return {
            row: idx + 1,
            ok: false,
            error: err.message,
            data: { displayName, facebookPageId },
          };
        }
      })
    );

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    res.json({
      total: results.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    console.error("[admin] Import Excel failed:", err);
    res.status(500).json({ error: "Lỗi đọc file Excel: " + err.message });
  }
});

// ---- Posts (filter theo pageId + hasShopeeLink) --------------------------

adminRouter.get("/posts", async (req, res) => {
  try {
    const { pageId, hasShopeeLink, limit } = req.query;
    const filter = { limit: limit ? parseInt(limit, 10) : 500 };
    if (pageId) filter.pageId = pageId;
    if (hasShopeeLink === "true") filter.hasShopeeLink = true;
    else if (hasShopeeLink === "false") filter.hasShopeeLink = false;

    const posts = await Posts.list(filter);
    // Trả về cả { posts, total } để PostsPanel parse được
    res.json({ posts, total: posts.length });
  } catch (err) {
    console.error("[admin] GET /posts failed:", err);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/posts", async (req, res) => {
  const { id, title, shopeeLink, message, pageId } = req.body || {};
  if (!id || !title || !pageId) {
    return res.status(400).json({ error: "id, title, pageId required" });
  }
  const post = await Posts.upsert({
    id, pageId, title,
    message: message || title,
    shopeeLink: shopeeLink || null,
    permalink: null,
  });
  res.status(201).json(post);
});

adminRouter.patch("/posts/:id", async (req, res) => {
  try {
    const updated = await Posts.update(req.params.id, req.body);
    if (!updated) return res.sendStatus(404);
    // Trả về { post } để PostsPanel parse được
    res.json({ post: updated });
  } catch (err) {
    console.error("[admin] PATCH /posts failed:", err);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.delete("/posts/:id", async (req, res) => {
  try {
    await Posts.remove(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Conversations (filter theo pageId) ----------------------------------

adminRouter.get("/conversations", async (req, res) => {
  const { pageId, status, type, limit } = req.query;
  res.json(await Conversations.list({
    pageId,
    status,
    type,
    limit: limit ? parseInt(limit, 10) : undefined,
  }));
});

adminRouter.get("/conversations/:id", async (req, res) => {
  const conv = await Conversations.get(req.params.id);
  if (!conv) return res.sendStatus(404);
  res.json(conv);
});

adminRouter.post("/conversations/:id/approve", async (req, res) => {
  try {
    const conv = await Conversations.get(req.params.id);
    if (!conv) return res.sendStatus(404);
    const lastAi = [...conv.messages].reverse().find(m => m.role === "ai");
    if (!lastAi) return res.status(400).json({ error: "no ai draft to approve" });
    const result = await engine.sendManualReply({ conversationId: conv.id, text: lastAi.text });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/conversations/:id/reply", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const result = await engine.sendManualReply({ conversationId: req.params.id, text });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/conversations/:id/regenerate", async (req, res) => {
  try {
    const result = await engine.regenerateReply(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Settings (per-page) -------------------------------------------------

adminRouter.get("/settings/:pageId", async (req, res) => {
  res.json(await Settings.allForPage(req.params.pageId));
});

adminRouter.patch("/settings/:pageId", async (req, res) => {
  const allowed = ["page_name", "business_desc", "tone", "custom_instructions",
    "auto_reply_enabled", "auto_send_shopee_link", "default_shopee_link"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      await Settings.set(req.params.pageId, key, req.body[key]);
    }
  }
  res.json(await Settings.allForPage(req.params.pageId));
});

// ---- Health (KHÔNG cần auth, để Railway healthcheck) ---------------------
// (đã được mount ở server.js trước requireAuth)
