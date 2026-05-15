import { Posts, Conversations, Messages, Settings } from "./store.js";
import * as FB from "./facebook.js";
import * as Pages from "./pages.js";
import { detectComplaint } from "./intent.js";
import { config } from "./config.js";
import { broadcast } from "./sse.js";
import {
  classifyIntent,
  getMatchedKeyword,
  getReplyTemplate,
  prependGreeting,
} from "./keywordMatcher.js";
import { generateAIReply, getFallbackReply, AINotConfiguredError } from "./aiReply.js";

// ═══════════════════════════════════════════════════════════════════
// Anti-spam config
// Skip nếu cùng khách + cùng post trong khoảng thời gian này
// Áp dụng cho CẢ keyword reply và AI reply (theo yêu cầu user)
// ═══════════════════════════════════════════════════════════════════
const COMMENT_ANTI_SPAM_WINDOW_MS = 20 * 60 * 1000; // 20 phút
const ANTI_SPAM_MINUTES = 20;

// ═══════════════════════════════════════════════════════════════════
// generateReply - Logic mới với 2 nhóm template
//
// Flow:
//   1. Classify intent của message:
//      - "price"    → hỏi giá  → template "xem giá"
//      - "purchase" → hỏi mua  → template "mua hàng"
//      - null       → không match → gọi AI
//   2. Nếu match nhưng KHÔNG có Shopee link → fallback AI
// ═══════════════════════════════════════════════════════════════════

