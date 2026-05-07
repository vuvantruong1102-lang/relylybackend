// Fast client-side intent classifier. The AI does its own detection too
// (and is more accurate on edge cases), but this lets us:
//   1. Pre-flag conversations in the dashboard
//   2. Skip expensive AI calls when we're highly confident (optional)
//   3. Decide whether to inject the link context into the prompt at all

const BUY_INTENT_PATTERNS = [
  /mua\s*(ở|o)?\s*(đâu|dau)/i,
  /\blink\b/i,
  /\bshopee\b/i,
  /đặt\s*(mua|hàng|đơn)/i,
  /\border\b/i,
  /chốt\s*đơn/i,
  /lấy\s*(1|một|2|3|hàng)/i,
  /mua\s*(luôn|ngay|này|nha)/i,
  /muốn\s*mua/i,
  /ship\s*(về|cho|tới|đến)/i,
  /thanh\s*toán/i,
  /cho\s*xin\s*link/i,
  /gửi\s*link/i,
  /\bcheckout\b/i,
];

const COMPLAINT_PATTERNS = [
  /lỗi/i,
  /hỏng/i,
  /không\s*(nhận|có|đúng|được)/i,
  /chưa\s*nhận/i,
  /trả\s*hàng/i,
  /hoàn\s*tiền/i,
  /khiếu\s*nại/i,
  /đơn\s*hàng.*#?\s*\d+/i,
  /mã\s*đơn/i,
  /tệ\s*quá/i,
  /thất\s*vọng/i,
];

export function detectBuyIntent(text) {
  if (!text) return false;
  return BUY_INTENT_PATTERNS.some(p => p.test(text));
}

export function detectComplaint(text) {
  if (!text) return false;
  return COMPLAINT_PATTERNS.some(p => p.test(text));
}
