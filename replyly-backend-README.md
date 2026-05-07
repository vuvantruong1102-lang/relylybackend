# Replyly Backend

Node.js Express backend kết nối Facebook Page với AI Claude. Nhận webhook từ Facebook → sinh phản hồi bằng Claude → gửi reply qua Graph API → push real-time về frontend qua SSE.

## Cấu trúc

```
backend/
├── src/
│   ├── server.js          Express entry, mount routes, CORS, graceful shutdown
│   ├── config.js          Đọc & validate env vars
│   ├── db.js              SQLite schema + Posts/Conversations/Messages/Settings
│   ├── webhook.js         Facebook webhook (GET verify, POST events)
│   ├── facebook.js        Graph API client + HMAC signature verification
│   ├── claude.js          Anthropic SDK wrapper, build system prompt
│   ├── replyEngine.js     Brain: detect intent, resolve link, gen reply, send
│   ├── linkExtractor.js   Regex extract Shopee URLs
│   ├── intent.js          Buy intent + complaint detection
│   ├── admin.js           REST API + SSE endpoint cho dashboard
│   └── sse.js             Real-time push manager (Server-Sent Events)
├── scripts/
│   └── test-webhook.js    Simulate FB events local với HMAC đúng
├── package.json
├── .env.example           Template env vars
├── railway.toml           Railway deploy config
├── render.yaml            Render Blueprint
├── Procfile               Heroku-style fallback
└── .nvmrc                 Node version pin (20.18.0)
```

## Trước khi deploy

Chuẩn bị 6 thông tin:

| Biến | Lấy từ đâu |
|------|------------|
| `FB_APP_SECRET` | App Settings → Basic → "App Secret" → Show |
| `FB_VERIFY_TOKEN` | Tự tạo: `openssl rand -hex 16` |
| `FB_PAGE_ACCESS_TOKEN` | Graph API Explorer → Generate Page Access Token |
| `FB_PAGE_ID` | Page → About → Page ID |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → API Keys |
| `FRONTEND_URL` | URL Vercel của bạn (`https://facebot-xxx.vercel.app`) |

---

## Deploy lên Railway (đơn giản nhất)

### Bước 1: Đẩy backend này lên GitHub

```bash
cd backend
git init
git add .
git commit -m "init replyly backend"
git branch -M main
git remote add origin https://github.com/<bạn>/replyly-backend.git
git push -u origin main
```

### Bước 2: Tạo project trên Railway

1. https://railway.com/new → **Deploy from GitHub repo** → chọn repo
2. Railway tự nhận diện Node.js, đọc `railway.toml`, build & deploy lần đầu

Build có thể fail lần đầu vì chưa có env vars — bình thường, sang bước 3.

### Bước 3: Thêm Environment Variables

Trong service → tab **Variables** → bấm **+ New Variable** lần lượt:

```
FB_APP_SECRET             = <giá trị>
FB_VERIFY_TOKEN           = <giá trị>
FB_PAGE_ACCESS_TOKEN      = <giá trị>
FB_PAGE_ID                = <giá trị>
ANTHROPIC_API_KEY         = sk-ant-...
FRONTEND_URL              = https://facebot-xxx.vercel.app
NODE_ENV                  = production
DB_PATH                   = /app/data/replyly.db
```

Sau khi set xong, Railway tự deploy lại với env vars mới (~30 giây).

### Bước 4: Mount Volume cho SQLite

Database SQLite phải lưu vào persistent disk, nếu không mỗi lần deploy lại sẽ mất hết dữ liệu.

1. Service → tab **Settings** → cuộn xuống **Volumes**
2. Bấm **+ New Volume**
3. **Mount path**: `/app/data`
4. **Size**: 1 GB (đủ cho hàng chục ngàn conversation)
5. Bấm **Add** → service tự restart

### Bước 5: Generate Domain

1. Tab **Settings** → mục **Networking** → **Generate Domain**
2. Railway tạo URL kiểu `replyly-backend-production-xxxx.up.railway.app`
3. Copy URL này — cần để config webhook Facebook và frontend

### Bước 6: Test backend

```bash
curl https://replyly-backend-production-xxxx.up.railway.app/health
# {"ok":true,"ts":...}
```

---

## Deploy lên Render (alternative)

### Cách 1: Blueprint tự động

1. Push code lên GitHub
2. https://dashboard.render.com → **New** → **Blueprint**
3. Connect repo → Render đọc `render.yaml` → tự tạo service + disk
4. Vào service mới → tab **Environment** → điền các biến `sync: false`:
   `FB_APP_SECRET`, `FB_VERIFY_TOKEN`, `FB_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID`, `ANTHROPIC_API_KEY`, `FRONTEND_URL`
