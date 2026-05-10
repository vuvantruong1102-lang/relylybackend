// Test webhook local mà không cần Facebook gọi thật
// Cách dùng:
//   node scripts/test-webhook.js post "Áo mới https://shopee.vn/yourshop/ao"
//   node scripts/test-webhook.js comment "Mua ở đâu shop?"
//   node scripts/test-webhook.js message "Cho xin link"
//
// Yêu cầu: server đang chạy local, FB_PAGE_ID env var đã set (page mặc định để test)

import "dotenv/config";
import crypto from "node:crypto";

const APP_SECRET = process.env.FB_APP_SECRET;
const PAGE_ID = process.env.FB_PAGE_ID || process.env.TEST_PAGE_ID;
const URL = process.env.WEBHOOK_URL || "http://localhost:3000/webhook";

if (!APP_SECRET || !PAGE_ID) {
  console.error("Cần set FB_APP_SECRET và FB_PAGE_ID (hoặc TEST_PAGE_ID) trong env");
  process.exit(1);
}

const [, , type, message] = process.argv;
if (!type || !message) {
  console.error("Usage: node scripts/test-webhook.js <post|comment|message> <text>");
  process.exit(1);
}

let body;
const now = Math.floor(Date.now() / 1000);
const fakeUserId = "1234567890123456";

if (type === "post") {
  body = {
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: now,
      changes: [{
        field: "feed",
        value: {
          item: "post",
          post_id: `${PAGE_ID}_${now}`,
          message,
          verb: "add",
          created_time: now,
        },
      }],
    }],
  };
} else if (type === "comment") {
  body = {
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: now,
      changes: [{
        field: "feed",
        value: {
          item: "comment",
          comment_id: `comment_${now}`,
          post_id: process.env.TEST_POST_ID || `${PAGE_ID}_test`,
          message,
          from: { id: fakeUserId, name: "Test User" },
          verb: "add",
        },
      }],
    }],
  };
} else if (type === "message") {
  body = {
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: now,
      messaging: [{
        sender: { id: fakeUserId },
        recipient: { id: PAGE_ID },
        timestamp: now * 1000,
        message: { mid: `mid_${now}`, text: message },
      }],
    }],
  };
} else {
  console.error("type phải là post, comment, hoặc message");
  process.exit(1);
}

const rawBody = JSON.stringify(body);
const signature = "sha256=" + crypto
  .createHmac("sha256", APP_SECRET)
  .update(rawBody)
  .digest("hex");

const res = await fetch(URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": signature,
  },
  body: rawBody,
});

console.log(`Status: ${res.status}`);
console.log(`Body: ${await res.text()}`);
