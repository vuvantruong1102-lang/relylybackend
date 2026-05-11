import express from "express";
import { verifySignature } from "./facebook.js";
import * as Pages from "./pages.js";
import * as engine from "./replyEngine.js";
import { config } from "./config.js";

export const webhookRouter = express.Router();

// ---- GET /webhook - Facebook verification (per-page) --------------------
// Khong can verify HMAC signature cho GET (Facebook khong gui signature)

webhookRouter.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`[webhook] GET verify request: mode=${mode}, token=${token ? token.slice(0, 8) + "..." : "(empty)"}`);

  if (mode !== "subscribe" || !token) {
    console.warn("[webhook] Invalid verify request - missing mode or token");
    return res.sendStatus(400);
  }

  const { query } = await import("./db.js");
  const result = await query(
    `SELECT id, facebook_page_id FROM pages WHERE verify_token = $1`,
    [token]
  );

  if (result.rows.length === 0) {
    console.warn(`[webhook] Verify token khong khop voi page nao: ${token.slice(0, 8)}...`);
    return res.sendStatus(403);
  }

  console.log(`[webhook] Verified successfully for page ID ${result.rows[0].id} (FB ${result.rows[0].facebook_page_id})`);
  return res.status(200).send(challenge);
});

// ---- POST /webhook - nhan events tu Facebook ----------------------------
// CO verify HMAC signature

webhookRouter.post("/", verifyWebhookSignature, async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  for (const entry of body.entry || []) {
    const pageId = entry.id;

    const page = await Pages.getPageByFacebookId(pageId);
    if (!page) {
      console.warn(`[webhook] Received event cho page chua register: ${pageId}`);
      continue;
    }

    try {
      await processEntry(pageId, entry);
    } catch (err) {
      console.error(`[webhook] Error processing entry for page ${pageId}:`, err);
    }
  }

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
      await engine.processMessage({
        pageId,
        mid: null,
        senderId: event.sender.id,
        text: "(Khach bam Send Message tu bai viet)",
        referralPostId: event.referral.ref,
      });
    }
  }

  // Feed changes
  for (const change of entry.changes || []) {
    if (change.field !== "feed") continue;
    const v = change.value;

    if (v.item === "comment") {
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

export function rawBodyMiddleware(req, res, buf) {
  req.rawBody = buf;
}

export function verifyWebhookSignature(req, res, next) {
  const sig = req.headers["x-hub-signature-256"];
  if (!verifySignature(req.rawBody, sig)) {
    console.warn("[webhook] Invalid signature on POST");
    return res.sendStatus(403);
  }
  next();
}
