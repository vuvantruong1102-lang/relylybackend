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

// ---- Direct fetch by URL (cho pagination next URL) ---------------------

async function fbFetchUrl(fullUrl) {
  const res = await fetch(fullUrl);
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

// ---- Fetch ALL posts của Page với pagination ----------------------------
/**
 * Lấy toàn bộ posts của Page qua pagination.
 *
 * ✨ FIX (2026-05-15):
 * - Giảm pageSize từ 100 → 25 để tránh Facebook error code 1
 *   ("Please reduce the amount of data you're asking for")
 * - BỎ comments.summary và reactions.summary để giảm payload size
 *   (Page lớn với nhiều engagement sẽ trả về data quá lớn)
 * - Tăng maxPagesIterations từ 20 → 30 để bù lại pageSize nhỏ hơn
 * - Thêm retry logic với pageSize=10 nếu vẫn lỗi
 *
 * @param {string} pageId - Facebook Page ID
 * @param {object} options
 * @param {number} options.maxPosts - Giới hạn safety (mặc định 500)
 * @param {number} options.pageSize - Số posts/request (mặc định 25)
 * @param {function} options.onProgress - Callback(count) sau mỗi batch
 * @returns {Promise<Array>}
 */
export async function getAllPagePosts(pageId, { maxPosts = 500, pageSize = 25, onProgress } = {}) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  // ✨ Fields tối giản: chỉ lấy info cần thiết
  // Bỏ comments.summary và reactions.summary để giảm payload
  const fields = "id,message,permalink_url,created_time";

  return await fetchPostsWithRetry({
    pageId,
    accessToken,
    fields,
    pageSize,
    maxPosts,
    onProgress,
  });
}

/**
 * Internal helper: fetch posts với retry logic.
 * Nếu pageSize hiện tại bị lỗi → tự động giảm pageSize và thử lại.
 */
async function fetchPostsWithRetry({ pageId, accessToken, fields, pageSize, maxPosts, onProgress, attempt = 1 }) {
  const allPosts = [];

  const firstUrl = new URL(graphApiUrl(`/${pageId}/posts`));
  firstUrl.searchParams.set("access_token", accessToken);
  firstUrl.searchParams.set("fields", fields);
  firstUrl.searchParams.set("limit", String(pageSize));

  let nextUrl = firstUrl.toString();
  let pageCount = 0;
  const maxPagesIterations = 30; // Tăng từ 20 → 30 vì pageSize nhỏ hơn

  try {
    while (nextUrl && allPosts.length < maxPosts && pageCount < maxPagesIterations) {
      const response = await fbFetchUrl(nextUrl);
      pageCount++;

      if (!response.data || !Array.isArray(response.data)) break;

      for (const post of response.data) {
        if (allPosts.length >= maxPosts) break;
        allPosts.push({
          id: post.id,
          message: post.message || "",
          permalink_url: post.permalink_url || null,
          created_time: post.created_time || null,
          comments_count: 0,   // Không lấy summary để giảm payload
          reactions_count: 0,  // Không lấy summary để giảm payload
        });
      }

      if (typeof onProgress === "function") {
        try { onProgress(allPosts.length); } catch {}
      }

      nextUrl = response.paging?.next || null;
    }

    console.log(`[fb] Fetched ${allPosts.length} posts for page ${pageId} (${pageCount} API calls, pageSize=${pageSize})`);
    return allPosts;
  } catch (err) {
    // ✨ Auto-retry với pageSize nhỏ hơn nếu gặp lỗi data overflow
    const isDataOverflowError = err.facebook?.code === 1
      || (err.message || "").includes("reduce the amount of data");

    if (isDataOverflowError && attempt < 3) {
      const newPageSize = Math.max(5, Math.floor(pageSize / 2));
      console.warn(`[fb] Data overflow error for page ${pageId}. Retrying with pageSize=${newPageSize} (attempt ${attempt + 1}/3)`);

      return await fetchPostsWithRetry({
        pageId,
        accessToken,
        fields,
        pageSize: newPageSize,
        maxPosts,
        onProgress,
        attempt: attempt + 1,
      });
    }

    // Nếu đã có 1 ít posts trước khi lỗi → return những gì đã có
    if (allPosts.length > 0) {
      console.warn(`[fb] Error after fetching ${allPosts.length} posts for page ${pageId}, returning partial data: ${err.message}`);
      return allPosts;
    }

    throw err;
  }
}