async function generateReply({ pageId, customerMessage, linkContext, type, post, isNewConv }) {
  const link = linkContext?.link || null;
  const intent = classifyIntent(customerMessage);
  const matched = getMatchedKeyword(customerMessage);

  // ✨ Greeting CHỈ áp dụng cho KEYWORD TEMPLATE (câu cứng, lặp lại)
  // KHÔNG áp dụng cho AI reply (vì AI tự viết tự nhiên rồi, thêm chào ngoài làm thừa)
  const withGreetingForTemplate = (reply) => isNewConv ? prependGreeting(reply) : reply;

  // Flow 1: Match keyword (price hoặc purchase) + có link → template
  if (intent && link) {
    console.log(
      `[engine] Keyword match: intent="${intent}", kw="${matched?.keyword}" → template reply (isNewConv=${isNewConv})`
    );
    return {
      reply: withGreetingForTemplate(getReplyTemplate(intent, link)),
      confidence: 1.0,
      needs_human: false,
      reason: `${intent}_keyword_match`,
      buy_intent: true,
      link_sent: true,
      matched_intent: intent,
      matched_keyword: matched?.keyword,
      source: `template_${intent}`,
      with_greeting: !!isNewConv,
    };
  }

  // Flow 2: Không match HOẶC match nhưng không có link → gọi AI
  console.log(
    `[engine] Calling AI (${intent ? "matched but no link" : "no keyword match"}, isNewConv=${isNewConv})`
  );

  try {
    const aiResult = await generateAIReply({
      pageId,
      customerMessage,
      type,
      post,
    });

    return {
      // ✨ KHÔNG prepend greeting - để AI tự viết tự nhiên
      reply: aiResult.reply,
      confidence: 0.85,
      needs_human: false,
      reason: intent ? `ai_no_link_fallback` : "ai_generated",
      buy_intent: !!intent,
      link_sent: false,
      source: "openai",
      model: aiResult.model,
      tokens: aiResult.tokens,
      matched_intent: intent,
      matched_keyword: matched?.keyword,
      with_greeting: false, // AI tự handle, không prepend
    };
  } catch (err) {
    // ✨ Nếu AI chưa configured → return null để caller SKIP (không reply)
    if (err instanceof AINotConfiguredError || err.code === "AI_NOT_CONFIGURED") {
      console.log(
        `[engine] AI not configured → SKIP reply (no template, no AI). Message: "${customerMessage?.slice(0, 60)}"`
      );
      return null; // ← signal cho caller biết skip
    }

    // Lỗi khác của OpenAI → log nhưng không reply gì
    console.error("[engine] AI call failed → SKIP reply:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Resolve Shopee link
// ═══════════════════════════════════════════════════════════════════

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
  return {
    link: fallback || null,
    source: fallback ? "page_default" : null,
    post: null,
  };
}

const genId = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ═══════════════════════════════════════════════════════════════════
// Process incoming COMMENT
// ═══════════════════════════════════════════════════════════════════

export async function processComment(payload) {
  const { pageId, comment_id, post_id, message, from } = payload;

  if (!message || !from || !pageId) return null;

  // Don't reply to ourselves
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

  // ═══════════════════════════════════════════════════════════════
  // Anti-spam check (20 phút): cùng khách + cùng post → skip
  // Áp dụng cho CẢ keyword reply và AI reply
  // ═══════════════════════════════════════════════════════════════
  const recentConv = await Conversations.findOpenByCustomerAndType({
    pageId,
    customerId: from.id,
    type: "comment",
    withinMs: COMMENT_ANTI_SPAM_WINDOW_MS,
  });
  const alreadyRepliedOnThisPostRecently =
    recentConv && recentConv.post_id === post_id;

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

  // Auto-reply enabled check
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

  // Anti-spam: cùng khách + cùng post + trong 20 phút → skip
  if (alreadyRepliedOnThisPostRecently) {
    const minutesAgo = Math.round((Date.now() - recentConv.updated_at) / 60000);
    console.log(
      `[engine] Skipping comment from ${from.id} - already replied on post ${post_id} ${minutesAgo}m ago (anti-spam window: ${ANTI_SPAM_MINUTES}m)`
    );
    await Conversations.setStatus(convId, "skipped_duplicate");
    await Messages.add({
      conversationId: convId,
      role: "ai",
      text: `[Hệ thống] Bỏ qua - đã reply khách này trên post này trong ${ANTI_SPAM_MINUTES} phút qua.`,
      metadata: {
        skipped: true,
        reason: `anti_spam_duplicate_within_${ANTI_SPAM_MINUTES}min`,
      },
    });
    return await Conversations.get(convId);
  }

  // Generate reply (keyword template hoặc AI)
  // Comment: mỗi lần là 1 conv mới → luôn isNewConv = true → có greeting
  const linkContext = await resolveLink({ pageId, postId: post_id });
  const aiResult = await generateReply({
    pageId,
    customerMessage: message,
    linkContext,
    type: "comment",
    post,
    isNewConv: true,
  });

  // ✨ Nếu generateReply trả null (AI chưa configured) → SKIP không reply
  if (!aiResult) {
    console.log(`[engine] Skipping comment - no keyword match + no AI available`);
    await Conversations.setStatus(convId, "skipped_no_ai");
    await Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Bỏ qua - không match keyword và AI chưa được cấu hình.",
      metadata: {
        skipped: true,
        reason: "no_keyword_match_and_no_ai",
      },
    });
    return await Conversations.get(convId);
  }

  let fbCommentReplyId = null;

  try {
    const sent = await FB.replyToComment(pageId, comment_id, aiResult.reply);
    fbCommentReplyId = sent.id;
  } catch (err) {
    console.error("[engine] Failed to send comment reply:", err.message);
  }

  // ✨ ANTI-SPAM: KHÔNG tự động gửi private DM khi khách comment
  // Trước đây: gửi cả public reply + private DM cùng nội dung
  // → Facebook flag là spam pattern, có thể khóa Page
  // Giờ: chỉ reply public dưới comment, khách muốn DM thì tự nhắn

  if (fbCommentReplyId) {
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
      sent_to_inbox: false, // ← Tắt tính năng tự DM
    },
    facebookMessageId: fbCommentReplyId,
  });

  return await Conversations.get(convId);
}

