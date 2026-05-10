// Regex extract Shopee URLs (shopee.vn, shopee.com.vn, s.shopee.vn short links)
// Hỗ trợ cả URL đầy đủ và rút gọn

const SHOPEE_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?shopee\.(?:vn|com\.vn|com|sg|co\.id|com\.my|com\.ph|tw)[^\s)]*/gi;

/**
 * Lấy tất cả Shopee link trong text
 */
export function extractShopeeLinks(text) {
  if (!text) return [];
  const matches = text.match(SHOPEE_REGEX) || [];
  return [...new Set(matches)]; // dedupe
}

/**
 * Lấy link Shopee đầu tiên (hoặc null nếu không có)
 */
export function firstShopeeLink(text) {
  const links = extractShopeeLinks(text);
  return links[0] || null;
}
