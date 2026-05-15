import { Posts, Conversations, Messages, Settings } from "./store.js";
import * as FB from "./facebook.js";
import * as Pages from "./pages.js";
import { detectComplaint } from "./intent.js";
import { config } from "./config.js";
import { broadcast } from "./sse.js";

// ---- Anti-spam config ---------------------------------------------------
// Skip nếu cùng khách + cùng post trong khoảng thời gian này.
// Sau khoảng này, khách comment lại sẽ được reply.
// Mặc định: 5 phút.
const COMMENT_ANTI_SPAM_WINDOW_MS = 5 * 60 * 1000;

// ---- Keyword-based reply -------------------------------------------------

function generateKeywordReply({ customerMessage, linkContext }) {
  const link = linkContext?.link || null;

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

// ---- Resolve link --------------------------------------------------------

export async function resolveLink({ pageId, postId }) {
  if (postId) {
    const post = await Posts.get(postId);
    if (post?.shopee_link) {
      return { link: post.shopee_link, source: "post", post };
    }
  }
  // Fallback: default link của page
  const page = await Pages.getPageByFacebookId(pageId);
  const fallback = page?.default_shopee_link || null;
  return { link: fallback || null, source: fallback ? "page_default" : null, post: null };
}

const genId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ---- Process incoming COMMENT --------------------------------------------

export async function processComment(payload) {
  const { pageId, comment_id, post_id, message, from } = payload;

  if (!message || !from || !pageId) return null;

  // Don't reply to ourselves (page commenting on own post)
  if (from.id === pageId) return null;

  // Make sure we have post info
  let post = await Posts.get(post_id);
  if (!post) {
    try {
      const fbPost = await FB.getPost(pageId, post_id);
      const { firstShopeeLink } = await import("./linkExtractor.js");
      post = await Posts.upsert({
        id: fbPost.id,
        pageId,
        title: (fbPost.message || "").slice(0, 100) || "Bài viết Facebook",
        message: fbPost.message || "",
        shopeeLink: firstShopeeLink(fbPost.message || ""),
        permalink: fbPost.permalink_url,
      });
    } catch (err) {
      console.error("[engine] Could not fetch post:", err.message);
    }
  }

  // ✨ Anti-spam check: chỉ skip nếu khách comment cùng post TRONG 5 phút ✨
  // Sau 5 phút, khách comment lại sẽ được reply bình thường.
  // Comment ở post khác thì luôn được reply (không bị skip).
  const recentConv = await Conversations.findOpenByCustomerAndType({
    pageId,
    customerId: from.id,
    type: "comment",
    withinMs: COMMENT_ANTI_SPAM_WINDOW_MS, // ← 5 phút thay vì default 24h
  });
  const alreadyRepliedOnThisPostRecently = recentConv && recentConv.post_id === post_id;

  // Create conversation
  const convId = genId("conv");
  const newConv = await Conversations.create({
    id: convId,
    pageId,
    type: "comment",
    facebookId: comment_id,
    threadId: post_id,
    customerId: from.id,
    customerName: from.name || "Khách",
    postId: post_id,
    status: "pending",
  });
  broadcast({ type: "new_conversation", conversation: newConv, pageId });

  await Messages.add({
    conversationId: convId,
    role: "customer",
    text: message,
    metadata: { fb_comment_id: comment_id, fb_post_id: post_id },
  });

  // Check auto-reply per page
  const autoEnabled = await Settings.get(pageId, "auto_reply_enabled");
  if (autoEnabled === false) {
    return await Conversations.get(convId);
  }

  // Pre-flag complaints
  if (detectComplaint(message)) {
    await Conversations.setStatus(convId, "needs_review");
    await Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Phát hiện khiếu nại — chuyển nhân viên xử lý thay vì auto-reply.",
      metadata: { needs_human: true, reason: "Khiếu nại" },
    });
    return await Conversations.get(convId);
  }

  // Anti-spam: cùng khách + cùng post + trong 5 phút → skip
  if (alreadyRepliedOnThisPostRecently) {
    const minutesAgo = Math.round((Date.now() - recentConv.updated_at) / 60000);
    console.log(`[engine] Skipping comment from ${from.id} - already replied on post ${post_id} ${minutesAgo}m ago (anti-spam window: 5m)`);
    await Conversations.setStatus(convId, "skipped_duplicate");
    await Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Bỏ qua - đã reply khách này trên post này trong 5 phút qua.",
      metadata: { skipped: true, reason: "anti_spam_duplicate_within_5min" },
    });
    return await Conversations.get(convId);
  }

  // Generate reply
  const linkContext = await resolveLink({ pageId, postId: post_id });
  const aiResult = generateKeywordReply({
    customerMessage: message,
    linkContext,
  });

  let fbCommentReplyId = null;
  let fbInboxMessageId = null;

  try {
    const sent = await FB.replyToComment(pageId, comment_id, aiResult.reply);
    fbCommentReplyId = sent.id;
  } catch (err) {
    console.error("[engine] Failed to send comment reply:", err.message);
  }

  try {
    const inboxSent = await FB.sendPrivateReply(pageId, comment_id, aiResult.reply);
    fbInboxMessageId = inboxSent?.message_id || inboxSent?.id || null;
  } catch (err) {
    console.error("[engine] Failed to send private reply (inbox):", err.message);
  }

  if (fbCommentReplyId || fbInboxMessageId) {
    await Conversations.setStatus(convId, "replied");
  } else {
    await Conversations.setStatus(convId, "failed");
  }

  await Messages.add({
    conversationId: convId,
    role: "ai",
    text: aiResult.reply,
    metadata: {
      ...aiResult,
      link_used: aiResult.link_sent ? linkContext.link : null,
      link_source: aiResult.link_sent ? linkContext.source : null,
      auto_sent: true,
      sent_to_comment: !!fbCommentReplyId,
      sent_to_inbox: !!fbInboxMessageId,
    },
    facebookMessageId: fbCommentReplyId,
  });

  return await Conversations.get(convId);
}

