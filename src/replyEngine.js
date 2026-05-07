import { Posts, Conversations, Messages, Settings } from "./db.js";
import { generateReply } from "./claude.js";
import * as FB from "./facebook.js";
import { detectBuyIntent, detectComplaint } from "./intent.js";
import { config } from "./config.js";
import { broadcast } from "./sse.js";

// ---- Link resolution ------------------------------------------------------
/**
 * Decide which Shopee link to use for a given conversation context.
 * Priority:
 *   1. Comment on post → use that post's shopee_link
 *   2. DM with referral to a post → use that post's shopee_link
 *   3. Fallback to global default link
 */
export function resolveLink({ postId }) {
  if (postId) {
    const post = Posts.get(postId);
    if (post?.shopee_link) {
      return { link: post.shopee_link, source: "post", post };
    }
  }
  const fallback = config.behavior.defaultShopeeLink || Settings.get("default_shopee_link");
  return { link: fallback || null, source: fallback ? "default" : null, post: null };
}

// ---- Generate ID ----------------------------------------------------------

const genId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ---- Process incoming COMMENT --------------------------------------------
/**
 * Called when a customer comments on a page post.
 * @param {object} payload Webhook value object from FB feed change
 *   {
 *     comment_id: "...",     // Required
 *     post_id: "...",        // Required (we use this to look up the link)
 *     message: "Mua ở đâu?", // Customer's text
 *     from: { id: "...", name: "..." },
 *     parent_id: "...",      // If it's a nested comment, parent comment id
 *   }
 */
export async function processComment(payload) {
  const { comment_id, post_id, message, from } = payload;

  if (!message || !from) {
    console.log("[engine] Skipping comment without message or sender");
    return null;
  }

  // Don't reply to ourselves
  if (from.id === config.facebook.pageId) {
    return null;
  }

  // Make sure we have post info; fetch if missing (Shopee link extraction
  // may have happened via the 'add' post event already, but be defensive)
  let post = Posts.get(post_id);
  if (!post) {
    try {
      const fbPost = await FB.getPost(post_id);
      const { firstShopeeLink } = await import("./linkExtractor.js");
      post = Posts.upsert({
        id: fbPost.id,
        pageId: config.facebook.pageId,
        title: (fbPost.message || "").slice(0, 100) || "Bài viết Facebook",
        message: fbPost.message || "",
        shopeeLink: firstShopeeLink(fbPost.message || ""),
        permalink: fbPost.permalink_url,
      });
    } catch (err) {
      console.error("[engine] Could not fetch post:", err.message);
    }
  }

  // Create conversation record
  const convId = genId("conv");
  const newConv = Conversations.create({
    id: convId,
    type: "comment",
    facebookId: comment_id,
    threadId: post_id,
    customerId: from.id,
    customerName: from.name || "Khách",
    postId: post_id,
    status: "pending",
  });
  broadcast({ type: "new_conversation", conversation: newConv });

  Messages.add({
    conversationId: convId,
    role: "customer",
    text: message,
    metadata: { fb_comment_id: comment_id, fb_post_id: post_id },
  });

  // If auto-reply is off, just store and stop
  if (!Settings.get("auto_reply_enabled") && !config.behavior.autoReplyEnabled) {
    return Conversations.get(convId);
  }

  // Pre-flag for ops dashboard (AI also detects, but this is faster)
  const intentSignals = {
    buyIntent: detectBuyIntent(message),
    isComplaint: detectComplaint(message),
  };

  if (intentSignals.isComplaint) {
    // Complaints with order numbers should probably go to a human
    Conversations.setStatus(convId, "needs_review");
    Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Phát hiện khiếu nại — chuyển nhân viên xử lý thay vì auto-reply.",
      metadata: { needs_human: true, reason: "Khiếu nại" },
    });
    return Conversations.get(convId);
  }

  // Generate AI reply
  const linkContext = resolveLink({ postId: post_id });
  const postContextStr = post?.title ? `bài đăng "${post.title}"` : "bài đăng";

  let aiResult;
  try {
    aiResult = await generateReply({
      customerMessage: message,
      isComment: true,
      postContext: postContextStr,
      linkContext,
    });
  } catch (err) {
    console.error("[engine] AI generation failed:", err);
    Conversations.setStatus(convId, "failed");
    return Conversations.get(convId);
  }

  // Decide: send automatically OR keep for human review
  const shouldAutoSend =
    aiResult.confidence >= config.behavior.confidenceThreshold &&
    !aiResult.needs_human;

  let fbMessageId = null;
  if (shouldAutoSend) {
    try {
      const sent = await FB.replyToComment(comment_id, aiResult.reply);
      fbMessageId = sent.id;
      Conversations.setStatus(convId, "replied");
    } catch (err) {
      console.error("[engine] Failed to send comment reply:", err.message);
      Conversations.setStatus(convId, "failed");
    }
  } else {
    Conversations.setStatus(convId, "needs_review");
  }

  Messages.add({
    conversationId: convId,
    role: "ai",
    text: aiResult.reply,
    metadata: {
      confidence: aiResult.confidence,
      needs_human: aiResult.needs_human,
      reason: aiResult.reason,
      buy_intent: aiResult.buy_intent,
      link_sent: aiResult.link_sent,
      link_used: aiResult.link_sent ? linkContext.link : null,
      link_source: aiResult.link_sent ? linkContext.source : null,
      auto_sent: shouldAutoSend,
      pre_flag: intentSignals,
    },
    facebookMessageId: fbMessageId,
  });

  return Conversations.get(convId);
}

