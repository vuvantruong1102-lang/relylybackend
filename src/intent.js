// Detect các tín hiệu khiếu nại trong message khách hàng
// Khi phát hiện -> không auto reply, đẩy lên cho nhân viên

const COMPLAINT_KEYWORDS = [
  "lỗi", "hỏng", "kém", "tệ", "chán", "lừa", "lừa đảo", "lừa người",
  "trả hàng", "hoàn tiền", "refund", "khiếu nại", "phản ánh",
  "không nhận được", "chưa nhận", "thiếu hàng", "sai hàng",
  "rách", "vỡ", "móp", "bể", "ố", "bẩn", "dơ",
  "cảnh báo", "tố cáo", "tố", "scam",
  "tệ quá", "dở quá", "mất tiền",
];

const COMPLAINT_PATTERNS = [
  /không\s+(?:được|hài\s*lòng|tốt|đúng|nhận)/i,
  /sao\s+(?:không|chưa)/i,
  /(?:đã|tôi)\s+(?:đặt|mua)\s+.+(?:nhưng|mà)/i,
];

export function detectComplaint(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  for (const kw of COMPLAINT_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  for (const re of COMPLAINT_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// Buy intent (giữ lại để dùng sau)
export function detectBuyIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const buyKeywords = ["mua", "order", "đặt", "ship", "giao hàng", "ở đâu", "link", "giá", "bao nhiêu"];
  return buyKeywords.some(kw => lower.includes(kw));
}
