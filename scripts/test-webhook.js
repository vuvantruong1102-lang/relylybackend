/**
 * Simulate Facebook webhook events against your local server.
 *
 *   node scripts/test-webhook.js comment "Mua ở đâu shop?"
 *   node scripts/test-webhook.js message "Cho xin link shopee"
 *   node scripts/test-webhook.js post "Sản phẩm mới về https://shopee.vn/yourshop/abc"
 *
 * The script computes the correct HMAC signature using FB_APP_SECRET so
 * that your server accepts the request just like FB would.
 */
import "dotenv/config";
import crypto from "node:crypto";

const HOST = process.env.HOST || "http://localhost:3000";
const APP_SECRET = process.env.FB_APP_SECRET;
const PAGE_ID = process.env.FB_PAGE_ID;

if (!APP_SECRET || !PAGE_ID) {
  console.error("Missing FB_APP_SECRET or FB_PAGE_ID in .env");
  process.exit(1);
}

const [, , kind, ...rest] = process.argv;
const text = rest.join(" ") || "Mua ở đâu shop?";

function sign(body) {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

async function send(payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${HOST}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": sign(body),
    },
    body,
  });
  console.log(`→ ${res.status} ${await res.text()}`);
}

const FAKE_USER = { id: "user_test_001", name: "Khách Test" };
const FAKE_POST_ID = `${PAGE_ID}_post_test_001`;

const builders = {
  comment: () => ({
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: Date.now(),
      changes: [{
        field: "feed",
        value: {
          item: "comment",
          verb: "add",
          comment_id: `comment_${Date.now()}`,
          post_id: FAKE_POST_ID,
          message: text,
          from: FAKE_USER,
          created_time: Math.floor(Date.now() / 1000),
        },
      }],
    }],
  }),

  message: () => ({
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: Date.now(),
      messaging: [{
        sender: { id: FAKE_USER.id },
        recipient: { id: PAGE_ID },
        timestamp: Date.now(),
        message: {
          mid: `mid.${Date.now()}`,
          text,
        },
      }],
    }],
  }),

  post: () => ({
    object: "page",
    entry: [{
      id: PAGE_ID,
      time: Date.now(),
      changes: [{
        field: "feed",
        value: {
          item: "post",
          verb: "add",
          post_id: FAKE_POST_ID,
          message: text,
          published: 1,
          created_time: Math.floor(Date.now() / 1000),
        },
      }],
    }],
  }),
};

const builder = builders[kind];
if (!builder) {
  console.error(`Unknown kind: ${kind}. Use: comment | message | post`);
  process.exit(1);
}

console.log(`Sending ${kind}: "${text}"`);
await send(builder());