// ---- Process incoming MESSAGE (DM) ---------------------------------------
/**
 * Called when a customer sends a direct message to the page.
 * @param {object} payload
 *   {
 *     mid: "...",          // Message ID
 *     senderId: "...",     // PSID
 *     text: "...",
 *     referralPostId: "..." (optional - if customer clicked "Send Message" from a post)
 *   }
 */
export async function processMessage(payload) {
  const { mid, senderId, text, referralPostId } = payload;

  if (!text) return null;
  if (senderId === config.facebook.pageId) return null;

  // Try to thread with an existing recent conversation (so we don't spam a
  // new convo for every message). For simplicity we look back 24h.
  let conv = Conversations.findOpenByCustomerAndType({
    customerId: senderId,
    type: "message",
  });

  let convId;
  if (conv) {
    convId = conv.id;
    // Update post link if we just learned about a referral
    if (referralPostId && !conv.post_id) {
      Conversations.setPost(convId, referralPostId);
    }
  } else {
    convId = genId("conv");
    // Try to enrich with profile name
    let customerName = "Khách";
    try {
      const profile = await FB.getUserProfile(senderId);
      if (profile?.first_name) {
        customerName = `${profile.first_name} ${profile.last_name || ""}`.trim();
      }
    } catch {}
    Conversations.create({
      id: convId,
      type: "message",
      facebookId: mid,
      threadId: senderId,
      customerId: senderId,
      customerName,
      postId: referralPostId || null,
      status: "pending",
    });
  }

  Messages.add({
    conversationId: convId,
    role: "customer",
    text,
    metadata: { fb_mid: mid, referral_post_id: referralPostId },
  });

  if (!Settings.get("auto_reply_enabled") && !config.behavior.autoReplyEnabled) {
    return Conversations.get(convId);
  }

  // Pre-flag complaints
  const isComplaint = detectComplaint(text);
  if (isComplaint) {
    Conversations.setStatus(convId, "needs_review");
    Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Phát hiện khiếu nại — chuyển nhân viên xử lý.",
      metadata: { needs_human: true, reason: "Khiếu nại" },
    });
    return Conversations.get(convId);
  }

  // Resolve link based on post reference (if any)
  const conversation = Conversations.get(convId);
  const linkContext = resolveLink({ postId: conversation.post_id });

  let postContextStr;
  if (conversation.post_id) {
    const p = Posts.get(conversation.post_id);
    postContextStr = p?.title ? `bài đăng "${p.title}"` : "bài đăng";
  }

  let aiResult;
  try {
    aiResult = await generateReply({
      customerMessage: text,
      isComment: false,
      postContext: postContextStr,
      linkContext,
    });
  } catch (err) {
    console.error("[engine] AI generation failed:", err);
    Conversations.setStatus(convId, "failed");
    return Conversations.get(convId);
  }

  const shouldAutoSend =
    aiResult.confidence >= config.behavior.confidenceThreshold &&
    !aiResult.needs_human;

  let fbMessageId = null;
  if (shouldAutoSend) {
    try {
      const sent = await FB.sendMessage(senderId, aiResult.reply);
      fbMessageId = sent.message_id;
      Conversations.setStatus(convId, "replied");
    } catch (err) {
      console.error("[engine] Failed to send DM:", err.message);
      Conversations.setStatus(convId, "failed");
    }
  } else {
    Conversations.setStatus(convId, "needs_review");
  }

  Messages.add({
    conversationId: convId,
    role: "ai",
    text: aiResult.reply,
    metadata: {
      confidence: aiResult.confidence,
      needs_human: aiResult.needs_human,
      reason: aiResult.reason,
      buy_intent: aiResult.buy_intent,
      link_sent: aiResult.link_sent,
      link_used: aiResult.link_sent ? linkContext.link : null,
      link_source: aiResult.link_sent ? linkContext.source : null,
      auto_sent: shouldAutoSend,
    },
    facebookMessageId: fbMessageId,
  });

  return Conversations.get(convId);
}

