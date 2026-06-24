// register.js — หน้าลงทะเบียนลูกค้า เปิดผ่าน LIFF ภายในแอป LINE

const loadingState = document.getElementById('loadingState');
const formState = document.getElementById('formState');
const successState = document.getElementById('successState');
const fatalErrorState = document.getElementById('fatalErrorState');

function showState(stateEl) {
  [loadingState, formState, successState, fatalErrorState].forEach((el) => el.classList.add('hidden'));
  stateEl.classList.remove('hidden');
}

function showFatalError(message) {
  document.getElementById('fatalErrorMessage').textContent = message;
  showState(fatalErrorState);
}

async function boot() {
  try {
    const configRes = await fetch('/api/public-config');
    const config = await configRes.json();

    if (!config.liffId) {
      showFatalError('ระบบยังไม่ได้ตั้งค่า LIFF ID กรุณาติดต่อผู้ดูแลระบบให้ตั้งค่าก่อน');
      return;
    }

    await liff.init({ liffId: config.liffId });

    if (!liff.isLoggedIn()) {
      liff.login(); // จะรีไดเรกต์ไปล็อกอิน LINE แล้วกลับมาที่หน้านี้พร้อม query string เดิม
      return;
    }

    const profile = await liff.getProfile();
    document.getElementById('profileName').textContent = profile.displayName || 'ผู้ใช้ LINE';
    document.getElementById('profilePic').src = profile.pictureUrl || '';

    const params = new URLSearchParams(window.location.search);
    const prefillCode = params.get('code');
    if (prefillCode) document.getElementById('codeInput').value = prefillCode;

    showState(formState);

    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('codeInput').value.trim();
      const errorEl = document.getElementById('formError');
      errorEl.textContent = '';
      errorEl.classList.remove('error');

      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, lineUserId: profile.userId, displayName: profile.displayName }),
        });
        const data = await res.json();
        if (!res.ok) {
          errorEl.textContent = data.error || 'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่';
          errorEl.classList.add('error');
          return;
        }
        document.getElementById('successMessage').textContent =
          `ห้อง "${data.roomName}" ผูกกับ LINE ของคุณแล้ว หากเปิดไฟทิ้งไว้นานเกินกำหนด ระบบจะแจ้งเตือนมาที่แชทนี้`;
        showState(successState);
      } catch (err) {
        errorEl.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง';
        errorEl.classList.add('error');
      }
    });
  } catch (err) {
    console.error(err);
    showFatalError('เกิดข้อผิดพลาดในการเชื่อมต่อ LINE กรุณาเปิดลิงก์นี้ผ่านแอป LINE อีกครั้ง หรือติดต่อผู้ดูแลระบบ');
  }
}

boot();
