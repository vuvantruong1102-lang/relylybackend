import * as FB from "./facebook.js";
import { Posts } from "./store.js";
import { firstShopeeLink } from "./linkExtractor.js";
import { broadcast } from "./sse.js";

/**
 * Sync toàn bộ posts của 1 Page từ Facebook về DB.
 * - Gọi Graph API /{page-id}/posts có pagination.
 * - Mỗi post: extract Shopee link, upsert vào DB.
 *
 * @param {string} pageId - Facebook Page ID
 * @param {object} options
 * @param {number} options.maxPosts - Giới hạn safety (mặc định 500)
 * @returns {Promise<{total, withShopeeLink, withoutShopeeLink, durationMs}>}
 */
export async function syncPagePosts(pageId, { maxPosts = 500 } = {}) {
  console.log(`[postSync] Starting sync for page ${pageId}...`);
  const startTime = Date.now();

  // Broadcast bắt đầu (frontend hiển thị spinner)
  broadcast({ type: "posts_sync_started", pageId });

  let fbPosts;
  try {
    fbPosts = await FB.getAllPagePosts(pageId, { maxPosts });
  } catch (err) {
    console.error(`[postSync] Failed to fetch posts for page ${pageId}:`, err.message);
    broadcast({ type: "posts_sync_failed", pageId, error: err.message });
    throw new Error(`Không lấy được posts từ Facebook: ${err.message}`);
  }

  // Upsert từng post vào DB
  let withShopeeLink = 0;
  let withoutShopeeLink = 0;
  const errors = [];

  for (const fbPost of fbPosts) {
    try {
      const shopeeLink = firstShopeeLink(fbPost.message || "");
      const fbCreatedTime = fbPost.created_time ? new Date(fbPost.created_time).getTime() : null;

      await Posts.upsert({
        id: fbPost.id,
        pageId,
        title: (fbPost.message || "").slice(0, 100) || "Bài viết Facebook",
        message: fbPost.message || "",
        shopeeLink,
        permalink: fbPost.permalink_url,
        fbCreatedTime,
        commentsCount: fbPost.comments_count || 0,
        reactionsCount: fbPost.reactions_count || 0,
      });

      if (shopeeLink) withShopeeLink++;
      else withoutShopeeLink++;
    } catch (err) {
      console.error(`[postSync] Failed to upsert post ${fbPost.id}:`, err.message);
      errors.push({ postId: fbPost.id, error: err.message });
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `[postSync] Done for page ${pageId}: ${fbPosts.length} posts (${withShopeeLink} with Shopee link) in ${duration}ms`
  );

  const stats = {
    total: fbPosts.length,
    withShopeeLink,
    withoutShopeeLink,
    durationMs: duration,
  };

  // Broadcast SSE để frontend refresh
  broadcast({ type: "posts_synced", pageId, stats });

  return {
    ...stats,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Sync posts in background (không block request).
 * Dùng khi vừa thêm Page mới.
 */
export function syncPagePostsBackground(pageId, options = {}) {
  // setTimeout để chạy sau khi response trả về client
  setTimeout(() => {
    syncPagePosts(pageId, options).catch((err) => {
      console.error(`[postSync] Background sync failed for page ${pageId}:`, err.message);
    });
  }, 100);
}
