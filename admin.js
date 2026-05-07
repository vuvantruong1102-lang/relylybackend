import express from "express";
import { Posts, Conversations, Settings } from "./db.js";
import * as engine from "./replyEngine.js";
import { sseHandler } from "./sse.js";

export const adminRouter = express.Router();
adminRouter.use(express.json());

// ---- Real-time SSE stream ------------------------------------------------
// Frontend connects here and receives push events whenever something changes.
// GET /api/events — keeps connection open indefinitely
adminRouter.get("/events", sseHandler);

// ---- Posts ---------------------------------------------------------------

adminRouter.get("/posts", (req, res) => {
  res.json(Posts.list());
});

adminRouter.post("/posts", (req, res) => {
  const { id, title, shopeeLink, message } = req.body || {};
  if (!id || !title) return res.status(400).json({ error: "id and title required" });
  const post = Posts.upsert({
    id,
    pageId: req.body.pageId || "manual",
    title,
    message: message || title,
    shopeeLink: shopeeLink || null,
    permalink: null,
  });
  res.status(201).json(post);
});

adminRouter.patch("/posts/:id", (req, res) => {
  const { title, shopeeLink } = req.body || {};
  const updated = Posts.update(req.params.id, {
    title,
    shopee_link: shopeeLink,
  });
  if (!updated) return res.sendStatus(404);
  res.json(updated);
});

adminRouter.delete("/posts/:id", (req, res) => {
  Posts.remove(req.params.id);
  res.sendStatus(204);
});

// ---- Conversations -------------------------------------------------------

adminRouter.get("/conversations", (req, res) => {
  const { status, type, limit } = req.query;
  res.json(Conversations.list({
    status,
    type,
    limit: limit ? parseInt(limit, 10) : undefined,
  }));
});

adminRouter.get("/conversations/:id", (req, res) => {
  const conv = Conversations.get(req.params.id);
  if (!conv) return res.sendStatus(404);
  res.json(conv);
});

// Approve & send (use the pending AI draft as-is)
adminRouter.post("/conversations/:id/approve", async (req, res) => {
  try {
    const conv = Conversations.get(req.params.id);
    if (!conv) return res.sendStatus(404);
    const lastAi = [...conv.messages].reverse().find(m => m.role === "ai");
    if (!lastAi) return res.status(400).json({ error: "no ai draft to approve" });
    const result = await engine.sendManualReply({ conversationId: conv.id, text: lastAi.text });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Send a custom (edited) reply
adminRouter.post("/conversations/:id/reply", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const result = await engine.sendManualReply({ conversationId: req.params.id, text });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Force regenerate the AI draft
adminRouter.post("/conversations/:id/regenerate", async (req, res) => {
  try {
    const result = await engine.regenerateReply(req.params.id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Settings ------------------------------------------------------------

adminRouter.get("/settings", (req, res) => {
  res.json(Settings.all());
});

adminRouter.patch("/settings", (req, res) => {
  const allowed = [
    "page_name", "business_desc", "tone", "custom_instructions",
    "auto_reply_enabled", "auto_send_shopee_link", "default_shopee_link",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) Settings.set(key, req.body[key]);
  }
  res.json(Settings.all());
});

// ---- Health --------------------------------------------------------------

adminRouter.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});
