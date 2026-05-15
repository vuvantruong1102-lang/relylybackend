// ═══════════════════════════════════════════════════════════════════
//   Keyword Matcher v3 - 2 nhóm template
//
//   NHÓM A - Hỏi giá: gia, bao nhieu, bn, nhieu tien
//   → Template: "Anh chị click vào link Shopee để xem giá nhé: {link}"
//
//   NHÓM B - Hỏi mua / hỗ trợ: mua, link, đặt, ship, cod, ...
//   → Template: "Anh chị click vào link Shopee này để mua hàng nhé: {link}"
// ═══════════════════════════════════════════════════════════════════

/**
 * Bỏ dấu tiếng Việt + chuyển lowercase
 */
export function removeAccents(text) {
  if (!text) return "";
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/**
 * NHÓM A - PRICE INQUIRY (hỏi giá)
 * Khi match → gửi template "xem giá"
 */
const PRICE_KEYWORDS = [
  "gia",          // giá, gía, gia
  "bao nhieu",    // bao nhiêu
  "bn",           // viết tắt "bao nhiêu"
  "nhieu tien",   // nhiêu tiền
];

/**
 * NHÓM B - PURCHASE INTENT (hỏi mua / nơi mua / hỗ trợ)
 * Khi match → gửi template "mua hàng"
 */
const PURCHASE_KEYWORDS = [
  // Mua hàng / nơi mua
  "mua",
  "o dau",
  "link",
  "dat",          // đặt
  "ban",          // bán
  "dat hang",     // đặt hàng
  "order",

  // Hỗ trợ / inbox
  "tu van",       // tư vấn
  "ib",
  "inbox",
  "nhan tin",     // nhắn tin

  // Logistics
  "ship",
  "cod",
  "si",           // sỉ
];

/**
 * Match keyword với word boundary
 */
function matchAny(text, keywords) {
  if (!text) return null;
  const normalized = removeAccents(text);
  if (!normalized) return null;

  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(normalized)) {
      return kw;
    }
  }
  return null;
}

/**
 * Phân loại intent của message vào 1 trong 3 trạng thái:
 *   - "price"     : hỏi giá → template PRICE
 *   - "purchase"  : hỏi mua → template PURCHASE
 *   - null        : không match → gọi AI
 *
 * Ưu tiên: PRICE > PURCHASE (vì "giá" có ý cụ thể hơn)
 *
 * @param {string} text
 * @returns {"price" | "purchase" | null}
 */
export function classifyIntent(text) {
  if (!text || typeof text !== "string") return null;

  // Ưu tiên price keywords trước
  if (matchAny(text, PRICE_KEYWORDS)) return "price";

  // Sau đó purchase keywords
  if (matchAny(text, PURCHASE_KEYWORDS)) return "purchase";

  return null;
}

/**
 * Trả về keyword đã match (để debug/log)
 * @param {string} text
 * @returns {{ intent: string, keyword: string } | null}
 */
export function getMatchedKeyword(text) {
  if (!text) return null;

  const priceKw = matchAny(text, PRICE_KEYWORDS);
  if (priceKw) return { intent: "price", keyword: priceKw };

  const purchaseKw = matchAny(text, PURCHASE_KEYWORDS);
  if (purchaseKw) return { intent: "purchase", keyword: purchaseKw };

  return null;
}

/**
 * Template "Xem giá" - khi match PRICE keyword
 * @param {string} link
 * @returns {string}
 */
export function getPriceReplyTemplate(link) {
  return `Anh chị click vào link Shopee để xem giá nhé: ${link}`;
}

/**
 * Template "Mua hàng" - khi match PURCHASE keyword
 * @param {string} link
 * @returns {string}
 */
export function getPurchaseReplyTemplate(link) {
  return `Anh chị click vào link Shopee này để mua hàng nhé: ${link}`;
}

/**
 * Helper: lấy template tương ứng với intent
 * @param {"price" | "purchase"} intent
 * @param {string} link
 * @returns {string}
 */
export function getReplyTemplate(intent, link) {
  if (intent === "price") return getPriceReplyTemplate(link);
  if (intent === "purchase") return getPurchaseReplyTemplate(link);
  return getPurchaseReplyTemplate(link); // fallback
}

// ─── Backward compat ─────────────────────────────────────────────
// Giữ API cũ để các nơi khác không break

/**
 * @deprecated Use classifyIntent() instead
 */
export function matchesPurchaseKeyword(text) {
  return classifyIntent(text) !== null;
}

/**
 * @deprecated Use getReplyTemplate() instead
 */
export function getKeywordReplyTemplate(link) {
  return getPurchaseReplyTemplate(link);
}

// Export keywords list (inspect/test)
export const KEYWORDS = {
  price: PRICE_KEYWORDS,
  purchase: PURCHASE_KEYWORDS,
};
