// ═══════════════════════════════════════════════════════════════════
// THÊM ENDPOINT NÀY VÀO src/admin.js
//
// Vị trí: Thêm vào CUỐI file admin.js, TRƯỚC dòng `export default router;`
//        (hoặc dòng `app.use(...)` cuối cùng)
//
// Mục đích: Backfill tên khách cho tất cả conv đang là "Khách"
// ═══════════════════════════════════════════════════════════════════

// ─── IMPORT (thêm vào đầu file admin.js nếu chưa có) ───────────────
// import { backfillCustomerNames } from "./replyEngine.js";

// ─── ROUTE ──────────────────────────────────────────────────────────

/**
 * POST /admin/backfill-names
 * Body: { pageId?: string, limit?: number }
 *
 * Backfill tên khách cho tất cả conv (hoặc 1 page) đang là "Khách".
 * Process trong background, trả về kết quả ngay sau khi xong.
 *
 * Test:
 *   curl -X POST https://web-production-d5bd.up.railway.app/admin/backfill-names \
 *     -H "Authorization: Bearer YOUR_TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d '{"limit": 100}'
 */
router.post("/admin/backfill-names", requireAuth, async (req, res) => {
  try {
    const { pageId, limit = 200 } = req.body || {};

    // Chạy trong background để không timeout request
    // (limit lớn có thể mất vài phút do rate limit 200ms/call)
    const result = await backfillCustomerNames({ pageId, limit });

    res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("[admin] backfill-names failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});
