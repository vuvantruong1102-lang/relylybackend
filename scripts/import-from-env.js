// Migrate page hiện tại từ env vars (FB_PAGE_*) vào DB
// Chạy sau khi deploy v2: node scripts/import-from-env.js
// Sau đó có thể xóa các env FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, FB_VERIFY_TOKEN

import "dotenv/config";
import { initSchema, pool } from "../src/db.js";
import * as Pages from "../src/pages.js";

(async () => {
  const facebookPageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const displayName = process.env.LEGACY_PAGE_NAME || "Yokool B2B";

  if (!facebookPageId || !accessToken) {
    console.error("✗ Missing FB_PAGE_ID hoặc FB_PAGE_ACCESS_TOKEN trong env");
    process.exit(1);
  }

  try {
    await initSchema();

    console.log(`→ Importing page ${displayName} (${facebookPageId})...`);

    const existing = await Pages.getPageByFacebookId(facebookPageId);
    if (existing) {
      console.log(`✓ Page đã tồn tại trong DB (ID ${existing.id}), skip.`);
      console.log("  Nếu muốn update token, dùng API PATCH /api/pages/:id");
      return;
    }

    const page = await Pages.createPage({
      displayName,
      facebookPageId,
      accessToken,
      defaultShopeeLink: process.env.DEFAULT_SHOPEE_LINK || null,
    });

    console.log(`✓ Imported page thành công:`);
    console.log(`  - ID nội bộ: ${page.id}`);
    console.log(`  - Page Facebook ID: ${page.facebook_page_id}`);
    console.log(`  - Display name: ${page.display_name}`);
    console.log(`  - Status: ${page.status}`);
    if (page.days_until_expiry !== null) {
      console.log(`  - Token còn ${page.days_until_expiry} ngày`);
    }
    console.log("");
    console.log("⚠️  Bước tiếp theo:");
    console.log("  1. Test webhook + auto-reply hoạt động bình thường");
    console.log("  2. Sau khi confirm OK, vào Railway xóa các env:");
    console.log("     - FB_PAGE_ACCESS_TOKEN");
    console.log("     - FB_PAGE_ID");
    console.log("     - FB_VERIFY_TOKEN");
  } catch (err) {
    console.error("✗ Import failed:", err.message);
    if (err.facebookError) {
      console.error("  Facebook error:", err.facebookError);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
