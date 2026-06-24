// server.js
// ระบบแจ้งเตือนไฟเปิดทิ้งไว้ในห้อง + ส่งข้อความแจ้งลูกค้าผ่าน LINE Official Account
// ข้อมูลเก็บใน MongoDB Atlas (ฟรี ไม่หมดอายุ) เพื่อให้ข้อมูลไม่หายตอน deploy ใหม่บนโฮสติ้งฟรีที่ไม่มี persistent disk เช่น Render
require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const SENSOR_API_KEY = process.env.SENSOR_API_KEY || 'changeme123';
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ไม่พบ MONGODB_URI ใน environment variables — ดูวิธีตั้งค่าใน README.md หัวข้อ "ตั้งค่าฐานข้อมูล (MongoDB Atlas)"');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ค่าเริ่มต้นของระบบ (ใช้ตอนยังไม่มีข้อมูลใด ๆ ในฐานข้อมูล) ----------
const DEFAULT_STATE = {
  settings: {
    lineChannelAccessToken: '',
    liffId: '',
    thresholdMinutes: 30,
    renotifyMinutes: 30,
  },
  rooms: [],
  registrations: [],
  notificationLog: [],
};

// ---------- การเชื่อมต่อ MongoDB ----------
const mongoClient = new MongoClient(MONGODB_URI);
let stateCollection;

async function connectDB() {
  await mongoClient.connect();
  const db = mongoClient.db('lightnoti'); // ใช้ฐานข้อมูลชื่อ lightnoti (สร้างอัตโนมัติถ้ายังไม่มี)
  stateCollection = db.collection('app_state');
  console.log('เชื่อมต่อ MongoDB สำเร็จ');
}

// ทั้งระบบเก็บข้อมูลทั้งหมดไว้ใน "เอกสาร" เดียว (เหมาะกับขนาดระบบนี้ที่มีไม่กี่สิบห้อง)
async function readDB() {
  let state = await stateCollection.findOne({ _id: 'main' });
  if (!state) {
    state = { _id: 'main', ...DEFAULT_STATE };
    await stateCollection.insertOne(state);
  }
  return state;
}
async function writeDB(state) {
  await stateCollection.replaceOne({ _id: 'main' }, state, { upsert: true });
}

// ---------- ฟังก์ชันช่วยคำนวณเวลา ----------
function minutesSince(isoString) {
  if (!isoString) return 0;
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

function decorateRoom(room, settings) {
  const minutesOn = room.status === 'on' ? minutesSince(room.lastChangedAt) : 0;
  return {
    ...room,
    minutesOn: Math.floor(minutesOn),
    secondsOn: room.status === 'on' ? Math.floor((Date.now() - new Date(room.lastChangedAt).getTime()) / 1000) : 0,
    overThreshold: room.status === 'on' && minutesOn >= settings.thresholdMinutes,
  };
}

// ---------- เรียก LINE Messaging API เพื่อส่งข้อความหาลูกค้า ----------
async function pushLineMessage(token, toUserId, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: toUserId,
      messages: [{ type: 'text', text }],
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`LINE API error ${res.status}: ${body}`);
  }
  return body;
}

// ============ API: ห้องทั้งหมด ============
app.get('/api/rooms', async (req, res) => {
  const db = await readDB();
  const rooms = db.rooms.map((r) => decorateRoom(r, db.settings));
  res.json({ rooms, settings: db.settings });
});

app.post('/api/rooms', async (req, res) => {
  const { name, code, customerName, lineUserId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อห้อง' });
  }
  if (!code || !code.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุรหัสห้องสำหรับลงทะเบียน' });
  }
  const db = await readDB();
  const cleanCode = code.trim();
  if (db.rooms.some((r) => r.code.toLowerCase() === cleanCode.toLowerCase())) {
    return res.status(400).json({ error: 'รหัสห้องนี้ถูกใช้ไปแล้ว กรุณาตั้งรหัสอื่น' });
  }
  const room = {
    id: 'room-' + crypto.randomUUID().slice(0, 8),
    name: name.trim(),
    code: cleanCode,
    customerName: (customerName || '').trim(),
    lineUserId: (lineUserId || '').trim(),
    status: 'off',
    lastChangedAt: new Date().toISOString(),
    lastNotifiedAt: null,
    registeredAt: null,
  };
  db.rooms.push(room);
  await writeDB(db);
  res.json(decorateRoom(room, db.settings));
});

