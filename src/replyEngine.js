import { Posts, Conversations, Messages, Settings } from "./db.js";
import * as FB from "./facebook.js";
import { detectComplaint } from "./intent.js";
import { config } from "./config.js";
import { broadcast } from "./sse.js";

// ---- Keyword-based reply (thay thế AI) -----------------------------------
function generateKeywordReply({ customerMessage, linkContext }) {
  const link = linkContext?.link || null;

  // Nếu không có link Shopee → trả về thông báo lỗi
  if (!link) {
    return {
      reply: "Hiện tại không có link Shopee.",
      confidence: 1.0,
      needs_human: false,
      reason: "no_shopee_link",
      buy_intent: false,
      link_sent: false,
    };
  }

  const text = (customerMessage || "").toLowerCase();

  // Keyword groups
  const askingPriceKeywords = ["giá", "bao nhiêu tiền", "bao nhiêu vậy", "bn tiền", "bn vậy"];
  const askingBuyKeywords = ["mua", "ở đâu", "link", "địa chỉ", "đặt", "order"];

  let reply;

  if (askingPriceKeywords.some(kw => text.includes(kw))) {
    reply = `Anh chị click vào link Shopee này để xem giá và mua hàng nhé: ${link}`;
  } else if (askingBuyKeywords.some(kw => text.includes(kw))) {
    reply = `Anh chị click vào link Shopee này để mua hàng nhé: ${link}`;
  } else {
    reply = `Anh chị click vào link Shopee này để mua hàng nhé: ${link}`;
  }

  return {
    reply,
    confidence: 1.0,
    needs_human: false,
    reason: "keyword_match",
    buy_intent: true,
    link_sent: true,
  };
}

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

  // Make sure we have post info; fetch if missing
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

  // ANTI-SPAM: Check if this customer already has an active conversation on this post
  const existingConv = Conversations.findOpenByCustomerAndType?.({
    customerId: from.id,
    type: "comment",
  });
  const alreadyRepliedOnThisPost = existingConv && existingConv.post_id === post_id;

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

  // Pre-flag complaints
  if (detectComplaint(message)) {
    Conversations.setStatus(convId, "needs_review");
    Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Phát hiện khiếu nại — chuyển nhân viên xử lý thay vì auto-reply.",
      metadata: { needs_human: true, reason: "Khiếu nại" },
    });
    return Conversations.get(convId);
  }

  // ANTI-SPAM: Skip if already replied on this post
  if (alreadyRepliedOnThisPost) {
    console.log(`[engine] Skipping comment from ${from.id} - already replied on post ${post_id}`);
    Conversations.setStatus(convId, "skipped_duplicate");
    Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Bỏ qua - đã reply khách này trên post này.",
      metadata: { skipped: true, reason: "anti_spam_duplicate" },
    });
    return Conversations.get(convId);
  }

  // Generate keyword reply
  const linkContext = resolveLink({ postId: post_id });
  const aiResult = generateKeywordReply({
    customerMessage: message,
    linkContext,
  });

  // Always send (confidence is always 1.0 for keyword match)
  let fbCommentReplyId = null;
  let fbInboxMessageId = null;

  // 1. Reply public dưới comment
  try {
    const sent = await FB.replyToComment(comment_id, aiResult.reply);
    fbCommentReplyId = sent.id;
  } catch (err) {
    console.error("[engine] Failed to send comment reply:", err.message);
  }

  // 2. Inbox riêng cho khách (PRIVATE_REPLIES)
  try {
    if (FB.sendPrivateReply) {
      const inboxSent = await FB.sendPrivateReply(comment_id, aiResult.reply);
      fbInboxMessageId = inboxSent?.message_id || inboxSent?.id || null;
    }
  } catch (err) {
    console.error("[engine] Failed to send private reply (inbox):", err.message);
  }

  // Update status
  if (fbCommentReplyId || fbInboxMessageId) {
    Conversations.setStatus(convId, "replied");
  } else {
    Conversations.setStatus(convId, "failed");
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
      auto_sent: true,
      sent_to_comment: !!fbCommentReplyId,
      sent_to_inbox: !!fbInboxMessageId,
    },
    facebookMessageId: fbCommentReplyId,
  });

  return Conversations.get(convId);
}

// ---- Process incoming MESSAGE (DM) ---------------------------------------
/**
 * Called when a customer sends a direct message to the page.
 */
export async function processMessage(payload) {
  const { mid, senderId, text, referralPostId } = payload;

  if (!text) return null;
  if (senderId === config.facebook.pageId) return null;

  // Try to thread with an existing recent conversation
  let conv = Conversations.findOpenByCustomerAndType({
    customerId: senderId,
    type: "message",
  });

  let convId;
  let isFirstMessage = true; // Flag để biết có phải tin đầu tiên không

  if (conv) {
    convId = conv.id;
    // Đã có conversation → đây không phải tin đầu tiên
    isFirstMessage = false;

    // Update post link if we just learned about a referral
    if (referralPostId && !conv.post_id) {
      Conversations.setPost(convId, referralPostId);
    }
  } else {
    convId = genId("conv");
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
  if (detectComplaint(text)) {
    Conversations.setStatus(convId, "needs_review");
    Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Phát hiện khiếu nại — chuyển nhân viên xử lý.",
      metadata: { needs_human: true, reason: "Khiếu nại" },
    });
    return Conversations.get(convId);
  }

  // ANTI-SPAM: Chỉ reply tin đầu tiên
  if (!isFirstMessage) {
    console.log(`[engine] Skipping DM from ${senderId} - not the first message`);
    Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Bỏ qua - không phải tin nhắn đầu tiên.",
      metadata: { skipped: true, reason: "anti_spam_not_first" },
    });
    return Conversations.get(convId);
  }

  // Resolve link based on post reference (if any)
  const conversation = Conversations.get(convId);
  const linkContext = resolveLink({ postId: conversation.post_id });

  // Generate keyword reply
  const aiResult = generateKeywordReply({
    customerMessage: text,
    linkContext,
  });

  // Always send
  let fbMessageId = null;
  try {
    const sent = await FB.sendMessage(senderId, aiResult.reply);
    fbMessageId = sent.message_id;
    Conversations.setStatus(convId, "replied");
  } catch (err) {
    console.error("[engine] Failed to send DM:", err.message);
    Conversations.setStatus(convId, "failed");
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
      auto_sent: true,
    },
    facebookMessageId: fbMessageId,
  });

  return Conversations.get(convId);
}

// ---- Process new/edited POST ---------------------------------------------
export async function processPostUpdate(payload) {
  const { post_id, message, verb } = payload;
  if (verb === "remove") {
    Posts.remove(post_id);
    return;
  }

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

// ---- Regenerate reply (now uses keyword logic) ---------------------------

export async function regenerateReply(conversationId) {
  const conv = Conversations.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  const lastCustomer = [...conv.messages].reverse().find(m => m.role === "customer");
  if (!lastCustomer) throw new Error("No customer message to reply to");

  const linkContext = resolveLink({ postId: conv.post_id });

  const aiResult = generateKeywordReply({
    customerMessage: lastCustomer.text,
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
