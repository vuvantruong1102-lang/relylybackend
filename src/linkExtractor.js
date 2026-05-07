// Shopee URL formats we want to capture:
//   https://shopee.vn/<anything>
//   https://s.shopee.vn/<short-code>           (short links from share)
//   https://shp.ee/<short-code>                (alternate short)
//   http variants of above
//
// We capture the first match — most posts contain one product/collection link.

const SHOPEE_URL_REGEX =
  /\bhttps?:\/\/(?:[\w-]+\.)?(?:shopee\.vn|shp\.ee)\/[^\s)<>"']+/gi;

export function extractShopeeLinks(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(SHOPEE_URL_REGEX) || [];
  // Strip trailing punctuation that often ends sentences
  return matches.map(url => url.replace(/[.,;:!?)\]]+$/, ""));
}

export function firstShopeeLink(text) {
  const links = extractShopeeLinks(text);
  return links[0] || null;
}
