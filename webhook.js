import express from "express";
import { config } from "./config.js";
import { verifySignature } from "./facebook.js";
import * as engine from "./replyEngine.js";

export const webhookRouter = express.Router();

// ---- GET /webhook  -- Facebook verification handshake -------------------
// When you subscribe a webhook in the FB Developer console, Facebook hits
// this endpoint with hub.mode=subscribe and a challenge string. We must
// echo back the challenge if the verify_token matches.

webhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.facebook.verifyToken) {
    console.log("[webhook] Verified — handshake OK");
    return res.status(200).send(challenge);
  }
  console.warn("[webhook] Failed verification attempt");
  return res.sendStatus(403);
});

// ---- POST /webhook -- Event delivery ------------------------------------
// IMPORTANT: We use express.raw({type:'*/*'}) on this route in server.js so
// that we have the exact bytes Facebook signed. Don't use express.json()
// before signature verification — JSON parse + re-stringify changes bytes.

webhookRouter.post("/", (req, res) => {
  const signature = req.get("x-hub-signature-256");
  const rawBody = req.body; // Buffer

  if (!verifySignature(rawBody, signature)) {
    console.warn("[webhook] Invalid signature");
    return res.sendStatus(401);
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.warn("[webhook] Invalid JSON body");
    return res.sendStatus(400);
  }

  // Respond fast — Facebook expects 200 within 20 seconds. Process events
  // asynchronously in the background. (For production, push to a queue
  // like BullMQ + Redis instead of fire-and-forget.)
  res.sendStatus(200);

  if (body.object === "page" && Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      handleEntry(entry).catch(err => {
        console.error("[webhook] Entry handling failed:", err);
      });
    }
  }
});

// ---- Per-entry dispatcher ------------------------------------------------

async function handleEntry(entry) {
  // 1. Direct messages (Messenger)
  if (Array.isArray(entry.messaging)) {
    for (const m of entry.messaging) {
      try {
        await handleMessaging(m);
      } catch (err) {
        console.error("[webhook] messaging error:", err);
      }
    }
  }

  // 2. Page changes (comments, new posts, edits, etc.)
  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      try {
        await handleChange(change);
      } catch (err) {
        console.error("[webhook] change error:", err);
      }
    }
  }
}

// ---- Messaging events (DMs) ---------------------------------------------

async function handleMessaging(m) {
  // Skip echoes (messages our own page sent)
  if (m.message?.is_echo) return;
  // Skip delivery/read receipts
  if (m.delivery || m.read) return;

  if (m.message?.text) {
    // Detect referral: when customer clicks "Send Message" from a post,
    // FB attaches a referral object with the post URL. We try multiple
    // shapes since FB sometimes puts it in different places.
    const referralPostId = extractReferralPostId(m);

    await engine.processMessage({
      mid: m.message.mid,
      senderId: m.sender?.id,
      text: m.message.text,
      referralPostId,
    });
    return;
  }

  // Standalone referral event (no message text yet, just landed in inbox)
  if (m.referral) {
    // We could pre-create a conversation here. For simplicity, we wait for
    // the first text message before initializing.
    console.log("[webhook] Standalone referral:", m.referral);
  }
}

function extractReferralPostId(m) {
  // Three places FB might tell us the post:
  //  1. m.referral.ref (when ref is a structured value with post id)
  //  2. m.referral.source_url containing a post URL (parse out the id)
  //  3. m.message.referral (embedded inside the message)
  const candidates = [
    m.referral,
    m.message?.referral,
    m.postback?.referral,
  ].filter(Boolean);

  for (const r of candidates) {
    // FB "m.me/{page}?ref=..." pattern. ref can be anything we set on the
    // page link, e.g. "post_<post_id>" if we configured the m.me deep link.
    if (r.ref?.startsWith("post_")) {
      return r.ref.slice(5);
    }
    // Some integrations include source_url with the post URL
    if (r.source_url) {
      const m1 = r.source_url.match(/\/posts\/([\w-]+)/);
      if (m1) return m1[1];
      const m2 = r.source_url.match(/[?&]story_fbid=(\d+)/);
      if (m2) return m2[1];
    }
  }
  return null;
}

// ---- Page change events --------------------------------------------------

async function handleChange(change) {
  if (change.field === "feed") {
    const v = change.value;

    // New / edited post
    if (v.item === "post" && (v.verb === "add" || v.verb === "edited" || v.verb === "remove")) {
      await engine.processPostUpdate({
        post_id: v.post_id,
        message: v.message,
        verb: v.verb,
      });
      return;
    }

    // New comment
    if (v.item === "comment" && v.verb === "add") {
      // Don't reply to our own page's comments
      if (v.from?.id === config.facebook.pageId) return;

      await engine.processComment({
        comment_id: v.comment_id,
        post_id: v.post_id,
        parent_id: v.parent_id,
        message: v.message,
        from: v.from,
      });
      return;
    }
  }
}
