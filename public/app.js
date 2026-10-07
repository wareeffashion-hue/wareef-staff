// Wareef staff app: one file, no build step. Hash routes, server-rendered data via JSON API.
import { startInk } from './ink.js';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

let ME = null;
let skew = 0;       // server clock minus device clock
let tz = 180;       // store timezone offset, minutes
const nowMs = () => Date.now() + skew;
const localIso = (ts) => new Date(ts + tz * 60000).toISOString();
const fmtT = (ts) => (ts ? localIso(ts).slice(11, 16) : '—');
const today = () => localIso(nowMs()).slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const money = (n) => `${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const int = (n) => Number(n || 0).toLocaleString('en-US');
const hm = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '—');
const mn = (m) => (m ? `${int(m)} د` : '—');
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayName = (d) => DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
const fmtDate = (d) => `${dayName(d)} ${d.slice(8)}/${d.slice(5, 7)}`;

const STATUS = {
  present: ['حاضر', 'good'], late: ['متأخر', 'warn'], absent: ['غائب', 'bad'], partial: ['غياب جزئي', 'bad'],
  excused: ['معذور', 'info'], off: ['إجازة أسبوعية', ''], off_worked: ['عمل في يوم إجازة', 'info'], holiday: ['إجازة رسمية', ''],
  upcoming: ['لم يبدأ الدوام', ''], not_arrived: ['لم يصل بعد', 'warn'],
};
const LIVE = { in: ['داخل الدوام', 'good'], leave: ['خروج مؤقت', 'warn'], out: ['خارج الدوام', ''], none: ['لم يسجّل', ''] };
const PUNCH = { in: 'حضور', out: 'انصراف', leave: 'خروج مؤقت', back: 'عودة' };
const DED = { late: 'تأخير', absence: 'غياب', early: 'انصراف مبكر', exit: 'خروج أثناء الدوام', violation: 'مخالفة', damage: 'تلف أو نقص', other: 'أخرى' };
const TK = { achievement: 'إنجاز يومي', note: 'ملاحظة', issue: 'مشكلة', request: 'طلب' };
const TS = { open: ['مفتوحة', 'warn'], in_progress: ['قيد المعالجة', 'info'], closed: ['مغلقة', 'good'] };
const PRI = { low: 'منخفضة', normal: 'عادية', high: 'عالية' };
const EXC = { leave: 'إجازة', sick: 'مرضية', holiday: 'إجازة رسمية للجميع', excused: 'عذر مقبول' };
const STOCK = { merchant_return: 'مرتجع للتاجر', new_goods: 'فاتورة بضاعة' };
let FLAGS = {};

const pill = (label, tone = '') => `<span class="pill ${tone}">${esc(label)}</span>`;
const statusPill = (s) => pill(...(STATUS[s] || [s, '']));
const flagList = (flags) => (flags || []).map((f) => `<span class="flag">${esc(FLAGS[f] || f)}</span>`).join('');
const table = (head, rows, { empty = 'لا توجد بيانات', foot = null, cls = '' } = {}) => rows.length
  ? `<div class="tbl"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>${foot ? `<tfoot><tr>${foot.map((c) => `<td>${c}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`
  : `<div class="tbl"><p class="empty">${empty}</p></div>`;
const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(label)}</option>`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Requested-With': 'fetch', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { ME = null; renderLogin(); throw new Error(data.error || 'يرجى تسجيل الدخول'); }
  if (!res.ok) throw new Error(data.error || 'تعذّر تنفيذ الطلب');
  return data;
}

function toast(msg, err = false) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), err ? 5000 : 2600);
}

/** Run an async action from a button, with feedback. */
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else o[el.name] = el.value;
  }
  return o;
}

