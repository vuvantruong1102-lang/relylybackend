const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
// CORS - Cho phép Vercel gọi
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ===== CORS: Cho phép Vercel gọi Railway =====
app.use(cors({
  origin: '*', // Production: thay bằng URL Vercel của bạn, ví dụ 'https://your-app.vercel.app'
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// ===== ENV =====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.PAGE_ID || '982845451588840';

// ===== Lưu trữ tạm trong RAM =====
// Cấu trúc: { senderId: { userId, userName, userAvatar, messages: [...] } }
const conversations = {};

// ===== Helper: Lấy thông tin user từ Facebook =====
async function fetchUserProfile(senderId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v21.0/${senderId}`,
      {
        params: {
          fields: 'name,profile_pic',
          access_token: PAGE_ACCESS_TOKEN
        }
      }
    );
    return {
      name: res.data.name || `User ${senderId.slice(-4)}`,
      avatar: res.data.profile_pic || null
    };
  } catch (err) {
    console.log(`Cannot fetch profile for ${senderId}:`, err.response?.data?.error?.message);
    // Nếu app chưa có quyền, dùng tên mặc định
    return {
      name: `User ${senderId.slice(-4)}`,
      avatar: null
    };
  }
}

// ===== Helper: Thêm tin nhắn vào conversation =====
async function addMessage(senderId, message, isFromPage = false) {
  if (!conversations[senderId]) {
    const profile = await fetchUserProfile(senderId);
    conversations[senderId] = {
      userId: senderId,
      userName: profile.name,
      userAvatar: profile.avatar,
      messages: [],
      lastMessageAt: Date.now()
    };
  }
  
  conversations[senderId].messages.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: message,
    isFromPage,
    timestamp: Date.now()
  });
  
  conversations[senderId].lastMessageAt = Date.now();
}

// ===== 1. Webhook verification (GET) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== 2. Webhook nhận tin nhắn (POST) =====
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📨 Received:', JSON.stringify(body, null, 2));

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const event = entry.messaging?.[0];
      if (!event) continue;
      
      const senderId = event.sender.id;
      const messageText = event.message?.text;
      
      // Bỏ qua echo (tin nhắn page tự gửi)
      if (event.message?.is_echo) continue;
      
      // Bỏ qua nếu sender là chính page
      if (senderId === PAGE_ID) continue;

      if (messageText) {
        await addMessage(senderId, messageText, false);
        console.log(`💬 Saved message from ${senderId}: ${messageText}`);
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  }
  res.sendStatus(404);
});

// ===== 3. API: Lấy danh sách hội thoại =====
app.get('/api/conversations', (req, res) => {
  const list = Object.values(conversations)
    .map(c => ({
      userId: c.userId,
      userName: c.userName,
      userAvatar: c.userAvatar,
      lastMessage: c.messages[c.messages.length - 1]?.text || '',
      lastMessageAt: c.lastMessageAt,
      messageCount: c.messages.length
    }))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  
  res.json(list);
});

// ===== 4. API: Lấy tin nhắn của 1 hội thoại =====
app.get('/api/messages/:senderId', (req, res) => {
  const conv = conversations[req.params.senderId];
  if (!conv) return res.json({ userId: req.params.senderId, userName: 'Unknown', messages: [] });
  
  res.json({
    userId: conv.userId,
    userName: conv.userName,
    userAvatar: conv.userAvatar,
    messages: conv.messages
  });
});

// ===== 5. API: Gửi tin nhắn về Messenger =====
app.post('/api/send', async (req, res) => {
  const { recipientId, text } = req.body;
  
  if (!recipientId || !text) {
    return res.status(400).json({ error: 'Missing recipientId or text' });
  }

  try {
    // Gọi Facebook Send API
    const fbRes = await axios.post(
      `https://graph.facebook.com/v21.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE'
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN }
      }
    );

    // Lưu tin nhắn vào conversation
    await addMessage(recipientId, text, true);
    
    console.log(`📤 Sent to ${recipientId}: ${text}`);
    res.json({ success: true, messageId: fbRes.data.message_id });
  } catch (err) {
    console.error('❌ Send error:', err.response?.data || err.message);
    res.status(500).json({ 
      error: err.response?.data?.error?.message || err.message 
    });
  }
});

// ===== 6. Health check =====
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    conversationCount: Object.keys(conversations).length 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
