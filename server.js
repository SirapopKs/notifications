// server.js
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
  console.error('ไม่พบ MONGODB_URI ใน environment variables — ดูวิธีตั้งค่าใน README.md');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

const DAY_NAMES_TH = {
  monday: 'จันทร์',
  tuesday: 'อังคาร',
  wednesday: 'พุธ',
  thursday: 'พฤหัสบดี',
  friday: 'ศุกร์',
};
const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// ---------- MongoDB ----------
const mongoClient = new MongoClient(MONGODB_URI);
let stateCollection;

async function connectDB() {
  await mongoClient.connect();
  const db = mongoClient.db('lightnoti');
  stateCollection = db.collection('app_state');
  console.log('เชื่อมต่อ MongoDB สำเร็จ');
}

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

// ---------- helpers ----------
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

// วันนี้คือวันอะไร (UTC+7)
function getTodayDay() {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return days[nowBkk.getUTCDay()];
}

// ---------- LINE ----------
async function pushLineMessage(token, toUserId, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: toUserId, messages: [{ type: 'text', text }] }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LINE API error ${res.status}: ${body}`);
  return body;
}

// ============ API: ห้อง ============
app.get('/api/rooms', async (req, res) => {
  const db = await readDB();
  const rooms = db.rooms.map((r) => decorateRoom(r, db.settings));
  res.json({ rooms, settings: db.settings });
});

app.post('/api/rooms', async (req, res) => {
  const { name, code, customerName, lineUserId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อห้อง' });
  if (!code || !code.trim()) return res.status(400).json({ error: 'กรุณาระบุรหัสห้อง' });
  const db = await readDB();
  const cleanCode = code.trim();
  if (db.rooms.some((r) => r.code.toLowerCase() === cleanCode.toLowerCase())) {
    return res.status(400).json({ error: 'รหัสห้องนี้ถูกใช้ไปแล้ว' });
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
    dutyRoster: [],
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
      return res.status(400).json({ error: 'รหัสห้องนี้ถูกใช้ไปแล้ว' });
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

// ============ API: เวรประจำวัน (admin) ============
app.get('/api/rooms/:id/duty', async (req, res) => {
  const db = await readDB();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  res.json(room.dutyRoster || []);
});

app.post('/api/rooms/:id/duty', async (req, res) => {
  const { name, day } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อ' });
  if (!VALID_DAYS.includes(day)) return res.status(400).json({ error: 'วันไม่ถูกต้อง' });
  const db = await readDB();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  if (!room.dutyRoster) room.dutyRoster = [];
  const entry = {
    id: 'duty-' + crypto.randomUUID().slice(0, 8),
    name: name.trim(),
    day,
    lineUserId: null,
    role: null,
    displayName: null,
  };
  room.dutyRoster.push(entry);
  await writeDB(db);
  res.json(entry);
});

app.delete('/api/rooms/:id/duty/:entryId', async (req, res) => {
  const db = await readDB();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'ไม่พบห้องนี้' });
  const before = (room.dutyRoster || []).length;
  room.dutyRoster = (room.dutyRoster || []).filter((e) => e.id !== req.params.entryId);
  if (room.dutyRoster.length === before) return res.status(404).json({ error: 'ไม่พบรายการนี้' });
  await writeDB(db);
  res.json({ ok: true });
});

// duty roster สาธารณะสำหรับหน้าลงทะเบียน (ไม่ส่ง lineUserId)
app.get('/api/room-duty-public/:code', async (req, res) => {
  const db = await readDB();
  const room = db.rooms.find((r) => r.code.toLowerCase() === req.params.code.toLowerCase());
  if (!room) return res.status(404).json({ error: 'ไม่พบรหัสห้องนี้' });
  const roster = (room.dutyRoster || []).map((e) => ({
    id: e.id,
    name: e.name,
    day: e.day,
    registered: !!e.lineUserId,
  }));
  res.json({ roomName: room.name, roster });
});

// ============ API: เซ็นเซอร์ IoT ============
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

app.get('/api/public-config', async (req, res) => {
  const db = await readDB();
  res.json({ liffId: db.settings.liffId || '' });
});

// ============ API: ลงทะเบียน (LIFF) ============
app.post('/api/register', async (req, res) => {
  const { code, lineUserId, displayName, role, dutyEntryId, dutyDays } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'กรุณากรอกรหัสห้อง' });
  if (!lineUserId) return res.status(400).json({ error: 'ไม่พบข้อมูล LINE กรุณาเปิดผ่านแอป LINE อีกครั้ง' });

  const db = await readDB();
  const cleanCode = code.trim();
  const room = db.rooms.find((r) => r.code.toLowerCase() === cleanCode.toLowerCase());
  if (!room) return res.status(404).json({ error: 'ไม่พบรหัสห้องนี้ กรุณาตรวจสอบกับผู้ดูแลอีกครั้ง' });

  if (!room.dutyRoster) room.dutyRoster = [];

  const cleanRole = role === 'teacher' ? 'teacher' : 'student';
  const cleanLineDisplayName = (req.body.lineDisplayName || '').trim();

  if (dutyEntryId) {
    // ผูก LINE กับรายชื่อที่ admin กรอกไว้
    const entry = room.dutyRoster.find((e) => e.id === dutyEntryId);
    if (entry) {
      entry.lineUserId = lineUserId;
      entry.role = cleanRole;
      entry.name = displayName || entry.name;
      entry.lineDisplayName = cleanLineDisplayName;
    }
  } else if (Array.isArray(dutyDays) && dutyDays.length > 0) {
    // สร้างรายการเวรใหม่สำหรับแต่ละวันที่เลือก
    room.dutyRoster = room.dutyRoster.filter((e) => e.lineUserId !== lineUserId);
    for (const day of dutyDays) {
      if (!VALID_DAYS.includes(day)) continue;
      room.dutyRoster.push({
        id: 'duty-' + crypto.randomUUID().slice(0, 8),
        name: displayName || 'ไม่ระบุชื่อ',
        day,
        lineUserId,
        role: cleanRole,
        lineDisplayName: cleanLineDisplayName,
      });
    }
  }

  // ให้ backward compat กับ room.lineUserId เดิม
  if (!room.lineUserId) {
    room.lineUserId = lineUserId;
    if (displayName && !room.customerName) room.customerName = displayName;
  }
  room.registeredAt = new Date().toISOString();
  await writeDB(db);
  res.json({ ok: true, roomName: room.name });
});

// ============ Webhook ============
app.get('/api/registrations', async (req, res) => {
  const db = await readDB();
  res.json(db.registrations.slice(-50).reverse());
});

app.post('/webhook', async (req, res) => {
  res.status(200).end();
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
        } catch (_) {}
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

// ============ ตรวจสอบห้องและส่งแจ้งเตือน ============
async function checkRoomsAndNotify() {
  const db = await readDB();
  const { lineChannelAccessToken, thresholdMinutes, renotifyMinutes } = db.settings;
  if (!lineChannelAccessToken) return;

  const todayDay = getTodayDay();
  let changed = false;

  for (const room of db.rooms) {
    if (room.status !== 'on') continue;
    const onMinutes = minutesSince(room.lastChangedAt);
    if (onMinutes < thresholdMinutes) continue;

    const minSinceLast = room.lastNotifiedAt ? minutesSince(room.lastNotifiedAt) : Infinity;
    if (minSinceLast < renotifyMinutes) continue;

    const todayDuty = (room.dutyRoster || []).filter((e) => e.day === todayDay);

    if (todayDuty.length === 0) {
      // ไม่มีเวรวันนี้ ใช้พฤติกรรมเดิม (ส่งให้ lineUserId ของห้อง)
      if (!room.lineUserId) continue;
      const text =
        `แจ้งเตือน: ไฟห้อง "${room.name}" เปิดทิ้งไว้นานแล้วประมาณ ${Math.floor(onMinutes)} นาที\n` +
        `กรุณาตรวจสอบและปิดไฟหากไม่ได้ใช้งานครับ/ค่ะ`;
      try {
        await pushLineMessage(lineChannelAccessToken, room.lineUserId, text);
        room.lastNotifiedAt = new Date().toISOString();
        db.notificationLog.push({ roomId: room.id, roomName: room.name, sentAt: room.lastNotifiedAt, success: true });
        changed = true;
      } catch (err) {
        console.error(`ส่งแจ้งเตือนห้อง ${room.name} ไม่สำเร็จ:`, err.message);
        db.notificationLog.push({ roomId: room.id, roomName: room.name, sentAt: new Date().toISOString(), success: false, error: err.message });
        changed = true;
      }
      continue;
    }

    // วันนี้มีเวร
    const dayNameTh = DAY_NAMES_TH[todayDay] || todayDay;
    const rosterLines = todayDuty
      .map((e) => `• ${e.name} ${e.lineUserId ? '(ลงทะเบียนแล้ว)' : '(ยังไม่ลงทะเบียน)'}`)
      .join('\n');

    let anyNotified = false;
    for (const duty of todayDuty) {
      if (!duty.lineUserId) continue;

      let text;
      if (duty.role === 'teacher') {
        text =
          `แจ้งเตือน: ไฟห้อง "${room.name}" เปิดทิ้งไว้นานแล้วประมาณ ${Math.floor(onMinutes)} นาที\n\n` +
          `รายชื่อเวรวัน${dayNameTh}:\n${rosterLines}\n\n` +
          `กรุณาแจ้งนักเรียนเวรให้ปิดไฟด้วยครับ/ค่ะ`;
      } else {
        text =
          `แจ้งเตือน: ไฟห้อง "${room.name}" เปิดทิ้งไว้นานแล้วประมาณ ${Math.floor(onMinutes)} นาที\n` +
          `คุณอยู่เวรวัน${dayNameTh} กรุณาตรวจสอบและปิดไฟหากไม่ได้ใช้งานครับ/ค่ะ`;
      }

      try {
        await pushLineMessage(lineChannelAccessToken, duty.lineUserId, text);
        anyNotified = true;
        db.notificationLog.push({ roomId: room.id, roomName: room.name, sentAt: new Date().toISOString(), success: true, sentTo: duty.name });
      } catch (err) {
        console.error(`ส่งแจ้งเตือนไปยัง ${duty.name} ไม่สำเร็จ:`, err.message);
        db.notificationLog.push({ roomId: room.id, roomName: room.name, sentAt: new Date().toISOString(), success: false, error: err.message });
      }
    }

    if (anyNotified) {
      room.lastNotifiedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) await writeDB(db);
}

// ============ เริ่มระบบ ============
async function start() {
  await connectDB();
  setInterval(() => {
    checkRoomsAndNotify().catch((err) => console.error('checkRoomsAndNotify error:', err));
  }, 30 * 1000);

  app.listen(PORT, () => {
    console.log(`ระบบแจ้งเตือนไฟเปิดทิ้งไว้ ทำงานที่ http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('เริ่มระบบไม่สำเร็จ:', err);
  process.exit(1);
});
