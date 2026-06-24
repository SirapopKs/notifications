const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // ~326.7, ตรงกับ r=52 ใน SVG

let settingsCache = { thresholdMinutes: 30, renotifyMinutes: 30 };

const roomGrid = document.getElementById('roomGrid');
const emptyState = document.getElementById('emptyState');
const liveCounter = document.getElementById('liveCounter');
const cardTemplate = document.getElementById('roomCardTemplate');

// ---------- helpers ----------
function formatHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function timeAgoLabel(iso) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'แจ้งเตือนล่าสุด: เมื่อสักครู่';
  if (mins < 60) return `แจ้งเตือนล่าสุด: ${mins} นาทีที่แล้ว`;
  return `แจ้งเตือนล่าสุด: ${Math.floor(mins / 60)} ชม.ที่แล้ว`;
}

function ringColor(ratio) {
  if (ratio >= 1) return 'var(--red)';
  if (ratio >= 0.6) return 'var(--amber)';
  return 'var(--green)';
}

// ---------- render ----------
function renderRooms(rooms) {
  const onCount = rooms.filter((r) => r.status === 'on').length;
  liveCounter.textContent = `${onCount} ห้องกำลังเปิดไฟ`;

  emptyState.classList.toggle('hidden', rooms.length > 0);
  roomGrid.innerHTML = '';

  for (const room of rooms) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = room.id;
    node.classList.toggle('is-on', room.status === 'on');
    node.classList.toggle('is-over', room.overThreshold);

    node.querySelector('.room-name').textContent = room.name;
    node.querySelector('.room-customer').textContent = room.customerName || 'ยังไม่ระบุลูกค้า';
    node.querySelector('.room-meta.last-notified').textContent = room.status === 'on' ? (timeAgoLabel(room.lastNotifiedAt) || 'ยังไม่เคยแจ้งเตือน') : '';
    node.querySelector('.room-meta.reg-status').textContent = room.lineUserId
      ? '✅ ผูก LINE แล้ว'
      : `รหัสห้อง: ${room.code} (ยังไม่ลงทะเบียน)`;

    const timerEl = node.querySelector('.timer');
    timerEl.textContent = room.status === 'on' ? formatHMS(room.secondsOn) : '--:--:--';

    const ratio = settingsCache.thresholdMinutes
      ? Math.min((room.minutesOn || 0) / settingsCache.thresholdMinutes, 1)
      : 0;
    const progressEl = node.querySelector('.ring-progress');
    if (room.status === 'on') {
      progressEl.style.stroke = ringColor(ratio);
      progressEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
    } else {
      progressEl.style.stroke = 'var(--border)';
      progressEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    }

    const toggleBtn = node.querySelector('.btn-toggle');
    toggleBtn.textContent = room.status === 'on' ? 'ปิดไฟ (จำลอง)' : 'เปิดไฟ (จำลอง)';
    toggleBtn.classList.toggle('state-on', room.status === 'on');
    toggleBtn.addEventListener('click', () => toggleRoom(room.id));

    node.querySelector('.edit-btn').addEventListener('click', () => openRoomModal(room));
    node.querySelector('.delete-btn').addEventListener('click', () => deleteRoom(room.id, room.name));
    node.querySelector('.link-btn').addEventListener('click', (e) => copyRegisterLink(room, e.currentTarget));

    roomGrid.appendChild(node);
  }
}

// ---------- data fetching ----------
async function refresh() {
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    settingsCache = data.settings;
    renderRooms(data.rooms);
  } catch (err) {
    console.error('โหลดข้อมูลห้องไม่สำเร็จ', err);
  }
}

async function toggleRoom(id) {
  await fetch(`/api/rooms/${id}/toggle`, { method: 'POST' });
  refresh();
}

async function deleteRoom(id, name) {
  if (!confirm(`ลบ "${name}" ออกจากระบบ?`)) return;
  await fetch(`/api/rooms/${id}`, { method: 'DELETE' });
  refresh();
}

async function copyRegisterLink(room, btn) {
  if (!settingsCache.liffId) {
    alert('ยังไม่ได้ตั้งค่า LIFF ID — ไปที่ปุ่ม "ตั้งค่า" เพื่อกรอกก่อน');
    return;
  }
  const link = `https://liff.line.me/${settingsCache.liffId}?code=${encodeURIComponent(room.code)}`;
  await navigator.clipboard.writeText(link);
  const original = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = original; }, 1500);
}

