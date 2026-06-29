// register.js — หน้าลงทะเบียนเวร (multi-step) เปิดผ่าน LIFF ใน LINE

const DAY_LABELS = {
  monday: 'จันทร์',
  tuesday: 'อังคาร',
  wednesday: 'พุธ',
  thursday: 'พฤหัสบดี',
  friday: 'ศุกร์',
};

const states = {
  loading: document.getElementById('loadingState'),
  code: document.getElementById('codeState'),
  role: document.getElementById('roleState'),
  duty: document.getElementById('dutyState'),
  success: document.getElementById('successState'),
  fatal: document.getElementById('fatalErrorState'),
};

let lineProfile = null;
let selectedRoom = null;   // { roomName, code, roster }
let selectedRole = null;   // 'teacher' | 'student'
let selectedEntryId = null; // duty roster entry id (if picked from list)
let selectedDays = new Set();
let useManualDays = false;

function showState(key) {
  Object.values(states).forEach((el) => el.classList.add('hidden'));
  states[key].classList.remove('hidden');
}

function showFatalError(msg) {
  document.getElementById('fatalErrorMessage').textContent = msg;
  showState('fatal');
}

// ---------- step 1: code ----------
document.getElementById('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('codeInput').value.trim();
  const errEl = document.getElementById('codeError');
  errEl.textContent = '';

  try {
    const res = await fetch(`/api/room-duty-public/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'ไม่พบรหัสห้องนี้';
      return;
    }
    selectedRoom = { roomName: data.roomName, code, roster: data.roster || [] };
    showState('role');
  } catch (err) {
    errEl.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่';
  }
});

// ---------- step 2: role ----------
document.querySelectorAll('.role-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedRole = btn.dataset.role;
  });
});

document.getElementById('roleNextBtn').addEventListener('click', () => {
  if (!selectedRole) {
    document.getElementById('roleError').textContent = 'กรุณาเลือกประเภทก่อน';
    return;
  }
  document.getElementById('roleError').textContent = '';
  prepareStep3();
  showState('duty');
});

document.getElementById('roleBackBtn').addEventListener('click', () => {
  selectedRole = null;
  document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('selected'));
  showState('code');
});

// ---------- step 3: duty ----------
function prepareStep3() {
  selectedEntryId = null;
  selectedDays = new Set();
  useManualDays = false;

  // แสดงชื่อ LINE และเติม placeholder ช่องชื่อจริง
  document.getElementById('dutyLineDisplayName').textContent = lineProfile.displayName || '';
  const fullNameInput = document.getElementById('fullNameInput');
  if (!fullNameInput.value) fullNameInput.value = lineProfile.displayName || '';

  const rosterPicker = document.getElementById('rosterPicker');
  const dayPicker = document.getElementById('dayPicker');
  const dutyStateTitle = document.getElementById('dutyStateTitle');
  const dutyStateSub = document.getElementById('dutyStateSub');

  // รีเซ็ต day buttons
  document.querySelectorAll('.day-btn').forEach((b) => b.classList.remove('selected'));

  const unregisteredRoster = (selectedRoom.roster || []).filter((e) => !e.registered);

  if (selectedRole === 'teacher') {
    dutyStateTitle.textContent = 'เลือกวันอยู่เวร';
    dutyStateSub.textContent = `เลือกวันที่คุณดูแลห้อง "${selectedRoom.roomName}"`;
    rosterPicker.classList.add('hidden');
    dayPicker.classList.remove('hidden');
  } else if (unregisteredRoster.length > 0) {
    // นักเรียน + มีรายชื่อในระบบ
    dutyStateTitle.textContent = 'เลือกชื่อของคุณ';
    dutyStateSub.textContent = `เลือกชื่อของคุณจากรายชื่อเวรห้อง "${selectedRoom.roomName}"`;
    rosterPicker.classList.remove('hidden');
    dayPicker.classList.add('hidden');
    renderRosterList(selectedRoom.roster);
  } else {
    // นักเรียน + ไม่มีรายชื่อในระบบ หรือรายชื่อลงทะเบียนหมดแล้ว
    dutyStateTitle.textContent = 'เลือกวันอยู่เวร';
    dutyStateSub.textContent = `เลือกวันที่คุณเป็นเวรห้อง "${selectedRoom.roomName}"`;
    rosterPicker.classList.add('hidden');
    dayPicker.classList.remove('hidden');
    useManualDays = true;
  }
}

function renderRosterList(roster) {
  const list = document.getElementById('rosterList');
  list.innerHTML = '';
  for (const entry of roster) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'duty-pick-item' + (entry.registered ? ' registered' : '');
    item.disabled = entry.registered;
    item.innerHTML = `
      <div class="pick-name">${entry.name}</div>
      <div>
        <span class="pick-day">วัน${DAY_LABELS[entry.day] || entry.day}</span>
        ${entry.registered ? '<span class="pick-reg"> · ลงทะเบียนแล้ว</span>' : ''}
      </div>
    `;
    if (!entry.registered) {
      item.addEventListener('click', () => {
        document.querySelectorAll('.duty-pick-item').forEach((i) => i.classList.remove('selected'));
        item.classList.add('selected');
        selectedEntryId = entry.id;
      });
    }
    list.appendChild(item);
  }
}

document.getElementById('switchToManualBtn').addEventListener('click', () => {
  useManualDays = true;
  selectedEntryId = null;
  document.getElementById('rosterPicker').classList.add('hidden');
  document.getElementById('dayPicker').classList.remove('hidden');
  document.getElementById('dutyStateTitle').textContent = 'เลือกวันอยู่เวร';
});

document.querySelectorAll('.day-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const day = btn.dataset.day;
    if (selectedDays.has(day)) {
      selectedDays.delete(day);
      btn.classList.remove('selected');
    } else {
      selectedDays.add(day);
      btn.classList.add('selected');
    }
  });
});

document.getElementById('dutyBackBtn').addEventListener('click', () => {
  showState('role');
});

document.getElementById('dutySubmitBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('dutyError');
  errEl.textContent = '';

  const fullName = document.getElementById('fullNameInput').value.trim();
  if (!fullName) {
    errEl.textContent = 'กรุณากรอกชื่อ-นามสกุลก่อน';
    return;
  }

  // validation
  const dayPickerVisible = !document.getElementById('dayPicker').classList.contains('hidden');
  if (dayPickerVisible && selectedDays.size === 0 && !selectedEntryId) {
    errEl.textContent = 'กรุณาเลือกวันที่อยู่เวรอย่างน้อย 1 วัน';
    return;
  }
  if (!dayPickerVisible && !selectedEntryId) {
    errEl.textContent = 'กรุณาเลือกชื่อของคุณจากรายการ';
    return;
  }

  try {
    const payload = {
      code: selectedRoom.code,
      lineUserId: lineProfile.userId,
      displayName: fullName,
      lineDisplayName: lineProfile.displayName || '',
      role: selectedRole,
    };
    if (selectedEntryId) {
      payload.dutyEntryId = selectedEntryId;
    } else {
      payload.dutyDays = Array.from(selectedDays);
    }

    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่';
      return;
    }

    const roleLabel = selectedRole === 'teacher' ? 'ครู' : 'นักเรียน';
    let dayDesc = '';
    if (selectedEntryId) {
      const entry = selectedRoom.roster.find((e) => e.id === selectedEntryId);
      dayDesc = entry ? `วัน${DAY_LABELS[entry.day]}` : '';
    } else {
      dayDesc = Array.from(selectedDays).map((d) => `วัน${DAY_LABELS[d]}`).join(', ');
    }

    document.getElementById('successMessage').textContent =
      `ลงทะเบียนเป็น${roleLabel}เวรห้อง "${data.roomName}" ${dayDesc} เรียบร้อยแล้ว ` +
      `ระบบจะแจ้งเตือนเข้า LINE เฉพาะวันที่คุณอยู่เวรครับ/ค่ะ`;
    showState('success');
  } catch (err) {
    errEl.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง';
  }
});

// ---------- boot ----------
async function boot() {
  try {
    const configRes = await fetch('/api/public-config');
    const config = await configRes.json();

    if (!config.liffId) {
      showFatalError('ระบบยังไม่ได้ตั้งค่า LIFF ID กรุณาติดต่อผู้ดูแลระบบ');
      return;
    }

    await liff.init({ liffId: config.liffId });

    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    lineProfile = await liff.getProfile();
    document.getElementById('profileName').textContent = lineProfile.displayName || 'ผู้ใช้ LINE';
    document.getElementById('profilePic').src = lineProfile.pictureUrl || '';

    const params = new URLSearchParams(window.location.search);
    const prefillCode = params.get('code');
    if (prefillCode) document.getElementById('codeInput').value = prefillCode;

    showState('code');
  } catch (err) {
    console.error(err);
    showFatalError('เกิดข้อผิดพลาดในการเชื่อมต่อ LINE กรุณาเปิดลิงก์นี้ผ่านแอป LINE อีกครั้ง');
  }
}

boot();
