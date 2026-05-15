// ═══════════════════════════════════════════════════════════════════
//   AI Reply v2 - Smart Sales Assistant
//
//   Phân loại intent của khách:
//   1. Product inquiry → reply + link + CTA
//   2. Detail question → reply ngắn + link + hỏi khai thác
//   3. Social/Greeting → reply thân thiện, KHÔNG kèm link
// ═══════════════════════════════════════════════════════════════════

import { Settings } from "./store.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const MAX_OUTPUT_TOKENS = 250;
const TEMPERATURE = 0.7;

/**
 * Build system prompt động dựa trên settings của Page + context
 */
async function buildSystemPrompt({ pageId, type, post, shopeeLink }) {
  // Settings của Page (user config qua Dashboard)
  const settings = await Settings.allForPage(pageId).catch(() => ({}));

  const pageName = settings.page_name || "Shop";
  const businessDesc = settings.business_desc || "";
  const tone = settings.tone || "thân thiện, gần gũi, nhiệt tình";
  const customInstructions = settings.custom_instructions || "";

  const typeText = type === "comment"
    ? "comment dưới bài viết Facebook"
    : "tin nhắn riêng (inbox)";

  // Post context
  let postContext = "";
  if (post && (post.message || post.title)) {
    const content = (post.message || post.title).slice(0, 500);
    postContext = `\nBài viết liên quan: "${content}"`;
  }

  // ─── Phần khác biệt: CÓ LINK vs KHÔNG CÓ LINK ───
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
Ví dụ: "Còn hàng không?", "Bao nhiêu tiền?", "Có hàng không?", 
       "Sản phẩm này thế nào?", "Mua ở đâu?", "Đặt được không?"

→ XỬ LÝ:
  1. Trả lời câu hỏi NGẮN (1 câu).
  ${shopeeLink ? `2. KÈM LINK SHOPEE ở cuối: "${shopeeLink}"
  3. Câu mời click rõ ràng: "Anh chị click link Shopee để đặt hàng nhé"` : `2. Khuyến khích inbox/bình luận để được tư vấn`}

═══════════════════════════════════════════════════════════════════

📋 NHÓM 2 - DETAIL QUESTION (hỏi chi tiết: size/màu/ship/chất liệu):
Ví dụ: "Size nào shop?", "Có màu xanh không?", "Ship bao lâu?",
       "Vải gì?", "Đổi trả được không?", "Có bảo hành không?"

→ XỬ LÝ:
  1. Trả lời ngắn dựa trên thông tin có (KHÔNG bịa).
     Nếu không chắc → "Anh/chị xem chi tiết trong mô tả Shopee nhé".
  ${shopeeLink ? `2. KÈM LINK SHOPEE: "${shopeeLink}"
  3. HỎI THÊM để khai thác: ví dụ
     - Size: "Anh/chị muốn size nào ạ?"
     - Màu: "Anh/chị thích màu gì?"
     - Ship: "Anh/chị ở khu vực nào ạ?"
     - Số lượng: "Anh/chị lấy mấy cái ạ?"` : `2. Hỏi khai thác để biết khách cần sản phẩm gì cụ thể
  3. Mời khách inbox để được gửi link và tư vấn`}

═══════════════════════════════════════════════════════════════════

💬 NHÓM 3 - SOCIAL/GREETING (chào hỏi / cảm ơn / khen):
Ví dụ: "Hi shop", "Đẹp quá!", "Cảm ơn shop", "Hay quá", 
       "Yêu shop", "👍", "Like", "Lần sau ủng hộ"

→ XỬ LÝ:
  1. Phản hồi thân thiện, lịch sự.
  2. KHÔNG kèm link Shopee (tránh spam, gây phiền).
  3. Có thể gợi mở nhẹ: "Anh/chị có cần tư vấn gì không ạ?"

═══════════════════════════════════════════════════════════════════

NGUYÊN TẮC CHUNG:
- Tối đa 2-3 câu, không lê thê.
- Xưng "shop"/"em", gọi khách "anh/chị" — KHÔNG dùng "tôi"/"bạn".
- KHÔNG bịa giá cụ thể, size cụ thể, ngày ship cụ thể nếu không có data.
- Tone: ${tone}.

═══════════════════════════════════════════════════════════════════
VÍ DỤ THỰC TẾ (giả sử link = "${shopeeLink || 'https://shope.ee/abc'}"):
═══════════════════════════════════════════════════════════════════

[NHÓM 1 - Product inquiry]

Khách: "Còn hàng không shop?"
→ "Dạ shop còn nhiều ạ! Anh chị click link Shopee để đặt hàng ngay nhé: ${shopeeLink || '{link}'}"

Khách: "Bao nhiêu tiền?"
→ "Dạ giá cụ thể anh/chị xem trên Shopee ạ, shop đang có ưu đãi: ${shopeeLink || '{link}'}"

Khách: "Mua được không?"
→ "Dạ được ạ! Anh chị bấm vào link Shopee đặt hàng nhanh nhé: ${shopeeLink || '{link}'}"

─────────────────────────────────────────────────────────────

[NHÓM 2 - Detail question]

Khách: "Size nào shop?"
→ "Dạ shop có nhiều size, anh/chị xem chi tiết trên Shopee giúp em nhé: ${shopeeLink || '{link}'}
   Anh/chị muốn size nào ạ?"

Khách: "Ship bao lâu?"
→ "Dạ shop ship 2-3 ngày là khách nhận ạ. Đặt hàng tại: ${shopeeLink || '{link}'}
   Anh/chị ở khu vực nào ạ?"

Khách: "Vải gì shop?"
→ "Dạ chất liệu cụ thể anh xem trong mô tả Shopee nhé: ${shopeeLink || '{link}'}
   Anh/chị muốn shop tư vấn thêm gì không ạ?"

─────────────────────────────────────────────────────────────

[NHÓM 3 - Social/Greeting - KHÔNG KÈM LINK]

Khách: "Đẹp quá!"
→ "Dạ cảm ơn anh/chị nhiều ạ! Có gì cần tư vấn anh/chị nhắn shop nhé."

Khách: "Hi shop"
→ "Dạ chào anh/chị! Anh/chị cần shop tư vấn sản phẩm nào ạ?"

Khách: "Yêu shop quá"
→ "Dạ shop cũng yêu anh/chị ạ 💖 Cần gì anh/chị inbox shop nhé!"

═══════════════════════════════════════════════════════════════════

LƯU Ý CUỐI:
- Phân tích kỹ message khách trước khi reply để chọn ĐÚNG NHÓM intent.
- Nếu không chắc, ưu tiên Nhóm 2 (an toàn nhất, vẫn có link nhưng có hỏi thêm).`;
}

/**
 * Gọi OpenAI generate reply
 */
export async function generateAIReply({ pageId, customerMessage, type, post }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // Resolve Shopee link (post.shopee_link → fallback default của Page)
  const shopeeLink = post?.shopee_link || null;
  // Nếu không có post link, lấy default từ settings
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

  try {
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
  } catch (err) {
    console.error("[aiReply] OpenAI call failed:", err.message);
    throw err;
  }
}

/**
 * Fallback reply khi OpenAI lỗi
 */
export function getFallbackReply() {
  return "Cảm ơn anh chị đã quan tâm! Anh chị inbox shop để được tư vấn chi tiết nhé.";
}
