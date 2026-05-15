import { query } from "./db.js";
import { encrypt, decrypt, generateVerifyToken } from "./crypto.js";
import { config, graphApiUrl } from "./config.js";

// ---- Validate token bằng cách gọi Graph API ------------------------------

/**
 * Verify Page Access Token bằng cách gọi /me endpoint của Graph API
 * Trả về thông tin page nếu token hợp lệ, throw error nếu không
 */
export async function validatePageToken(pageAccessToken, expectedPageId = null) {
  const url = new URL(graphApiUrl(`/me`));
  url.searchParams.set("access_token", pageAccessToken);
  url.searchParams.set("fields", "id,name,category");

  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok || json.error) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Token không hợp lệ: ${msg}`);
    err.facebookError = json.error;
    throw err;
  }

  if (expectedPageId && json.id !== expectedPageId) {
    throw new Error(`Page ID không khớp. Token này thuộc về page ${json.id}, không phải ${expectedPageId}`);
  }

  // Lấy thêm token expiry info
  let expiresAt = null;
  try {
    const debugUrl = new URL(graphApiUrl(`/debug_token`));
    debugUrl.searchParams.set("input_token", pageAccessToken);
    debugUrl.searchParams.set("access_token", `${config.facebook.appId}|${config.facebook.appSecret}`);
    const debugRes = await fetch(debugUrl);
    const debugJson = await debugRes.json();
    if (debugJson.data?.expires_at) {
      expiresAt = debugJson.data.expires_at * 1000; // sec → ms
    } else if (debugJson.data?.data_access_expires_at) {
      expiresAt = debugJson.data.data_access_expires_at * 1000;
    }
  } catch (err) {
    console.warn("[pages] Could not fetch token expiry:", err.message);
  }

  return {
    pageId: json.id,
    pageName: json.name,
    category: json.category,
    expiresAt,
  };
}

// ---- Subscribe page vào webhook ------------------------------------------

export async function subscribePageToWebhook(pageAccessToken, pageId) {
  const url = new URL(graphApiUrl(`/${pageId}/subscribed_apps`));
  url.searchParams.set("access_token", pageAccessToken);
  url.searchParams.set("subscribed_fields", "messages,messaging_postbacks,feed,messaging_referrals");

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();

  if (!res.ok || !json.success) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(`Subscribe webhook thất bại: ${msg}`);
  }

  return true;
}

// ---- CRUD ----------------------------------------------------------------

/**
 * Tạo page mới: validate token, encrypt, lưu DB, subscribe webhook
 */
export async function createPage({ displayName, facebookPageId, accessToken, defaultShopeeLink }) {
  if (!displayName || !facebookPageId || !accessToken) {
    throw new Error("displayName, facebookPageId và accessToken là bắt buộc");
  }

  // Validate token
  const tokenInfo = await validatePageToken(accessToken, facebookPageId);

  // Encrypt
  const encToken = encrypt(accessToken);
  const verifyToken = generateVerifyToken();
  const now = Date.now();

  const result = await query(
    `INSERT INTO pages
      (facebook_page_id, display_name, access_token_enc, verify_token, default_shopee_link,
       status, token_expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7)
     ON CONFLICT (facebook_page_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       access_token_enc = EXCLUDED.access_token_enc,
       default_shopee_link = EXCLUDED.default_shopee_link,
       status = 'active',
       token_expires_at = EXCLUDED.token_expires_at,
       last_error = NULL,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [facebookPageId, displayName, encToken, verifyToken, defaultShopeeLink || null, tokenInfo.expiresAt, now]
  );

  const page = result.rows[0];

  // Subscribe webhook (best-effort, không fail cả flow nếu lỗi)
  try {
    await subscribePageToWebhook(accessToken, facebookPageId);
    console.log(`[pages] Subscribed webhook for page ${facebookPageId}`);
  } catch (err) {
    console.error(`[pages] Failed to subscribe webhook: ${err.message}`);
    await query(`UPDATE pages SET last_error = $1 WHERE id = $2`, [err.message, page.id]);
  }

  return sanitizePage(page);
}

export async function listPages() {
  const result = await query(`SELECT * FROM pages ORDER BY created_at ASC`);
  return result.rows.map(sanitizePage);
}

export async function getPageById(id) {
  const result = await query(`SELECT * FROM pages WHERE id = $1`, [id]);
  return result.rows[0] ? sanitizePage(result.rows[0]) : null;
}