function modal(title, html, mount) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="dh"><h2>${esc(title)}</h2><button class="x" type="button" aria-label="إغلاق">×</button></div><div class="db">${html}</div>`;
  document.body.append(d);
  $('.x', d).onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  d.showModal();
  mount?.(d);
  return d;
}

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
  coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M15 12.5c3.3 0 6-1.3 6-3M15 16c3.3 0 6-1.3 6-3V9"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  ticket: '<path d="M4 5h16v4a3 3 0 0 0 0 6v4H4v-4a3 3 0 0 0 0-6z"/><path d="M9 9h6M9 13h6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 8v5M12 16v.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5 5 0 0 1 3.5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
  down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h13a4 4 0 0 1 4 4M17 20l4-4-4-4M21 16H8a4 4 0 0 1-4-4"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9 17h6"/>',
  barcode: '<path d="M4 5v14M7 5v14M11 5v14M14 5v14M17 5v14M20 5v14"/><path d="M2 3h3M19 3h3M2 21h3M19 21h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

// ------------------------------------------------------------------ phone notifications (Web Push)
const PUSH = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  ios: () => /iphone|ipad|ipod/i.test(navigator.userAgent),
  standalone: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  async sub() { if (!PUSH.supported()) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); },
  async enable() {
    if (!PUSH.supported()) throw new Error(PUSH.ios() && !PUSH.standalone() ? 'على الآيفون: أضف النظام للشاشة الرئيسية أولاً (Safari ← مشاركة ← إضافة إلى الشاشة الرئيسية) ثم افتحه منها' : 'هذا المتصفح لا يدعم التنبيهات. استخدم Chrome');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('رفضت التنبيهات. فعّلها من إعدادات المتصفح ← الإشعارات');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('/api/push/key');
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (ch) => ch.charCodeAt(0)) });
    }
    return api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  },
  async disable() { const sub = await PUSH.sub(); if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); } },
  /** After login on a phone that already allowed notifications, attach the device to this account. */
  async refresh() { try { if (PUSH.supported() && Notification.permission === 'granted') { const sub = await PUSH.sub(); if (sub) await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }); } } catch {} },
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ------------------------------------------------------------------ boot & shell
async function boot() {
  try {
    const me = await api('/api/me');
    ME = me.user;
    ME.channels = me.channels;
    ME.periods = me.periods;
    ME.metrics = me.metrics;
    skew = me.now - Date.now();
    tz = me.tzOffset;
    window.addEventListener('hashchange', route);
    route();
    PUSH.refresh();
  } catch {
    if (!ME) renderLogin();
  }
}

function renderLogin() {
  window.removeEventListener('hashchange', route);
  app.innerHTML = `<div class="login"><form class="card form" id="loginForm">
    <img src="/img/logo-full.png" alt="وريف">
    <p class="tag">فريق واحد، هدف واحد</p>
    <label class="f">اسم المستخدم<input name="username" id="lg-user" autocomplete="username" autocapitalize="none" dir="ltr" required></label>
    <label class="f">كلمة المرور<input name="password" id="lg-pass" type="password" autocomplete="current-password" dir="ltr" required></label>
    <button class="btn" type="submit">دخول</button>
    <button class="link" type="button" id="forgot" style="justify-self:center">نسيت كلمة المرور؟</button>
  </form></div>`;
  $('#forgot').onclick = () => forgotPassword($('#lg-user').value.trim());
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    const ok = await act(btn, () => api('/api/login', { method: 'POST', body: formData(e.target) }));
    if (ok) { location.hash = ''; boot(); }
  };
}

/** Two steps: a code to the WhatsApp number on file, then the new password. */
function forgotPassword(username = '') {
  modal('استعادة كلمة المرور', `<form class="form" id="fp1">
      <p class="muted small">يوصلك رمز تحقق على واتساب الرقم المسجّل لك في النظام.</p>
      <label class="f">اسم المستخدم<input name="username" id="fp-user" dir="ltr" autocapitalize="none" required value="${esc(username)}"></label>
      <button class="btn" type="submit">أرسل الرمز</button>
    </form>
    <form class="form" id="fp2" hidden>
      <p class="muted small">إذا كان الحساب مربوطاً برقم واتساب، وصلك الرمز الآن.</p>
      <label class="f">رمز التحقق<input name="code" id="fp-code" dir="ltr" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <label class="f">كلمة المرور الجديدة<input name="password" id="fp-pass" type="password" dir="ltr" minlength="6" autocomplete="new-password" required></label>
      <button class="btn" type="submit">حفظ كلمة المرور</button>
    </form>`, (dl) => {
    $('#fp1', dl).onsubmit = async (e) => {
      e.preventDefault();
      if (await act($('button', e.target), () => api('/api/reset/request', { method: 'POST', body: formData(e.target) }))) { e.target.hidden = true; $('#fp2', dl).hidden = false; $('#fp-code', dl).focus(); }
    };
    $('#fp2', dl).onsubmit = async (e) => {
      e.preventDefault();
      const body = { ...formData(e.target), username: $('#fp-user', dl).value };
      if (await act($('button', e.target), () => api('/api/reset/confirm', { method: 'POST', body }), 'تم تغيير كلمة المرور. ادخل بها الآن')) { dl.close(); $('#lg-user').value = body.username; $('#lg-pass').focus(); }
    };
  });
}

function navItems() {
  if (ME.role === 'admin') {
    return [
      ['dashboard', 'لوحة اليوم', 'home'], ['attendance', 'الحضور والانصراف', 'clock'], ['leaves', 'الإجازات والاستئذان', 'sun'], ['payroll', 'الرواتب', 'wallet'],
      ['money', 'الخصومات والسلف', 'coins'], ['ops', 'العمليات اليومية', 'box'], ['scan', 'الباركود', 'barcode'], ['requests', 'الفسح والنواقص', 'swap'], ['tickets', 'التذاكر', 'ticket'],
      ['performance', 'الأداء', 'trophy'], ['analytics', 'المؤشرات', 'chart'],
      ['flags', 'مؤشرات التلاعب', 'shield'], ['staff', 'الموظفون', 'users'], ['reports', 'التقارير والتصدير', 'file'], ['settings', 'الإعدادات', 'gear'],
    ];
  }
  const ops = ME.perms.some((p) => p === 'orders' || p === 'stock' || p.startsWith('m:')) ? [['ops', 'العمليات', 'box']] : [];
  if (ME.manager) {
    // Supervisor: an employee who punches, plus the team pages without salaries or settings.
    return [
      ['today', 'البصمة', 'clock'], ['dashboard', 'لوحة اليوم', 'home'], ['attendance', 'الحضور والانصراف', 'cal'], ['leaves', 'الإجازات والاستئذان', 'sun'],
      ...ops, ['scan', 'الباركود', 'barcode'], ['requests', 'الفسح والنواقص', 'swap'], ['tickets', 'التذاكر', 'ticket'], ['performance', 'الأداء', 'trophy'], ['analytics', 'المؤشرات', 'chart'],
      ['flags', 'مؤشرات التلاعب', 'shield'], ['reports', 'التقارير', 'file'], ['mine', 'سجلي', 'wallet'], ['account', 'حسابي', 'user'],
    ];
  }
  return [
    ['today', 'البصمة', 'clock'], ...(ME.perms.includes('scan') ? [['scan', 'الباركود', 'barcode']] : []), ['mine', 'سجلي', 'cal'], ['leaves', 'إجازاتي', 'sun'], ['tickets', 'تذاكري', 'ticket'],
    ...ops, ...(ME.perms.includes('requests') ? [['requests', 'الفسح والنواقص', 'swap']] : []), ['account', 'حسابي', 'user'],
  ];
}

const PAGES = {};
function route() {
  const items = navItems();
  const key = location.hash.replace(/^#\/?/, '').split('?')[0] || items[0][0];
  const page = key === 'account' || (key === 'notifications' && ME.role === 'admin') || items.some(([k]) => k === key) ? key : items[0][0];
  clearInterval(window.__tick);
  app.innerHTML = `<div class="shell">
    <nav class="rail" aria-label="القائمة">
      <div class="brand"><img src="/img/logo-mark.png" alt="وريف"><span>${esc(ME.name)}${ME.name === 'المدير' ? '' : `<br>${ME.role === 'admin' ? 'المدير' : ME.manager ? 'مشرف' : 'موظف'}`}</span></div>
      ${items.map(([k, label, ic]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${icon(ic)}${label}</a>`).join('')}
      <div class="foot">${ME.role === 'admin' ? `<a href="#/account">${icon('user')}حسابي</a>` : ''}<a href="#" id="logout">${icon('out')}تسجيل الخروج</a></div>
    </nav>
    <main class="main" id="page"><div class="mobile-head"><img src="/img/logo-mark.png" alt="وريف"><div class="mh-tools"><a href="#/account" class="mh-me">${icon('user')}${esc(ME.name)}</a><button type="button" class="mh-out" data-logout aria-label="تسجيل الخروج" title="تسجيل الخروج">${icon('out')}</button></div></div><p class="muted">جاري التحميل...</p></main>
    <nav class="tabbar" aria-label="القائمة">${items.map(([k, label, ic]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${icon(ic)}${label}</a>`).join('')}</nav>
  </div>`;
  $('#logout').onclick = (e) => { e.preventDefault(); logout(); };
  const fn = PAGES[page] || PAGES.account;
  fn().catch((e) => { $('#page').innerHTML = `<div class="panel"><p>${esc(e.message)}</p></div>`; });
}

async function logout() {
  if (!confirm('تسجيل الخروج من النظام؟')) return;
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  ME = null;
  renderLogin();
}
// the phone header and the account page carry their own logout buttons
document.addEventListener('click', (e) => { if (e.target.closest('[data-logout]')) { e.preventDefault(); logout(); } });

/** Write the page body (keeps the phone header). */
function render(html) {
  const head = $('.mobile-head').outerHTML;
  $('#page').innerHTML = head + html;
  return $('#page');
}
const refresh = () => route();

// ------------------------------------------------------------------ employee: punch screen
PAGES.today = async () => {
  if (ME.role === 'admin') return PAGES.dashboard();
  let data = await api('/api/my/today');
  const draw = () => {
    const d = data.day;
    const live = LIVE[d.liveState] || LIVE.out;
    const buttons = {
      in: '<button class="btn" data-p="in">تسجيل حضور</button>',
      leave: '<button class="btn ghost" data-p="leave">خروج مؤقت</button>',
      back: '<button class="btn" data-p="back">رجعت للمكتب</button>',
      out: '<button class="btn ghost" data-p="out">تسجيل انصراف</button>',
    };
    const pg = render(`
      <section class="panel punch">
        <div class="clock" id="clock">--:--:--</div>
        <p class="muted">${fmtDate(data.date)}</p>
        <div class="state">${pill(live[0], live[1])} ${d.periods.length ? statusPill(d.status) : pill('لا يوجد دوام اليوم')}</div>
        ${d.periods.length ? `<div class="periods">${d.periods.map((p) => pill(`${p.name}: ${p.start} – ${p.end}`, 'plain')).join('')}</div>` : ''}
        ${exitCard(data)}
        <div id="pushBanner"></div>
        <div class="actions">${data.allowed.filter((a) => !(a === 'leave' && data.exit?.status === 'approved' && !data.exit.left_at)).map((a) => buttons[a]).join('')}
          ${data.allowed.includes('leave') && !(data.exit && (data.exit.status === 'pending' || (data.exit.status === 'approved' && !data.exit.back_at))) ? '<button class="btn ghost" data-x="ask">طلب إذن خروج</button>' : ''}</div>
        ${data.geo ? '<p class="muted small">يُسجَّل موقعك مع كل بصمة للتحقق من وجودك في مكان العمل.</p>' : ''}
      </section>
      <div class="kpis">
        <div class="kpi ${d.lateMinutes ? 'warn' : ''}"><b>${int(d.lateMinutes)}</b><span>دقائق تأخير اليوم</span></div>
        <div class="kpi ${d.exitMinutes ? 'warn' : ''}"><b>${int(d.exitMinutes)}</b><span>دقائق خروج</span></div>
        <div class="kpi"><b>${hm(d.presentMinutes)}</b><span>ساعات العمل اليوم</span></div>
      </div>
      <section class="panel"><header><h2>بصمات اليوم</h2></header>
        ${data.punches.length ? `<div class="timeline">${data.punches.map((p) => `<div class="ev ${p.type}"><b class="num">${fmtT(p.ts)}</b><span class="dot"></span><div>${PUNCH[p.type]}${p.note ? ` <span class="muted small">· ${esc(p.note)}</span>` : ''}</div></div>`).join('')}</div>` : '<p class="muted">لم تسجّل أي بصمة اليوم.</p>'}
      </section>`);
    $$('[data-p]', pg).forEach((b) => { b.onclick = () => punch(b.dataset.p, b); });
    pushBanner($('#pushBanner', pg));
    const ask = $('[data-x=ask]', pg);
    if (ask) ask.onclick = () => askExit();
    const go = $('[data-x=go]', pg);
    if (go) go.onclick = () => punch('leave', go, data.exit.id);
    const cancel = $('[data-x=cancel]', pg);
    if (cancel) cancel.onclick = async () => { const r = await act(cancel, () => api(`/api/exit-requests/${data.exit.id}`, { method: 'DELETE' }), 'تم إلغاء الطلب'); if (r) { data = r; draw(); } };
    tick();
  };
  const tick = () => {
    const c = $('#clock'); if (c) c.textContent = localIso(nowMs()).slice(11, 19);
    const cd = $('#exit-cd');
    if (cd && data.exit?.left_at) {
      const left = data.exit.left_at + data.exit.minutes * 60000 - nowMs();
      const a = Math.abs(left);
      cd.textContent = `${left < 0 ? '+' : ''}${Math.floor(a / 60000)}:${String(Math.floor((a % 60000) / 1000)).padStart(2, '0')}`;
      cd.closest('.exitcard').classList.toggle('over', left < 0);
    }
  };
  function askExit() {
    modal('طلب إذن خروج', `<form class="form" id="xF">
        <p class="muted small">يوصل الطلب للمدير على واتساب، ويوصلك قراره. الوقت يبدأ من لحظة خروجك.</p>
        <div class="seg" role="radiogroup" aria-label="المدة">${[15, 30, 45, 60, 90].map((m, i) => `<button type="button" data-m="${m}" class="${i === 1 ? 'on' : ''}">${m} د</button>`).join('')}</div>
        <label class="f">المدة بالدقائق<input type="number" name="minutes" id="x-min" min="5" max="240" step="5" value="30" inputmode="numeric" required></label>
        <label class="f">السبب<textarea name="reason" id="x-reason" required maxlength="300" placeholder="مثال: مراجعة بنك، توصيل طلب عاجل، ظرف عائلي"></textarea></label>
        <button class="btn" type="submit">أرسل الطلب للمدير</button></form>`, (dl) => {
      $$('[data-m]', dl).forEach((b) => { b.onclick = () => { $('#x-min', dl).value = b.dataset.m; $$('[data-m]', dl).forEach((x) => x.classList.toggle('on', x === b)); }; });
      $('#x-min', dl).oninput = () => $$('[data-m]', dl).forEach((x) => x.classList.toggle('on', x.dataset.m === $('#x-min', dl).value));
      $('#xF', dl).onsubmit = async (e) => {
        e.preventDefault();
        const r = await act($('button[type=submit]', e.target), () => api('/api/exit-requests', { method: 'POST', body: formData(e.target) }), 'تم إرسال الطلب للمدير');
        if (r) { dl.close(); data = r; draw(); }
      };
    });
  }
  async function punch(type, btn, exitId = null) {
    let note = '';
    if (type === 'leave' && !exitId) {
      if (!confirm('الخروج بدون إذن مسبق يوصل للمدير ويُحسب من وقت الخروج. تقدر تطلب إذن خروج بدلاً منه. تكمل؟')) return;
      note = await new Promise((resolve) => {
        const d = modal('خروج مؤقت', `<form class="form" id="lv"><label class="f">سبب الخروج<textarea name="note" id="lv-note" required maxlength="300" placeholder="مثال: مراجعة بنك، توصيل طلب، ظرف عائلي"></textarea></label><button class="btn" type="submit">تسجيل الخروج المؤقت</button></form>`,
          (dl) => { $('#lv', dl).onsubmit = (e) => { e.preventDefault(); const v = $('#lv-note', dl).value.trim(); dl.close(); resolve(v); }; });
        d.addEventListener('close', () => resolve(''), { once: true });
      });
      if (!note) return;
    }
    btn.disabled = true;
    const pos = data.geo ? await locate() : null;
    if (data.requireGeo && !pos) { btn.disabled = false; toast('فعّل خدمة الموقع في جوالك واسمح للمتصفح باستخدامها', true); return; }
    const r = await act(btn, () => api('/api/punch', { method: 'POST', body: { type, note, exit_id: exitId, client_ts: Date.now(), ...(pos || {}) } }), `تم تسجيل ${type === 'back' ? 'رجوعك' : PUNCH[type]} الساعة ${fmtT(nowMs())}`);
    if (r) { data = r; draw(); }
  }
  draw();
  window.__tick = setInterval(tick, 1000);
  const poll = setInterval(async () => {
    if (!$('#clock')) { clearInterval(poll); return; }
    if (data.exit?.status !== 'pending' && Date.now() - lastPoll < 55000) return;
    lastPoll = Date.now();
    try { data = await api('/api/my/today'); draw(); } catch {}
  }, 10000);
  let lastPoll = Date.now();
};

/** «Turn on phone alarms» card, until the device is subscribed (or dismissed for 3 days). */
async function pushBanner(el) {
  if (!el) return;
  let later = 0; try { later = +localStorage.getItem('push-later') || 0; } catch {}
  if (Date.now() < later) return;
  const sub = await PUSH.sub().catch(() => null);
  if (sub && Notification.permission === 'granted') return;
  const iosHint = PUSH.ios() && !PUSH.standalone();
  el.innerHTML = `<div class="pushcard"><b>🔔 فعّل منبّه الدوام على جوالك</b>
    <span>${iosHint ? 'على الآيفون: من Safari اضغط مشاركة ← «إضافة إلى الشاشة الرئيسية»، وافتح النظام من الأيقونة ثم فعّل.' : 'يوصلك قبل كل فترة، وعند الاستراحة والانصراف، وكل قرار على طلباتك، حتى لو الجوال مقفل.'}</span>
    <div class="row" style="justify-content:center">${iosHint ? '' : '<button class="btn sm" type="button" id="pb-on">تفعيل التنبيهات</button>'}<button class="link" type="button" id="pb-later">لاحقاً</button></div></div>`;
  $('#pb-later', el).onclick = () => { try { localStorage.setItem('push-later', Date.now() + 3 * 86400000); } catch {} el.innerHTML = ''; };
  const on = $('#pb-on', el);
  if (on) on.onclick = async () => { if (await act(on, () => PUSH.enable(), 'تم تفعيل تنبيهات الجوال')) el.innerHTML = ''; };
}

/** Where the exit permission stands, on the punch screen. */
function exitCard(data) {
  const x = data.exit;
  if (!x) return '';
  if (x.status === 'pending') return `<div class="exitcard wait"><b>⏳ بانتظار موافقة المدير</b><span>خروج ${x.minutes} دقيقة · ${esc(x.reason)}</span><button class="link" data-x="cancel" type="button">إلغاء الطلب</button></div>`;
  if (x.status === 'rejected') return `<div class="exitcard no"><b>⛔ لم تتم الموافقة على الخروج</b>${x.response ? `<span>${esc(x.response)}</span>` : ''}</div>`;
  if (!x.left_at) return `<div class="exitcard ok"><b>✅ تمت الموافقة على خروجك ${x.minutes} دقيقة</b>${x.response ? `<span>${esc(x.response)}</span>` : ''}<span>الوقت يبدأ لما تضغط «اخرج الآن».</span><button class="btn" data-x="go" type="button">اخرج الآن</button></div>`;
  if (!x.back_at) return `<div class="exitcard out"><span>متبقي من إذن الخروج</span><b class="cd" id="exit-cd">--:--</b><span>خرجت الساعة ${fmtT(x.left_at)} · ${x.minutes} دقيقة</span></div>`;
  return `<div class="exitcard ok"><b>↩️ تم تسجيل رجوعك الساعة ${fmtT(x.back_at)}</b><span>استخدمت ${Math.round((x.back_at - x.left_at) / 60000)} من ${x.minutes} دقيقة</span></div>`;
}

function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

// ------------------------------------------------------------------ employee: my month
PAGES.mine = async () => {
  const month = sessionStorage.getItem('mine-month') || thisMonth();
  const d = await api(`/api/my/month?month=${month}`);
  const s = d.summary || {};
  const dedTotal = d.deductions.reduce((t, x) => t + x.amount, 0);
  const pg = render(`
    <div class="topline"><h1>سجلي الشهري</h1><div class="tools"><input type="month" id="mm" value="${month}" aria-label="الشهر">
      ${d.closed ? `<a class="btn" href="/payslip?month=${month}" target="_blank" rel="noopener">${icon('file')}قسيمة الراتب</a>` : ''}</div></div>
    ${d.award?.user_id === ME.id ? `<section class="panel award"><b>🏆 أنت موظف الشهر</b><span>تقييمك ${d.award.score} من 100. شكراً على التزامك وجهدك 🤍</span></section>`
      : d.award ? `<section class="panel award soft"><b>🏆 موظف الشهر: ${esc(d.award.name)}</b><span>المنافسة مفتوحة للشهر الجاي</span></section>` : ''}
    <div class="kpis">
      <div class="kpi good"><b>${int(s.presentDays)}</b><span>أيام الحضور</span></div>
      <div class="kpi ${s.absentDays ? 'bad' : ''}"><b>${int(s.absentDays)}</b><span>أيام الغياب</span></div>
      <div class="kpi ${s.lateMinutes ? 'warn' : ''}"><b>${int(s.lateMinutes)}</b><span>دقائق التأخير</span></div>
      <div class="kpi"><b>${int(s.exitMinutes)}</b><span>دقائق الخروج</span></div>
      <div class="kpi ${dedTotal ? 'bad' : ''}"><b>${money(dedTotal)}</b><span>الخصومات (ر.س)</span></div>
      <div class="kpi"><b>${money(d.balance)}</b><span>المتبقي من السلف</span></div>
    </div>
    <section class="panel"><header><h2>الأيام</h2></header>
      ${table(['اليوم', 'الحالة', 'الحضور', 'الانصراف', 'تأخير', 'انصراف مبكر', 'خروج', 'ساعات العمل', 'ملاحظات'],
        d.days.slice().reverse().map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${statusPill(r.status)}</td><td>${fmtT(r.firstIn)}</td><td>${fmtT(r.lastOut)}</td><td>${mn(r.lateMinutes)}</td><td>${mn(r.earlyMinutes)}</td><td>${mn(r.exitMinutes)}</td><td>${hm(r.presentMinutes)}</td><td>${flagList(r.flags)}</td></tr>`))}
    </section>
    <div class="grid2">
      <section class="panel"><header><h2>الخصومات</h2></header>
        ${table(['التاريخ', 'السبب', 'المبلغ', 'التفاصيل'], d.deductions.map((x) => `<tr><td>${x.date}</td><td>${DED[x.category]}</td><td>${money(x.amount)}</td><td class="wrap">${esc(x.reason)}</td></tr>`), { empty: 'لا توجد خصومات هذا الشهر' })}
      </section>
      <section class="panel"><header><h2>السلف</h2><span class="muted">المتبقي: <b>${money(d.balance)}</b> ر.س</span></header>
        ${table(['التاريخ', 'النوع', 'المبلغ', 'ملاحظة'], d.debts.map((x) => `<tr><td>${x.date}</td><td>${x.kind === 'loan' ? pill('سلفة', 'warn') : pill('سداد', 'good')}</td><td>${money(x.amount)}</td><td class="wrap">${esc(x.note)}</td></tr>`), { empty: 'لا توجد سلف' })}
      </section>
    </div>`);
  $('#mm', pg).onchange = (e) => { sessionStorage.setItem('mine-month', e.target.value || thisMonth()); refresh(); };
};

// ------------------------------------------------------------------ account
PAGES.account = async () => {
  const pg = render(`
    <div class="topline"><h1>حسابي</h1></div>
    <section class="panel" style="max-width:520px"><header><h2>تغيير كلمة المرور</h2></header>
      <form class="form" id="pw">
        <label class="f">كلمة المرور الحالية<input type="password" name="current" id="pw-cur" autocomplete="current-password" dir="ltr" required></label>
        <label class="f">كلمة المرور الجديدة<input type="password" name="password" id="pw-new" autocomplete="new-password" dir="ltr" minlength="6" required></label>
        <button class="btn" type="submit">حفظ</button>
      </form>
      <p class="muted small">اسم المستخدم: <b dir="ltr">${esc(ME.username)}</b></p>
    </section>
    <section class="panel" style="max-width:520px"><header><h2>تنبيهات الجوال</h2><span id="ps"></span></header>
      <p class="muted small">منبّهات الدوام وكل إشعارات النظام تطلع على شاشة هذا الجوال مباشرة بصوت واهتزاز، حتى لو كان مقفل. فعّلها على كل جوال تستخدمه.</p>
      <div class="row"><button class="btn" type="button" id="p-on">تفعيل على هذا الجوال</button><button class="btn ghost" type="button" id="p-test">إرسال تنبيه تجربة</button><button class="link bad" type="button" id="p-off">إيقاف</button></div>
      ${PUSH.ios() && !PUSH.standalone() ? '<p class="muted small">على الآيفون: من Safari اضغط مشاركة ← «إضافة إلى الشاشة الرئيسية»، وافتح النظام من الأيقونة الجديدة، ثم فعّل من هنا.</p>' : ''}
    </section>
    <div style="max-width:520px"><button class="btn ghost" type="button" data-logout style="width:100%">${icon('out')}تسجيل الخروج</button></div>`);
  const ps = $('#ps', pg);
  const showState = async () => { const sub = await PUSH.sub().catch(() => null); ps.innerHTML = sub && Notification.permission === 'granted' ? pill('مفعّلة', 'good') : pill('غير مفعّلة', 'warn'); };
  showState();
  $('#p-on', pg).onclick = async (e) => { if (await act(e.target, () => PUSH.enable(), 'تم التفعيل')) showState(); };
  $('#p-test', pg).onclick = (e) => act(e.target, () => api('/api/push/test', { method: 'POST' }), 'أُرسل التنبيه، شوف شاشة الجوال');
  $('#p-off', pg).onclick = async (e) => { await act(e.target, () => PUSH.disable(), 'تم الإيقاف'); showState(); };
  $('#pw', pg).onsubmit = async (e) => {
    e.preventDefault();
    const ok = await act($('button', e.target), () => api('/api/me/password', { method: 'POST', body: formData(e.target) }), 'تم تغيير كلمة المرور');
    if (ok) e.target.reset();
  };
};

// ------------------------------------------------------------------ manager: dashboard
PAGES.dashboard = async () => {
  const date = sessionStorage.getItem('dash-date') || today();
  const d = await api(`/api/dashboard?date=${date}`);
  FLAGS = d.flagLabels;
  const att = d.attendance;
  const c = (...s) => att.filter((r) => s.includes(r.status)).length;
  const inside = att.filter((r) => r.liveState === 'in').length;
  const onLeave = att.filter((r) => r.liveState === 'leave').length;
  const flagged = d.punches.filter((p) => p.flags.length && !p.voided && !(p.flags.length === 1 && p.flags[0] === 'manager_entry')).length;
  const ops = d.ops;
  const mv = (k) => ops?.metrics?.[k]?.value || 0;
  const isToday = date === today();
  const hour = +localIso(nowMs()).slice(11, 13);
  const greet = !isToday ? `يوم <b>${esc(dayName(date))}</b>` : hour < 12 ? 'صباح <b>الخير</b>' : 'مساء <b>الخير</b>';
  const monthName = new Date(`${date}T12:00:00Z`).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  const pg = render(`
    <section class="hero">
      <div class="intro">
        <p class="hud">${isToday ? '<span><span class="pulse"></span><b>مباشر</b></span>' : ''}<span>الفريق <b>${att.length}</b></span><span>البصمات <b>${d.punches.filter((p) => !p.voided).length}</b></span><span>آخر تحديث <b>${fmtT(d.now)}</b></span></p>
        <p class="eyebrow">وريف · لوحة ${isToday ? 'اليوم' : 'يوم سابق'} · ${esc(dayName(date))} ${esc(monthName)}</p>
        <h1 class="silver">${greet}</h1>
        ${isToday ? '<p class="now" id="clock">--:--:--</p>' : ''}
        <div class="bigstats">
          ${isToday
            ? `<div class="good"><b data-count="${inside}">${inside}</b><span>داخل الدوام الآن</span></div><div class="${onLeave ? 'warn' : ''}"><b data-count="${onLeave}">${onLeave}</b><span>في خروج مؤقت</span></div>`
            : `<div class="good"><b data-count="${c('present', 'late', 'partial')}">0</b><span>حضروا</span></div>`}
          <div class="${c('late') ? 'warn' : ''}"><b data-count="${c('late')}">0</b><span>متأخرون</span></div>
          <div class="${c('absent', 'partial', 'not_arrived') ? 'bad' : ''}"><b data-count="${c('absent', 'partial', 'not_arrived')}">0</b><span>${isToday ? 'غائبون أو لم يصلوا' : 'غياب كلي أو جزئي'}</span></div>
        </div>
        <div class="tools">
          <input type="date" id="dd" value="${date}" max="${today()}" aria-label="التاريخ">
          <a class="btn ghost" href="/report/daily?date=${date}" target="_blank" rel="noopener">${icon('file')}التقرير اليومي</a>
          <a class="btn ghost" href="/report/daily.pdf?date=${date}">${icon('down')}PDF</a>
          <a class="btn" href="/api/export/daily?date=${date}">${icon('down')}تصدير Excel</a>
        </div>
      </div>
      ${dial(att, date, isToday)}
    </section>

    <div class="band">
      <div><b data-count="${ops?.totalOrders || 0}">0</b><span>طلبات اليوم</span></div>
      <div><b data-count="${ops?.totalAmount || 0}">0</b><span>مبيعات اليوم (ر.س)</span></div>
      <div><b data-count="${mv('orders_prepared')}">0</b><span>طلبات مجهّزة</span></div>
      <div><b data-count="${mv('shipments')}">0</b><span>شحنات</span></div>
      <div><b data-count="${mv('returns_warehouse')}">0</b><span>مرتجعات للمستودع</span></div>
      <div class="${d.pendingRequests ? 'warn' : ''}"><b data-count="${d.pendingRequests}">0</b><span>طلبات فسح ونواقص</span></div>
      <div class="${d.pendingLeaves ? 'warn' : ''}"><b data-count="${d.pendingLeaves}">0</b><span>طلبات إجازة واستئذان</span></div>
      <div class="${flagged ? 'bad' : ''}"><b data-count="${flagged}">0</b><span>بصمات مشبوهة</span></div>
      <div class="${d.openTickets ? 'warn' : ''}"><b data-count="${d.openTickets}">0</b><span>تذاكر مفتوحة</span></div>
    </div>

    ${d.exits.length ? `<section class="panel"><header><h2>أذونات الخروج</h2><span class="muted small">تقدر توافق من واتساب: موافق ج ورقم الطلب</span></header>
      <div class="list">${d.exits.map((x) => `<div class="item exitrow"><div class="top"><b>${esc(x.user_name)} · ${x.minutes} دقيقة</b>${x.status === 'pending' ? pill('بانتظارك', 'warn') : x.left_at ? pill(`خارج منذ ${fmtT(x.left_at)}`, Date.now() > x.left_at + x.minutes * 60000 ? 'bad' : 'info') : pill('موافق، لم يخرج بعد', 'good')}</div>
        <span class="muted small">#${x.id} · ${esc(x.reason)} · طلبه الساعة ${fmtT(x.created_at)}</span>
        ${x.status === 'pending' ? `<div class="acts"><button class="btn sm" data-xa="${x.id}">موافقة</button><button class="btn sm ghost" data-xr="${x.id}">رفض</button></div>` : ''}</div>`).join('')}</div>
    </section>` : ''}
    <section class="panel"><header><h2>الفريق</h2><span class="muted small">الشريط يمثّل اليوم من 6 صباحاً إلى 10 مساءً. اضغط على أي موظف لعرض بصماته وتعديلها</span></header>
      <div class="staff">${att.map((r) => {
        const live = LIVE[r.liveState] || LIVE.out;
        return `<button class="sc" type="button" data-u="${r.userId}" data-n="${esc(r.name)}">
          <span class="glyph" aria-hidden="true">${esc(r.name.slice(0, 1))}</span>
          <div class="top"><div class="who"><span class="avatar">${esc(r.name.slice(0, 1))}</span><b>${esc(r.name)}</b></div>${statusPill(r.status)}</div>
          ${isToday ? `<div>${pill(live[0], live[1])}</div>` : ''}
          ${strip(r, date, isToday)}
          <dl><dt>أول حضور</dt><dd>${fmtT(r.firstIn)}</dd><dt>آخر انصراف</dt><dd>${fmtT(r.lastOut)}</dd>
          <dt>تأخير</dt><dd>${mn(r.lateMinutes)}</dd><dt>خروج</dt><dd>${mn(r.exitMinutes)}</dd><dt>ساعات العمل</dt><dd>${hm(r.presentMinutes)}</dd></dl>
          ${r.flags.length ? `<div>${flagList(r.flags)}</div>` : ''}
        </button>`;
      }).join('') || '<p class="muted">لا يوجد موظفون نشطون.</p>'}</div>
    </section>

    <div class="grid2">
      <section class="panel"><header><h2>الطلبات حسب القناة</h2><a class="link" href="#/ops">تسجيل أو تعديل</a></header>
        ${ops ? channelRibbon(d.channels, ops) : '<p class="muted">لم تُسجَّل عمليات هذا اليوم بعد. سجّلها من صفحة العمليات اليومية.</p>'}
      </section>
      <section class="panel"><header><h2>ملاحظات وإنجازات اليوم</h2><a class="link" href="#/tickets">كل التذاكر</a></header>
        <div class="list">${d.tickets.map((t) => `<button class="item" type="button" data-t="${t.id}"><div class="top"><b>${esc(t.title)}</b>${pill(...TS[t.status])}</div><span class="muted small">${esc(t.user_name)} · ${TK[t.kind]} · ${fmtT(t.created_at)}</span></button>`).join('') || '<p class="muted">لا توجد تذاكر اليوم.</p>'}</div>
      </section>
    </div>
    <div class="grid2">
      <section class="panel"><header><h2>أرقام اليوم</h2><a class="link" href="#/ops">العمليات اليومية</a></header>
        ${table(['البند', 'العدد', 'سجّلها', 'ملاحظات'], d.metrics.map((m) => {
          const v = ops?.metrics?.[m.key];
          return `<tr><td>${esc(m.name)}</td><td>${v ? `<b>${int(v.value)}</b>` : '<span class="muted">لم يُسجَّل</span>'}</td><td>${esc(v?.by || '')}</td><td class="wrap">${esc(v?.note || '')}</td></tr>`;
        }))}
      </section>
      <section class="panel"><header><h2>فواتير البضائع ومرتجعات التجار</h2></header>
        ${table(['النوع', 'التاجر', 'الفاتورة', 'كود المنتج', 'العدد'], d.stock.map((s) => `<tr><td>${pill(STOCK[s.kind], s.kind === 'new_goods' ? 'good' : 'warn')}</td><td>${esc(s.party)}</td><td dir="ltr">${esc(s.invoice_no)}</td><td dir="ltr">${esc(s.sku || s.description)}</td><td>${int(s.quantity)}</td></tr>`), { empty: 'لا يوجد شيء مسجّل اليوم' })}
      </section>
    </div>`);
  $('#dd', pg).onchange = (e) => { sessionStorage.setItem('dash-date', e.target.value || today()); refresh(); };
  $$('[data-u]', pg).forEach((b) => { b.addEventListener('click', () => dayDetail(+b.dataset.u, b.dataset.n, date)); });
  $$('[data-t]', pg).forEach((b) => { b.onclick = () => ticketModal(+b.dataset.t); });
  $$('[data-xa]', pg).forEach((b) => { b.onclick = async () => { if (await act(b, () => api(`/api/leaves/${b.dataset.xa}`, { method: 'PUT', body: { status: 'approved' } }), 'تمت الموافقة ووصل الموظف إشعار')) refresh(); }; });
  $$('[data-xr]', pg).forEach((b) => { b.onclick = async () => {
    const why = prompt('سبب الرفض (اختياري)') ;
    if (why === null) return;
    if (await act(b, () => api(`/api/leaves/${b.dataset.xr}`, { method: 'PUT', body: { status: 'rejected', response: why } }), 'تم الرفض ووصل الموظف إشعار')) refresh();
  }; });
  countUp(pg);
  if (isToday) {
    const tick = () => { const el = $('#clock'); if (el) el.textContent = localIso(nowMs()).slice(11, 19); };
    tick();
    window.__tick = setInterval(tick, 1000);
  }
};

// The working day, 06:00 → 22:00, mapped onto a 300° arc that opens at the bottom.
const DAY_FROM = 6 * 60;
const DAY_TO = 22 * 60;
const minuteOf = (ts) => ((ts + tz * 60000) % 86400000) / 60000;
const hhmmMin = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const clampDay = (m) => Math.min(DAY_TO, Math.max(DAY_FROM, m));

function dial(att, date, isToday) {
  const C = 230;
  const A0 = -150;
  const A1 = 150;
  const ang = (m) => A0 + ((clampDay(m) - DAY_FROM) / (DAY_TO - DAY_FROM)) * (A1 - A0);
  const pt = (r, a) => [C + r * Math.sin((a * Math.PI) / 180), C - r * Math.cos((a * Math.PI) / 180)];
  const arc = (r, m1, m2) => {
    const a = ang(m1);
    const b = ang(m2);
    if (b - a < 0.4) return '';
    const [x1, y1] = pt(r, a);
    const [x2, y2] = pt(r, b);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const n = att.length || 1;
  const inner = 84;
  const outer = 192;
  const step = n > 1 ? (outer - inner) / (n - 1) : 0;
  const sw = Math.max(5, Math.min(12, step * 0.5));
  const now = minuteOf(nowMs());
  let idx = 0;
  const seg = (cls, r, m1, m2, w) => {
    const p = arc(r, m1, m2);
    return p ? `<path class="seg ${cls}" d="${p}" pathLength="1" stroke-width="${w}" style="--i:${idx++}"/>` : '';
  };

  const rings = att.map((row, i) => {
    const r = inner + i * step;
    const tracks = row.periods.map((p) => {
      const d = arc(r, hhmmMin(p.start), hhmmMin(p.end));
      return d ? `<path class="track" d="${d}" pathLength="1" stroke-width="${sw}" style="--i:${i}"/>` : '';
    }).join('');
    const late = row.periods.filter((p) => p.late > 0).map((p) => {
      const end = p.firstIn ? minuteOf(p.firstIn) : now;
      return seg('l', r, hhmmMin(p.start), end, Math.max(2, sw * 0.35));
    }).join('');
    const pres = (row.intervals || []).map(([a, b]) => seg('p', r, minuteOf(a), minuteOf(b), sw)).join('');
    const exits = (row.exits || []).map((x) => seg('x', r, minuteOf(x.start), minuteOf(x.end), Math.max(2, sw * 0.35))).join('');
    const [lx, ly] = pt(r, A0 - 4);
    const tip = `${row.name}: ${(STATUS[row.status] || [row.status])[0]} · حضور ${fmtT(row.firstIn)} · تأخير ${row.lateMinutes} د · عمل ${hm(row.presentMinutes)}`;
    return `<g class="ring" data-u="${row.userId}" data-n="${esc(row.name)}"><title>${esc(tip)}</title>
      <path d="${arc(r, DAY_FROM, DAY_TO)}" stroke="transparent" stroke-width="${step || 20}" fill="none"/>
      ${tracks}${late}${pres}${exits}<text class="name" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="end">${esc(row.name)}</text></g>`;
  }).join('');

  let ticks = '';
  for (let h = 6; h <= 22; h++) {
    const a = ang(h * 60);
    const major = h % 3 === 0;
    const [x1, y1] = pt(outer + 14, a);
    const [x2, y2] = pt(outer + (major ? 24 : 19), a);
    ticks += `<line class="tick ${major ? 'major' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    if (major) {
      const [tx, ty] = pt(outer + 38, a);
      ticks += `<text class="hl" x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" text-anchor="middle">${h > 12 ? h - 12 : h}${h < 12 ? 'ص' : 'م'}</text>`;
    }
  }
  let hand = '';
  if (isToday && now >= DAY_FROM && now <= DAY_TO) {
    const [hx, hy] = pt(outer + 12, ang(now));
    const [bx, by] = pt(inner - 22, ang(now));
    hand = `<line class="hand" x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}"/><circle class="handdot" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="4"/>`;
  }
  const present = isToday ? att.filter((r) => r.liveState === 'in').length : att.filter((r) => r.presentMinutes > 0).length;
  return `<figure class="dial" style="margin:0" aria-label="دوام الفريق على مدار اليوم">
    <svg viewBox="-20 -20 500 500" role="img">
      <defs>
        <linearGradient id="foilStroke" gradientUnits="userSpaceOnUse" x1="20" y1="420" x2="440" y2="60"><stop offset="0" stop-color="#12b39d"/><stop offset=".3" stop-color="#4f86f7"/><stop offset=".55" stop-color="#7b55f0"/><stop offset=".8" stop-color="#e2569c"/><stop offset="1" stop-color="#ee9a37"/></linearGradient>
        <linearGradient id="foilText" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17131f"/><stop offset=".55" stop-color="#5b3fd1"/><stop offset="1" stop-color="#0e8f80"/></linearGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <radialGradient id="core"><stop offset="0" stop-color="rgb(171 134 255 / 22%)"/><stop offset=".6" stop-color="rgb(95 227 203 / 8%)"/><stop offset="1" stop-color="rgb(95 227 203 / 0%)"/></radialGradient>
      </defs>
      <circle cx="${C}" cy="${C}" r="${inner - 14}" fill="url(#core)"/>
      <circle class="orbit" cx="${C}" cy="${C}" r="${outer + 52}"/><circle class="orbit b" cx="${C}" cy="${C}" r="${inner - 26}"/>
      ${ticks}${rings}${hand}
      <g class="center"><text class="n" x="${C}" y="${C + 14}">${present}<tspan font-size="24" fill="#7d7690">/${att.length}</tspan></text>
      <text class="t" x="${C}" y="${C + 38}">${isToday ? 'داخل الدوام' : 'حضروا'}</text></g>
    </svg>
    <figcaption class="legend"><span><i style="background:var(--foil)"></i>حضور</span><span><i style="background:var(--warn)"></i>تأخير</span><span><i style="background:repeating-linear-gradient(90deg,var(--bad) 0 3px,transparent 3px 6px)"></i>خروج مؤقت</span><span><i style="background:rgb(28 22 52 / 12%)"></i>وقت الدوام</span></figcaption>
  </figure>`;
}

/** The same day as a horizontal strip, for each staff card. */
function strip(row, date, isToday) {
  const pos = (m) => ((clampDay(m) - DAY_FROM) / (DAY_TO - DAY_FROM)) * 100;
  const bar = (cls, m1, m2) => {
    const a = pos(m1);
    const w = pos(m2) - a;
    return w > 0.2 ? `<i class="${cls}" style="inset-inline-start:${a.toFixed(2)}%;width:${w.toFixed(2)}%"></i>` : '';
  };
  const now = minuteOf(nowMs());
  return `<div><div class="strip">
      ${row.periods.map((p) => bar('sch', hhmmMin(p.start), hhmmMin(p.end))).join('')}
      ${row.periods.filter((p) => p.late > 0).map((p) => bar('lt', hhmmMin(p.start), p.firstIn ? minuteOf(p.firstIn) : now)).join('')}
      ${(row.intervals || []).map(([a, b]) => bar('pr', minuteOf(a), minuteOf(b))).join('')}
      ${(row.exits || []).map((x) => bar('ex', minuteOf(x.start), minuteOf(x.end))).join('')}
      ${isToday && now > DAY_FROM && now < DAY_TO ? `<i class="nw" style="inset-inline-start:${pos(now).toFixed(2)}%"></i>` : ''}
    </div><div class="strip-axis"><span>6ص</span><span>12م</span><span>6م</span><span>10م</span></div></div>`;
}

function channelRibbon(channels, ops) {
  const total = channels.reduce((t, ch) => t + (ops.channels[ch.key]?.count || 0), 0);
  const shade = (i) => ['var(--teal)', 'var(--violet)', 'var(--rose)', 'var(--amber)', 'var(--sky)'][i % 5];
  return `<div class="ribbon">
    <div class="total"><b class="silver">${int(total)}</b><span class="muted">طلب · ${money(ops.totalAmount)} ر.س</span></div>
    <div class="flow" role="img" aria-label="توزيع الطلبات على القنوات">${channels.map((ch, i) => {
      const n = ops.channels[ch.key]?.count || 0;
      return n ? `<span style="flex:${n};background:${shade(i)};--c:${shade(i)};--i:${i}" title="${esc(ch.name)}: ${n}"></span>` : '';
    }).join('')}</div>
    <div class="keys">${channels.map((ch, i) => {
      const n = ops.channels[ch.key]?.count || 0;
      return `<div style="--c:${shade(i)}"><b>${int(n)}</b><span>${esc(ch.name)} · ${total ? Math.round((n / total) * 100) : 0}% · ${money(ops.channels[ch.key]?.amount)} ر.س</span></div>`;
    }).join('')}</div>
  </div>`;
}

/** Numbers roll up to their value once, on first paint. */
function countUp(root) {
  const els = $$('[data-count]', root);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { els.forEach((el) => { el.textContent = int(el.dataset.count); }); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 1100);
    const e = 1 - (1 - k) ** 3;
    els.forEach((el) => { el.textContent = int(Math.round(+el.dataset.count * e)); });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Punches for one employee on one day, with manual add and void. */
async function dayDetail(userId, name, date) {
  const { punches } = await api(`/api/punches?date=${date}&user_id=${userId}`);
  modal(`${name} · ${fmtDate(date)}`, `
    ${table(['الوقت', 'النوع', 'بواسطة', 'ملاحظة', 'مؤشرات', ''], punches.map((p) => `<tr style="${p.voided ? 'opacity:.45;text-decoration:line-through' : ''}">
      <td>${fmtT(p.ts)}</td><td>${PUNCH[p.type]}</td><td>${p.source === 'manager' ? 'المدير' : 'الموظف'}</td><td class="wrap">${esc(p.note)}</td>
      <td class="wrap">${flagList(p.flags)}${p.lat ? ` <a class="link" href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">الموقع</a>` : ''}${p.ip ? `<div class="muted small" dir="ltr">${esc(p.ip)}</div>` : ''}</td>
      <td>${p.voided ? 'ملغاة' : `<button class="link bad" data-void="${p.id}">إلغاء</button>`}</td></tr>`), { empty: 'لا توجد بصمات' })}
    <form class="form" id="voidF" hidden><div class="row"><label class="f">سبب إلغاء البصمة<input name="reason" id="void-reason" required></label><button class="btn danger" type="submit">تأكيد الإلغاء</button></div></form>
    <form class="form" id="addF"><h3>إضافة بصمة يدوياً</h3>
      <div class="row">
        <label class="f">النوع<select name="type" id="add-type">${Object.entries(PUNCH).map(([k, v]) => opt(k, v)).join('')}</select></label>
        <label class="f">الوقت<input type="time" name="time" id="add-time" required></label>
      </div>
      <label class="f">السبب<input name="note" id="add-note" required placeholder="مثال: نسي تسجيل الانصراف، تعطل الجوال"></label>
      <p class="muted small">البصمات اليدوية تظهر بعلامة «أدخلها المدير» وتُحفظ في سجل التعديلات.</p>
      <button class="btn" type="submit">إضافة</button>
    </form>`, (dl) => {
    let voidId = null;
    $$('[data-void]', dl).forEach((b) => { b.onclick = () => { voidId = +b.dataset.void; $('#voidF', dl).hidden = false; $('#void-reason', dl).focus(); }; });
    $('#voidF', dl).onsubmit = async (e) => {
      e.preventDefault();
      const ok = await act($('button', e.target), () => api(`/api/punches/${voidId}`, { method: 'DELETE', body: formData(e.target) }), 'أُلغيت البصمة');
      if (ok) { dl.close(); refresh(); }
    };
    $('#addF', dl).onsubmit = async (e) => {
      e.preventDefault();
      const ok = await act($('button[type=submit]', e.target), () => api('/api/punches', { method: 'POST', body: { ...formData(e.target), user_id: userId, date } }), 'أُضيفت البصمة');
      if (ok) { dl.close(); refresh(); }
    };
  });
}

// ------------------------------------------------------------------ manager: attendance
let staffCache = null;
async function staffList() {
  if (!staffCache) staffCache = (await api('/api/staff')).users;
  return staffCache;
}
const staffOptions = (list, sel, all = 'كل الموظفين') => `${all ? opt('', all, sel) : ''}${list.filter((u) => u.active).map((u) => opt(u.id, u.name, sel)).join('')}`;

PAGES.attendance = async () => {
  const st = JSON.parse(sessionStorage.getItem('att') || 'null') || { from: addDays(today(), -6), to: today(), user: '' };
  const [d, staff, ex] = await Promise.all([
    api(`/api/attendance?from=${st.from}&to=${st.to}&user_id=${st.user}`), staffList(), api(`/api/excuses?from=${addDays(today(), -60)}&to=${addDays(today(), 60)}`),
  ]);
  if (!Object.keys(FLAGS).length) FLAGS = (await api(`/api/flags?from=${today()}&to=${today()}`)).labels;
  const mny = ME.role === 'admin';
  const pg = render(`
    <div class="topline"><h1>الحضور والانصراف</h1>
      <form class="tools" id="flt">
        <input type="date" name="from" id="f-from" value="${st.from}" aria-label="من">
        <input type="date" name="to" id="f-to" value="${st.to}" aria-label="إلى">
        <select name="user" id="f-user" aria-label="الموظف">${staffOptions(staff, st.user)}</select>
        <a class="btn ghost" href="/api/export/attendance?from=${st.from}&to=${st.to}">${icon('down')}تصدير</a>
      </form></div>
    <section class="panel"><header><h2>الملخص</h2><span class="muted small">${st.from} إلى ${st.to}</span></header>
      ${table(['الموظف', 'أيام العمل', 'حضور', 'غياب', 'غياب جزئي', 'أيام تأخير', 'دقائق التأخير', 'انصراف مبكر', 'خروج أثناء الدوام', 'إضافي', ...(mny ? ['الخصم المقترح (ر.س)'] : [])],
        d.summary.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${s.workDays}</td><td>${s.presentDays}</td><td>${s.absentDays ? pill(s.absentDays, 'bad') : 0}</td><td>${s.partialDays}</td><td>${s.lateDays}</td><td>${mn(s.lateMinutes)}</td><td>${mn(s.earlyMinutes)}</td><td>${mn(s.exitMinutes)}</td><td>${hm(s.overtimeMinutes)}</td>${mny ? `<td>${money(s.suggested)}</td>` : ''}</tr>`))}
      <p class="muted small" ${mny ? '' : 'hidden'}>الخصم المقترح يُحسب من الراتب: أجر اليوم = الراتب ÷ 30، مقسوماً على دقائق دوام ذلك اليوم. لا يُخصم شيء إلا إذا اعتمدته من صفحة الرواتب أو الخصومات.</p>
    </section>
    <section class="panel"><header><h2>التفاصيل اليومية</h2><span class="muted small">اضغط على أي صف لعرض البصمات</span></header>
      ${table(['اليوم', 'الموظف', 'الحالة', 'الحضور', 'الانصراف', 'تأخير', 'انصراف مبكر', 'خروج', 'ساعات العمل', 'إضافي', ...(mny ? ['مقترح'] : []), 'ملاحظات'],
        d.rows.slice().sort((a, b) => b.date.localeCompare(a.date) || a.userId - b.userId).map((r) => `<tr class="click" data-u="${r.userId}" data-n="${esc(r.name)}" data-d="${r.date}">
          <td>${fmtDate(r.date)}</td><td>${esc(r.name)}</td><td>${statusPill(r.status)}</td><td>${fmtT(r.firstIn)}</td><td>${fmtT(r.lastOut)}</td><td>${mn(r.lateMinutes)}</td><td>${mn(r.earlyMinutes)}</td><td>${mn(r.exitMinutes)}</td><td>${hm(r.presentMinutes)}</td><td>${hm(r.overtimeMinutes)}</td>${mny ? `<td>${r.suggested ? money(r.suggested) : '—'}</td>` : ''}<td>${flagList(r.flags)}</td></tr>`))}
    </section>
    <section class="panel"><header><h2>الإجازات والأعذار</h2><span class="muted small">الأيام المعذورة لا يُحسب فيها غياب ولا تأخير</span></header>
      <form class="form" id="exF"><div class="row">
        <label class="f">النوع<select name="kind" id="ex-kind">${Object.entries(EXC).map(([k, v]) => opt(k, v)).join('')}</select></label>
        <label class="f" id="ex-user-l">الموظف<select name="user_id" id="ex-user">${staffOptions(staff, '', 'اختر الموظف')}</select></label>
        <label class="f">من<input type="date" name="from" id="ex-from" value="${today()}" required></label>
        <label class="f">إلى<input type="date" name="to" id="ex-to" value="${today()}" required></label>
      </div><div class="row"><label class="f">ملاحظة<input name="note" id="ex-note"></label><button class="btn" type="submit" style="flex:0 0 auto">حفظ</button></div></form>
      ${table(['التاريخ', 'الموظف', 'النوع', 'ملاحظة', ''], ex.excuses.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.user_name || 'الجميع')}</td><td>${EXC[e.kind]}</td><td class="wrap">${esc(e.note)}</td><td><button class="link bad" data-ex="${e.id}">حذف</button></td></tr>`), { empty: 'لا توجد إجازات أو أعذار مسجّلة' })}
    </section>`);
  $('#flt', pg).onchange = (e) => { sessionStorage.setItem('att', JSON.stringify(formData(e.currentTarget))); refresh(); };
  $$('tr[data-u]', pg).forEach((tr) => { tr.onclick = () => dayDetail(+tr.dataset.u, tr.dataset.n, tr.dataset.d); });
  const kind = $('#ex-kind', pg);
  kind.onchange = () => { $('#ex-user-l', pg).hidden = kind.value === 'holiday'; };
  $('#exF', pg).onsubmit = async (e) => {
    e.preventDefault();
    if (await act($('button', e.target), () => api('/api/excuses', { method: 'POST', body: formData(e.target) }), 'تم الحفظ')) refresh();
  };
  $$('[data-ex]', pg).forEach((b) => { b.onclick = async () => { if (await act(b, () => api(`/api/excuses/${b.dataset.ex}`, { method: 'DELETE' }), 'تم الحذف')) refresh(); }; });
};

