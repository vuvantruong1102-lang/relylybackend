// Detect cac tin hieu khieu nai trong message khach hang
// Khi phat hien -> khong auto reply, day len cho nhan vien

// Tu khoa khieu nai - moi tu phai du dac trung, KHONG dung tu 1 ky tu
// vi se match nham vao cac tu khac (vd "to" match "tot", "tom"...)
const COMPLAINT_KEYWORDS = [
  "lỗi sản phẩm", "hàng lỗi", "bị lỗi",
  "hỏng", "hư", "kém chất lượng",
  "tệ quá", "tệ thế", "tệ vậy", "quá tệ",
  "chán quá", "thất vọng",
  "lừa đảo", "lừa người", "bị lừa",
  "trả hàng", "hoàn tiền", "refund",
  "khiếu nại", "phản ánh", "phàn nàn",
  "không nhận được", "chưa nhận được", "không nhận hàng",
  "thiếu hàng", "sai hàng", "giao sai",
  "hàng rách", "hàng vỡ", "hàng móp", "hàng bể",
  "ố vàng", "ố bẩn", "bị bẩn", "hàng bẩn", "hàng dơ",
  "cảnh báo", "tố cáo", "scam",
  "dở quá", "mất tiền",
];

// Patterns: chi match khi co cau truc complaint ro rang
const COMPLAINT_PATTERNS = [
  /không\s+(?:hài\s*lòng|đúng\s*hàng|đúng\s*sản\s*phẩm)/i,
  /(?:đã|tôi)\s+(?:đặt|mua)\s+.+(?:nhưng|mà)\s+.*(?:không|chưa|sai|lỗi)/i,
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

// Buy intent (giu lai de dung sau)
export function detectBuyIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const buyKeywords = ["mua", "order", "đặt", "ship", "giao hàng", "ở đâu", "link", "giá", "bao nhiêu"];
  return buyKeywords.some(kw => lower.includes(kw));
}
