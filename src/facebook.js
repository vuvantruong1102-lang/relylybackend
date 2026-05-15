import crypto from "node:crypto";
import { config, graphApiUrl } from "./config.js";
import { getPageAccessToken } from "./pages.js";

// ---- Signature verification ---------------------------------------------

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

// ---- HTTP helper -------------------------------------------------------

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

// ---- Token cache --------------------------------------------------------

const tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

// ---- API methods --------------------------------------------------------

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

/**
 * ✨ FIX 1: getUserProfile - LOG ERROR rõ ràng để debug
 *
 * Trước: try/catch silent → không biết tại sao fail
 * Sau: log error rõ ràng + thử fallback với fields tối thiểu (chỉ "name")
 *
 * Facebook policy (sau 2023): user phải có "ENGAGEMENT" với Page
 * (đã từng nhắn tin / comment) trong 30 ngày qua thì mới get được profile.
 */
export async function getUserProfile(pageId, psid) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) {
    console.warn(`[fb] getUserProfile: no access token for page ${pageId}`);
    return null;
  }

  // Thử với fields đầy đủ trước
  try {
    const profile = await fbFetch(`/${psid}`, {
      accessToken,
      query: { fields: "first_name,last_name,profile_pic" },
    });
    return profile;
  } catch (err) {
    console.warn(
      `[fb] getUserProfile failed for psid=${psid} page=${pageId}: ${err.message}`
    );

    // ✨ Fallback: thử lấy chỉ field "name" (đôi khi work khi full fields fail)
    try {
      const profile = await fbFetch(`/${psid}`, {
        accessToken,
        query: { fields: "name" },
      });
      if (profile?.name) {
        // Split name thành first_name + last_name để compatible với code cũ
        const parts = profile.name.trim().split(/\s+/);
        return {
          name: profile.name,
          first_name: parts[0] || "",
          last_name: parts.slice(1).join(" ") || "",
        };
      }
    } catch (err2) {
      console.warn(
        `[fb] getUserProfile fallback also failed for psid=${psid}: ${err2.message}`
      );
    }

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
 * ✨ FIX 2: getAllPagePosts - INCLUDE comments/reactions count
 *
 * Trước: bỏ comments.summary + reactions.summary → count luôn = 0
 * Sau: include summary fields, có retry logic giảm pageSize nếu data overflow
 *
 * Strategy:
 * 1. Thử pageSize=25 với fields đầy đủ (kèm summary counts)
 * 2. Nếu lỗi data overflow → giảm pageSize = 10, vẫn giữ summary
 * 3. Nếu vẫn lỗi → giảm pageSize = 5, vẫn giữ summary
 * 4. Cuối cùng: bỏ summary để không bị block hoàn toàn
 */
export async function getAllPagePosts(pageId, { maxPosts = 500, pageSize = 25, onProgress } = {}) {
  const accessToken = await getTokenCached(pageId);
  if (!accessToken) throw new Error(`No access token for page ${pageId}`);

  // ✨ Include summary cho comments và reactions để lấy count
  const fieldsWithCounts = "id,message,permalink_url,created_time,comments.summary(true).limit(0),reactions.summary(true).limit(0)";
  const fieldsMinimal = "id,message,permalink_url,created_time";

  return await fetchPostsWithRetry({
    pageId,
    accessToken,
    fields: fieldsWithCounts,
    fieldsMinimal,
    pageSize,
    maxPosts,
    onProgress,
  });
}

/**
 * Fetch posts với retry logic.
 * Retry order: pageSize=25 → 10 → 5 → minimal fields (bỏ counts)
 */
async function fetchPostsWithRetry({
  pageId,
  accessToken,
  fields,
  fieldsMinimal,
  pageSize,
  maxPosts,
  onProgress,
  attempt = 1,
}) {
  const allPosts = [];

  const firstUrl = new URL(graphApiUrl(`/${pageId}/posts`));
  firstUrl.searchParams.set("access_token", accessToken);
  firstUrl.searchParams.set("fields", fields);
  firstUrl.searchParams.set("limit", String(pageSize));

  let nextUrl = firstUrl.toString();
  let pageCount = 0;
  const maxPagesIterations = 30;

  try {
    while (nextUrl && allPosts.length < maxPosts && pageCount < maxPagesIterations) {
      const response = await fbFetchUrl(nextUrl);
      pageCount++;

      if (!response.data || !Array.isArray(response.data)) break;

      for (const post of response.data) {
        if (allPosts.length >= maxPosts) break;

        // ✨ Parse comments.summary và reactions.summary đúng cách
        const commentsCount = post.comments?.summary?.total_count ?? 0;
        const reactionsCount = post.reactions?.summary?.total_count ?? 0;

        allPosts.push({
          id: post.id,
          message: post.message || "",
          permalink_url: post.permalink_url || null,
          created_time: post.created_time || null,
          comments_count: commentsCount,
          reactions_count: reactionsCount,
        });
      }

      if (typeof onProgress === "function") {
        try { onProgress(allPosts.length); } catch {}
      }

      nextUrl = response.paging?.next || null;
    }

    console.log(
      `[fb] Fetched ${allPosts.length} posts for page ${pageId} (${pageCount} API calls, pageSize=${pageSize}, withCounts=${fields.includes('summary')})`
    );
    return allPosts;
  } catch (err) {
    const isDataOverflowError = err.facebook?.code === 1
      || (err.message || "").includes("reduce the amount of data");

    if (isDataOverflowError && attempt < 4) {
      // Strategy retry:
      // Attempt 1 → 2: giảm pageSize từ 25 → 10
      // Attempt 2 → 3: giảm pageSize từ 10 → 5
      // Attempt 3 → 4: bỏ summary, dùng fields minimal
      let newFields = fields;
      let newPageSize = pageSize;

      if (attempt === 1) {
        newPageSize = 10;
      } else if (attempt === 2) {
        newPageSize = 5;
      } else if (attempt === 3) {
        newFields = fieldsMinimal;
        newPageSize = 25;
        console.warn(
          `[fb] Page ${pageId}: Still data overflow with pageSize=5 + summary. Falling back to minimal fields (counts will be 0).`
        );
      }

      console.warn(
        `[fb] Data overflow for page ${pageId}. Retry attempt ${attempt + 1}/4: pageSize=${newPageSize}, withCounts=${newFields.includes('summary')}`
      );

      return await fetchPostsWithRetry({
        pageId,
        accessToken,
        fields: newFields,
        fieldsMinimal,
        pageSize: newPageSize,
        maxPosts,
        onProgress,
        attempt: attempt + 1,
      });
    }

    if (allPosts.length > 0) {
      console.warn(`[fb] Error after fetching ${allPosts.length} posts for page ${pageId}, returning partial data: ${err.message}`);
      return allPosts;
    }

    throw err;
  }
}