// ---- Process incoming MESSAGE (DM) ---------------------------------------

export async function processMessage(payload) {
  const { pageId, mid, senderId, text, referralPostId } = payload;

  if (!text || !pageId) return null;
  if (senderId === pageId) return null;

  // Thread with existing conversation
  let conv = await Conversations.findOpenByCustomerAndType({
    pageId,
    customerId: senderId,
    type: "message",
  });

  let convId;

  if (conv) {
    convId = conv.id;
    if (referralPostId && !conv.post_id) {
      await Conversations.setPost(convId, referralPostId);
    }
  } else {
    convId = genId("conv");
    let customerName = "Khách";
    try {
      const profile = await FB.getUserProfile(pageId, senderId);
      if (profile?.first_name) {
        customerName = `${profile.first_name} ${profile.last_name || ""}`.trim();
      }
    } catch {}

    await Conversations.create({
      id: convId,
      pageId,
      type: "message",
      facebookId: mid,
      threadId: senderId,
      customerId: senderId,
      customerName,
      postId: referralPostId || null,
      status: "pending",
    });
  }

  await Messages.add({
    conversationId: convId,
    role: "customer",
    text,
    metadata: { fb_mid: mid, referral_post_id: referralPostId },
  });

  const autoEnabled = await Settings.get(pageId, "auto_reply_enabled");
  if (autoEnabled === false) {
    return await Conversations.get(convId);
  }

  if (detectComplaint(text)) {
    await Conversations.setStatus(convId, "needs_review");
    await Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Phát hiện khiếu nại — chuyển nhân viên xử lý.",
      metadata: { needs_human: true, reason: "Khiếu nại" },
    });
    return await Conversations.get(convId);
  }

  const conversation = await Conversations.get(convId);
  const linkContext = await resolveLink({ pageId, postId: conversation.post_id });
  const aiResult = generateKeywordReply({
    customerMessage: text,
    linkContext,
  });

  let fbMessageId = null;
  try {
    const sent = await FB.sendMessage(pageId, senderId, aiResult.reply);
    fbMessageId = sent.message_id;
    await Conversations.setStatus(convId, "replied");
  } catch (err) {
    console.error("[engine] Failed to send DM:", err.message);
    await Conversations.setStatus(convId, "failed");
  }

  await Messages.add({
    conversationId: convId,
    role: "ai",
    text: aiResult.reply,
    metadata: {
      ...aiResult,
      link_used: aiResult.link_sent ? linkContext.link : null,
      link_source: aiResult.link_sent ? linkContext.source : null,
      auto_sent: true,
    },
    facebookMessageId: fbMessageId,
  });

  return await Conversations.get(convId);
}

// ---- Process new/edited POST ---------------------------------------------

export async function processPostUpdate(payload) {
  const { pageId, post_id, message, verb } = payload;

  if (verb === "remove") {
    await Posts.remove(post_id);
    return;
  }

  let permalink = null;
  let fullMessage = message || "";
  try {
    const fbPost = await FB.getPost(pageId, post_id);
    fullMessage = fbPost.message || fullMessage;
    permalink = fbPost.permalink_url || null;
  } catch (err) {
    console.error("[engine] Could not fetch post during indexing:", err.message);
  }

  const { firstShopeeLink } = await import("./linkExtractor.js");
  const shopeeLink = firstShopeeLink(fullMessage);

  const savedPost = await Posts.upsert({
    id: post_id,
    pageId,
    title: fullMessage.slice(0, 100) || "Bài viết Facebook",
    message: fullMessage,
    shopeeLink,
    permalink,
  });

  broadcast({ type: "new_post", post: savedPost, pageId });

  if (shopeeLink) {
    console.log(`[engine] Indexed post ${post_id} with Shopee link: ${shopeeLink}`);
  } else {
    console.log(`[engine] Indexed post ${post_id} (no Shopee link found)`);
  }
}

// ---- Manual reply --------------------------------------------------------

export async function sendManualReply({ conversationId, text }) {
  const conv = await Conversations.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  let fbMessageId = null;
  if (conv.type === "message") {
    const sent = await FB.sendMessage(conv.page_id, conv.thread_id, text);
    fbMessageId = sent.message_id;
  } else {
    const sent = await FB.replyToComment(conv.page_id, conv.facebook_id, text);
    fbMessageId = sent.id;
  }

  await Messages.add({
    conversationId,
    role: "human",
    text,
    metadata: { manual: true },
    facebookMessageId: fbMessageId,
  });
  await Conversations.setStatus(conversationId, "replied");
  return await Conversations.get(conversationId);
}

// ---- Regenerate reply ----------------------------------------------------

export async function regenerateReply(conversationId) {
  const conv = await Conversations.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  const lastCustomer = [...conv.messages].reverse().find(m => m.role === "customer");
  if (!lastCustomer) throw new Error("No customer message to reply to");

  const linkContext = await resolveLink({ pageId: conv.page_id, postId: conv.post_id });
  const aiResult = generateKeywordReply({
    customerMessage: lastCustomer.text,
    linkContext,
  });

  await Messages.add({
    conversationId,
    role: "ai",
    text: aiResult.reply,
    metadata: {
      ...aiResult,
      link_used: aiResult.link_sent ? linkContext.link : null,
      link_source: aiResult.link_sent ? linkContext.source : null,
      regenerated: true,
    },
  });
  return await Conversations.get(conversationId);
}