export async function getPageByFacebookId(facebookPageId) {
  const result = await query(`SELECT * FROM pages WHERE facebook_page_id = $1`, [facebookPageId]);
  return result.rows[0] || null;
}

/**
 * Lấy decrypted access token của page (DÙNG NỘI BỘ, không expose ra API)
 */
export async function getPageAccessToken(facebookPageId) {
  const row = await getPageByFacebookId(facebookPageId);
  if (!row) return null;
  return decrypt(row.access_token_enc);
}

export async function updatePage(id, fields) {
  const allowed = ["display_name", "default_shopee_link", "status"];
  const sets = [];
  const params = [];
  let idx = 1;

  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${idx++}`);
      params.push(fields[k]);
    }
  }

  // Support cả camelCase từ frontend (displayName, defaultShopeeLink)
  if (fields.displayName !== undefined && fields.display_name === undefined) {
    sets.push(`display_name = $${idx++}`);
    params.push(fields.displayName);
  }
  if (fields.defaultShopeeLink !== undefined && fields.default_shopee_link === undefined) {
    sets.push(`default_shopee_link = $${idx++}`);
    params.push(fields.defaultShopeeLink);
  }

  // Special handling cho update token
  let newAccessToken = null;
  let newFacebookPageId = null;
  if (fields.accessToken) {
    // Lấy page hiện tại để biết facebook_page_id để validate
    const currentResult = await query(`SELECT facebook_page_id FROM pages WHERE id = $1`, [id]);
    if (!currentResult.rows[0]) return null;
    newFacebookPageId = currentResult.rows[0].facebook_page_id;

    const tokenInfo = await validatePageToken(fields.accessToken, newFacebookPageId);
    sets.push(`access_token_enc = $${idx++}`);
    params.push(encrypt(fields.accessToken));
    sets.push(`token_expires_at = $${idx++}`);
    params.push(tokenInfo.expiresAt);
    sets.push(`status = 'active'`);
    sets.push(`last_error = NULL`);
    newAccessToken = fields.accessToken;
  }

  if (sets.length === 0) return getPageById(id);

  sets.push(`updated_at = $${idx++}`);
  params.push(Date.now());
  params.push(id);

  const result = await query(
    `UPDATE pages SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );

  const updated = result.rows[0] ? sanitizePage(result.rows[0]) : null;

  // Nếu vừa update token, tự động re-subscribe webhook
  if (newAccessToken && newFacebookPageId && updated) {
    try {
      await subscribePageToWebhook(newAccessToken, newFacebookPageId);
      console.log(`[pages] Re-subscribed webhook for page ${newFacebookPageId} after token update`);
    } catch (err) {
      console.error(`[pages] Failed to re-subscribe webhook after token update: ${err.message}`);
      await query(`UPDATE pages SET last_error = $1 WHERE id = $2`, [err.message, id]);
    }
  }

  return updated;
}

export async function deletePage(id) {
  const page = await getPageById(id);
  if (!page) return null;

  // Cleanup data của page (posts, conversations, messages cascade)
  await query(`DELETE FROM conversations WHERE page_id = $1`, [page.facebook_page_id]);
  await query(`DELETE FROM posts WHERE page_id = $1`, [page.facebook_page_id]);
  await query(`DELETE FROM settings WHERE page_id = $1`, [page.facebook_page_id]);
  await query(`DELETE FROM pages WHERE id = $1`, [id]);

  return page;
}

// ---- Helper: Sanitize page (loại bỏ encrypted token khỏi response) -------
// Giữ verify_token để dashboard hiển thị (dashboard đã có auth bảo vệ)

function sanitizePage(row) {
  if (!row) return null;
  const { access_token_enc, ...safe } = row;
  return {
    ...safe,
    has_token: !!access_token_enc,
    days_until_expiry: row.token_expires_at
      ? Math.max(0, Math.floor((row.token_expires_at - Date.now()) / (1000 * 60 * 60 * 24)))
      : null,
  };
}

// ---- Test gửi tin nhắn (debug) -------------------------------------------

export async function testSendMessage({ facebookPageId, recipientPsid, text }) {
  const accessToken = await getPageAccessToken(facebookPageId);
  if (!accessToken) throw new Error("Page không tồn tại trong DB");

  const url = new URL(graphApiUrl(`/${facebookPageId}/messages`));
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      messaging_type: "RESPONSE",
      message: { text },
    }),
  });

  const json = await res.json();
  return {
    ok: res.ok,
    status: res.status,
    response: json,
  };
}
