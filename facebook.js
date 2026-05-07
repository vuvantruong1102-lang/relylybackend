import crypto from "node:crypto";
import { config, graphApiUrl } from "./config.js";

// ---- Signature verification ---------------------------------------------
// Facebook signs every webhook delivery with HMAC-SHA256(app_secret, body).
// We MUST verify this on every POST to /webhook to prevent forged events.

export function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;
  const [algo, sig] = signatureHeader.split("=");
  if (algo !== "sha256" || !sig) return false;
  const expected = crypto
    .createHmac("sha256", config.facebook.appSecret)
    .update(rawBody)
    .digest("hex");
  // Constant-time compare
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ---- HTTP helper --------------------------------------------------------

async function fbFetch(path, { method = "GET", body, query } = {}) {
  const url = new URL(graphApiUrl(path));
  url.searchParams.set("access_token", config.facebook.pageAccessToken);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fbErr = json?.error;
    const msg = fbErr ? `[${fbErr.code}] ${fbErr.message}` : `HTTP ${res.status}`;
    const err = new Error(`Facebook API error: ${msg}`);
    err.facebook = fbErr;
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---- Send DM ------------------------------------------------------------

export async function sendMessage(recipientPsid, text) {
  return fbFetch(`/${config.facebook.pageId}/messages`, {
    method: "POST",
    body: {
      recipient: { id: recipientPsid },
      messaging_type: "RESPONSE",
      message: { text },
    },
  });
}

// ---- Reply to a comment -------------------------------------------------
// POST /{comment-id}/comments → creates a child comment.

export async function replyToComment(commentId, text) {
  return fbFetch(`/${commentId}/comments`, {
    method: "POST",
    body: { message: text },
  });
}

// ---- Send a Private Reply to a comment ---------------------------------
// Useful when you want to DM the customer directly from a comment.
// Only works within 7 days of the original comment. We use this as an
// optional companion when the link is sensitive (e.g. exclusive promo).

export async function privateReplyToComment(commentId, text) {
  return fbFetch(`/${config.facebook.pageId}/messages`, {
    method: "POST",
    body: {
      recipient: { comment_id: commentId },
      message: { text },
    },
  });
}

// ---- Fetch post info ----------------------------------------------------
// Used to read the post message (so we can re-extract Shopee links if the
// initial webhook payload didn't include them).

export async function getPost(postId) {
  return fbFetch(`/${postId}`, {
    query: { fields: "id,message,permalink_url,created_time" },
  });
}

// ---- Fetch user profile --------------------------------------------------
// Used to enrich conversation with customer name/avatar.

export async function getUserProfile(psid) {
  try {
    return await fbFetch(`/${psid}`, {
      query: { fields: "first_name,last_name,profile_pic" },
    });
  } catch (err) {
    // Often fails for users who haven't messaged page yet, or due to perms
    return null;
  }
}

// ---- Fetch comment context ----------------------------------------------
// Returns parent post id of a comment, used when webhook payload only has
// the comment_id and we need to look up the post → shopee link mapping.

export async function getComment(commentId) {
  return fbFetch(`/${commentId}`, {
    query: { fields: "id,message,from,parent,post_id" },
  });
}
