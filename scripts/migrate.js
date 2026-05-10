// Chạy migration thủ công: node scripts/migrate.js
// Tự động chạy mỗi khi server start (qua initSchema), nhưng có script này để debug

import { initSchema, pool } from "../src/db.js";

(async () => {
  try {
    await initSchema();
    console.log("✓ Migration thành công");
  } catch (err) {
    console.error("✗ Migration thất bại:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
