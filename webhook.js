import express from "express";
import { verifySignature } from "./facebook.js";
import * as Pages from "./pages.js";
import * as engine from "./replyEngine.js";
import { config } from "./config.js";

export const webhookRouter = express.Router();

// ---- GET /webhook - Facebook verification (per-page) --------------------
// Khi Facebook verify URL, nó gửi `hub.verify_token` mà ta phải so với
// verify_token đã đăng ký. Vì mỗi page có verify_token riêng, ta check
// trong DB.

webhookRouter.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode !== "subscribe" || !token) {
    return res.sendStatus(400);
  }

  // Check xem token này có khớp với page nào trong DB không
  const { query } = await import("./db.js");
  const result = await query(
    `SELECT id FROM pages WHERE verify_token = $1`,
    [token]
  );

  if (result.rows.length === 0) {
    console.warn(`[webhook] Verify token không khớp với page nào: ${token.slice(0, 8)}...`);
    return res.sendStatus(403);
  }

  console.log(`[webhook] Verified for page ID ${result.rows[0].id}`);
  return res.status(200).send(challenge);
});

// ---- POST /webhook - nhận events từ Facebook ----------------------------
// Express needs raw body cho HMAC verification, nên expose middleware này
// ở server.js trước khi parse JSON.

webhookRouter.post("/", async (req, res) => {
  // verifySignature đã chạy ở middleware trước
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // Facebook gửi batch events trong entry[]
  // Mỗi entry là 1 page
  for (const entry of body.entry || []) {
    const pageId = entry.id;

    // Verify page tồn tại trong DB
    const page = await Pages.getPageByFacebookId(pageId);
    if (!page) {
      console.warn(`[webhook] Received event cho page chưa register: ${pageId}`);
      continue;
    }

    // Process events
    try {
      await processEntry(pageId, entry);
    } catch (err) {
      console.error(`[webhook] Error processing entry for page ${pageId}:`, err);
    }
  }

  // Trả 200 ngay (Facebook timeout 20s)
  res.sendStatus(200);
});

async function processEntry(pageId, entry) {
  // Messages (DM)
  for (const event of entry.messaging || []) {
    if (event.message?.text) {
      await engine.processMessage({
        pageId,
        mid: event.message.mid,
        senderId: event.sender.id,
        text: event.message.text,
        referralPostId: event.referral?.ref || event.message?.referral?.product?.id || null,
      });
    } else if (event.referral?.ref) {
      // Send Message từ post → tạo conv stub với postId
      await engine.processMessage({
        pageId,
        mid: null,
        senderId: event.sender.id,
        text: "(Khách bấm Send Message từ bài viết)",
        referralPostId: event.referral.ref,
      });
    }
  }

  // Feed changes (posts, comments)
  for (const change of entry.changes || []) {
    if (change.field !== "feed") continue;
    const v = change.value;

    if (v.item === "comment") {
      // Skip comment do page tự tạo
      if (v.from?.id === pageId) continue;

      await engine.processComment({
        pageId,
        comment_id: v.comment_id,
        post_id: v.post_id,
        message: v.message,
        from: v.from,
      });
    } else if (v.item === "post" || v.item === "status") {
      await engine.processPostUpdate({
        pageId,
        post_id: v.post_id || v.id,
        message: v.message,
        verb: v.verb,
      });
    }
  }
}

// ---- Middleware: verify HMAC signature ----------------------------------
// Mount trước parser JSON cho raw body access
export function rawBodyMiddleware(req, res, buf) {
  req.rawBody = buf;
}

export function verifyWebhookSignature(req, res, next) {
  const sig = req.headers["x-hub-signature-256"];
  if (!verifySignature(req.rawBody, sig)) {
    console.warn("[webhook] Invalid signature");
    return res.sendStatus(403);
  }
  next();
}