// ---------- room modal ----------
const roomModal = document.getElementById('roomModal');
const roomForm = document.getElementById('roomForm');

function openRoomModal(room) {
  document.getElementById('roomModalTitle').textContent = room ? 'แก้ไขห้อง' : 'เพิ่มห้องใหม่';
  document.getElementById('roomId').value = room ? room.id : '';
  document.getElementById('roomName').value = room ? room.name : '';
  document.getElementById('roomCode').value = room ? room.code : '';
  document.getElementById('roomCustomer').value = room ? room.customerName : '';
  document.getElementById('roomLineId').value = room ? room.lineUserId : '';
  roomModal.classList.remove('hidden');
  document.getElementById('roomName').focus();
}

function closeRoomModal() {
  roomModal.classList.add('hidden');
  roomForm.reset();
}

document.getElementById('openAddRoomBtn').addEventListener('click', () => openRoomModal(null));
document.getElementById('cancelRoomBtn').addEventListener('click', closeRoomModal);
roomModal.addEventListener('click', (e) => { if (e.target === roomModal) closeRoomModal(); });

roomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('roomId').value;
  const payload = {
    name: document.getElementById('roomName').value,
    code: document.getElementById('roomCode').value,
    customerName: document.getElementById('roomCustomer').value,
    lineUserId: document.getElementById('roomLineId').value,
  };
  const res = id
    ? await fetch(`/api/rooms/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    : await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'บันทึกไม่สำเร็จ');
    return;
  }
  closeRoomModal();
  refresh();
});

// ---------- settings modal ----------
const settingsModal = document.getElementById('settingsModal');
const settingsForm = document.getElementById('settingsForm');

async function openSettingsModal() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  document.getElementById('thresholdMinutes').value = data.thresholdMinutes;
  document.getElementById('renotifyMinutes').value = data.renotifyMinutes;
  document.getElementById('liffId').value = data.liffId || '';
  document.getElementById('lineToken').value = '';
  document.getElementById('tokenStatus').textContent = data.lineChannelAccessTokenSet
    ? 'มีการตั้งค่า token ไว้แล้ว (เว้นว่างไว้หากไม่ต้องการเปลี่ยน)'
    : 'ยังไม่ได้ตั้งค่า token — จะยังไม่มีการส่งข้อความ LINE จริงจนกว่าจะกรอก';
  document.getElementById('registerLinkInfo').textContent = data.liffId
    ? 'ตั้งค่า LIFF ID แล้ว — กดปุ่ม 🔗 ที่การ์ดห้องแต่ละห้องเพื่อคัดลอกลิงก์ลงทะเบียนของห้องนั้น'
    : 'กรอก LIFF ID แล้วบันทึกก่อน จึงจะสร้างลิงก์ลงทะเบียนให้แต่ละห้องได้ (ดูปุ่ม 🔗 ที่การ์ดห้องแต่ละห้อง)';
  await loadRegistrations();
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

document.getElementById('openSettingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('cancelSettingsBtn').addEventListener('click', closeSettingsModal);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettingsModal(); });

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    thresholdMinutes: document.getElementById('thresholdMinutes').value,
    renotifyMinutes: document.getElementById('renotifyMinutes').value,
    liffId: document.getElementById('liffId').value,
  };
  const token = document.getElementById('lineToken').value;
  if (token) payload.lineChannelAccessToken = token;
  await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  closeSettingsModal();
  refresh();
});

async function loadRegistrations() {
  const list = document.getElementById('registrationsList');
  try {
    const res = await fetch('/api/registrations');
    const regs = await res.json();
    if (!regs.length) {
      list.innerHTML = '<p class="no-registrations">ยังไม่มีใครทักแชทเข้ามา</p>';
      return;
    }
    list.innerHTML = '';
    for (const reg of regs) {
      const row = document.createElement('div');
      row.className = 'registration-item';
      row.innerHTML = `
        <span class="ruid">${reg.displayName ? reg.displayName + ' — ' : ''}${reg.userId}</span>
        <button type="button">คัดลอก</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        navigator.clipboard.writeText(reg.userId);
        row.querySelector('button').textContent = 'คัดลอกแล้ว';
      });
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = '<p class="no-registrations">โหลดรายชื่อไม่สำเร็จ</p>';
  }
}

// ---------- boot ----------
refresh();
setInterval(refresh, 5000);