// ------------------------------------------------------------------ manager: payroll
PAGES.payroll = async () => {
  const month = sessionStorage.getItem('pay-month') || thisMonth();
  const d = await api(`/api/payroll?month=${month}`);
  const sum = (k) => d.rows.reduce((t, r) => t + r[k], 0);
  const pg = render(`
    <div class="topline"><h1>مسيّر الرواتب</h1><div class="tools"><input type="month" id="pm" value="${month}" aria-label="الشهر">
      <a class="btn ghost" href="/api/export/payroll?month=${month}">${icon('down')}تصدير Excel</a>
      ${d.closed ? `<button class="btn ghost" id="pay-send" type="button">إعادة إرسال القسائم</button><button class="btn ghost" id="pay-open" type="button">فتح الشهر</button>`
        : `<button class="btn" id="pay-close" type="button">إقفال الشهر وإرسال القسائم</button>`}</div></div>
    <section class="panel closebar ${d.closed ? 'done' : ''}">
      ${d.closed
        ? `<p>${pill('مقفل', 'good')} أُقفل ${esc(d.closed.by ? `بواسطة ${d.closed.by} ` : '')}يوم ${new Date(d.closed.at + tz * 60000).toISOString().slice(0, 10)}. الأرقام مجمّدة، والخصومات والسلف لهذا الشهر لا تتغير حتى تفتحه.</p>`
        : `<p>${pill('مفتوح', 'warn')} الأرقام تتحدث مع كل بصمة وخصم. في نهاية الشهر اضغط «إقفال الشهر»: يتجمّد المسيّر وتوصل كل موظف قسيمة راتبه على واتساب.</p>`}
    </section>
    <section class="panel">
      ${table(['الموظف', 'الراتب', 'حضور', 'غياب', 'أيام تأخير', 'دقائق التأخير', 'خروج', 'الخصم المقترح', 'الخصومات المعتمدة', 'أقساط السلف', 'الصافي', 'متبقي السلف', ''],
        d.rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${money(r.salary)}</td><td>${r.presentDays}/${r.workDays}</td><td>${r.absentDays ? pill(r.absentDays, 'bad') : 0}</td><td>${r.lateDays}</td><td>${mn(r.lateMinutes)}</td><td>${mn(r.exitMinutes + r.earlyMinutes)}</td>
          <td>${money(r.suggested)}</td><td>${money(r.deductions)}</td><td>${money(r.repayments)}</td><td><b>${money(r.net)}</b></td><td>${money(r.debtBalance)}</td>
          <td class="nowrap">${d.closed ? '' : `<button class="btn sm ghost" data-ded="${r.userId}" data-amt="${Math.max(0, Math.round((r.suggested - r.deductions) * 100) / 100)}">خصم</button> `}<a class="link" href="/payslip?month=${month}&user_id=${r.userId}" target="_blank" rel="noopener">القسيمة</a></td></tr>`),
        { foot: ['الإجمالي', money(sum('salary')), '', '', '', '', '', money(sum('suggested')), money(sum('deductions')), money(sum('repayments')), money(sum('net')), money(sum('debtBalance')), ''] })}
      <p class="muted small">الصافي = الراتب − الخصومات المعتمدة − أقساط السلف المخصومة من الراتب. الخصم المقترح للاسترشاد فقط ولا يدخل في الصافي حتى تعتمده. ${!d.rows.some((r) => r.salary) ? '<b>أدخل رواتب الموظفين من صفحة الموظفين ليظهر الخصم المقترح.</b>' : ''}</p>
    </section>`);
  $('#pm', pg).onchange = (e) => { sessionStorage.setItem('pay-month', e.target.value || thisMonth()); refresh(); };
  $$('[data-ded]', pg).forEach((b) => { b.onclick = () => deductionModal(+b.dataset.ded, b.dataset.amt); });
  const close = $('#pay-close', pg);
  if (close) close.onclick = async () => {
    if (!confirm(`إقفال مسيّر ${month}؟ تتجمّد الأرقام وتوصل القسائم للموظفين على واتساب.`)) return;
    const r = await act(close, () => api('/api/payroll/close', { method: 'POST', body: { month } }));
    if (r) { toast(`تم الإقفال. أُرسلت ${r.sent} قسيمة`); refresh(); }
  };
  const send = $('#pay-send', pg);
  if (send) send.onclick = async () => { const r = await act(send, () => api('/api/payroll/payslips', { method: 'POST', body: { month } })); if (r) toast(`أُرسلت ${r.sent} قسيمة`); };
  const reopen = $('#pay-open', pg);
  if (reopen) reopen.onclick = async () => {
    if (!confirm('فتح الشهر يسمح بتعديل الخصومات والسلف، وتعود الأرقام تتحدث. متأكد؟')) return;
    if (await act(reopen, () => api(`/api/payroll/close/${month}`, { method: 'DELETE' }), 'تم فتح الشهر')) refresh();
  };
};

async function deductionModal(userId = '', amount = '') {
  const staff = await staffList();
  modal('خصم جديد', `<form class="form" id="dF">${deductionFields(staff, userId, amount)}<button class="btn" type="submit">اعتماد الخصم</button></form>`, (dl) => {
    $('#dF', dl).onsubmit = async (e) => {
      e.preventDefault();
      if (await act($('button', e.target), () => api('/api/deductions', { method: 'POST', body: formData(e.target) }), 'تم اعتماد الخصم')) { dl.close(); refresh(); }
    };
  });
}
const deductionFields = (staff, userId = '', amount = '') => `
  <div class="row">
    <label class="f">الموظف<select name="user_id" id="dd-user" required>${staffOptions(staff, userId, 'اختر الموظف')}</select></label>
    <label class="f">السبب<select name="category" id="dd-cat">${Object.entries(DED).map(([k, v]) => opt(k, v)).join('')}</select></label>
  </div><div class="row">
    <label class="f">المبلغ (ر.س)<input type="number" name="amount" id="dd-amt" min="0.01" step="0.01" value="${amount || ''}" required></label>
    <label class="f">التاريخ<input type="date" name="date" id="dd-date" value="${today()}" required></label>
  </div>
  <label class="f">التفاصيل<input name="reason" id="dd-reason" placeholder="مثال: تأخير 45 دقيقة يوم السبت"></label>`;

// ------------------------------------------------------------------ manager: deductions & debts
PAGES.money = async () => {
  const month = sessionStorage.getItem('money-month') || thisMonth();
  const from = `${month}-01`;
  const to = addDays(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 1)).toISOString().slice(0, 10), -1);
  const [ded, debts, staff] = await Promise.all([api(`/api/deductions?from=${from}&to=${to}`), api('/api/debts'), staffList()]);
  const pg = render(`
    <div class="topline"><h1>الخصومات والسلف</h1><div class="tools"><a class="btn ghost" href="/api/export/debts">${icon('down')}تصدير السلف</a></div></div>
    <div class="kpis">${debts.balances.map((b) => `<div class="kpi ${b.balance > 0 ? 'warn' : ''}"><b>${money(b.balance)}</b><span>${esc(b.name)}: متبقي السلف</span></div>`).join('')}</div>
    <div class="grid2">
      <section class="panel"><header><h2>تسجيل خصم</h2></header>
        <form class="form" id="dF">${deductionFields(staff)}<button class="btn" type="submit">اعتماد الخصم</button></form>
      </section>
      <section class="panel"><header><h2>تسجيل سلفة أو سداد</h2></header>
        <form class="form" id="lF">
          <div class="row">
            <label class="f">الموظف<select name="user_id" id="ln-user" required>${staffOptions(staff, '', 'اختر الموظف')}</select></label>
            <label class="f">النوع<select name="kind" id="ln-kind">${opt('loan', 'سلفة جديدة')}${opt('repayment', 'سداد / قسط')}</select></label>
          </div><div class="row">
            <label class="f">المبلغ (ر.س)<input type="number" name="amount" id="ln-amt" min="0.01" step="0.01" required></label>
            <label class="f">التاريخ<input type="date" name="date" id="ln-date" value="${today()}" required></label>
          </div>
          <label class="check" id="ln-sal-l" hidden><input type="checkbox" name="from_salary" id="ln-sal" checked>يُخصم من الراتب (وإلا فهو سداد نقدي)</label>
          <label class="f">ملاحظة<input name="note" id="ln-note"></label>
          <button class="btn" type="submit">حفظ</button>
        </form>
      </section>
    </div>
    <section class="panel"><header><h2>الخصومات</h2><input type="month" id="mm" value="${month}" aria-label="الشهر"></header>
      ${table(['التاريخ', 'الموظف', 'السبب', 'المبلغ', 'التفاصيل', ''], ded.deductions.map((x) => `<tr><td>${x.date}</td><td>${esc(x.user_name)}</td><td>${DED[x.category]}</td><td><b>${money(x.amount)}</b></td><td class="wrap">${esc(x.reason)}</td><td><button class="link bad" data-dd="${x.id}">حذف</button></td></tr>`),
        { empty: 'لا توجد خصومات في هذا الشهر', foot: ded.deductions.length ? ['', '', 'الإجمالي', money(ded.deductions.reduce((t, x) => t + x.amount, 0)), '', ''] : null })}
    </section>
    <section class="panel"><header><h2>سجل السلف</h2></header>
      ${table(['التاريخ', 'الموظف', 'النوع', 'المبلغ', 'من الراتب', 'ملاحظة', ''], debts.debts.map((x) => `<tr><td>${x.date}</td><td>${esc(x.user_name)}</td><td>${x.kind === 'loan' ? pill('سلفة', 'warn') : pill('سداد', 'good')}</td><td>${money(x.amount)}</td><td>${x.kind === 'repayment' ? (x.from_salary ? 'نعم' : 'نقداً') : '—'}</td><td class="wrap">${esc(x.note)}</td><td><button class="link bad" data-dl="${x.id}">حذف</button></td></tr>`), { empty: 'لا توجد سلف' })}
    </section>`);
  $('#mm', pg).onchange = (e) => { sessionStorage.setItem('money-month', e.target.value || thisMonth()); refresh(); };
  $('#ln-kind', pg).onchange = (e) => { $('#ln-sal-l', pg).hidden = e.target.value !== 'repayment'; };
  $('#dF', pg).onsubmit = async (e) => { e.preventDefault(); if (await act($('button', e.target), () => api('/api/deductions', { method: 'POST', body: formData(e.target) }), 'تم اعتماد الخصم')) refresh(); };
  $('#lF', pg).onsubmit = async (e) => { e.preventDefault(); if (await act($('button', e.target), () => api('/api/debts', { method: 'POST', body: formData(e.target) }), 'تم الحفظ')) refresh(); };
  confirmDelete(pg, '[data-dd]', (id) => `/api/deductions/${id}`);
  confirmDelete(pg, '[data-dl]', (id) => `/api/debts/${id}`);
};

/** Two-step delete: first click arms the button, second click deletes. */
function confirmDelete(root, sel, urlOf) {
  $$(sel, root).forEach((b) => {
    b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'تأكيد الحذف؟'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'حذف'; }, 4000); return; }
      const id = Object.values(b.dataset).find((v) => /^\d+$/.test(v));
      if (await act(b, () => api(urlOf(id), { method: 'DELETE' }), 'تم الحذف')) refresh();
    };
  });
}

// ------------------------------------------------------------------ daily operations (manager + allowed staff)
PAGES.ops = async () => {
  const date = sessionStorage.getItem('ops-date') || today();
  const d = await api(`/api/ops?from=${addDays(today(), -30)}&to=${today()}`);
  const day = d.ops.find((o) => o.date === date) || { channels: {}, metrics: {}, notes: '' };
  const isAdmin = ME.role === 'admin';
  const may = (p) => isAdmin || ME.perms.includes(p);
  const myMetrics = d.metrics.filter((m) => may(`m:${m.key}`));
  const SCAN_OF = { shipments: 'shipment', returns_warehouse: 'return' };
  const scanned = (key) => !!(SCAN_OF[key] && d.scans?.[date]?.[SCAN_OF[key]]);
  const tot = (k) => d.ops.reduce((t, o) => t + (o[k] || 0), 0);
  const mtot = (k) => d.ops.reduce((t, o) => t + (o.metrics[k]?.value || 0), 0);
  const tooOld = !isAdmin && date < addDays(today(), -3);

  const ordersPanel = may('orders') ? `<section class="panel"><header><h2>طلبات القنوات</h2><span class="muted small">عدد الطلبات ومبلغها لكل قناة</span></header>
    <form class="form" id="oF">
      ${table(['القناة', 'عدد الطلبات', 'المبلغ (ر.س)'], d.channels.map((c) => `<tr><td><b>${esc(c.name)}</b></td>
        <td><input type="number" min="0" step="1" inputmode="numeric" name="c_${c.key}" id="c-${c.key}" value="${day.channels[c.key]?.count ?? ''}" placeholder="0" aria-label="طلبات ${esc(c.name)}"></td>
        <td><input type="number" min="0" step="0.01" inputmode="decimal" name="a_${c.key}" id="a-${c.key}" value="${day.channels[c.key]?.amount ?? ''}" placeholder="0" aria-label="مبلغ ${esc(c.name)}"></td></tr>`))}
      <label class="f">ملاحظات اليوم<textarea name="notes" id="o-notes" placeholder="أي شيء مهم: تأخر شركة شحن، نفاد منتج...">${esc(day.notes)}</textarea></label>
      <button class="btn" type="submit" ${tooOld ? 'disabled' : ''}>حفظ طلبات ${fmtDate(date)}</button>
    </form></section>` : '';

  const metricsPanel = myMetrics.length ? `<section class="panel"><header><h2>${isAdmin ? 'الأرقام اليومية' : 'أرقامي اليومية'}</h2><span class="muted small">${fmtDate(date)}</span></header>
    <form class="form" id="mF">
      ${myMetrics.map((m) => `<div class="row">
        <label class="f">${esc(m.name)}${scanned(m.key) ? ' <span class="pill good" style="font-size:.72rem">من الباركود</span>' : ''}<input type="number" min="0" step="1" inputmode="numeric" name="v_${m.key}" id="m-${m.key}" value="${day.metrics[m.key]?.value ?? ''}" placeholder="0" ${scanned(m.key) ? 'disabled' : ''}></label>
        ${m.note ? `<label class="f" style="flex:2 1 220px">ملاحظات ${esc(m.name)}<textarea name="n_${m.key}" id="mn-${m.key}" rows="2" placeholder="اكتب تفاصيل كل إشكالية...">${esc(day.metrics[m.key]?.note || '')}</textarea></label>` : ''}
        ${day.metrics[m.key]?.by && isAdmin ? `<span class="muted small" style="flex:0 0 auto">سجّلها ${esc(day.metrics[m.key].by)}</span>` : ''}
      </div>`).join('')}
      <button class="btn" type="submit" ${tooOld ? 'disabled' : ''}>حفظ الأرقام</button>
    </form></section>` : '';

  const stockPanel = may('stock') ? `<section class="panel"><header><h2>فواتير البضائع ومرتجعات التجار</h2></header>
    <form class="form" id="sF">
      <div class="seg" role="radiogroup" aria-label="النوع"><button type="button" class="on" data-k="new_goods">فاتورة بضاعة جديدة</button><button type="button" data-k="merchant_return">أصناف أُرجعت للتاجر</button></div>
      <input type="hidden" name="kind" id="s-kind" value="new_goods">
      <div class="row">
        <label class="f">التاجر<input name="party" id="s-party" required></label>
        <label class="f" id="s-inv-l">رقم الفاتورة<input name="invoice_no" id="s-inv" dir="ltr"></label>
        <label class="f">التاريخ<input type="date" name="date" id="s-date" value="${date}" max="${today()}"></label>
      </div>
      <div id="lines">${lineRow(0)}</div>
      <button type="button" class="link" id="addLine" style="justify-self:start">+ إضافة صنف</button>
      <label class="f">ملاحظة<input name="note" id="s-note"></label>
      <button class="btn" type="submit">حفظ</button>
    </form></section>` : '';

  const pg = render(`
    <div class="topline"><h1>العمليات اليومية</h1><div class="tools">
      <input type="date" id="od" value="${date}" max="${today()}" aria-label="التاريخ">
      ${isAdmin ? `<a class="btn ghost" href="/api/export/ops?from=${addDays(today(), -30)}&to=${today()}">${icon('down')}تصدير</a>` : ''}</div></div>
    ${tooOld ? '<p class="muted">التعديل متاح لآخر 3 أيام فقط. للتعديل على يوم أقدم تواصل مع المدير.</p>' : ''}
    <div class="grid2">${ordersPanel}${metricsPanel}</div>
    ${stockPanel}
    <section class="panel"><header><h2>آخر 30 يوماً</h2><span class="muted small">اضغط على يوم لعرضه وتعديله</span></header>
      ${table(['اليوم', ...(may('orders') ? [...d.channels.map((c) => esc(c.name)), 'الإجمالي', 'المبلغ'] : []), ...myMetrics.map((m) => esc(m.name)), 'ملاحظات'],
        d.ops.map((o) => `<tr class="click" data-od="${o.date}"><td>${fmtDate(o.date)}</td>
          ${may('orders') ? `${d.channels.map((c) => `<td>${int(o.channels[c.key]?.count)}</td>`).join('')}<td><b>${int(o.totalOrders)}</b></td><td>${money(o.totalAmount)}</td>` : ''}
          ${myMetrics.map((m) => `<td>${o.metrics[m.key] ? int(o.metrics[m.key].value) : '—'}</td>`).join('')}
          <td class="wrap">${esc([o.notes, ...myMetrics.map((m) => o.metrics[m.key]?.note).filter(Boolean)].filter(Boolean).join(' · '))}</td></tr>`),
        { empty: 'لم يُسجَّل شيء بعد', foot: d.ops.length ? ['الإجمالي', ...(may('orders') ? [...d.channels.map((c) => int(d.ops.reduce((t, o) => t + (o.channels[c.key]?.count || 0), 0))), int(tot('totalOrders')), money(tot('totalAmount'))] : []), ...myMetrics.map((m) => int(mtot(m.key))), ''] : null })}
    </section>
    ${may('stock') ? `<section class="panel"><header><h2>سجل الفواتير والمرتجعات للتجار</h2></header>
      ${table(['التاريخ', 'النوع', 'التاجر', 'رقم الفاتورة', 'كود المنتج', 'العدد', 'القيمة', 'ملاحظة', 'سجّلها', 'حالة المرتجع', ...(isAdmin ? [''] : [])],
        d.stock.map((s) => `<tr><td>${s.date}</td><td>${pill(STOCK[s.kind], s.kind === 'new_goods' ? 'good' : 'warn')}</td><td>${esc(s.party)}</td><td dir="ltr">${esc(s.invoice_no)}</td><td dir="ltr"><b>${esc(s.sku || s.description)}</b></td><td>${int(s.quantity)}</td><td>${s.value ? money(s.value) : '—'}</td><td class="wrap">${esc(s.note)}</td><td>${esc(s.created_by_name || '')}</td>
          <td>${s.kind === 'merchant_return' ? `<button class="pillbtn" type="button" data-rs="${s.id}" title="${esc(s.status_note)}">${pill(...(RET[s.status] || RET.ready))}</button>` : ''}</td>${isAdmin ? `<td><button class="link bad" data-sd="${s.id}">حذف</button></td>` : ''}</tr>`),
        { empty: 'لا توجد سجلات' })}
    </section>` : ''}`);

  $('#od', pg).onchange = (e) => { sessionStorage.setItem('ops-date', e.target.value || today()); refresh(); };
  $$('tr[data-od]', pg).forEach((tr) => { tr.onclick = () => { sessionStorage.setItem('ops-date', tr.dataset.od); refresh(); }; });
  const oF = $('#oF', pg);
  if (oF) oF.onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const channels = Object.fromEntries(d.channels.map((c) => [c.key, { count: f[`c_${c.key}`] || 0, amount: f[`a_${c.key}`] || 0 }]));
    if (await act($('button[type=submit]', e.target), () => api(`/api/ops/${date}`, { method: 'PUT', body: { channels, notes: f.notes } }), 'تم حفظ الطلبات')) refresh();
  };
  const mF = $('#mF', pg);
  if (mF) mF.onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const metrics = Object.fromEntries(myMetrics.filter((m) => !scanned(m.key) && (f[`v_${m.key}`] !== '' || f[`n_${m.key}`])).map((m) => [m.key, { value: f[`v_${m.key}`] || 0, note: f[`n_${m.key}`] || '' }]));
    if (!Object.keys(metrics).length) return toast('اكتب رقماً واحداً على الأقل', true);
    if (await act($('button[type=submit]', e.target), () => api(`/api/ops/${date}`, { method: 'PUT', body: { metrics } }), 'تم حفظ الأرقام')) refresh();
  };
  const sF = $('#sF', pg);
  if (sF) {
    let n = 1;
    $('#addLine', pg).onclick = () => { $('#lines', pg).insertAdjacentHTML('beforeend', lineRow(n++)); };
    $('#lines', pg).addEventListener('click', (e) => { if (e.target.matches('[data-rmline]') && $$('.line', pg).length > 1) e.target.closest('.line').remove(); });
    $$('.seg button', pg).forEach((b) => { b.onclick = () => {
      $$('.seg button', pg).forEach((x) => x.classList.toggle('on', x === b));
      $('#s-kind', pg).value = b.dataset.k;
      $('#s-inv-l', pg).firstChild.textContent = b.dataset.k === 'new_goods' ? 'رقم الفاتورة' : 'رقم إشعار الإرجاع (اختياري)';
    }; });
    sF.onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const lines = $$('.line', pg).map((l) => ({ sku: $('[name=sku]', l).value.trim(), quantity: $('[name=qty]', l).value, value: $('[name=val]', l).value }))
        .filter((l) => l.sku || l.quantity);
      if (!lines.length) return toast('أضف صنفاً واحداً على الأقل: كود المنتج والعدد', true);
      if (await act($('button[type=submit]', e.target), () => api('/api/stock', { method: 'POST', body: { kind: f.kind, party: f.party, invoice_no: f.invoice_no, date: f.date, note: f.note, lines } }), `تم حفظ ${lines.length} صنف`)) refresh();
    };
  }
  confirmDelete(pg, '[data-sd]', (id) => `/api/stock/${id}`);
  $$('[data-rs]', pg).forEach((b) => { b.onclick = () => {
    const s = d.stock.find((x) => x.id === +b.dataset.rs);
    const siblings = d.stock.filter((x) => x.kind === 'merchant_return' && x.date === s.date && x.party === s.party && x.invoice_no === s.invoice_no).length;
    modal(`مرتجع ${s.sku} · ${s.party}`, `<form class="form" id="rsF">
        <div class="seg" role="radiogroup" aria-label="الحالة">${Object.entries(RET).map(([k, v]) => `<button type="button" data-k="${k}" class="${(s.status || 'ready') === k ? 'on' : ''}">${v[0]}</button>`).join('')}</div>
        <label class="f">ملاحظة (شركة الشحن، رقم البوليصة، مبلغ التسوية...)<input name="note" id="rs-note" value="${esc(s.status_note)}"></label>
        ${siblings > 1 ? `<label class="check"><input type="checkbox" name="all" id="rs-all" checked>طبّقها على كل أصناف هذا الإرسال (${siblings})</label>` : ''}
        <button class="btn" type="submit">حفظ</button></form>`, (dl) => {
      let status = s.status || 'ready';
      $$('.seg button', dl).forEach((x) => { x.onclick = () => { status = x.dataset.k; $$('.seg button', dl).forEach((y) => y.classList.toggle('on', y === x)); }; });
      $('#rsF', dl).onsubmit = async (e) => {
        e.preventDefault();
        const f = formData(e.target);
        if (await act($('button[type=submit]', e.target), () => api(`/api/stock/${s.id}/status`, { method: 'PUT', body: { status, note: f.note, all: !!f.all } }), 'تم التحديث')) { dl.close(); refresh(); }
      };
    });
  }; });
};
const RET = { ready: ['جاهز للإرسال', 'warn'], sent: ['أُرسل للتاجر', 'info'], settled: ['تمت التسوية', 'good'] };

function lineRow(i) {
  return `<div class="row line">
    <label class="f">كود المنتج<input name="sku" id="l-sku-${i}" dir="ltr" autocomplete="off"></label>
    <label class="f">العدد<input name="qty" id="l-qty-${i}" type="number" min="1" step="1" inputmode="numeric"></label>
    <label class="f">القيمة (اختياري)<input name="val" id="l-val-${i}" type="number" min="0" step="0.01" inputmode="decimal"></label>
    <button type="button" class="link bad" data-rmline style="flex:0 0 auto;align-self:center">حذف</button>
  </div>`;
}

// ------------------------------------------------------------------ release & shortage requests
const RQ = { release: 'فسح لإرجاع منتجات', shortage: 'طلب نواقص' };
const RS = { pending: ['بانتظار المدير', 'warn'], approved: ['تمت الموافقة', 'info'], rejected: ['مرفوض', 'bad'], done: ['تم التنفيذ', 'good'] };
PAGES.requests = async () => {
  const isAdmin = ME.manager;
  const status = sessionStorage.getItem('rq-status') || '';
  const d = await api(`/api/requests?status=${status}`);
  const pg = render(`
    <div class="topline"><h1>طلبات الفسح والنواقص</h1><div class="tools">
      <select id="rq-st" aria-label="الحالة">${opt('', 'كل الحالات', status)}${Object.entries(RS).map(([k, v]) => opt(k, v[0], status)).join('')}</select></div></div>
    <div class="grid2">
      ${ME.perms.includes('requests') ? `<section class="panel"><header><h2>طلب جديد</h2></header>
        <form class="form" id="rqF">
          <div class="seg" role="radiogroup" aria-label="نوع الطلب"><button type="button" class="on" data-k="release">فسح لإرجاع منتجات</button><button type="button" data-k="shortage">طلب نواقص</button></div>
          <input type="hidden" name="kind" id="rq-kind" value="release">
          <div class="row">
            <label class="f">كود المنتج<input name="sku" id="rq-sku" dir="ltr" required autocomplete="off"></label>
            <label class="f">العدد<input name="quantity" id="rq-qty" type="number" min="1" step="1" inputmode="numeric" required></label>
          </div>
          <label class="f">السبب<textarea name="reason" id="rq-reason" required placeholder="مثال: عيب مصنعي في الخياطة، أو: نفد المقاس 54 والطلب عليه مستمر"></textarea></label>
          <button class="btn" type="submit">رفع الطلب</button>
        </form></section>` : ''}
      <section class="panel" style="${ME.perms.includes('requests') ? '' : 'grid-column:1/-1'}"><header><h2>${d.requests.length} طلب</h2></header>
        ${table(['#', 'التاريخ', ...(isAdmin ? ['الموظف'] : []), 'النوع', 'كود المنتج', 'العدد', 'السبب', 'الحالة', 'رد المدير'],
          d.requests.map((q) => `<tr class="${isAdmin ? 'click' : ''}" data-rq="${q.id}"><td>${q.id}</td><td>${fmtDate(q.date)}</td>${isAdmin ? `<td>${esc(q.user_name)}</td>` : ''}
            <td>${RQ[q.kind]}</td><td dir="ltr"><b>${esc(q.sku)}</b></td><td>${int(q.quantity)}</td><td class="wrap">${esc(q.reason)}</td><td>${pill(...RS[q.status])}</td><td class="wrap">${esc(q.response) || '—'}</td></tr>`),
          { empty: 'لا توجد طلبات' })}
        ${isAdmin ? '<p class="muted small">اضغط على أي طلب لتغيير حالته أو الرد عليه.</p>' : ''}
      </section>
    </div>`);
  $('#rq-st', pg).onchange = (e) => { sessionStorage.setItem('rq-status', e.target.value); refresh(); };
  const f = $('#rqF', pg);
  if (f) {
    $$('.seg button', pg).forEach((b) => { b.onclick = () => { $$('.seg button', pg).forEach((x) => x.classList.toggle('on', x === b)); $('#rq-kind', pg).value = b.dataset.k; }; });
    f.onsubmit = async (e) => { e.preventDefault(); if (await act($('button[type=submit]', e.target), () => api('/api/requests', { method: 'POST', body: formData(e.target) }), 'تم رفع الطلب')) refresh(); };
  }
  if (isAdmin) {
    $$('tr[data-rq]', pg).forEach((tr) => { tr.onclick = () => {
      const q = d.requests.find((x) => x.id === +tr.dataset.rq);
      modal(`طلب #${q.id} · ${RQ[q.kind]}`, `
        <p><b>${esc(q.user_name)}</b> · ${fmtDate(q.date)} · كود <b dir="ltr">${esc(q.sku)}</b> · العدد ${int(q.quantity)}</p>
        <div class="msg">${esc(q.reason)}</div>
        <form class="form" id="rqU">
          <label class="f">الحالة<select name="status" id="rqu-st">${Object.entries(RS).map(([k, v]) => opt(k, v[0], q.status)).join('')}</select></label>
          <label class="f">رد المدير<textarea name="response" id="rqu-resp">${esc(q.response)}</textarea></label>
          <button class="btn" type="submit">حفظ</button>
        </form>`, (dl) => {
        $('#rqU', dl).onsubmit = async (e) => { e.preventDefault(); if (await act($('button', e.target), () => api(`/api/requests/${q.id}`, { method: 'PUT', body: formData(e.target) }), 'تم الحفظ')) { dl.close(); refresh(); } };
      });
    }; });
  }
};

// ------------------------------------------------------------------ tickets
PAGES.tickets = async () => {
  const isAdmin = ME.manager;
  const st = JSON.parse(sessionStorage.getItem('tk') || 'null') || { status: '', user: '' };
  const [d, staff] = await Promise.all([
    api(`/api/tickets?from=${addDays(today(), -90)}&to=${today()}&status=${st.status}&user_id=${st.user}`),
    isAdmin ? staffList() : Promise.resolve([]),
  ]);
  const pg = render(`
    <div class="topline"><h1>${isAdmin ? 'التذاكر' : 'تذاكري'}</h1>
      <form class="tools" id="tf">
        <select name="status" id="tf-status" aria-label="الحالة">${opt('', 'كل الحالات', st.status)}${Object.entries(TS).map(([k, v]) => opt(k, v[0], st.status)).join('')}</select>
        ${isAdmin ? `<select name="user" id="tf-user" aria-label="الموظف">${staffOptions(staff, st.user)}</select><a class="btn ghost" href="/api/export/tickets?from=${addDays(today(), -30)}&to=${today()}">${icon('down')}تصدير</a>` : ''}
      </form></div>
    <div class="grid2">
      ${ME.role === 'admin' ? '' : `<section class="panel"><header><h2>تذكرة جديدة</h2></header>
        <form class="form" id="nt">
          <div class="row">
            <label class="f">النوع<select name="kind" id="nt-kind">${Object.entries(TK).map(([k, v]) => opt(k, v)).join('')}</select></label>
            <label class="f">الأولوية<select name="priority" id="nt-pri">${Object.entries(PRI).map(([k, v]) => opt(k, v, 'normal')).join('')}</select></label>
          </div>
          <label class="f">العنوان<input name="title" id="nt-title" required maxlength="140" placeholder="مثال: إنجازات اليوم، أو: نقص في كراتين التغليف"></label>
          <label class="f">التفاصيل<textarea name="body" id="nt-body" rows="6" placeholder="جهّزت 34 طلب، رديت على 20 محادثة، استلمت شحنة المورد..."></textarea></label>
          <button class="btn" type="submit">رفع التذكرة</button>
        </form></section>`}
      <section class="panel" style="${ME.role === 'admin' ? 'grid-column:1/-1' : ''}"><header><h2>${d.tickets.length} تذكرة</h2></header>
        <div class="list">${d.tickets.map((t) => `<button class="item" type="button" data-t="${t.id}">
          <div class="top"><b>${esc(t.title)}</b><span>${t.priority === 'high' ? pill('عالية', 'bad') : ''} ${pill(...TS[t.status])}</span></div>
          <span class="muted small">#${t.id} · ${isAdmin ? `${esc(t.user_name)} · ` : ''}${TK[t.kind]} · ${fmtDate(t.date)} ${fmtT(t.created_at)}${t.replies ? ` · ${t.replies} رد` : ''}</span>
        </button>`).join('') || '<p class="muted">لا توجد تذاكر.</p>'}</div>
      </section>
    </div>`);
  $('#tf', pg).onchange = (e) => { sessionStorage.setItem('tk', JSON.stringify(formData(e.currentTarget))); refresh(); };
  $$('[data-t]', pg).forEach((b) => { b.onclick = () => ticketModal(+b.dataset.t); });
  const nt = $('#nt', pg);
  if (nt) nt.onsubmit = async (e) => { e.preventDefault(); if (await act($('button', e.target), () => api('/api/tickets', { method: 'POST', body: formData(e.target) }), 'تم رفع التذكرة')) refresh(); };
};

async function ticketModal(id) {
  const { ticket: t, replies } = await api(`/api/tickets/${id}`);
  const isAdmin = ME.manager;
  modal(`#${t.id} · ${t.title}`, `
    <div class="row" style="align-items:center">${pill(TK[t.kind], 'plain')} ${pill(...TS[t.status])} <span class="muted small">${esc(t.user_name)} · ${fmtDate(t.date)} ${fmtT(t.created_at)} · أولوية ${PRI[t.priority]}</span></div>
    <div class="thread">
      <div class="msg"><div class="meta">${esc(t.user_name)}</div>${esc(t.body) || '<span class="muted">بدون تفاصيل</span>'}</div>
      ${replies.map((r) => `<div class="msg ${r.role === 'admin' ? 'mgr' : ''}"><div class="meta">${esc(r.user_name || '')} · ${fmtDate(new Date(r.created_at + tz * 60000).toISOString().slice(0, 10))} ${fmtT(r.created_at)}</div>${esc(r.body)}</div>`).join('')}
    </div>
    <form class="form" id="rp"><label class="f">ردّ<textarea name="body" id="rp-body" required></textarea></label>
      <div class="row">${isAdmin ? `<label class="f">الحالة<select id="rp-status" name="status">${Object.entries(TS).map(([k, v]) => opt(k, v[0], t.status)).join('')}</select></label>` : ''}<button class="btn" type="submit" style="flex:0 0 auto">إرسال</button></div>
    </form>`, (dl) => {
    const st = $('#rp-status', dl);
    if (st) st.onchange = async () => { if (await act(st, () => api(`/api/tickets/${id}`, { method: 'PUT', body: { status: st.value } }), 'تم تحديث الحالة')) { dl.close(); refresh(); } };
    const body = $('#rp-body', dl);
    body.required = !isAdmin;
    $('#rp', dl).onsubmit = async (e) => {
      e.preventDefault();
      if (!body.value.trim()) return;
      if (await act($('button', e.target), () => api(`/api/tickets/${id}/replies`, { method: 'POST', body: { body: body.value } }), 'تم الإرسال')) { dl.close(); ticketModal(id); }
    };
  });
}

// ------------------------------------------------------------------ manager: manipulation signals
PAGES.flags = async () => {
  const tab = sessionStorage.getItem('flags-tab') || 'punches';
  const d = await api(`/api/flags?from=${addDays(today(), -30)}&to=${today()}`);
  FLAGS = d.labels;
  const ACTIONS = { 'punch.add': 'أضاف بصمة يدوياً', 'punch.void': 'ألغى بصمة', 'deduction.add': 'سجّل خصماً', 'deduction.delete': 'حذف خصماً', 'debt.loan': 'سجّل سلفة', 'debt.repayment': 'سجّل سداد سلفة', 'debt.delete': 'حذف سجل سلفة', 'excuse.add': 'سجّل إجازة أو عذراً', 'excuse.delete': 'حذف إجازة', 'user.add': 'أضاف موظفاً', 'user.update': 'عدّل بيانات موظف', 'settings.update': 'عدّل الإعدادات', 'ops.update': 'عدّل عمليات يوم', 'stock.delete': 'حذف سجل بضاعة' };
  const suspicious = d.punches.filter((p) => p.flags.some((f) => f !== 'manager_entry'));
  const pg = render(`
    <div class="topline"><div><h1>مؤشرات التلاعب</h1><p class="muted">آخر 30 يوماً. هذه مؤشرات للمراجعة وليست إدانة.</p></div></div>
    <div class="seg" role="tablist">
      <button type="button" data-tab="punches" class="${tab === 'punches' ? 'on' : ''}">بصمات مشبوهة (${suspicious.length})</button>
      <button type="button" data-tab="days" class="${tab === 'days' ? 'on' : ''}">أيام فيها ملاحظات (${d.days.length})</button>
      <button type="button" data-tab="manual" class="${tab === 'manual' ? 'on' : ''}">بصمات يدوية (${d.punches.length - suspicious.length + suspicious.filter((p) => p.flags.includes('manager_entry')).length})</button>
      <button type="button" data-tab="audit" class="${tab === 'audit' ? 'on' : ''}">سجل التعديلات</button>
    </div>
    <section class="panel">${{
      punches: table(['التاريخ', 'الوقت', 'الموظف', 'النوع', 'المؤشر', 'الشبكة', 'الموقع'], suspicious.map((p) => `<tr class="click" data-u="${p.user_id}" data-n="${esc(p.user_name)}" data-d="${p.date}" style="${p.voided ? 'opacity:.45' : ''}"><td>${fmtDate(p.date)}</td><td>${fmtT(p.ts)}</td><td>${esc(p.user_name)}</td><td>${PUNCH[p.type]}</td><td class="wrap">${flagList(p.flags.filter((f) => f !== 'manager_entry'))}</td><td dir="ltr" class="small">${esc(p.ip || '')}</td><td>${p.lat ? `<a class="link" href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">خريطة</a>` : '—'}</td></tr>`), { empty: 'لا توجد بصمات مشبوهة' }),
      days: table(['التاريخ', 'الموظف', 'الملاحظة'], d.days.map((x) => `<tr class="click" data-u="${x.userId}" data-n="${esc(x.name)}" data-d="${x.date}"><td>${fmtDate(x.date)}</td><td>${esc(x.name)}</td><td class="wrap">${flagList(x.flags)}</td></tr>`), { empty: 'لا توجد ملاحظات' }),
      manual: table(['التاريخ', 'الوقت', 'الموظف', 'النوع', 'السبب'], d.punches.filter((p) => p.flags.includes('manager_entry')).map((p) => `<tr class="click" data-u="${p.user_id}" data-n="${esc(p.user_name)}" data-d="${p.date}"><td>${fmtDate(p.date)}</td><td>${fmtT(p.ts)}</td><td>${esc(p.user_name)}</td><td>${PUNCH[p.type]}</td><td class="wrap">${esc(p.note)}</td></tr>`), { empty: 'لا توجد بصمات يدوية' }),
      audit: table(['الوقت', 'بواسطة', 'الإجراء', 'الموظف', 'التفاصيل'], d.audit.map((a) => `<tr><td>${new Date(a.ts + tz * 60000).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${esc(a.actor_name || '')}</td><td>${ACTIONS[a.action] || esc(a.action)}</td><td>${esc(a.target_name || '—')}</td><td class="wrap small" dir="auto">${esc(a.details)}</td></tr>`), { empty: 'لا توجد تعديلات' }),
    }[tab]}</section>
    <section class="panel"><header><h2>كيف يكتشف النظام التلاعب</h2></header>
      <ul class="muted small" style="margin:0;padding-inline-start:18px;display:grid;gap:4px">
        <li>وقت البصمة يُؤخذ من السيرفر دائماً، فتغيير ساعة الجوال لا يفيد، ويُسجَّل الفرق إن وُجد.</li>
        <li>كل جوال يأخذ معرّفاً خاصاً؛ إذا بصم جوال واحد لأكثر من موظف خلال اليوم تظهر علامة.</li>
        <li>عند تحديد موقع المحل أو شبكته في الإعدادات، تُعلَّم البصمات من خارجها.</li>
        <li>الخروج المؤقت يحتاج سبباً، ويُعلَّم إذا طال أكثر من المسموح.</li>
        <li>الموظف لا يستطيع تعديل أو حذف بصماته، وكل تعديل يجريه المدير يُحفظ هنا.</li>
      </ul>
    </section>`);
  $$('[data-tab]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('flags-tab', b.dataset.tab); refresh(); }; });
  $$('tr[data-u]', pg).forEach((tr) => { tr.onclick = () => dayDetail(+tr.dataset.u, tr.dataset.n, tr.dataset.d); });
};

// ------------------------------------------------------------------ manager: staff
PAGES.staff = async () => {
  staffCache = null;
  const d = await api('/api/users');
  const permName = (k) => d.permissions.find((p) => p.key === k)?.name.replace('رقم يومي: ', '') || k;
  const periodName = (ids) => (ids ? ids.map((id) => d.periods.find((p) => p.id === id)?.name || id).join('، ') : 'كل الفترات');
  const pg = render(`
    <div class="topline"><h1>الموظفون</h1><button class="btn" id="addU" type="button">إضافة موظف</button></div>
    <section class="panel">
      ${table(['الاسم', 'اسم المستخدم', 'الدخول', 'واتساب', 'تنبيهات الجوال', 'الراتب', 'الفترات', 'الإجازة الأسبوعية', 'الصلاحيات', 'الحالة', ''],
        d.users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.role === 'admin' ? ` ${pill('مدير', 'info')}` : ''}</td><td dir="ltr">${esc(u.username)}</td>
          <td>${u.has_password ? pill('مفعّل', 'good') : pill('بدون كلمة مرور', 'warn')}</td><td dir="ltr" class="small">${u.role === 'admin' ? '—' : (u.phone ? esc(u.phone) : '<span class="muted">—</span>')}</td><td>${u.push_devices ? pill(`${u.push_devices} جهاز`, 'good') : '<span class="muted small">غير مفعّلة</span>'}</td><td>${u.role === 'admin' ? '—' : money(u.salary)}</td>
          <td class="wrap">${u.role === 'admin' ? '—' : esc(periodName(u.periods))}</td><td>${u.day_off === null ? 'لا يوجد' : DAYS[u.day_off]}</td>
          <td class="wrap small">${u.role === 'admin' ? 'كل شيء' : (u.perms.map((k) => esc(permName(k))).join('، ') || '—')}</td><td>${u.active ? pill('نشط', 'good') : pill('موقوف', '')}</td>
          <td><button class="btn sm ghost" data-e="${u.id}">تعديل</button></td></tr>`))}
      <p class="muted small">الموظف بدون كلمة مرور لا يستطيع الدخول. اضغط «تعديل» وحدد له كلمة مرور ثم أعطه اسم المستخدم وكلمة المرور.</p>
    </section>`);
  const edit = (u) => modal(u ? `تعديل ${u.name}` : 'موظف جديد', `<form class="form" id="uF">
      <div class="row"><label class="f">الاسم<input name="name" id="u-name" value="${esc(u?.name || '')}" required></label>
      <label class="f">اسم المستخدم (إنجليزي)<input name="username" id="u-username" dir="ltr" value="${esc(u?.username || '')}" autocapitalize="none" required></label></div>
      <div class="row"><label class="f">${u?.has_password ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور'}<input name="password" id="u-pass" dir="ltr" autocomplete="new-password" minlength="6" ${u ? '' : 'required'}></label>
      ${u?.role === 'admin' ? '' : `<label class="f">الراتب الشهري (ر.س)<input type="number" min="0" step="0.01" name="salary" id="u-salary" value="${u?.salary || ''}"></label>`}</div>
      ${u?.role === 'admin' ? '' : `<label class="f">جوال واتساب (للإشعارات)<input name="phone" id="u-phone" dir="ltr" inputmode="tel" placeholder="05xxxxxxxx" value="${esc(u?.phone || '')}"></label>`}
      ${u?.role === 'admin' ? '' : `
      <fieldset style="border:1px solid var(--line);border-radius:8px;padding:10px 14px"><legend class="small">فترات الدوام</legend>
        <div class="row">${d.periods.map((p) => `<label class="check"><input type="checkbox" name="p_${p.id}" id="u-p-${p.id}" ${!u?.periods || u.periods.includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</div></fieldset>
      <div class="row"><label class="f">الإجازة الأسبوعية<select name="day_off" id="u-off">${opt('', 'لا يوجد', u?.day_off ?? '')}${DAYS.map((n, i) => opt(i, n, u?.day_off ?? '')).join('')}</select></label></div>
      <fieldset style="border:1px solid var(--line);border-radius:8px;padding:10px 14px"><legend class="small">الصلاحيات: وش يقدر يسجّل</legend>
        <div style="display:grid;gap:6px">${d.permissions.map((p) => `<label class="check"><input type="checkbox" name="perm_${p.key}" id="u-perm-${p.key.replace(':', '-')}" ${u?.perms?.includes(p.key) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</div></fieldset>
      ${u ? `<label class="check"><input type="checkbox" name="active" id="u-active" ${u.active ? 'checked' : ''}>حساب نشط (إلغاء التفعيل يوقف دخوله ويخفيه من التقارير)</label>` : ''}`}
      <button class="btn" type="submit">حفظ</button></form>`, (dl) => {
    $('#uF', dl).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const body = { name: f.name, username: f.username, ...(f.password ? { password: f.password } : {}) };
      if (u?.role !== 'admin') {
        Object.assign(body, { salary: f.salary || 0, phone: f.phone || '', day_off: f.day_off, perms: d.permissions.filter((p) => f[`perm_${p.key}`]).map((p) => p.key), periods: d.periods.filter((p) => f[`p_${p.id}`]).map((p) => p.id) });
        if (body.periods.length === d.periods.length) body.periods = null;
        if (u) body.active = f.active;
      }
      const ok = await act($('button', e.target), () => api(u ? `/api/users/${u.id}` : '/api/users', { method: u ? 'PUT' : 'POST', body }), 'تم الحفظ');
      if (ok) { dl.close(); refresh(); }
    };
  });
  $('#addU', pg).onclick = () => edit(null);
  $$('[data-e]', pg).forEach((b) => { b.onclick = () => edit(d.users.find((u) => u.id === +b.dataset.e)); });
};

// ------------------------------------------------------------------ manager: reports
PAGES.reports = async () => {
  const pg = render(`
    <div class="topline"><h1>التقارير والتصدير</h1></div>
    <p class="muted">ملفات CSV تفتح مباشرة في Excel بالعربي. التقرير اليومي يفتح في صفحة جاهزة للطباعة أو الحفظ PDF.</p>
    <div class="grid2">
      <section class="panel"><header><h2>التقرير اليومي الشامل</h2></header>
        <p class="muted small">الحضور والبصمات، الطلبات حسب القناة، الشحنات والمرتجعات، البضائع، التذاكر، والخصومات والسلف لذلك اليوم.</p>
        <div class="row"><label class="f">اليوم<input type="date" id="r-day" value="${today()}" max="${today()}"></label></div>
        <div class="row"><a class="btn ghost" id="r-print" target="_blank" rel="noopener">${icon('file')}عرض وطباعة</a><a class="btn ghost" id="r-pdf">${icon('down')}تنزيل PDF</a><a class="btn" id="r-csv">${icon('down')}تنزيل Excel</a></div>
      </section>
      <section class="panel"><header><h2>التقرير الشهري</h2></header>
        <p class="muted small">الطلبات والعمليات، البضائع والمرتجعات، تقييم الأداء، الحضور${ME.role === 'admin' ? ' والرواتب' : ''}. يوصلك ملخصه على واتساب أول كل شهر.</p>
        <div class="row"><label class="f">الشهر<input type="month" id="r-mm" value="${thisMonth()}"></label></div>
        <a class="btn ghost" id="r-month" target="_blank" rel="noopener">${icon('file')}عرض وطباعة</a>
      </section>
      <section class="panel"><header><h2>الحضور لفترة</h2></header>
        <div class="row"><label class="f">من<input type="date" id="r-af" value="${addDays(today(), -29)}"></label><label class="f">إلى<input type="date" id="r-at" value="${today()}"></label></div>
        <a class="btn" id="r-att">${icon('down')}تنزيل</a>
      </section>
${ME.role === 'admin' ? `      <section class="panel"><header><h2>مسيّر الرواتب الشهري</h2></header>
        <div class="row"><label class="f">الشهر<input type="month" id="r-m" value="${thisMonth()}"></label></div>
        <a class="btn" id="r-pay">${icon('down')}تنزيل</a>
      </section>` : ''}
      <section class="panel"><header><h2>العمليات والتذاكر لفترة</h2></header>
        <div class="row"><label class="f">من<input type="date" id="r-of" value="${addDays(today(), -29)}"></label><label class="f">إلى<input type="date" id="r-ot" value="${today()}"></label></div>
        <div class="row"><a class="btn" id="r-ops">${icon('down')}العمليات والبضائع</a><a class="btn ghost" id="r-tk">${icon('down')}التذاكر</a></div>
      </section>
      ${ME.role === 'admin' ? `      <section class="panel"><header><h2>السلف والنسخ الاحتياطي</h2></header>
        <p class="muted small">النظام يحفظ نسخة احتياطية تلقائياً كل يوم على السيرفر، ويرسل نسخة لواتساب المدير كل ليلة (من الإعدادات). وتقدر تنزّل نسخة كاملة الآن.</p>
        <div class="row"><a class="btn ghost" href="/api/export/debts">${icon('down')}سجل السلف</a><a class="btn ghost" href="/api/backup">${icon('down')}نسخة احتياطية كاملة</a></div>
      </section>` : ''}
    </div>`);
  const sync = () => {
    const v = (id) => $(id, pg).value;
    $('#r-print', pg).href = `/report/daily?date=${v('#r-day')}`;
    $('#r-month', pg).href = `/report/monthly?month=${v('#r-mm')}`;
    $('#r-csv', pg).href = `/api/export/daily?date=${v('#r-day')}`;
    $('#r-pdf', pg).href = `/report/daily.pdf?date=${v('#r-day')}`;
    $('#r-att', pg).href = `/api/export/attendance?from=${v('#r-af')}&to=${v('#r-at')}`;
    if ($('#r-pay', pg)) $('#r-pay', pg).href = `/api/export/payroll?month=${v('#r-m')}`;
    $('#r-ops', pg).href = `/api/export/ops?from=${v('#r-of')}&to=${v('#r-ot')}`;
    $('#r-tk', pg).href = `/api/export/tickets?from=${v('#r-of')}&to=${v('#r-ot')}`;
  };
  pg.addEventListener('change', sync);
  sync();
};

/** Render WhatsApp markup (*bold*, _italic_, > quote) as HTML, for previews. */
function waFormat(text) {
  return text.split('\n').map((line) => {
    let h = esc(line).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>');
    if (line.startsWith('> ')) h = `<span class="wa-q">${h.slice(5)}</span>`;
    return h || '&nbsp;';
  }).join('<br>');
}

/** The WhatsApp link box: shows the QR while waiting for a scan, then the linked number. */
function waPanel(pg) {
  const box = $('#wa-link', pg);
  const pillEl = $('#wa-pill', pg);
  let timer = null;
  const draw = (w) => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (w.provider !== 'qr') {
      pillEl.innerHTML = pill('مزوّد خارجي', 'info');
      box.innerHTML = '<p class="muted small">الإرسال عبر مزوّد خارجي مضبوط في متغيرات Railway.</p>';
      return;
    }
    const states = { connected: ['واتساب مربوط', 'good'], qr: ['بانتظار مسح الرمز', 'warn'], connecting: ['جاري الاتصال...', 'info'], off: ['غير مربوط', 'bad'] };
    pillEl.innerHTML = pill(...(states[w.status] || states.off));
    if (w.status === 'connected') {
      box.innerHTML = `<div class="row" style="align-items:center"><p style="flex:1 1 260px">الرسائل تُرسل من الرقم <b dir="ltr">+${esc(w.me || '')}</b>.</p><button type="button" class="btn ghost" id="wa-out" style="flex:0 0 auto">فصل الحساب</button></div>`;
      $('#wa-out', box).onclick = async (e) => {
        if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = 'تأكيد الفصل؟'; return; }
        const r = await act(e.target, () => api('/api/whatsapp/logout', { method: 'POST' }), 'تم فصل الحساب');
        if (r) poll();
      };
    } else if (w.status === 'qr' && w.qr) {
      box.innerHTML = `<div class="qr-wrap"><div class="qr">${w.qr}</div><ol class="small">
        <li>افتح واتساب في الجوال اللي تبي الرسائل تطلع منه.</li>
        <li>اضغط <b>الإعدادات</b> ← <b>الأجهزة المرتبطة</b> ← <b>ربط جهاز</b>.</li>
        <li>وجّه الكاميرا على الرمز. يتجدد الرمز تلقائياً كل دقيقة تقريباً.</li>
        <li class="muted">ننصح برقم مخصّص للنظام، مو رقمك الشخصي.</li></ol></div>`;
    } else if (w.status === 'connecting') {
      box.innerHTML = '<p class="muted">جاري الاتصال بواتساب...</p>';
    } else {
      box.innerHTML = `<div class="row" style="align-items:center"><p style="flex:1 1 260px">اربط حساب واتساب بمسح رمز QR، والنظام يرسل منه الإشعارات والمنبهات.${w.error ? `<br><span class="muted small">${esc(w.error)}</span>` : ''}</p><button type="button" class="btn" id="wa-in" style="flex:0 0 auto">ربط حساب واتساب</button></div>`;
      $('#wa-in', box).onclick = async (e) => { if (await act(e.target, () => api('/api/whatsapp/connect', { method: 'POST' }))) poll(); };
    }
  };
  const poll = async () => {
    try { draw(await api('/api/whatsapp')); } catch { /* keep the last state */ }
  };
  poll();
  timer = setInterval(poll, 3000);
}

// ------------------------------------------------------------------ manager: notifications log
const NS = { pending: ['بالانتظار', 'warn'], sent: ['أُرسلت', 'good'], failed: ['فشلت', 'bad'], skipped: ['لم تُرسل: المزوّد غير مضبوط', ''] };
PAGES.notifications = async () => {
  const d = await api('/api/notifications');
  render(`
    <div class="topline"><h1>سجل إشعارات واتساب</h1><a class="link" href="#/settings">إعدادات الإشعارات</a></div>
    <section class="panel">
      ${table(['الوقت', 'إلى', 'الموظف', 'الرسالة', 'الحالة'], d.notifications.map((n) => `<tr><td>${fmtDate(new Date(n.created_at + tz * 60000).toISOString().slice(0, 10))} ${fmtT(n.created_at)}</td>
        <td dir="ltr" class="small">${esc(n.to_phone)}</td><td>${esc(n.user_name || 'المدير')}</td><td class="wrap small" style="white-space:pre-wrap;min-width:260px">${esc(n.body)}</td>
        <td>${pill(...(NS[n.status] || [n.status, '']))}${n.error && n.status !== 'skipped' ? `<div class="muted small">${esc(n.error)}</div>` : ''}</td></tr>`), { empty: 'لا توجد إشعارات بعد' })}
    </section>`);
};

// ------------------------------------------------------------------ manager: settings
PAGES.settings = async () => {
  const s = await api('/api/settings');
  const order = [6, 0, 1, 2, 3, 4, 5];
  const perRow = (p) => `<div class="per"><input name="id" value="${esc(p.id)}" dir="ltr" placeholder="am" aria-label="المعرّف" style="flex:0 1 70px"><input name="name" value="${esc(p.name)}" placeholder="اسم الفترة" aria-label="اسم الفترة"><input type="time" name="start" value="${p.start}" aria-label="من"><input type="time" name="end" value="${p.end}" aria-label="إلى"><button type="button" class="link bad" data-rm>حذف</button></div>`;
  const mtRow = (m) => `<div class="per"><input name="key" value="${esc(m.key)}" dir="ltr" placeholder="pending_chats" aria-label="المعرّف" style="flex:0 1 150px"><input name="name" value="${esc(m.name)}" placeholder="اسم البند" aria-label="اسم البند"><label class="check small"><input type="checkbox" name="note" ${m.note ? 'checked' : ''}>مع ملاحظات</label><button type="button" class="link bad" data-rm>حذف</button></div>`;
  const chRow = (c) => `<div class="per"><input name="key" value="${esc(c.key)}" dir="ltr" placeholder="salla" aria-label="المعرّف" style="flex:0 1 110px"><input name="name" value="${esc(c.name)}" placeholder="اسم القناة" aria-label="اسم القناة"><button type="button" class="link bad" data-rm>حذف</button></div>`;
  const pg = render(`
    <div class="topline"><h1>الإعدادات</h1></div>
    <section class="panel"><header><h2>جدول الدوام</h2><span class="muted small">المعرّف بالإنجليزي ويُستخدم لربط الموظف بالفترة</span></header>
      <div class="sched" id="sched">${order.map((d) => `<div class="day" data-day="${d}"><b>${DAYS[d]}</b><div><div class="pers">${(s.schedule.days[d] || []).map(perRow).join('')}</div><button type="button" class="link" data-addp>+ إضافة فترة</button></div></div>`).join('')}</div>
      <div class="row">
        <label class="f">فترة السماح للتأخير (دقائق)<input type="number" min="0" max="120" id="s-grace" value="${s.grace_minutes}"></label>
        <label class="f">أقصى مدة للخروج المؤقت (دقائق)<input type="number" min="1" max="600" id="s-exit" value="${s.max_exit_minutes}"></label>
      </div>
      <p class="muted small">التأخير ضمن فترة السماح لا يُحسب. إذا تجاوزها يُحسب التأخير كاملاً من بداية الدوام.</p>
    </section>
    <section class="panel"><header><h2>الحماية من التلاعب</h2></header>
      <label class="f">شبكات المحل المسموحة (عنوان IP لكل سطر، اتركه فارغاً للسماح بأي شبكة)<textarea id="s-ips" dir="ltr" rows="3">${esc(s.security.allowed_ips.join('\n'))}</textarea></label>
      <p class="muted small">عنوان الشبكة اللي تتصل منها الآن: <b dir="ltr">${esc(s.your_ip || '')}</b>. إذا كنت في المحل، أضفه هنا.</p>
      <div class="row">
        <label class="f">خط العرض<input id="s-lat" dir="ltr" value="${s.security.geo?.lat ?? ''}" inputmode="decimal"></label>
        <label class="f">خط الطول<input id="s-lng" dir="ltr" value="${s.security.geo?.lng ?? ''}" inputmode="decimal"></label>
        <label class="f">نصف القطر المسموح (متر)<input type="number" id="s-rad" value="${s.security.geo?.radius ?? 150}" min="20" max="5000"></label>
      </div>
      <div class="row"><button type="button" class="btn ghost" id="s-here" style="flex:0 0 auto">استخدم موقعي الحالي كموقع للمحل</button><button type="button" class="link" id="s-nogeo" style="flex:0 0 auto">إلغاء تحديد الموقع</button></div>
      <label class="check"><input type="checkbox" id="s-req" ${s.security.require_geo ? 'checked' : ''}>إلزام الموظف بتفعيل الموقع عند البصمة</label>
      <label class="f" style="max-width:320px">أقصى فرق مقبول في ساعة الجوال (دقائق)<input type="number" id="s-skew" min="1" max="120" value="${s.security.max_clock_skew_minutes}"></label>
    </section>
    <section class="panel"><header><h2>إشعارات واتساب</h2><span id="wa-pill"></span></header>
      <div id="wa-link" class="wa-link"></div>
      <div class="row">
        <label class="f">جوال المدير (تصله التنبيهات والملخص)<input id="n-phone" dir="ltr" inputmode="tel" placeholder="05xxxxxxxx" value="${esc(s.notify.manager_phone)}"></label>
        <label class="f">وقت الملخص اليومي<input type="time" id="n-time" value="${s.notify.summary_time}"></label>
        <label class="f">رابط النظام (يظهر أسفل الرسائل)<input id="n-url" dir="ltr" placeholder="https://..." value="${esc(s.notify.app_url || location.origin)}"></label>
        <label class="f">تذكير الموظف بعد بداية الدوام بـ (دقائق)<input type="number" id="n-after" min="1" max="120" value="${s.notify.remind_after_minutes}"></label>
        <label class="f">منبّه قبل بداية كل فترة بـ (دقائق)<input type="number" id="n-before" min="1" max="120" value="${s.notify.alert_before_minutes}"></label>
      </div>
      <div style="display:grid;gap:8px">
        <label class="check"><input type="checkbox" id="n-alarm" ${s.notify.shift_alerts ? 'checked' : ''}>منبّه الفترات للموظف: قبل بداية كل فترة، وعند الاستراحة، وعند نهاية الدوام</label>
        <label class="check"><input type="checkbox" id="n-staff" ${s.notify.remind_staff ? 'checked' : ''}>تذكير الموظف إذا ما سجّل حضور، أو نسي يسجّل انصراف</label>
        <label class="check"><input type="checkbox" id="n-mgr" ${s.notify.alert_manager ? 'checked' : ''}>تنبيهات للمدير: تأخير، غياب، بصمة مشبوهة، خروج مؤقت، طلب فسح أو نواقص، تذكرة جديدة</label>
        <label class="check"><input type="checkbox" id="n-acc" ${s.notify.staff_account ? 'checked' : ''}>إشعار الموظف عن حسابه: خصم، سلفة أو سداد، رد على تذكرته، قرار على طلبه</label>
        <label class="check"><input type="checkbox" id="n-sum" ${s.notify.daily_summary ? 'checked' : ''}>ملخص يومي للمدير: الحضور والتأخير والغياب، الطلبات حسب القناة، الأرقام اليومية، وما لم يُسجَّل</label>
        <label class="check"><input type="checkbox" id="n-push" ${s.notify.push !== false ? 'checked' : ''}>تنبيهات الجوال المباشرة (مثل المنبّه): نفس الإشعارات تطلع على شاشة جوال الموظف وجوالك، بجانب واتساب</label>
        <label class="check" style="margin-inline-start:26px"><input type="checkbox" id="n-pdf" ${s.notify.summary_pdf ? 'checked' : ''}>أرسل الملخص اليومي كملف PDF للتقرير اليومي الشامل (مع أهم الأرقام في نص الرسالة)</label>
        <label class="check"><input type="checkbox" id="n-all" ${s.notify.alert_all ? 'checked' : ''}>كل حركة صغيرة أو كبيرة للمدير: كل بصمة، كل رقم يُسجَّل، كل فاتورة ومرتجع، كل رد على تذكرة</label>
        <label class="check"><input type="checkbox" id="n-month" ${s.notify.monthly_auto ? 'checked' : ''}>أول كل شهر: التقرير الشهري للمدير، وإعلان موظف الشهر للفريق</label>
        <div class="row" style="align-items:center"><label class="check" style="flex:2 1 300px"><input type="checkbox" id="n-bak" ${s.notify.daily_backup ? 'checked' : ''}>نسخة احتياطية من قاعدة البيانات لواتساب المدير كل ليلة</label>
          <label class="f" style="flex:0 1 160px">وقت النسخة<input type="time" id="n-bak-t" value="${s.notify.backup_time || '23:30'}"></label></div>
      </div>
      <div class="msg small"><b>الرد من واتساب:</b> لما يوصلك طلب فسح أو نواقص أو إجازة، رد من جوالك: <b>موافق ف12</b> أو <b>رفض ف12 السبب</b> أو <b>تم ف12</b>، وللإجازات <b>موافق ج3</b>. واكتب <b>طلبات</b> لعرض كل ما ينتظر ردك.</div>
      <div class="row"><button type="button" class="btn ghost" id="n-test" style="flex:0 0 auto">إرسال رسالة تجربة لجوالي</button><button type="button" class="btn ghost" id="n-test-sum" style="flex:0 0 auto">أرسل ملخص اليوم الآن</button><button type="button" class="btn ghost" id="n-preview" style="flex:0 0 auto">معاينة شكل الرسائل</button><a class="link" href="#/notifications" style="flex:0 0 auto;align-self:center">سجل الإشعارات</a></div>
      <p class="muted small">أرقام الموظفين تُضاف من صفحة الموظفين. احفظ الإعدادات قبل التجربة.</p>
    </section>
    <section class="panel"><header><h2>الأرقام اليومية</h2><span class="muted small">البنود اللي يسجّلها الموظفون يومياً. حدّد من يسجّل كل بند من صفحة الموظفين</span></header>
      <div id="mts">${(s.metrics || []).map(mtRow).join('')}</div>
      <button type="button" class="link" id="addMt">+ إضافة بند</button>
    </section>
    <section class="panel"><header><h2>قنوات الطلبات</h2><span class="muted small">تظهر في صفحة العمليات اليومية والتقارير</span></header>
      <div id="chs">${s.channels.map(chRow).join('')}</div>
      <button type="button" class="link" id="addCh">+ إضافة قناة</button>
    </section>
    <div><button class="btn" id="save" type="button">حفظ الإعدادات</button></div>`);
  pg.addEventListener('click', (e) => {
    if (e.target.matches('[data-rm]')) e.target.closest('.per').remove();
    if (e.target.matches('[data-addp]')) e.target.previousElementSibling.insertAdjacentHTML('beforeend', perRow({ id: '', name: '', start: '09:00', end: '17:00' }));
  });
  waPanel(pg);
  $('#n-preview', pg).onclick = async (e) => {
    const d = await act(e.target, () => api('/api/notifications/preview'));
    if (d) modal('شكل رسائل واتساب', `<div class="wa-chat">${d.samples.map(([t, b]) => `<p class="wa-label">${esc(t)}</p><div class="wa-bubble">${waFormat(b)}</div>`).join('')}</div>`);
  };
  $('#n-test', pg).onclick = (e) => act(e.target, () => api('/api/notifications/test', { method: 'POST', body: {} }), 'وصلت رسالة التجربة لجوالك');
  $('#n-test-sum', pg).onclick = (e) => act(e.target, () => api('/api/notifications/test', { method: 'POST', body: { kind: 'summary' } }), 'تم إرسال ملخص اليوم');
  $('#addMt', pg).onclick = () => $('#mts', pg).insertAdjacentHTML('beforeend', mtRow({ key: '', name: '', note: false }));
  $('#addCh', pg).onclick = () => $('#chs', pg).insertAdjacentHTML('beforeend', chRow({ key: '', name: '' }));
  $('#s-here', pg).onclick = async (e) => {
    e.target.disabled = true;
    const p = await locate();
    e.target.disabled = false;
    if (!p) return toast('تعذّر تحديد موقعك. اسمح للمتصفح باستخدام الموقع', true);
    $('#s-lat', pg).value = p.lat.toFixed(6);
    $('#s-lng', pg).value = p.lng.toFixed(6);
    toast(`تم تحديد الموقع (دقة ${p.accuracy} متر). اضغط حفظ`);
  };
  $('#s-nogeo', pg).onclick = () => { $('#s-lat', pg).value = ''; $('#s-lng', pg).value = ''; $('#s-req', pg).checked = false; };
  $('#save', pg).onclick = async (e) => {
    const field = (row, n) => $(`[name=${n}]`, row).value.trim();
    const days = {};
    $$('.day', pg).forEach((dEl) => { days[dEl.dataset.day] = $$('.per', dEl).map((r) => ({ id: field(r, 'id'), name: field(r, 'name'), start: field(r, 'start'), end: field(r, 'end') })); });
    const lat = $('#s-lat', pg).value.trim();
    const lng = $('#s-lng', pg).value.trim();
    const body = {
      schedule: { days },
      grace_minutes: $('#s-grace', pg).value,
      max_exit_minutes: $('#s-exit', pg).value,
      security: {
        allowed_ips: $('#s-ips', pg).value,
        geo: lat && lng ? { lat, lng, radius: $('#s-rad', pg).value } : null,
        require_geo: $('#s-req', pg).checked,
        max_clock_skew_minutes: $('#s-skew', pg).value,
      },
      channels: $$('#chs .per', pg).map((r) => ({ key: field(r, 'key'), name: field(r, 'name') })),
      metrics: $$('#mts .per', pg).map((r) => ({ key: field(r, 'key'), name: field(r, 'name'), note: $('[name=note]', r).checked })),
      notify: {
        manager_phone: $('#n-phone', pg).value.trim(), app_url: $('#n-url', pg).value.trim(), summary_time: $('#n-time', pg).value, remind_after_minutes: $('#n-after', pg).value,
        shift_alerts: $('#n-alarm', pg).checked, alert_before_minutes: $('#n-before', pg).value,
        remind_staff: $('#n-staff', pg).checked, alert_manager: $('#n-mgr', pg).checked, staff_account: $('#n-acc', pg).checked, daily_summary: $('#n-sum', pg).checked, summary_pdf: $('#n-pdf', pg).checked, push: $('#n-push', pg).checked,
        alert_all: $('#n-all', pg).checked, monthly_auto: $('#n-month', pg).checked, daily_backup: $('#n-bak', pg).checked, backup_time: $('#n-bak-t', pg).value,
      },
    };
    if (await act(e.target, () => api('/api/settings', { method: 'PUT', body }), 'تم حفظ الإعدادات')) { staffCache = null; boot(); }
  };
};

// ------------------------------------------------------------------ leave & permission requests
const LK = { leave: 'إجازة', sick: 'إجازة مرضية', permission: 'استئذان بالساعات' };
const LS = { pending: ['بانتظار المدير', 'warn'], approved: ['تمت الموافقة', 'good'], rejected: ['مرفوض', 'bad'] };
const leaveWhen = (q) => (q.minutes ? `${fmtDate(q.from_date)} · خروج ${q.minutes} دقيقة${q.left_at ? ` (${fmtT(q.left_at)}${q.back_at ? ` – ${fmtT(q.back_at)}` : ''})` : ''}` : q.kind === 'permission' ? `${fmtDate(q.from_date)} · ${q.from_time} – ${q.to_time}`
  : q.from_date === q.to_date ? fmtDate(q.from_date) : `${fmtDate(q.from_date)} ← ${fmtDate(q.to_date)}`);
PAGES.leaves = async () => {
  const mgr = ME.manager;
  const status = sessionStorage.getItem('lv-status') || '';
  const d = await api(`/api/leaves?status=${status}`);
  const own = ME.role !== 'admin';
  const pg = render(`
    <div class="topline"><h1>${mgr ? 'الإجازات والاستئذان' : 'إجازاتي'}</h1><div class="tools">
      <select id="lv-st" aria-label="الحالة">${opt('', 'كل الحالات', status)}${Object.entries(LS).map(([k, v]) => opt(k, v[0], status)).join('')}</select></div></div>
    <div class="grid2">
      ${own ? `<section class="panel"><header><h2>طلب جديد</h2></header>
        <form class="form" id="lvF">
          <div class="seg" role="radiogroup" aria-label="نوع الطلب">${Object.entries(LK).map(([k, v], i) => `<button type="button" data-k="${k}" class="${i ? '' : 'on'}">${v}</button>`).join('')}</div>
          <input type="hidden" name="kind" id="lv-kind" value="leave">
          <div class="row">
            <label class="f" id="lv-from-l">من يوم<input type="date" name="from_date" id="lv-from" value="${addDays(today(), 1)}" min="${addDays(today(), -7)}" required></label>
            <label class="f" id="lv-to-l">إلى يوم<input type="date" name="to_date" id="lv-to" value="${addDays(today(), 1)}" min="${addDays(today(), -7)}"></label>
            <label class="f" id="lv-ft-l" hidden>من الساعة<input type="time" name="from_time" id="lv-ft" value="10:00"></label>
            <label class="f" id="lv-tt-l" hidden>إلى الساعة<input type="time" name="to_time" id="lv-tt" value="11:00"></label>
          </div>
          <label class="f">السبب<textarea name="reason" id="lv-reason" required maxlength="500" placeholder="مثال: مراجعة مستشفى، ظرف عائلي، سفر"></textarea></label>
          <button class="btn" type="submit">رفع الطلب للمدير</button>
          <p class="muted small">بعد الموافقة ما يُحسب عليك غياب ولا تأخير في أيام الإجازة أو وقت الاستئذان، ويوصلك القرار على واتساب.</p>
        </form></section>` : ''}
      <section class="panel" style="${own ? '' : 'grid-column:1/-1'}"><header><h2>${d.leaves.length} طلب</h2></header>
        ${table(['#', ...(mgr ? ['الموظف'] : []), 'النوع', 'الموعد', 'السبب', 'الحالة', 'الرد'],
          d.leaves.map((q) => `<tr><td>${q.id}</td>${mgr ? `<td><b>${esc(q.user_name)}</b></td>` : ''}<td>${LK[q.kind]}</td><td class="nowrap">${leaveWhen(q)}</td>
            <td class="wrap">${esc(q.reason)}</td><td class="nowrap">${pill(...LS[q.status])}${mgr && q.user_id !== ME.id ? `<div class="acts"><button class="btn sm" data-ok="${q.id}">موافقة</button><button class="btn sm ghost" data-no="${q.id}">رفض</button></div>` : ''}</td><td class="wrap">${esc(q.response) || '—'}</td></tr>`),
          { empty: 'لا توجد طلبات' })}
        ${mgr ? '<p class="muted small">تقدر توافق من واتساب مباشرة: رد على رسالة الطلب بـ <b>موافق ج12</b> أو <b>رفض ج12 السبب</b>.</p>' : ''}
      </section>
    </div>`);
  $('#lv-st', pg).onchange = (e) => { sessionStorage.setItem('lv-status', e.target.value); refresh(); };
  const f = $('#lvF', pg);
  if (f) {
    $$('.seg button', pg).forEach((b) => { b.onclick = () => {
      $$('.seg button', pg).forEach((x) => x.classList.toggle('on', x === b));
      $('#lv-kind', pg).value = b.dataset.k;
      const perm = b.dataset.k === 'permission';
      $('#lv-to-l', pg).hidden = perm; $('#lv-ft-l', pg).hidden = !perm; $('#lv-tt-l', pg).hidden = !perm;
      $('#lv-from-l', pg).firstChild.textContent = perm ? 'اليوم' : 'من يوم';
    }; });
    $('#lv-from', pg).onchange = (e) => { if ($('#lv-to', pg).value < e.target.value) $('#lv-to', pg).value = e.target.value; };
    f.onsubmit = async (e) => { e.preventDefault(); if (await act($('button[type=submit]', e.target), () => api('/api/leaves', { method: 'POST', body: formData(e.target) }), 'تم رفع الطلب')) refresh(); };
  }
  const decide = (id, status) => {
    const q = d.leaves.find((x) => x.id === id);
    modal(`${status === 'approved' ? 'موافقة على' : 'رفض'} ${LK[q.kind]} · ${q.user_name}`, `<form class="form" id="lvD">
        <p>${leaveWhen(q)}</p><div class="msg">${esc(q.reason)}</div>
        <label class="f">رد للموظف (اختياري)<textarea name="response" id="lvd-resp">${esc(q.response)}</textarea></label>
        <button class="btn" type="submit">${status === 'approved' ? 'اعتماد الموافقة' : 'تأكيد الرفض'}</button></form>`, (dl) => {
      $('#lvD', dl).onsubmit = async (e) => {
        e.preventDefault();
        if (await act($('button', e.target), () => api(`/api/leaves/${id}`, { method: 'PUT', body: { status, response: formData(e.target).response } }), 'تم وإرسال إشعار للموظف')) { dl.close(); refresh(); }
      };
    });
  };
  $$('[data-ok]', pg).forEach((b) => { b.onclick = () => decide(+b.dataset.ok, 'approved'); });
  $$('[data-no]', pg).forEach((b) => { b.onclick = () => decide(+b.dataset.no, 'rejected'); });
};

// ------------------------------------------------------------------ performance board
const ring = (v, size = 64) => {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const val = v ?? 0;
  const tone = v === null ? 'var(--line-2)' : val >= 85 ? 'var(--good)' : val >= 65 ? 'var(--warn)' : 'var(--bad)';
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--sunk)" stroke-width="6"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${tone}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c * val) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle">${v ?? '—'}</text></svg>`;
};
PAGES.performance = async () => {
  const month = sessionStorage.getItem('perf-month') || thisMonth();
  const d = await api(`/api/performance?month=${month}`);
  const meter = (label, v, hint) => `<div class="meter"><span>${label}</span><div class="bar"><i style="width:${v ?? 0}%"></i></div><b>${v ?? '—'}</b>${hint ? `<small class="muted">${hint}</small>` : ''}</div>`;
  const pg = render(`
    <div class="topline"><div><h1>لوحة الأداء</h1><p class="muted small">التقييم = 70% التزام + 30% تسجيل يومي. الالتزام: نسبة الحضور، ناقص نقطة لكل 10 دقائق تأخير ولكل 15 دقيقة خروج.</p></div>
      <div class="tools"><input type="month" id="pf-m" value="${month}" aria-label="الشهر">
      <a class="btn ghost" href="/report/monthly?month=${month}" target="_blank" rel="noopener">${icon('file')}التقرير الشهري</a>
      ${ME.role === 'admin' ? `<button class="btn" id="pf-award" type="button">${d.award ? 'إعادة إعلان موظف الشهر' : 'إعلان موظف الشهر'}</button>` : ''}</div></div>
    ${d.award ? `<section class="panel award"><b>🏆 موظف شهر ${month}: ${esc(d.award.name)}</b><span>${d.award.score} من 100 · ${esc(d.award.details)}</span></section>` : ''}
    <div class="perf">${d.rows.map((r) => `<section class="panel pcard ${r.rank === 1 && r.score !== null ? 'top' : ''}">
      <div class="phead">${ring(r.score)}<div><b>${r.rank ? `#${r.rank} · ` : ''}${esc(r.name)}</b>
        <span class="muted small">${r.change === null ? 'لا توجد مقارنة' : r.change > 0 ? `<span class="up">▲ ${r.change}</span> عن الشهر السابق` : r.change < 0 ? `<span class="down">▼ ${-r.change}</span> عن الشهر السابق` : 'نفس الشهر السابق'}</span></div></div>
      ${meter('الالتزام', r.commitment, `حضور ${r.presentDays}/${r.expectedDays} · تأخير ${int(r.lateMinutes)} د · خروج ${int(r.exitMinutes)} د`)}
      ${r.recording !== null ? meter('التسجيل اليومي', r.recording, `سجّل في ${r.recordDays} يوم`) : ''}
      ${r.metrics.length ? `<div class="chips">${r.metrics.map((m) => `<span class="chip"><b>${int(m.total)}</b> ${esc(m.name)}</span>`).join('')}</div>` : ''}
      <p class="muted small">${int(r.achievements)} إنجاز · ${int(r.requests)} طلب فسح أو نواقص</p>
      ${ME.role === 'admin' ? `<button class="link" type="button" data-pick="${r.userId}">اختره موظف الشهر</button>` : ''}
    </section>`).join('')}</div>`);
  $('#pf-m', pg).onchange = (e) => { sessionStorage.setItem('perf-month', e.target.value || thisMonth()); refresh(); };
  const announce = async (btn, userId = null) => {
    if (!confirm('يوصل الإعلان لكل الفريق على واتساب. متأكد؟')) return;
    const r = await act(btn, () => api('/api/awards', { method: 'POST', body: { month, user_id: userId } }));
    if (r) { toast(`تم إعلان ${r.award.name} موظف الشهر`); refresh(); }
  };
  const aw = $('#pf-award', pg);
  if (aw) aw.onclick = () => announce(aw);
  $$('[data-pick]', pg).forEach((b) => { b.onclick = () => announce(b, +b.dataset.pick); });
};

// ------------------------------------------------------------------ analytics: trends
/** Daily bars with a 7-day average line. Time runs left → right; hover a bar for its value. */
function trendChart(days, values, { unit = '', fmt = int, avg = true, tone = 'ink', small = false } = {}) {
  if (innerWidth < 640) small = true;
  const W = small ? 380 : 720; const H = small ? 190 : 200; const pad = { l: 40, r: 10, t: 12, b: 26 };
  const vals = values.map((v) => (v === null || v === undefined ? null : Number(v)));
  const max = Math.max(1, ...vals.filter((v) => v !== null));
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; })();
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const bw = iw / days.length;
  const y = (v) => pad.t + ih - (v / nice) * ih;
  const x = (i) => pad.l + i * bw + bw / 2;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(nice * f)}" y2="${y(nice * f)}" class="gl"/><text x="${pad.l - 6}" y="${y(nice * f) + 4}" text-anchor="end" class="ax">${fmt(nice * f)}</text>`).join('');
  const bars = vals.map((v, i) => (v === null ? '' : `<rect x="${x(i) - Math.max(1, bw * 0.34)}" y="${y(v)}" width="${Math.max(2, bw * 0.68)}" height="${Math.max(0, pad.t + ih - y(v))}" rx="${Math.min(3, bw / 4)}" class="b ${tone}"><title>${fmtDate(days[i])}: ${fmt(v)}${unit}</title></rect>`)).join('');
  let line = '';
  if (avg && days.length >= 10) {
    const pts = vals.map((_, i) => {
      const win = vals.slice(Math.max(0, i - 6), i + 1).filter((v) => v !== null);
      return win.length ? `${x(i).toFixed(1)},${y(win.reduce((a, b) => a + b, 0) / win.length).toFixed(1)}` : null;
    }).filter(Boolean);
    line = `<polyline points="${pts.join(' ')}" class="avg"/>`;
  }
  const step = Math.ceil(days.length / 8);
  const labels = days.map((d, i) => ((i % step === 0 && days.length - 1 - i >= step / 2) || i === days.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="ax">${d.slice(8)}/${d.slice(5, 7)}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" dir="ltr" role="img">${grid}${bars}${line}${labels}</svg>`;
}
function statLine(days, values, fmt = int, unit = '') {
  const v = values.map((n) => n ?? 0);
  const total = v.reduce((a, b) => a + b, 0);
  const recorded = values.filter((n) => n !== null && n !== undefined).length || 1;
  const best = v.indexOf(Math.max(...v));
  return `<p class="stats"><span>الإجمالي <b>${fmt(total)}${unit}</b></span><span>المتوسط اليومي <b>${fmt(Math.round((total / recorded) * 10) / 10)}${unit}</b></span>${total ? `<span>أعلى يوم <b>${fmtDate(days[best])}: ${fmt(v[best])}${unit}</b></span>` : ''}</p>`;
}
PAGES.analytics = async () => {
  const span = +(sessionStorage.getItem('an-span') || 30);
  const metricKey = sessionStorage.getItem('an-metric') || '';
  const d = await api(`/api/analytics?from=${addDays(today(), -(span - 1))}&to=${today()}`);
  const days = d.days.map((x) => x.date);
  const col = (k) => d.days.map((x) => x[k]);
  const mk = d.metrics.find((m) => m.key === metricKey) ? metricKey : d.metrics[0]?.key;
  const chTotals = d.channels.map((c) => ({ ...c, n: d.days.reduce((t, x) => t + x.channels[c.key], 0) })).sort((a, b) => b.n - a.n);
  const chMax = Math.max(1, ...chTotals.map((c) => c.n));
  const rate = d.days.map((x) => (x.scheduled ? Math.round((x.present / x.scheduled) * 100) : null));
  const pg = render(`
    <div class="topline"><div><h1>المؤشرات</h1><p class="muted small">الاتجاهات اليومية. الخط هو متوسط آخر 7 أيام.</p></div>
      <div class="seg" role="tablist">${[14, 30, 90].map((n) => `<button type="button" data-span="${n}" class="${n === span ? 'on' : ''}">${n} يوم</button>`).join('')}</div></div>
    <section class="panel"><header><h2>الطلبات اليومية</h2></header>${statLine(days, col('orders'))}${trendChart(days, col('orders'), { unit: ' طلب' })}</section>
    <div class="grid2">
      <section class="panel"><header><h2>المبيعات (ر.س)</h2></header>${statLine(days, col('amount'), money)}${trendChart(days, col('amount'), { fmt: (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : int(n)), tone: 'violet', small: true })}</section>
      <section class="panel"><header><h2>حصة القنوات</h2><span class="muted small">آخر ${span} يوم</span></header>
        <div class="hbars">${chTotals.map((c) => `<div><span>${esc(c.name)}</span><div class="bar"><i style="width:${(c.n / chMax) * 100}%"></i></div><b>${int(c.n)}</b></div>`).join('')}</div></section>
    </div>
    <section class="panel"><header><h2>الأرقام اليومية</h2>
      <select id="an-m" aria-label="البند">${d.metrics.map((m) => opt(m.key, m.name, mk)).join('')}</select></header>
      ${mk ? statLine(days, d.days.map((x) => x.metrics[mk])) + trendChart(days, d.days.map((x) => x.metrics[mk]), { tone: 'teal' }) : '<p class="muted">لا توجد بنود</p>'}</section>
    <div class="grid2">
      <section class="panel"><header><h2>دقائق التأخير للفريق</h2></header>${statLine(days, col('lateMinutes'), int, ' د')}${trendChart(days, col('lateMinutes'), { unit: ' دقيقة', tone: 'warn', small: true })}</section>
      <section class="panel"><header><h2>نسبة الحضور %</h2></header>${trendChart(days, rate, { unit: '%', tone: 'good', avg: false, small: true })}
        <p class="muted small">الحاضرون ÷ المجدولون في ذلك اليوم (بدون المعذورين).</p></section>
    </div>`);
  $$('[data-span]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('an-span', b.dataset.span); refresh(); }; });
  const sel = $('#an-m', pg);
  if (sel) sel.onchange = () => { sessionStorage.setItem('an-metric', sel.value); refresh(); };
};

// ------------------------------------------------------------------ barcode scanning
// A scanner (USB or Bluetooth) types the code and presses Enter; the field stays focused so the
// employee just keeps scanning. On phones with a camera barcode reader, a camera mode is offered too.
const SK = { shipment: ['شحنات طالعة', 'شحنة طالعة اليوم'], return: ['مرتجعات من العملاء', 'مرتجع من العملاء اليوم'] };
let audioCtx = null;
function beep(ok) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const tones = ok ? [[1320, 0, .09]] : [[330, 0, .14], [262, .17, .2]];
    for (const [f, at, d] of tones) {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.frequency.value = f; o.type = ok ? 'sine' : 'square'; g.gain.value = ok ? .2 : .12;
      o.connect(g); g.connect(audioCtx.destination); o.start(audioCtx.currentTime + at); o.stop(audioCtx.currentTime + at + d);
    }
  } catch {}
  if (!ok && navigator.vibrate) navigator.vibrate([90, 60, 90]);
}
PAGES.scan = async () => {
  let kind = sessionStorage.getItem('scan-kind') || 'shipment';
  let d = await api(`/api/scans?kind=${kind}`);
  const mgr = ME.manager;
  const canUndo = (x) => mgr || (x.user_id === ME.id && nowMs() - x.ts < 10 * 60000);
  const rowHtml = (x) => `<tr data-row="${x.id}"><td class="num">${fmtT(x.ts)}</td><td dir="ltr"><b>${esc(x.code)}</b></td><td>${esc(x.user_name || '')}</td>
    <td>${canUndo(x) ? `<button class="link bad" data-undo="${x.id}" type="button" aria-label="إلغاء المسح" title="إلغاء المسح">✕</button>` : ''}</td></tr>`;
  const pg = render(`
    <div class="topline"><div><h1>المسح بالباركود</h1><p class="muted small">وجّه جهاز الباركود على البوليصة. كل كود ينحسب مرة وحدة، والعدد يدخل في أرقامك تلقائياً.</p></div></div>
    <div class="seg scanseg" role="tablist">${Object.entries(SK).map(([k, v]) => `<button type="button" data-k="${k}" class="${k === kind ? 'on' : ''}">${v[0]}</button>`).join('')}</div>
    <section class="panel scanbox ${kind}" id="box">
      <div class="scount"><b id="cnt">${int(d.counts[kind])}</b><span>${SK[kind][1]}</span></div>
      <form id="scanF" autocomplete="off"><input id="code" class="scaninput" placeholder="امسح الباركود هنا" inputmode="none" autocomplete="off" autocapitalize="none" spellcheck="false" dir="ltr" aria-label="الكود"></form>
      <p class="sresult" id="res" role="status">جاهز للمسح</p>
      <div class="row" style="justify-content:center">
        <button class="btn ghost sm" type="button" id="kb">إدخال يدوي</button>
        ${'BarcodeDetector' in window ? '<button class="btn ghost sm" type="button" id="cam">المسح بالكاميرا</button>' : ''}
      </div>
    </section>
    <section class="panel"><header><h2>${SK[kind][0]} · اليوم</h2><span class="muted small">إلغاء المسح متاح خلال 10 دقائق</span></header>
      <div class="tbl"><table><thead><tr><th>الوقت</th><th>الكود</th><th>بواسطة</th><th></th></tr></thead><tbody id="list">${d.scans.map(rowHtml).join('')}</tbody></table>
      <p class="empty" id="empty" ${d.scans.length ? 'hidden' : ''}>لم يُمسح شيء بعد</p></div>
    </section>`);
  const input = $('#code', pg), box = $('#box', pg), res = $('#res', pg);
  const focus = () => { if (!document.querySelector('dialog[open]') && document.activeElement !== input) input.focus({ preventScroll: true }); };
  focus();
  const keep = setInterval(() => { if (!input.isConnected) { clearInterval(keep); return; } focus(); }, 800);
  input.addEventListener('blur', () => setTimeout(focus, 150));
  $('#kb', pg).onclick = () => { input.inputMode = input.inputMode === 'none' ? 'text' : 'none'; input.blur(); setTimeout(() => input.focus(), 50); };
  const flash = (ok, text) => {
    box.classList.remove('ok', 'bad'); void box.offsetWidth; box.classList.add(ok ? 'ok' : 'bad');
    res.textContent = text; res.className = `sresult ${ok ? 'good' : 'bad'}`; beep(ok);
  };
  let busy = false;
  async function submit(code) {
    code = code.trim(); if (!code || busy) return; busy = true;
    try {
      const r = await api('/api/scans', { method: 'POST', body: { kind, code } });
      $('#cnt', pg).textContent = int(r.count);
      $('#list', pg).insertAdjacentHTML('afterbegin', rowHtml({ ...r, user_id: ME.id, user_name: ME.name }));
      $('#empty', pg).hidden = true;
      flash(true, `✓ ${code}${r.note ? ` · ${r.note}` : ''}`);
    } catch (e) { flash(false, `${code}: ${e.message}`); } finally { busy = false; }
  }
  $('#scanF', pg).onsubmit = (e) => { e.preventDefault(); const v = input.value; input.value = ''; submit(v); };
  $$('[data-k]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('scan-kind', b.dataset.k); refresh(); }; });
  $('#list', pg).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-undo]'); if (!b) return;
    const r = await act(b, () => api(`/api/scans/${b.dataset.undo}`, { method: 'DELETE' }), 'تم إلغاء المسح');
    if (r) { b.closest('tr').remove(); $('#cnt', pg).textContent = int(r.count); }
  });
  const cam = $('#cam', pg);
  if (cam) cam.onclick = async () => {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { toast('اسمح للمتصفح باستخدام الكاميرا', true); return; }
    const det = new BarcodeDetector();
    let last = '', lastAt = 0, live = true;
    const dl = modal('المسح بالكاميرا', '<video id="vid" playsinline muted style="width:100%;border-radius:12px;background:#000"></video><p class="muted small" style="text-align:center">وجّه الكاميرا على الباركود</p>', () => {});
    const v = $('#vid', dl); v.srcObject = stream; await v.play();
    dl.addEventListener('close', () => { live = false; stream.getTracks().forEach((tr) => tr.stop()); focus(); });
    const loop = async () => {
      if (!live) return;
      try {
        const [hit] = await det.detect(v);
        if (hit && (hit.rawValue !== last || Date.now() - lastAt > 2500)) { last = hit.rawValue; lastAt = Date.now(); submit(hit.rawValue); }
      } catch {}
      setTimeout(loop, 250);
    };
    loop();
  };
};

startInk();
boot();
