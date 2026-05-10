import crypto from "node:crypto";
import { config, graphApiUrl } from "./config.js";
import { getPageAccessToken } from "./pages.js";

// ---- Signature verification ---------------------------------------------
// App Secret là chung cho cả app, nên không cần per-page

export function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;
  const [algo, sig] = signatureHeader.split("=");
  if (algo !== "sha256" || !sig) return false;
  const expected = crypto
    .createHmac("sha256", config.facebook.appSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ---- HTTP helper - nhận token qua param ---------------------------------

async function fbFetch(path, { method = "GET", body, query, accessToken } = {}) {
  if (!accessToken) {
    throw new Error("fbFetch requires accessToken parameter");
  }

  const url = new URL(graphApiUrl(path));
  url.searchParams.set("access_token", accessToken);
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

// ---- Helper: lookup token cho page (cache trong process) ----------------

const tokenCache = new Map(); // pageId -> { token, expiresAt: cache_expiry }
const CACHE_TTL = 5 * 60 * 1000; // 5 phút

async function getTokenCached(pageId) {
  const cached = tokenCache.get(pageId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const token = await getPageAccessToken(pageId);
  if (token) {
    tokenCache.set(pageId, { token, expiresAt: Date.now() + CACHE_TTL });
  }
  return token;
}

export function invalidateTokenCache(pageId) {
  if (pageId) {
    tokenCache.delete(pageId);
  } else {
    tokenCache.clear();
  }
}

// ---- API methods -- tất cả đều nhận pageId làm param đầu ----------------

export async function sendMessage(pageId, recipientPsid, text) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  return fbFetch(`/${pageId}/messages`, {
    method: "POST",
    accessToken,
    body: {
      recipient: { id: recipientPsid },
      messaging_type: "RESPONSE",
      message: { text },
    },
  });
}

export async function replyToComment(pageId, commentId, text) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  return fbFetch(`/${commentId}/comments`, {
    method: "POST",
    accessToken,
    body: { message: text },
  });
}

export async function sendPrivateReply(pageId, commentId, text) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  return fbFetch(`/${pageId}/messages`, {
    method: "POST",
    accessToken,
    body: {
      recipient: { comment_id: commentId },
      message: { text },
    },
  });
}

export async function getPost(pageId, postId) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  return fbFetch(`/${postId}`, {
    accessToken,
    query: { fields: "id,message,permalink_url,created_time" },
  });
}

export async function getUserProfile(pageId, psid) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) return null;

  try {
    return await fbFetch(`/${psid}`, {
      accessToken,
      query: { fields: "first_name,last_name,profile_pic" },
    });
  } catch (err) {
    return null;
  }
}

export async function getComment(pageId, commentId) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  return fbFetch(`/${commentId}`, {
    accessToken,
    query: { fields: "id,message,from,parent,post_id" },
  });
}