5. **Manual Deploy** → **Deploy latest commit**

URL có dạng `https://replyly-backend.onrender.com`

### Cách 2: Tạo Web Service thủ công

1. **New** → **Web Service** → connect GitHub repo
2. Build: `npm install --production=false`
3. Start: `npm start`
4. Health Check: `/health`
5. Add **Disk**: name `replyly-data`, mount path `/opt/render/project/src/data`, size 1 GB
6. Set env vars (`DB_PATH=/opt/render/project/src/data/replyly.db`)

⚠️ **Free tier Render** ngủ sau 15 phút không có request → cold start ~30 giây. Webhook Facebook timeout 20 giây nên sẽ miss event đầu tiên sau khi ngủ. Nếu chạy production thật, **đổi Starter $7/tháng** để luôn online.

Railway free tier có $5 credit/tháng cho phép service luôn online — phù hợp hơn cho test/demo.

---

## Sau khi backend đã chạy

### 1. Đăng ký Webhook Facebook

https://developers.facebook.com → App → **Webhooks** → **Page**:

- **Callback URL**: `https://<your-backend-url>/webhook`
- **Verify Token**: chuỗi GIỐNG HỆT `FB_VERIFY_TOKEN` trong env vars
- Bấm **Verify and Save**

### 2. Subscribe fields

Trong Webhooks page subscription, tick:
- `messages` — tin nhắn DM
- `messaging_postbacks` — click quick replies
- `feed` — comment + bài viết mới (cần thiết để index Shopee link)
- `messaging_referrals` — khi khách bấm "Send Message" từ post

### 3. Subscribe Page vào App

```bash
curl -X POST "https://graph.facebook.com/v21.0/$FB_PAGE_ID/subscribed_apps" \
  -d "subscribed_fields=messages,messaging_postbacks,feed,messaging_referrals" \
  -d "access_token=$FB_PAGE_ACCESS_TOKEN"
# {"success": true}
```

### 4. Cập nhật Frontend Vercel

Vercel project → **Settings → Environment Variables** → thêm:

```
VITE_BACKEND_URL = https://<your-backend-url>
```

(không có dấu `/` cuối). Redeploy frontend.

Sau đó dashboard sẽ:
- Fetch posts/conversations/settings từ backend
- Subscribe SSE → bài viết mới hiện real-time, không cần refresh

### 5. Test end-to-end

Đăng bài thật trên Facebook Page có link Shopee:

```
Áo thun mới về! Mua tại https://shopee.vn/yourshop/ao-thun
```

Trong vài giây:
- Backend log: `[engine] Indexed post ... with Shopee link: ...`
- Dashboard Vercel hiện bài viết mới ở tab "Bài viết & Link" — không cần refresh

Khi có khách comment "Mua ở đâu shop?":
- Backend log: AI generate + send reply
- Comment Facebook xuất hiện reply tự động kèm link Shopee đúng

---

## Troubleshooting

| Triệu chứng | Nguyên nhân | Cách sửa |
|-------------|-------------|----------|
| Build fail "node-gyp", "python" | better-sqlite3 cần native compile | Railway/Render có sẵn build tools — thử redeploy. Nếu fail, đổi sang Postgres |
| Webhook verification fail | `FB_VERIFY_TOKEN` không khớp | Check env var phải giống chính xác chuỗi gõ trong FB dashboard |
| "Invalid signature" mọi event | `FB_APP_SECRET` sai | Lấy lại từ App Settings → Basic → Show |
| Comment đến nhưng không reply | Page Access Token thiếu permission | Regenerate với đủ scope (xem mục Trước khi deploy) |
| SSE từ Vercel không kết nối | `FRONTEND_URL` chưa set hoặc CORS | Thêm Vercel URL vào `FRONTEND_URL` env var, restart |
| Service Render ngủ không nhận webhook | Free tier sleep | Upgrade Starter $7, hoặc dùng Railway |
| SQLite mất dữ liệu sau redeploy | Chưa mount volume | Add volume tại đúng path + set `DB_PATH` env var |
| Tin nhắn AI không gửi sau redeploy | Page Access Token hết hạn (60 ngày) | Regenerate long-lived token, update env var |

## Test local

```bash
npm install
cp .env.example .env
# điền các giá trị
npm run dev   # http://localhost:3000
```

Test webhook không cần Facebook:

```bash
node scripts/test-webhook.js post "Áo mới https://shopee.vn/yourshop/ao"
node scripts/test-webhook.js comment "Mua ở đâu shop?"
node scripts/test-webhook.js message "Cho xin link"
```

## License

MIT
