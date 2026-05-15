// ═══════════════════════════════════════════════════════════════════
//   AI Reply - Smart Sales Assistant (v3 - safe mode)
//
//   - Nếu thiếu OPENAI_API_KEY → throw error với code AI_NOT_CONFIGURED
//   - replyEngine sẽ catch error này và SKIP reply (thay vì gửi nhảm)
// ═══════════════════════════════════════════════════════════════════

import { Settings } from "./store.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const MAX_OUTPUT_TOKENS = 250;
const TEMPERATURE = 0.7;

// Custom error class để replyEngine phân biệt được
export class AINotConfiguredError extends Error {
  constructor(message = "OPENAI_API_KEY not configured") {
    super(message);
    this.name = "AINotConfiguredError";
    this.code = "AI_NOT_CONFIGURED";
  }
}

/**
 * Kiểm tra AI có sẵn sàng không (check API key)
 */
export function isAIConfigured() {
  return !!OPENAI_API_KEY && OPENAI_API_KEY.length > 0;
}

/**
 * Build system prompt động dựa trên settings của Page + context
 */
async function buildSystemPrompt({ pageId, type, post, shopeeLink }) {
  const settings = await Settings.allForPage(pageId).catch(() => ({}));

  const pageName = settings.page_name || "Shop";
  const businessDesc = settings.business_desc || "";
  const tone = settings.tone || "thân thiện, gần gũi, nhiệt tình";
  const customInstructions = settings.custom_instructions || "";

  const typeText = type === "comment"
    ? "comment dưới bài viết Facebook"
    : "tin nhắn riêng (inbox)";

  let postContext = "";
  if (post && (post.message || post.title)) {
    const content = (post.message || post.title).slice(0, 500);
    postContext = `\nBài viết liên quan: "${content}"`;
  }

  const linkInstruction = shopeeLink
    ? `
LINK SHOPEE CỦA SẢN PHẨM (rất quan trọng):
${shopeeLink}

MỤC TIÊU CHÍNH: Dẫn dắt khách click vào link Shopee này để mua hàng.`
    : `
HIỆN CHƯA CÓ LINK SHOPEE cho bài viết này.
→ Khuyến khích khách inbox riêng hoặc bình luận tên sản phẩm để được gửi link.`;

  return `Bạn là TƯ VẤN BÁN HÀNG của Page Facebook "${pageName}".

${businessDesc ? `Mô tả business: ${businessDesc}` : ""}
Tone giao tiếp: ${tone}
${customInstructions ? `Hướng dẫn riêng: ${customInstructions}` : ""}
${linkInstruction}

Bối cảnh: Khách hàng vừa gửi ${typeText}.${postContext}

═══════════════════════════════════════════════════════════════════
PHÂN LOẠI 3 NHÓM INTENT — XỬ LÝ KHÁC NHAU:
═══════════════════════════════════════════════════════════════════

🛒 NHÓM 1 - PRODUCT INQUIRY (hỏi về sản phẩm / mua hàng):
Ví dụ: "Còn hàng không?", "Bao nhiêu tiền?", "Mua ở đâu?"

→ XỬ LÝ:
  1. Trả lời câu hỏi NGẮN (1 câu).
  ${shopeeLink ? `2. KÈM LINK SHOPEE ở cuối: "${shopeeLink}"
  3. Câu mời click rõ ràng` : `2. Khuyến khích inbox/bình luận để được tư vấn`}

📋 NHÓM 2 - DETAIL QUESTION (hỏi chi tiết: size/màu/ship/chất liệu):
Ví dụ: "Size nào?", "Có màu xanh không?", "Ship bao lâu?"

→ XỬ LÝ:
  1. Trả lời ngắn dựa trên thông tin có (KHÔNG bịa).
  ${shopeeLink ? `2. KÈM LINK SHOPEE: "${shopeeLink}"
  3. HỎI THÊM để khai thác (size/màu/khu vực)` : `2. Hỏi khai thác để biết khách cần sản phẩm gì
  3. Mời khách inbox để được gửi link`}

💬 NHÓM 3 - SOCIAL/GREETING (chào / cảm ơn / khen):
Ví dụ: "Hi shop", "Đẹp quá!", "Cảm ơn shop"

→ XỬ LÝ:
  1. Phản hồi thân thiện, lịch sự.
  2. KHÔNG kèm link Shopee (tránh spam).
  3. Có thể gợi mở nhẹ: "Anh/chị có cần tư vấn gì không ạ?"

═══════════════════════════════════════════════════════════════════

NGUYÊN TẮC CHUNG:
- Tối đa 2-3 câu, không lê thê.
- Xưng "shop"/"em", gọi khách "anh/chị".
- KHÔNG bịa giá cụ thể, size cụ thể, ngày ship cụ thể nếu không có data.
- Tone: ${tone}.`;
}

/**
 * Gọi OpenAI generate reply
 *
 * @throws {AINotConfiguredError} nếu chưa cấu hình OPENAI_API_KEY
 * @throws {Error} nếu OpenAI API lỗi
 */
export async function generateAIReply({ pageId, customerMessage, type, post }) {
  // ✨ Check API key trước khi gọi
  if (!OPENAI_API_KEY) {
    throw new AINotConfiguredError(
      "OPENAI_API_KEY not configured in environment variables. " +
      "Add OPENAI_API_KEY to Railway variables to enable AI replies."
    );
  }

  // Resolve Shopee link
  const shopeeLink = post?.shopee_link || null;
  let finalLink = shopeeLink;
  if (!finalLink) {
    const settings = await Settings.allForPage(pageId).catch(() => ({}));
    finalLink = settings.default_shopee_link || null;
  }

  const systemPrompt = await buildSystemPrompt({
    pageId,
    type,
    post,
    shopeeLink: finalLink,
  });

  const requestBody = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: customerMessage },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
  };

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    throw new Error("OpenAI returned empty reply");
  }

  return {
    reply,
    model: data.model || OPENAI_MODEL,
    tokens: data.usage?.total_tokens || 0,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    hasLinkInContext: !!finalLink,
  };
}

/**
 * Fallback reply khi không gọi được AI (giữ lại để dùng nếu cần)
 */
export function getFallbackReply() {
  return "Cảm ơn anh chị đã quan tâm! Anh chị inbox shop để được tư vấn chi tiết nhé.";
}
