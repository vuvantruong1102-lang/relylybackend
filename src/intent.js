// ═══════════════════════════════════════════════════════════════════
//   Intent Detection v2
//   - Phát hiện complaint với word boundary (chính xác cao)
//   - BỎ keywords gây false positive: "hư", "hỏng" đơn lẻ
//   - Giữ keywords đặc trưng + pattern phức tạp
// ═══════════════════════════════════════════════════════════════════

/**
 * Keywords báo hiệu khách HỎI/KHIẾU NẠI rõ ràng.
 *
 * IMPORTANT: KHÔNG dùng keyword 1-2 ký tự hoặc dễ là substring
 * của từ khác. Ví dụ:
 *   - "hư" match trong "như", "nhưng", "phương", "thư"
 *   - "to" match trong "tốt", "tôm"
 *   - "lỗi" match trong "lối", "khối" (nếu không có word boundary)
 *
 * Mỗi keyword phải là CỤM TỪ ĐẶC TRƯNG hoặc dùng word boundary.
 */
const COMPLAINT_KEYWORDS = [
  // Lỗi sản phẩm (cụm rõ ràng)
  "lỗi sản phẩm",
  "hàng lỗi",
  "bị lỗi",
  "hàng hỏng",
  "bị hỏng",
  "kém chất lượng",
  "không đúng hàng",
  "không đúng sản phẩm",

  // Phàn nàn chất lượng (cụm cảm thán)
  "tệ quá",
  "tệ thế",
  "tệ vậy",
  "quá tệ",
  "chán quá",
  "dở quá",
  "thất vọng",
  "không hài lòng",

  // Lừa đảo (cụm có ngữ cảnh)
  "lừa đảo",
  "lừa người",
  "bị lừa",
  "scam",
  "cảnh báo shop",
  "tố cáo shop",
  "shop lừa",

  // Hoàn trả / refund
  "trả hàng",
  "hoàn tiền",
  "hoàn trả",
  "refund",
  "đổi trả",
  "mất tiền",

  // Khiếu nại / phản ánh
  "khiếu nại",
  "phản ánh",
  "phàn nàn",
  "yêu cầu giải quyết",

  // Không nhận được hàng
  "không nhận được",
  "chưa nhận được",
  "không nhận hàng",
  "chưa nhận hàng",
  "không có hàng",
  "không thấy hàng",

  // Sai / thiếu hàng
  "thiếu hàng",
  "sai hàng",
  "giao sai",
  "giao thiếu",
  "giao nhầm",
  "nhận sai",
  "nhầm hàng",

  // Hàng bị hư hại
  "hàng rách",
  "hàng vỡ",
  "hàng móp",
  "hàng bể",
  "hàng nát",
  "hàng dơ",
  "hàng bẩn",
  "bị bẩn",
  "ố vàng",
  "ố bẩn",
  "rách rồi",
  "vỡ rồi",
  "móp rồi",
];

/**
 * Patterns: chi tiết hơn keyword đơn, cần cấu trúc câu rõ ràng.
 */
const COMPLAINT_PATTERNS = [
  // "đã đặt ... nhưng/mà không/chưa/sai/lỗi"
  /(?:đã|tôi|mình|em|tớ)\s+(?:đặt|mua|order)\s+.{1,80}?(?:nhưng|mà|nhung|ma)\s+.{0,50}?(?:không|chưa|sai|lỗi|hỏng|tệ|chán|dở)/i,

  // "không hài lòng về ..."
  /không\s+hài\s*lòng/i,

  // "rất tệ", "cực tệ", "vô cùng tệ"
  /(?:rất|cực|vô\s*cùng|hết\s*sức)\s+(?:tệ|chán|kém|dở|tồi)/i,
];

/**
 * Match keyword với word boundary
 * Cách 1: nếu keyword có chứa space (cụm từ) → dùng includes() OK
 *         vì cụm 2 từ ít khi match nhầm
 * Cách 2: nếu keyword là 1 từ → dùng regex \b để word boundary
 */
function matchKeyword(text, keyword) {
  const isMultiWord = keyword.includes(" ");

  if (isMultiWord) {
    // Cụm từ: dùng includes() đơn giản
    return text.toLowerCase().includes(keyword.toLowerCase());
  } else {
    // Từ đơn: dùng word boundary để tránh substring match
    // Escape special regex chars
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    return pattern.test(text);
  }
}

/**
 * Detect complaint trong message khách hàng
 * @param {string} text
 * @returns {boolean}
 */
export function detectComplaint(text) {
  if (!text || typeof text !== "string") return false;

  // Check keywords
  for (const kw of COMPLAINT_KEYWORDS) {
    if (matchKeyword(text, kw)) {
      return true;
    }
  }

  // Check patterns
  for (const re of COMPLAINT_PATTERNS) {
    if (re.test(text)) {
      return true;
    }
  }

  return false;
}

/**
 * Trả về keyword/pattern đã match (debug)
 * @param {string} text
 * @returns {string|null}
 */
export function getMatchedComplaintReason(text) {
  if (!text) return null;

  for (const kw of COMPLAINT_KEYWORDS) {
    if (matchKeyword(text, kw)) return `keyword:${kw}`;
  }

  for (let i = 0; i < COMPLAINT_PATTERNS.length; i++) {
    if (COMPLAINT_PATTERNS[i].test(text)) return `pattern:${i}`;
  }

  return null;
}

/**
 * Buy intent (giữ lại để dùng sau)
 */
export function detectBuyIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const buyKeywords = [
    "mua", "order", "đặt", "ship", "giao hàng",
    "ở đâu", "link", "giá", "bao nhiêu",
  ];
  return buyKeywords.some((kw) => lower.includes(kw));
}