app.put('/api/rooms/:id', async (req, res) => {
  const db = await readDB();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  const { name, code, customerName, lineUserId } = req.body;
  if (code !== undefined && code.trim() && code.trim().toLowerCase() !== room.code.toLowerCase()) {
    const cleanCode = code.trim();
    if (db.rooms.some((r) => r.id !== room.id && r.code.toLowerCase() === cleanCode.toLowerCase())) {
      return res.status(400).json({ error: 'รหัสห้องนี้ถูกใช้ไปแล้ว กรุณาตั้งรหัสอื่น' });
    }
    room.code = cleanCode;
  }
  if (name !== undefined) room.name = name.trim();
  if (customerName !== undefined) room.customerName = customerName.trim();
  if (lineUserId !== undefined) room.lineUserId = lineUserId.trim();
  await writeDB(db);
  res.json(decorateRoom(room, db.settings));
});

app.delete('/api/rooms/:id', async (req, res) => {
  const db = await readDB();
  const before = db.rooms.length;
  db.rooms = db.rooms.filter((r) => r.id !== req.params.id);
  if (db.rooms.length === before) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  await writeDB(db);
  res.json({ ok: true });
});

// สลับสถานะไฟด้วยตนเอง (ใช้ทดสอบระบบ หรือกดจากแดชบอร์ดโดยพนักงาน)
app.post('/api/rooms/:id/toggle', async (req, res) => {
  const db = await readDB();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  room.status = room.status === 'on' ? 'off' : 'on';
  room.lastChangedAt = new Date().toISOString();
  if (room.status === 'off') room.lastNotifiedAt = null;
  await writeDB(db);
  res.json(decorateRoom(room, db.settings));
});

// ============ API: รับสถานะจากเซ็นเซอร์/อุปกรณ์ IoT จริง ============
// ตัวอย่างการเรียกจากอุปกรณ์:
// curl -X POST http://SERVER/api/sensor/room-1 \
//   -H "Content-Type: application/json" -H "x-api-key: changeme123" \
//   -d '{"status":"on"}'
app.post('/api/sensor/:id', async (req, res) => {
  if (req.headers['x-api-key'] !== SENSOR_API_KEY) {
    return res.status(401).json({ error: 'API key ไม่ถูกต้อง' });
  }
  const { status } = req.body;
  if (status !== 'on' && status !== 'off') {
    return res.status(400).json({ error: 'status ต้องเป็น "on" หรือ "off"' });
  }
  const db = await readDB();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  if (room.status !== status) {
    room.status = status;
    room.lastChangedAt = new Date().toISOString();
    if (status === 'off') room.lastNotifiedAt = null;
    await writeDB(db);
  }
  res.json(decorateRoom(room, db.settings));
});

// ============ API: ตั้งค่า ============
app.get('/api/settings', async (req, res) => {
  const db = await readDB();
  const { lineChannelAccessToken, ...rest } = db.settings;
  res.json({ ...rest, lineChannelAccessTokenSet: !!lineChannelAccessToken });
});

app.put('/api/settings', async (req, res) => {
  const db = await readDB();
  const { lineChannelAccessToken, liffId, thresholdMinutes, renotifyMinutes } = req.body;
  if (lineChannelAccessToken !== undefined) db.settings.lineChannelAccessToken = lineChannelAccessToken.trim();
  if (liffId !== undefined) db.settings.liffId = liffId.trim();
  if (thresholdMinutes !== undefined) db.settings.thresholdMinutes = Math.max(1, Number(thresholdMinutes));
  if (renotifyMinutes !== undefined) db.settings.renotifyMinutes = Math.max(1, Number(renotifyMinutes));
  await writeDB(db);
  res.json({ ok: true });
});

// ============ API: ตั้งค่าสาธารณะ (ใช้โดยหน้าลงทะเบียน ไม่ต้องล็อกอิน) ============
app.get('/api/public-config', async (req, res) => {
  const db = await readDB();
  res.json({ liffId: db.settings.liffId || '' });
});

// ============ API: ลูกค้าลงทะเบียนผูก LINE กับห้องของตัวเอง (เรียกจากหน้า LIFF) ============
app.post('/api/register', async (req, res) => {
  const { code, lineUserId, displayName } = req.body;
  if (!code || !code.trim()) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสห้อง' });
  }
  if (!lineUserId) {
    return res.status(400).json({ error: 'ไม่พบข้อมูล LINE กรุณาเปิดผ่านแอป LINE อีกครั้ง' });
  }
  const db = await readDB();
  const cleanCode = code.trim();
  const room = db.rooms.find((r) => r.code.toLowerCase() === cleanCode.toLowerCase());
  if (!room) {
    return res.status(404).json({ error: 'ไม่พบรหัสห้องนี้ในระบบ กรุณาตรวจสอบรหัสกับผู้ดูแลอีกครั้ง' });
  }
  room.lineUserId = lineUserId;
  if (displayName && !room.customerName) room.customerName = displayName;
  room.registeredAt = new Date().toISOString();
  await writeDB(db);
  res.json({ ok: true, roomName: room.name });
});