// ---- Process new/edited POST ---------------------------------------------
/**
 * Indexes posts and extracts Shopee links so future comments on this post
 * can use the right link automatically.
 */
export async function processPostUpdate(payload) {
  const { post_id, message, verb } = payload;
  if (verb === "remove") {
    Posts.remove(post_id);
    return;
  }

  // Sometimes 'message' is in payload, sometimes we need to fetch. Always
  // fetch to get the permalink and to be safe.
  let permalink = null;
  let fullMessage = message || "";
  try {
    const fbPost = await FB.getPost(post_id);
    fullMessage = fbPost.message || fullMessage;
    permalink = fbPost.permalink_url || null;
  } catch (err) {
    console.error("[engine] Could not fetch post during indexing:", err.message);
  }

  const { firstShopeeLink } = await import("./linkExtractor.js");
  const shopeeLink = firstShopeeLink(fullMessage);

  const savedPost = Posts.upsert({
    id: post_id,
    pageId: config.facebook.pageId,
    title: fullMessage.slice(0, 100) || "Bài viết Facebook",
    message: fullMessage,
    shopeeLink,
    permalink,
  });

  // Notify all connected dashboard clients instantly
  broadcast({ type: "new_post", post: savedPost });

  if (shopeeLink) {
    console.log(`[engine] Indexed post ${post_id} with Shopee link: ${shopeeLink}`);
  } else {
    console.log(`[engine] Indexed post ${post_id} (no Shopee link found)`);
  }
}

// ---- Manual reply (called from admin API) --------------------------------

export async function sendManualReply({ conversationId, text }) {
  const conv = Conversations.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  let fbMessageId = null;
  if (conv.type === "message") {
    const sent = await FB.sendMessage(conv.thread_id, text);
    fbMessageId = sent.message_id;
  } else {
    const sent = await FB.replyToComment(conv.facebook_id, text);
    fbMessageId = sent.id;
  }

  Messages.add({
    conversationId,
    role: "human",
    text,
    metadata: { manual: true },
    facebookMessageId: fbMessageId,
  });
  Conversations.setStatus(conversationId, "replied");
  return Conversations.get(conversationId);
}

// ---- Regenerate AI reply (called when human rejects current draft) ------

export async function regenerateReply(conversationId) {
  const conv = Conversations.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  // Get the last customer message
  const lastCustomer = [...conv.messages].reverse().find(m => m.role === "customer");
  if (!lastCustomer) throw new Error("No customer message to reply to");

  const linkContext = resolveLink({ postId: conv.post_id });
  let postContextStr;
  if (conv.post_id) {
    const p = Posts.get(conv.post_id);
    postContextStr = p?.title ? `bài đăng "${p.title}"` : "bài đăng";
  }

  const aiResult = await generateReply({
    customerMessage: lastCustomer.text,
    isComment: conv.type === "comment",
    postContext: postContextStr,
    linkContext,
  });

  Messages.add({
    conversationId,
    role: "ai",
    text: aiResult.reply,
    metadata: {
      confidence: aiResult.confidence,
      needs_human: aiResult.needs_human,
      reason: aiResult.reason,
      buy_intent: aiResult.buy_intent,
      link_sent: aiResult.link_sent,
      link_used: aiResult.link_sent ? linkContext.link : null,
      link_source: aiResult.link_sent ? linkContext.source : null,
      regenerated: true,
    },
  });
  return Conversations.get(conversationId);
}
