# Replyly Backend v2.0 - Multi-Page

Node.js Express backend hỗ trợ nhiều Facebook Page cùng lúc, với encryption cho access token và Postgres làm DB.

## Thay đổi so với v1.0

| | v1.0 | v2.0 |
|---|---|---|
| Số page hỗ trợ | 1 (qua env) | Nhiều (qua DB) |
| Database | SQLite | Postgres |
| Token storage | Env vars | DB encrypted (AES-256-GCM) |
| Auth | Không có | Mật khẩu chung qua header |
| Import nhiều page | Không | Excel upload |
| Test debug | Không | Endpoint test send |

## Cấu trúc

```
backend/
├── src/
│   ├── server.js           Entry point
│   ├── config.js           Env vars (đã đổi)
│   ├── crypto.js           AES-256-GCM encryption
│   ├── db.js               Postgres pool + schema migration
│   ├── store.js            Posts, Conversations, Messages, Settings
│   ├── pages.js            CRUD pages + validate token
│   ├── facebook.js         Graph API (nhận token theo param)
│   ├── webhook.js          Webhook handler (multi-page)
│   ├── replyEngine.js      Logic auto-reply (nhận pageId)
│   ├── admin.js            REST API endpoints
│   ├── auth.js             Password middleware
│   ├── sse.js              Real-time SSE
│   ├── linkExtractor.js    Regex Shopee URL
│   └── intent.js           Detect khiếu nại
├── scripts/
│   ├── migrate.js                  Init/update schema
│   ├── import-from-env.js          Migrate page hiện tại từ env vào DB
│   ├── create-template-xlsx.js     Tạo file Excel template
│   ├── pages-template.xlsx         File mẫu để import
│   └── test-webhook.js             Test webhook local
├── package.json
├── .env.example
├── railway.toml
└── README.md
```

## Quy trình deploy lên Railway

### Giai đoạn 1: Chuẩn bị

1. **Backup DB cũ** (nếu cần) - SQLite file ở Railway volume cũ
2. **Add Postgres plugin** trong project: New → Database → PostgreSQL
3. **Sinh ENCRYPTION_KEY**: `openssl rand -hex 32` (lưu vào password manager)

### Giai đoạn 2: Set env vars (giữ song song env cũ + mới)

Trong Railway → service backend → Variables:

```
# Mới
FB_APP_ID=<App ID Facebook của bạn>
ENCRYPTION_KEY=<64 hex chars từ openssl rand>
DATABASE_URL=${{Postgres.DATABASE_URL}}    # Reference, không paste string
DASHBOARD_PASSWORD=<mật khẩu mạnh, đổi thường xuyên>
FRONTEND_URL=https://messenger-frontend-eight-rho.vercel.app

# Giữ nguyên
FB_APP_SECRET=<như cũ>
FB_GRAPH_VERSION=v21.0
ANTHROPIC_API_KEY=<như cũ>
NODE_ENV=production
PORT=3000

# TẠM GIỮ (sẽ xóa sau khi migration thành công)
FB_PAGE_ACCESS_TOKEN=<như cũ>
FB_PAGE_ID=<như cũ>
FB_VERIFY_TOKEN=<như cũ>
LEGACY_PAGE_NAME=Yokool B2B
```

### Giai đoạn 3: Deploy code v2

1. Push code v2 lên GitHub: `git push origin main`
2. Railway auto-deploy (hoặc bấm Deploy)
3. Theo dõi log:
   - `[db] Schema ready.` → Postgres tables đã tạo
   - `[server] Replyly backend listening on :3000` → server ready

### Giai đoạn 4: Migrate page hiện tại

Một lần duy nhất, chạy script import từ env vào DB:

```
# Cách 1: Railway CLI
railway run npm run import-from-env

# Cách 2: Mở terminal trong service Railway → Logs → "Run command"
npm run import-from-env
```

Output mong đợi:
```
→ Importing page Yokool B2B (...)...
✓ Imported page thành công:
  - ID nội bộ: 1
  - Page Facebook ID: ...
  - Status: active
  - Token còn 47 ngày
```

### Giai đoạn 5: Đăng ký lại Webhook (vì verify_token đã đổi)

Mỗi page giờ có verify_token random riêng. Xem token mới:

```
# Lấy verify_token của page vừa import (yêu cầu auth header)
curl -H "X-Auth-Password: <DASHBOARD_PASSWORD>" \
     https://<your-backend>.up.railway.app/api/pages
```

Trong response, tìm `verify_token` của page → vào Facebook Developer Console → Webhooks → Edit Subscription → cập nhật:
- Callback URL: `https://<your-backend>.up.railway.app/webhook` (giữ nguyên)
- **Verify Token**: chuỗi mới từ DB (KHÁC với `FB_VERIFY_TOKEN` cũ)
- Subscribe các fields: `messages, messaging_postbacks, feed, messaging_referrals`

⚠️ **Lưu ý:** v2.0 cho phép mỗi page 1 verify_token riêng (do code tự gen lúc thêm page). Cách này phù hợp khi nhiều page chia sẻ 1 webhook URL.

