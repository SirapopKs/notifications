const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

const DAY_LABELS = {
  monday: 'จันทร์',
  tuesday: 'อังคาร',
  wednesday: 'พุธ',
  thursday: 'พฤหัสบดี',
  friday: 'ศุกร์',
};
const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

let settingsCache = { thresholdMinutes: 30, renotifyMinutes: 30 };
let dutyCurrentDay = 'monday';
let dutyCurrentRoomId = null;
let dutyRoster = [];

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

// ---------- render rooms ----------
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

    const dutyCount = (room.dutyRoster || []).length;
    const regCount = (room.dutyRoster || []).filter((e) => e.lineUserId).length;
    node.querySelector('.room-meta.reg-status').textContent = dutyCount > 0
      ? `เวร ${dutyCount} คน (ผูก LINE แล้ว ${regCount} คน)`
      : room.lineUserId ? '✅ ผูก LINE แล้ว' : `รหัสห้อง: ${room.code} (ยังไม่ลงทะเบียน)`;

    const timerEl = node.querySelector('.timer');
    timerEl.textContent = room.status === 'on' ? formatHMS(room.secondsOn) : '--:--:--';

    const ratio = settingsCache.thresholdMinutes ? Math.min((room.minutesOn || 0) / settingsCache.thresholdMinutes, 1) : 0;
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
    node.querySelector('.duty-btn').addEventListener('click', () => openDutyModal(room));

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

// ---------- duty modal ----------
const dutyModal = document.getElementById('dutyModal');
const dutyAddForm = document.getElementById('dutyAddForm');

async function openDutyModal(room) {
  dutyCurrentRoomId = room.id;
  dutyCurrentDay = 'monday';
  document.getElementById('dutyRoomId').value = room.id;
  document.getElementById('dutyAddDay').value = 'monday';
  document.getElementById('dutyModalTitle').textContent = `เวรประจำวัน — ${room.name}`;

  document.querySelectorAll('.duty-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.day === 'monday');
  });

  await loadDutyRoster(room.id);
  dutyModal.classList.remove('hidden');
}

function closeDutyModal() {
  dutyModal.classList.add('hidden');
  dutyCurrentRoomId = null;
  dutyRoster = [];
  refresh();
}

async function loadDutyRoster(roomId) {
  try {
    const res = await fetch(`/api/rooms/${roomId}/duty`);
    dutyRoster = await res.json();
    renderDutyDay();
  } catch (err) {
    console.error('โหลดเวรไม่สำเร็จ', err);
  }
}

function renderDutyDay() {
  const content = document.getElementById('dutyDayContent');
  const dayEntries = dutyRoster.filter((e) => e.day === dutyCurrentDay);

  if (dayEntries.length === 0) {
    content.innerHTML = '<p class="duty-empty">ยังไม่มีรายชื่อเวรสำหรับวันนี้</p>';
    return;
  }

  content.innerHTML = '';
  for (const entry of dayEntries) {
    const row = document.createElement('div');
    row.className = 'duty-row';
    const roleLabel = entry.role === 'teacher' ? 'ครู' : entry.role === 'student' ? 'นักเรียน' : '—';
    const statusBadge = entry.lineUserId
      ? `<span class="duty-badge duty-badge-ok">ลงทะเบียนแล้ว</span>`
      : `<span class="duty-badge duty-badge-no">ยังไม่ลงทะเบียน</span>`;
    const lineName = entry.lineDisplayName || entry.displayName || '';
    const lineNameSuffix = lineName
      ? ` <span class="duty-line-name">(${lineName})</span>` : '';
    row.innerHTML = `
      <div class="duty-row-info">
        <span class="duty-name">${entry.name}${lineNameSuffix}</span>
        <span class="duty-role">${roleLabel}</span>
        ${statusBadge}
      </div>
      <button class="icon-btn duty-delete-btn" data-id="${entry.id}" title="ลบ" aria-label="ลบ">✕</button>
    `;
    row.querySelector('.duty-delete-btn').addEventListener('click', () => deleteDutyEntry(entry.id));
    content.appendChild(row);
  }
}

async function deleteDutyEntry(entryId) {
  if (!dutyCurrentRoomId) return;
  await fetch(`/api/rooms/${dutyCurrentRoomId}/duty/${entryId}`, { method: 'DELETE' });
  await loadDutyRoster(dutyCurrentRoomId);
}

document.querySelectorAll('.duty-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    dutyCurrentDay = tab.dataset.day;
    document.getElementById('dutyAddDay').value = dutyCurrentDay;
    document.querySelectorAll('.duty-tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderDutyDay();
  });
});

dutyAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('dutyAddName').value.trim();
  const day = document.getElementById('dutyAddDay').value;
  if (!name) return;
  await fetch(`/api/rooms/${dutyCurrentRoomId}/duty`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, day }),
  });
  document.getElementById('dutyAddName').value = '';
  await loadDutyRoster(dutyCurrentRoomId);
});

document.getElementById('closeDutyBtn').addEventListener('click', closeDutyModal);
dutyModal.addEventListener('click', (e) => { if (e.target === dutyModal) closeDutyModal(); });

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
    ? 'ตั้งค่า LIFF ID แล้ว — กดปุ่ม 🔗 ที่การ์ดห้องแต่ละห้องเพื่อคัดลอกลิงก์ลงทะเบียน'
    : 'กรอก LIFF ID แล้วบันทึกก่อน จึงจะสร้างลิงก์ลงทะเบียนให้แต่ละห้องได้';
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
