import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { Settings } from "./db.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const TONE_HINTS = {
  friendly:     "Vui vẻ, dùng từ shop/khách",
  professional: "Lịch sự, dùng kính ngữ",
  playful:      "Hài hước, dùng emoji nhẹ",
  concise:      "Đi thẳng vào vấn đề",
};

function buildSystemPrompt({ linkContext }) {
  const pageName = Settings.get("page_name") || "Tiệm của bạn";
  const businessDesc = Settings.get("business_desc") || "";
  const tone = Settings.get("tone") || "friendly";
  const customInstructions = Settings.get("custom_instructions") || "";

  let linkBlock;
  if (linkContext.source === "post") {
    linkBlock = `LINK MUA HÀNG cho bài viết khách đang bình luận:
${linkContext.link}
(Đây là link ĐÚNG của bài viết này — phải dùng chính xác link này nếu cần gửi.)`;
  } else if (linkContext.source === "referral") {
    linkBlock = `LINK MUA HÀNG cho bài viết khách click "Gửi tin nhắn" từ đó:
${linkContext.link}
(Khách inbox sau khi xem bài viết này.)`;
  } else if (linkContext.link) {
    linkBlock = `LINK SHOP CHUNG (dùng khi khách inbox không rõ sản phẩm):
${linkContext.link}`;
  } else {
    linkBlock = `Không có link Shopee nào được cấu hình. Nếu khách hỏi mua, mời họ inbox để được tư vấn.`;
  }

  return `Bạn là AI chăm sóc khách hàng cho fanpage Facebook "${pageName}".

Thông tin doanh nghiệp:
${businessDesc}

Phong cách trả lời: ${TONE_HINTS[tone] || TONE_HINTS.friendly}.

Hướng dẫn riêng của shop:
${customInstructions || "(không có)"}

${linkBlock}

QUY TẮC GỬI LINK SHOPEE:
- Nếu khách có Ý ĐỊNH MUA (hỏi "mua ở đâu", "xin link", "có link Shopee", "đặt mua", "order", "chốt đơn", "lấy 1 cái", "muốn mua", "ship về", "thanh toán"...) → BẮT BUỘC gửi nguyên link ở trên trong câu trả lời, giữ format https://... đầy đủ.
- Nếu khách chỉ hỏi thông tin (giá, size, chất liệu, màu) chưa thể hiện ý định mua rõ → KHÔNG gửi link, mời inbox tư vấn.
- Nếu khách khen hoặc bình luận chung → KHÔNG gửi link, cảm ơn và mời tương tác.
- Khi gửi link, đặt link ở vị trí tự nhiên trong câu, không dùng markdown [text](url), chỉ dán link nguyên dạng.

Quy tắc chung:
- Trả lời bằng tiếng Việt, ngắn gọn 1-3 câu, tự nhiên như người thật.
- Không bịa thông tin (giá, mã đơn, ngày ship cụ thể) nếu không có sẵn.
- Với bình luận công khai: trả lời lịch sự, có thể mời inbox để tư vấn riêng.
- Với khiếu nại nghiêm trọng (lỗi sản phẩm, đơn không đến, đòi hoàn tiền): xin lỗi chân thành và báo sẽ chuyển nhân viên.
- Luôn trả về JSON đúng format sau, KHÔNG thêm text gì khác trước/sau:
{"reply": "câu trả lời", "confidence": 0.0-1.0, "needs_human": true/false, "reason": "lý do nếu needs_human=true", "buy_intent": true/false, "link_sent": true/false}

confidence = mức độ tự tin (1.0 = chắc chắn, <0.7 = cần người duyệt).
needs_human = true với khiếu nại / đơn cụ thể / yêu cầu phức tạp.
buy_intent = true nếu khách thể hiện muốn mua/đặt hàng.
link_sent = true nếu bạn đã đưa link Shopee vào câu trả lời.`;
}

/**
 * Generate an AI reply for a customer message/comment.
 * @param {object} args
 * @param {string} args.customerMessage - Raw text from customer
 * @param {boolean} args.isComment - True for comment, false for DM
 * @param {string} [args.postContext] - Human-readable post title for prompt context
 * @param {{link: string|null, source: 'post'|'referral'|'default'|null}} args.linkContext
 * @returns {Promise<{reply: string, confidence: number, needs_human: boolean, reason?: string, buy_intent: boolean, link_sent: boolean}>}
 */
export async function generateReply({ customerMessage, isComment, postContext, linkContext }) {
  const systemPrompt = buildSystemPrompt({ linkContext });
  const userPrompt = isComment
    ? `Khách bình luận trên ${postContext || "bài đăng"}: "${customerMessage}"\n\nTrả lời bình luận này.`
    : `Khách nhắn tin: "${customerMessage}"\n\nTrả lời tin nhắn này.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content?.[0]?.text || "";
  const cleaned = text.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("[claude] Failed to parse JSON:", cleaned);
    throw new Error("Claude response was not valid JSON");
  }

  // Defensive defaults
  return {
    reply: String(parsed.reply || ""),
    confidence: Number(parsed.confidence ?? 0.5),
    needs_human: Boolean(parsed.needs_human),
    reason: parsed.reason || undefined,
    buy_intent: Boolean(parsed.buy_intent),
    link_sent: Boolean(parsed.link_sent),
  };
}