### Giai đoạn 6: Test end-to-end

1. Comment vào page test → check log Railway → conversation tạo trong DB
2. Test send DM:
```
curl -X POST https://<backend>/api/pages/1/test-send \
  -H "X-Auth-Password: <password>" \
  -H "Content-Type: application/json" \
  -d '{"recipientPsid": "<PSID khách đã từng nhắn>", "text": "Test"}'
```

### Giai đoạn 7: Cleanup env vars cũ

Sau khi confirm tất cả OK (>= 24 giờ chạy ổn), xóa:
- `FB_PAGE_ACCESS_TOKEN`
- `FB_PAGE_ID`
- `FB_VERIFY_TOKEN`
- `LEGACY_PAGE_NAME`

## API Endpoints

Tất cả endpoint dưới `/api/*` (trừ `/api/auth/login`) đều yêu cầu header:
```
X-Auth-Password: <DASHBOARD_PASSWORD>
```

### Authentication

| Method | Path | Body | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | `{password}` | Verify password, lưu vào localStorage |

### Pages

| Method | Path | Body | Mô tả |
|---|---|---|---|
| GET | `/api/pages` | - | List tất cả page |
| POST | `/api/pages` | `{displayName, facebookPageId, accessToken, defaultShopeeLink?}` | Thêm page mới (validate token + auto subscribe) |
| PATCH | `/api/pages/:id` | `{display_name?, default_shopee_link?, accessToken?, status?}` | Update page |
| DELETE | `/api/pages/:id` | - | Xóa page và toàn bộ data liên quan |
| POST | `/api/pages/:id/test-send` | `{recipientPsid, text}` | Test gửi DM debug |
| POST | `/api/pages/import-excel` | `multipart/form-data: file` | Import nhiều page từ Excel |

### Conversations & Posts

| Method | Path | Query | Mô tả |
|---|---|---|---|
| GET | `/api/conversations` | `pageId, status, type, limit` | List conversations (filter theo page) |
| GET | `/api/conversations/:id` | - | Detail + messages |
| POST | `/api/conversations/:id/approve` | - | Approve AI draft, gửi luôn |
| POST | `/api/conversations/:id/reply` | `{text}` | Gửi reply manual |
| POST | `/api/conversations/:id/regenerate` | - | Generate lại reply |
| GET | `/api/posts` | `pageId` | List posts của page |

### Settings (per-page)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/settings/:pageId` | Lấy settings của page |
| PATCH | `/api/settings/:pageId` | Update settings (page_name, business_desc, tone, etc.) |

### Real-time

| Method | Path | Query | Mô tả |
|---|---|---|---|
| GET | `/api/events` | `pageId?, auth=<password>` | SSE stream new conversations/posts |

## Format file Excel cho import

| display_name | page_id | page_access_token | default_shopee_link |
|---|---|---|---|
| Shop Áo Nam | 123456789012345 | EAAxxx... | https://shopee.vn/shop1 |
| Mỹ Phẩm Nature | 987654321098765 | EAAyyy... | (để trống) |

- File `.xlsx`, `.xls`, `.csv` đều được
- Tối đa 50 page mỗi lần
- Tối đa 5MB
- 4 cột bắt buộc theo thứ tự trên (cột `default_shopee_link` có thể bỏ trống)

Tải file mẫu: `scripts/pages-template.xlsx`

## Test local

```bash
npm install
cp .env.example .env
# Điền các giá trị, đặc biệt DATABASE_URL local

npm run migrate    # Init schema
npm run dev        # Server dev mode

# Trong terminal khác:
node scripts/test-webhook.js comment "Mua ở đâu?"
```

## Troubleshooting

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| "ENCRYPTION_KEY must be 64 hex characters" | Key sai format | Generate lại: `openssl rand -hex 32` |
| "DATABASE_URL: required" | Chưa add Postgres plugin | Railway → New → PostgreSQL → reference biến |
| Webhook trả 403 | Verify token không khớp | Check token của page trong DB qua `GET /api/pages` |
| "Token không hợp lệ" khi thêm page | Page Access Token sai/hết hạn | Generate token mới ở Graph API Explorer |
| "Subscribe webhook thất bại" | Quyền `pages_manage_metadata` chưa duyệt | Check App Review status |
| App ID/Secret sai | Token validation fail ở `debug_token` | Check FB_APP_ID + FB_APP_SECRET đúng app |
| Migrate script lỗi "Page đã tồn tại" | Đã chạy import trước đó | OK, skip safe |

## Bảo mật

- **ENCRYPTION_KEY**: lưu trong password manager. Lộ key = lộ tất cả token.
- **DASHBOARD_PASSWORD**: đổi định kỳ. Trong production nên chuyển sang JWT/session.
- **File Excel chứa token**: xóa khỏi máy local + cloud storage sau khi upload.
- **Logs**: check Railway logs không leak token (đã sanitize trong response).