// ============ API: รายชื่อผู้ที่เคยทักแชทมา (ใช้หา LINE userId ของลูกค้า) ============
app.get('/api/registrations', async (req, res) => {
  const db = await readDB();
  res.json(db.registrations.slice(-50).reverse());
});

// ============ Webhook: รับข้อความจากลูกค้าผ่าน LINE OA ============
// ตั้งค่า Webhook URL ใน LINE Developers Console ให้ชี้มาที่ https://YOUR_DOMAIN/webhook
// (ทุกครั้งที่ลูกค้าทักแชทมา ระบบจะบันทึก LINE userId ไว้ให้เลือกผูกกับห้อง)
app.post('/webhook', async (req, res) => {
  res.status(200).end(); // ตอบ LINE ทันทีตาม spec ก่อนประมวลผล
  try {
    const db = await readDB();
    const events = req.body.events || [];
    for (const event of events) {
      const userId = event.source && event.source.userId;
      if (!userId) continue;
      let displayName = '';
      const token = db.settings.lineChannelAccessToken;
      if (token) {
        try {
          const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (profileRes.ok) {
            const profile = await profileRes.json();
            displayName = profile.displayName || '';
          }
        } catch (_) {
          /* เพิกเฉยถ้าดึงโปรไฟล์ไม่ได้ */
        }
      }
      db.registrations.push({
        userId,
        displayName,
        lastMessage: event.message && event.message.text ? event.message.text : '',
        timestamp: new Date().toISOString(),
      });
    }
    if (events.length) await writeDB(db);
  } catch (err) {
    console.error('webhook error:', err);
  }
});

// ============ ตัวตรวจสอบเป็นระยะ: ห้องไหนเปิดไฟนานเกินกำหนด ก็ส่ง LINE แจ้งลูกค้า ============
async function checkRoomsAndNotify() {
  const db = await readDB();
  const { lineChannelAccessToken, thresholdMinutes, renotifyMinutes } = db.settings;
  let changed = false;

  for (const room of db.rooms) {
    if (room.status !== 'on') continue;
    const onMinutes = minutesSince(room.lastChangedAt);
    if (onMinutes < thresholdMinutes) continue;

    const minutesSinceLastNotify = room.lastNotifiedAt ? minutesSince(room.lastNotifiedAt) : Infinity;
    if (minutesSinceLastNotify < renotifyMinutes) continue;

    if (!room.lineUserId || !lineChannelAccessToken) {
      // ยังไม่ได้ผูก LINE userId หรือยังไม่ได้ตั้งค่า token จึงข้ามการแจ้งเตือนจริง
      continue;
    }

    const text =
      `แจ้งเตือน: ไฟห้อง "${room.name}" เปิดทิ้งไว้นานแล้วประมาณ ${Math.floor(onMinutes)} นาที\n` +
      `กรุณาตรวจสอบและปิดไฟหากไม่ได้ใช้งานครับ/ค่ะ`;

    try {
      await pushLineMessage(lineChannelAccessToken, room.lineUserId, text);
      room.lastNotifiedAt = new Date().toISOString();
      db.notificationLog.push({
        roomId: room.id,
        roomName: room.name,
        sentAt: room.lastNotifiedAt,
        success: true,
      });
      changed = true;
    } catch (err) {
      console.error(`ส่งข้อความแจ้งห้อง ${room.name} ไม่สำเร็จ:`, err.message);
      db.notificationLog.push({
        roomId: room.id,
        roomName: room.name,
        sentAt: new Date().toISOString(),
        success: false,
        error: err.message,
      });
      changed = true;
    }
  }

  if (changed) await writeDB(db);
}

// ============ เริ่มระบบ: เชื่อมต่อฐานข้อมูลก่อน แล้วค่อยเปิดรับ request ============
async function start() {
  await connectDB();
  setInterval(() => {
    checkRoomsAndNotify().catch((err) => console.error('checkRoomsAndNotify error:', err));
  }, 30 * 1000); // ตรวจสอบทุก 30 วินาที

  app.listen(PORT, () => {
    console.log(`ระบบแจ้งเตือนไฟเปิดทิ้งไว้ ทำงานที่ http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('เริ่มระบบไม่สำเร็จ:', err);
  process.exit(1);
});
