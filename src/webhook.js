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
  // ✨ LOG MỚI: luôn log khi nhận được POST sau verify ✨
  console.log(`[webhook] ✅ POST received - signature verified`);
  console.log(`[webhook] Body object: ${req.body?.object}, entries: ${(req.body?.entry || []).length}`);

  const body = req.body;
  if (body.object !== "page") {
    console.warn(`[webhook] Unknown object type: ${body.object}`);
    return res.sendStatus(404);
  }

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    console.log(`[webhook] Processing entry for page ${pageId}`);

    const page = await Pages.getPageByFacebookId(pageId);
    if (!page) {
      console.warn(`[webhook] ⚠️ Received event cho page chua register trong DB: ${pageId}`);
      continue;
    }
    console.log(`[webhook] ✅ Page ${pageId} found in DB (display: ${page.display_name})`);

    try {
      await processEntry(pageId, entry);
      console.log(`[webhook] ✅ Done processing entry for page ${pageId}`);
    } catch (err) {
      console.error(`[webhook] ❌ Error processing entry for page ${pageId}:`, err);
    }
  }

  res.sendStatus(200);
});

async function processEntry(pageId, entry) {
  // Messages (DM)
  for (const event of entry.messaging || []) {
    console.log(`[webhook] Found messaging event from ${event.sender?.id}`);
    if (event.message?.text) {
      console.log(`[webhook] Processing DM: "${event.message.text.slice(0, 50)}"`);
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
    console.log(`[webhook] Found change: field=${change.field}, item=${change.value?.item}, verb=${change.value?.verb}`);

    if (change.field !== "feed") {
      console.log(`[webhook] Skipping non-feed change: ${change.field}`);
      continue;
    }
    const v = change.value;

    if (v.item === "comment") {
      console.log(`[webhook] Comment event - from=${v.from?.id}, pageId=${pageId}, message="${(v.message || "").slice(0, 50)}"`);
      if (v.from?.id === pageId) {
        console.log(`[webhook] ⚠️ Skipping comment from page itself`);
        continue;
      }
      await engine.processComment({
        pageId,
        comment_id: v.comment_id,
        post_id: v.post_id,
        message: v.message,
        from: v.from,
      });
      console.log(`[webhook] ✅ processComment done`);
    } else if (v.item === "post" || v.item === "status") {
      console.log(`[webhook] Post update event - verb=${v.verb}, post_id=${v.post_id || v.id}`);
      await engine.processPostUpdate({
        pageId,
        post_id: v.post_id || v.id,
        message: v.message,
        verb: v.verb,
      });
    } else {
      console.log(`[webhook] Skipping item type: ${v.item}`);
    }
  }
}

// ---- Middleware: verify HMAC signature ----------------------------------

export function rawBodyMiddleware(req, res, buf) {
  req.rawBody = buf;
}

export function verifyWebhookSignature(req, res, next) {
  // ✨ LOG MỚI: log mọi POST request đến /webhook ✨
  console.log(`[webhook] 📨 POST /webhook received - headers: x-hub-signature-256=${req.headers["x-hub-signature-256"] ? "present" : "MISSING"}`);
  console.log(`[webhook] Body size: ${req.rawBody?.length || 0} bytes`);

  const sig = req.headers["x-hub-signature-256"];
  if (!sig) {
    console.warn("[webhook] ❌ Missing x-hub-signature-256 header");
    return res.sendStatus(403);
  }

  const isValid = verifySignature(req.rawBody, sig);
  if (!isValid) {
    console.warn(`[webhook] ❌ Invalid signature on POST`);
    console.warn(`[webhook] Received sig: ${sig.slice(0, 20)}...`);
    console.warn(`[webhook] Body preview: ${(req.rawBody?.toString() || "").slice(0, 200)}`);
    return res.sendStatus(403);
  }

  console.log(`[webhook] ✅ Signature verified OK`);
  next();
}