// ═══════════════════════════════════════════════════════════════════
// Process incoming MESSAGE (DM)
// ═══════════════════════════════════════════════════════════════════

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
  let isNewConv = false;

  if (conv) {
    convId = conv.id;
    if (referralPostId && !conv.post_id) {
      await Conversations.setPost(convId, referralPostId);
    }
  } else {
    convId = genId("conv");
    isNewConv = true;
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

  // Auto-reply enabled check
  const autoEnabled = await Settings.get(pageId, "auto_reply_enabled");
  if (autoEnabled === false) {
    return await Conversations.get(convId);
  }

  // Detect complaint
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

  // ═══════════════════════════════════════════════════════════════
  // ✨ ANTI-SPAM cho INBOX - LOGIC MỚI (v5)
  // ═══════════════════════════════════════════════════════════════
  //
  // Quy tắc: Khách CŨ (đã từng inbox/comment với Page) → bypass anti-spam
  //          Khách MỚI → giữ anti-spam 20 phút như cũ
  //
  // Lý do: Khách cũ đã chat → ý định mua mạnh → cần reply nhanh để chốt đơn
  //        Khách mới có thể spam test → vẫn cần anti-spam bảo vệ
  // ═══════════════════════════════════════════════════════════════

  // Check xem khách này đã từng có conversation với Page chưa (bất kể type)
  const hasAnyPreviousConv = await Conversations.findOpenByCustomerAndType({
    pageId,
    customerId: senderId,
    type: "message",
  }) || await Conversations.findOpenByCustomerAndType({
    pageId,
    customerId: senderId,
    type: "comment",
  });

  const isReturningCustomer = !!hasAnyPreviousConv;

  // Chỉ áp dụng anti-spam nếu là KHÁCH MỚI (chưa từng chat trước đây)
  if (!isReturningCustomer && !isNewConv && conv) {
    const conversation = await Conversations.get(convId);
    const messages = conversation.messages || [];
    // Tìm AI message gần nhất (không tính tin "[Hệ thống]" skip)
    const lastAiMsg = [...messages].reverse().find(
      (m) => m.role === "ai" && !m.metadata?.skipped
    );

    if (lastAiMsg) {
      const lastAiTime = Number(lastAiMsg.created_at);
      const elapsed = Date.now() - lastAiTime;
      if (elapsed < COMMENT_ANTI_SPAM_WINDOW_MS) {
        const minutesAgo = Math.round(elapsed / 60000);
        console.log(
          `[engine] Skipping inbox from ${senderId} - new customer + already replied ${minutesAgo}m ago (anti-spam window: ${ANTI_SPAM_MINUTES}m)`
        );
        await Messages.add({
          conversationId: convId,
          role: "ai",
          text: `[Hệ thống] Bỏ qua - đã reply khách này trong ${ANTI_SPAM_MINUTES} phút qua.`,
          metadata: {
            skipped: true,
            reason: `anti_spam_duplicate_within_${ANTI_SPAM_MINUTES}min`,
          },
        });
        return await Conversations.get(convId);
      }
    }
  } else if (isReturningCustomer) {
    console.log(
      `[engine] Inbox from ${senderId} - returning customer, BYPASS anti-spam → reply ngay`
    );
  }

  // Generate reply
  const conversation = await Conversations.get(convId);
  const linkContext = await resolveLink({
    pageId,
    postId: conversation.post_id,
  });
  // Lấy post info nếu có post_id (cho AI context)
  let post = null;
  if (conversation.post_id) {
    post = await Posts.get(conversation.post_id);
  }

  const aiResult = await generateReply({
    pageId,
    customerMessage: text,
    linkContext,
    type: "message",
    post,
    isNewConv,
  });

  // ✨ Nếu generateReply trả null (AI chưa configured) → SKIP không reply
  if (!aiResult) {
    console.log(`[engine] Skipping inbox - no keyword match + no AI available`);
    await Conversations.setStatus(convId, "skipped_no_ai");
    await Messages.add({
      conversationId: convId,
      role: "ai",
      text: "[Hệ thống] Bỏ qua - không match keyword và AI chưa được cấu hình.",
      metadata: {
        skipped: true,
        reason: "no_keyword_match_and_no_ai",
      },
    });
    return await Conversations.get(convId);
  }

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

// ═══════════════════════════════════════════════════════════════════
// Process new/edited POST
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// Manual reply (từ Dashboard)
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// Regenerate reply (từ Dashboard)
// ═══════════════════════════════════════════════════════════════════

export async function regenerateReply(conversationId) {
  const conv = await Conversations.get(conversationId);
  if (!conv) throw new Error("Conversation not found");

  const lastCustomer = [...conv.messages].reverse().find((m) => m.role === "customer");
  if (!lastCustomer) throw new Error("No customer message to reply to");

  const linkContext = await resolveLink({
    pageId: conv.page_id,
    postId: conv.post_id,
  });
  let post = null;
  if (conv.post_id) {
    post = await Posts.get(conv.post_id);
  }

  const aiResult = await generateReply({
    pageId: conv.page_id,
    customerMessage: lastCustomer.text,
    linkContext,
    type: conv.type,
    post,
    isNewConv: false, // regenerate không cần chào lại
  });

  if (!aiResult) {
    throw new Error(
      "Không thể tạo reply: không match keyword và AI chưa được cấu hình. " +
      "Vui lòng setup OPENAI_API_KEY trong Railway."
    );
  }

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
