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
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

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
  } catch {
    if (!ME) renderLogin();
  }
}

function renderLogin() {
  window.removeEventListener('hashchange', route);
  app.innerHTML = `<div class="login"><form class="card form" id="loginForm">
    <img src="/img/logo-full.png" alt="وريف">
    <p class="tag">فريق العمل · فخامة تليق بك</p>
    <label class="f">اسم المستخدم<input name="username" id="lg-user" autocomplete="username" autocapitalize="none" dir="ltr" required></label>
    <label class="f">كلمة المرور<input name="password" id="lg-pass" type="password" autocomplete="current-password" dir="ltr" required></label>
    <button class="btn" type="submit">دخول</button>
  </form></div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    const ok = await act(btn, () => api('/api/login', { method: 'POST', body: formData(e.target) }));
    if (ok) { location.hash = ''; boot(); }
  };
}

function navItems() {
  if (ME.role === 'admin') {
    return [
      ['dashboard', 'لوحة اليوم', 'home'], ['attendance', 'الحضور والانصراف', 'clock'], ['payroll', 'الرواتب', 'wallet'],
      ['money', 'الخصومات والسلف', 'coins'], ['ops', 'العمليات اليومية', 'box'], ['requests', 'الفسح والنواقص', 'swap'], ['tickets', 'التذاكر', 'ticket'],
      ['flags', 'مؤشرات التلاعب', 'shield'], ['staff', 'الموظفون', 'users'], ['reports', 'التقارير والتصدير', 'file'], ['settings', 'الإعدادات', 'gear'],
    ];
  }
  return [
    ['today', 'البصمة', 'clock'], ['mine', 'سجلي', 'cal'], ['tickets', 'تذاكري', 'ticket'],
    ...(ME.perms.some((p) => p === 'orders' || p === 'stock' || p.startsWith('m:')) ? [['ops', 'العمليات', 'box']] : []),
    ...(ME.perms.includes('requests') ? [['requests', 'الفسح والنواقص', 'swap']] : []), ['account', 'حسابي', 'user'],
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
      <div class="brand"><img src="/img/logo-mark.png" alt="وريف"><span>${esc(ME.name)}${ME.name === 'المدير' ? '' : `<br>${ME.role === 'admin' ? 'المدير' : 'موظف'}`}</span></div>
      ${items.map(([k, label, ic]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${icon(ic)}${label}</a>`).join('')}
      <div class="foot">${ME.role === 'admin' ? `<a href="#/account">${icon('user')}حسابي</a>` : ''}<a href="#" id="logout">${icon('out')}تسجيل الخروج</a></div>
    </nav>
    <main class="main" id="page"><div class="mobile-head"><img src="/img/logo-mark.png" alt="وريف"><span class="muted small">${esc(ME.name)}</span></div><p class="muted">جاري التحميل...</p></main>
    <nav class="tabbar" aria-label="القائمة">${items.map(([k, label, ic]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${icon(ic)}${label}</a>`).join('')}</nav>
  </div>`;
  $('#logout').onclick = async (e) => {
    e.preventDefault();
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    ME = null;
    renderLogin();
  };
  const fn = PAGES[page] || PAGES.account;
  fn().catch((e) => { $('#page').innerHTML = `<div class="panel"><p>${esc(e.message)}</p></div>`; });
}

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
      back: '<button class="btn" data-p="back">عودة من الخروج</button>',
      out: '<button class="btn ghost" data-p="out">تسجيل انصراف</button>',
    };
    const pg = render(`
      <section class="panel punch">
        <div class="clock" id="clock">--:--:--</div>
        <p class="muted">${fmtDate(data.date)}</p>
        <div class="state">${pill(live[0], live[1])} ${d.periods.length ? statusPill(d.status) : pill('لا يوجد دوام اليوم')}</div>
        ${d.periods.length ? `<div class="periods">${d.periods.map((p) => pill(`${p.name}: ${p.start} – ${p.end}`, 'plain')).join('')}</div>` : ''}
        <div class="actions">${data.allowed.map((a) => buttons[a]).join('')}</div>
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
    tick();
  };
  const tick = () => { const c = $('#clock'); if (c) c.textContent = localIso(nowMs()).slice(11, 19); };
  async function punch(type, btn) {
    let note = '';
    if (type === 'leave') {
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
    const r = await act(btn, () => api('/api/punch', { method: 'POST', body: { type, note, client_ts: Date.now(), ...(pos || {}) } }), `تم تسجيل ${PUNCH[type]} الساعة ${fmtT(nowMs())}`);
    if (r) { data = r; draw(); }
  }
  draw();
  window.__tick = setInterval(tick, 1000);
  const poll = setInterval(async () => {
    if (!$('#clock')) { clearInterval(poll); return; }
    try { data = await api('/api/my/today'); draw(); } catch {}
  }, 60000);
};

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
    <div class="topline"><h1>سجلي الشهري</h1><div class="tools"><input type="month" id="mm" value="${month}" aria-label="الشهر"></div></div>
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
    </section>`);
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
      <div class="${flagged ? 'bad' : ''}"><b data-count="${flagged}">0</b><span>بصمات مشبوهة</span></div>
      <div class="${d.openTickets ? 'warn' : ''}"><b data-count="${d.openTickets}">0</b><span>تذاكر مفتوحة</span></div>
    </div>

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
  if (!staffCache) staffCache = (await api('/api/users')).users.filter((u) => u.role === 'employee');
  return staffCache;
}
const staffOptions = (list, sel, all = 'كل الموظفين') => `${all ? opt('', all, sel) : ''}${list.filter((u) => u.active).map((u) => opt(u.id, u.name, sel)).join('')}`;

PAGES.attendance = async () => {
  const st = JSON.parse(sessionStorage.getItem('att') || 'null') || { from: addDays(today(), -6), to: today(), user: '' };
  const [d, staff, ex] = await Promise.all([
    api(`/api/attendance?from=${st.from}&to=${st.to}&user_id=${st.user}`), staffList(), api(`/api/excuses?from=${addDays(today(), -60)}&to=${addDays(today(), 60)}`),
  ]);
  if (!Object.keys(FLAGS).length) FLAGS = (await api(`/api/flags?from=${today()}&to=${today()}`)).labels;
  const pg = render(`
    <div class="topline"><h1>الحضور والانصراف</h1>
      <form class="tools" id="flt">
        <input type="date" name="from" id="f-from" value="${st.from}" aria-label="من">
        <input type="date" name="to" id="f-to" value="${st.to}" aria-label="إلى">
        <select name="user" id="f-user" aria-label="الموظف">${staffOptions(staff, st.user)}</select>
        <a class="btn ghost" href="/api/export/attendance?from=${st.from}&to=${st.to}">${icon('down')}تصدير</a>
      </form></div>
    <section class="panel"><header><h2>الملخص</h2><span class="muted small">${st.from} إلى ${st.to}</span></header>
      ${table(['الموظف', 'أيام العمل', 'حضور', 'غياب', 'غياب جزئي', 'أيام تأخير', 'دقائق التأخير', 'انصراف مبكر', 'خروج أثناء الدوام', 'إضافي', 'الخصم المقترح (ر.س)'],
        d.summary.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${s.workDays}</td><td>${s.presentDays}</td><td>${s.absentDays ? pill(s.absentDays, 'bad') : 0}</td><td>${s.partialDays}</td><td>${s.lateDays}</td><td>${mn(s.lateMinutes)}</td><td>${mn(s.earlyMinutes)}</td><td>${mn(s.exitMinutes)}</td><td>${hm(s.overtimeMinutes)}</td><td>${money(s.suggested)}</td></tr>`))}
      <p class="muted small">الخصم المقترح يُحسب من الراتب: أجر اليوم = الراتب ÷ 30، مقسوماً على دقائق دوام ذلك اليوم. لا يُخصم شيء إلا إذا اعتمدته من صفحة الرواتب أو الخصومات.</p>
    </section>
    <section class="panel"><header><h2>التفاصيل اليومية</h2><span class="muted small">اضغط على أي صف لعرض البصمات</span></header>
      ${table(['اليوم', 'الموظف', 'الحالة', 'الحضور', 'الانصراف', 'تأخير', 'انصراف مبكر', 'خروج', 'ساعات العمل', 'إضافي', 'مقترح', 'ملاحظات'],
        d.rows.slice().sort((a, b) => b.date.localeCompare(a.date) || a.userId - b.userId).map((r) => `<tr class="click" data-u="${r.userId}" data-n="${esc(r.name)}" data-d="${r.date}">
          <td>${fmtDate(r.date)}</td><td>${esc(r.name)}</td><td>${statusPill(r.status)}</td><td>${fmtT(r.firstIn)}</td><td>${fmtT(r.lastOut)}</td><td>${mn(r.lateMinutes)}</td><td>${mn(r.earlyMinutes)}</td><td>${mn(r.exitMinutes)}</td><td>${hm(r.presentMinutes)}</td><td>${hm(r.overtimeMinutes)}</td><td>${r.suggested ? money(r.suggested) : '—'}</td><td>${flagList(r.flags)}</td></tr>`))}
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
      <a class="btn" href="/api/export/payroll?month=${month}">${icon('down')}تصدير Excel</a></div></div>
    <section class="panel">
      ${table(['الموظف', 'الراتب', 'حضور', 'غياب', 'أيام تأخير', 'دقائق التأخير', 'خروج', 'الخصم المقترح', 'الخصومات المعتمدة', 'أقساط السلف', 'الصافي', 'متبقي السلف', ''],
        d.rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${money(r.salary)}</td><td>${r.presentDays}/${r.workDays}</td><td>${r.absentDays ? pill(r.absentDays, 'bad') : 0}</td><td>${r.lateDays}</td><td>${mn(r.lateMinutes)}</td><td>${mn(r.exitMinutes + r.earlyMinutes)}</td>
          <td>${money(r.suggested)}</td><td>${money(r.deductions)}</td><td>${money(r.repayments)}</td><td><b>${money(r.net)}</b></td><td>${money(r.debtBalance)}</td>
          <td><button class="btn sm ghost" data-ded="${r.userId}" data-amt="${Math.max(0, Math.round((r.suggested - r.deductions) * 100) / 100)}">خصم</button></td></tr>`),
        { foot: ['الإجمالي', money(sum('salary')), '', '', '', '', '', money(sum('suggested')), money(sum('deductions')), money(sum('repayments')), money(sum('net')), money(sum('debtBalance')), ''] })}
      <p class="muted small">الصافي = الراتب − الخصومات المعتمدة − أقساط السلف المخصومة من الراتب. الخصم المقترح للاسترشاد فقط ولا يدخل في الصافي حتى تعتمده. ${!d.rows.some((r) => r.salary) ? '<b>أدخل رواتب الموظفين من صفحة الموظفين ليظهر الخصم المقترح.</b>' : ''}</p>
    </section>`);
  $('#pm', pg).onchange = (e) => { sessionStorage.setItem('pay-month', e.target.value || thisMonth()); refresh(); };
  $$('[data-ded]', pg).forEach((b) => { b.onclick = () => deductionModal(+b.dataset.ded, b.dataset.amt); });
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
        <label class="f">${esc(m.name)}<input type="number" min="0" step="1" inputmode="numeric" name="v_${m.key}" id="m-${m.key}" value="${day.metrics[m.key]?.value ?? ''}" placeholder="0"></label>
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
      ${table(['التاريخ', 'النوع', 'التاجر', 'رقم الفاتورة', 'كود المنتج', 'العدد', 'القيمة', 'ملاحظة', 'سجّلها', ...(isAdmin ? [''] : [])],
        d.stock.map((s) => `<tr><td>${s.date}</td><td>${pill(STOCK[s.kind], s.kind === 'new_goods' ? 'good' : 'warn')}</td><td>${esc(s.party)}</td><td dir="ltr">${esc(s.invoice_no)}</td><td dir="ltr"><b>${esc(s.sku || s.description)}</b></td><td>${int(s.quantity)}</td><td>${s.value ? money(s.value) : '—'}</td><td class="wrap">${esc(s.note)}</td><td>${esc(s.created_by_name || '')}</td>${isAdmin ? `<td><button class="link bad" data-sd="${s.id}">حذف</button></td>` : ''}</tr>`),
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
    const metrics = Object.fromEntries(myMetrics.filter((m) => f[`v_${m.key}`] !== '' || f[`n_${m.key}`]).map((m) => [m.key, { value: f[`v_${m.key}`] || 0, note: f[`n_${m.key}`] || '' }]));
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
};

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
  const isAdmin = ME.role === 'admin';
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
  const isAdmin = ME.role === 'admin';
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
      ${isAdmin ? '' : `<section class="panel"><header><h2>تذكرة جديدة</h2></header>
        <form class="form" id="nt">
          <div class="row">
            <label class="f">النوع<select name="kind" id="nt-kind">${Object.entries(TK).map(([k, v]) => opt(k, v)).join('')}</select></label>
            <label class="f">الأولوية<select name="priority" id="nt-pri">${Object.entries(PRI).map(([k, v]) => opt(k, v, 'normal')).join('')}</select></label>
          </div>
          <label class="f">العنوان<input name="title" id="nt-title" required maxlength="140" placeholder="مثال: إنجازات اليوم، أو: نقص في كراتين التغليف"></label>
          <label class="f">التفاصيل<textarea name="body" id="nt-body" rows="6" placeholder="جهّزت 34 طلب، رديت على 20 محادثة، استلمت شحنة المورد..."></textarea></label>
          <button class="btn" type="submit">رفع التذكرة</button>
        </form></section>`}
      <section class="panel" style="${isAdmin ? 'grid-column:1/-1' : ''}"><header><h2>${d.tickets.length} تذكرة</h2></header>
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
  const isAdmin = ME.role === 'admin';
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
      ${table(['الاسم', 'اسم المستخدم', 'الدخول', 'واتساب', 'الراتب', 'الفترات', 'الإجازة الأسبوعية', 'الصلاحيات', 'الحالة', ''],
        d.users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.role === 'admin' ? ` ${pill('مدير', 'info')}` : ''}</td><td dir="ltr">${esc(u.username)}</td>
          <td>${u.has_password ? pill('مفعّل', 'good') : pill('بدون كلمة مرور', 'warn')}</td><td dir="ltr" class="small">${u.role === 'admin' ? '—' : (u.phone ? esc(u.phone) : '<span class="muted">—</span>')}</td><td>${u.role === 'admin' ? '—' : money(u.salary)}</td>
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
        <div class="row"><a class="btn ghost" id="r-print" target="_blank" rel="noopener">${icon('file')}عرض وطباعة</a><a class="btn" id="r-csv">${icon('down')}تنزيل Excel</a></div>
      </section>
      <section class="panel"><header><h2>الحضور لفترة</h2></header>
        <div class="row"><label class="f">من<input type="date" id="r-af" value="${addDays(today(), -29)}"></label><label class="f">إلى<input type="date" id="r-at" value="${today()}"></label></div>
        <a class="btn" id="r-att">${icon('down')}تنزيل</a>
      </section>
      <section class="panel"><header><h2>مسيّر الرواتب الشهري</h2></header>
        <div class="row"><label class="f">الشهر<input type="month" id="r-m" value="${thisMonth()}"></label></div>
        <a class="btn" id="r-pay">${icon('down')}تنزيل</a>
      </section>
      <section class="panel"><header><h2>العمليات والتذاكر لفترة</h2></header>
        <div class="row"><label class="f">من<input type="date" id="r-of" value="${addDays(today(), -29)}"></label><label class="f">إلى<input type="date" id="r-ot" value="${today()}"></label></div>
        <div class="row"><a class="btn" id="r-ops">${icon('down')}العمليات والبضائع</a><a class="btn ghost" id="r-tk">${icon('down')}التذاكر</a></div>
      </section>
      <section class="panel"><header><h2>السلف والنسخ الاحتياطي</h2></header>
        <p class="muted small">النظام يحفظ نسخة احتياطية تلقائياً كل يوم. تقدر تنزّل نسخة كاملة من قاعدة البيانات لحفظها عندك.</p>
        <div class="row"><a class="btn ghost" href="/api/export/debts">${icon('down')}سجل السلف</a><a class="btn ghost" href="/api/backup">${icon('down')}نسخة احتياطية كاملة</a></div>
      </section>
    </div>`);
  const sync = () => {
    const v = (id) => $(id, pg).value;
    $('#r-print', pg).href = `/report/daily?date=${v('#r-day')}`;
    $('#r-csv', pg).href = `/api/export/daily?date=${v('#r-day')}`;
    $('#r-att', pg).href = `/api/export/attendance?from=${v('#r-af')}&to=${v('#r-at')}`;
    $('#r-pay', pg).href = `/api/export/payroll?month=${v('#r-m')}`;
    $('#r-ops', pg).href = `/api/export/ops?from=${v('#r-of')}&to=${v('#r-ot')}`;
    $('#r-tk', pg).href = `/api/export/tickets?from=${v('#r-of')}&to=${v('#r-ot')}`;
  };
  pg.addEventListener('change', sync);
  sync();
};

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
    <section class="panel"><header><h2>إشعارات واتساب</h2>${s.whatsapp.configured ? pill('المزوّد متصل', 'good') : pill('المزوّد غير مضبوط', 'warn')}</header>
      ${s.whatsapp.configured ? '' : '<p class="muted small">أضف بيانات مزوّد واتساب في متغيرات Railway (رابط الإرسال <b dir="ltr">WHATSAPP_API_URL</b> والرمز <b dir="ltr">WHATSAPP_TOKEN</b>)، ثم أعد النشر. إلى ذلك الحين تُحفظ الإشعارات في السجل ولا تُرسل.</p>'}
      <div class="row">
        <label class="f">جوال المدير (تصله التنبيهات والملخص)<input id="n-phone" dir="ltr" inputmode="tel" placeholder="05xxxxxxxx" value="${esc(s.notify.manager_phone)}"></label>
        <label class="f">وقت الملخص اليومي<input type="time" id="n-time" value="${s.notify.summary_time}"></label>
        <label class="f">تذكير الموظف بعد بداية الدوام بـ (دقائق)<input type="number" id="n-after" min="1" max="120" value="${s.notify.remind_after_minutes}"></label>
      </div>
      <div style="display:grid;gap:8px">
        <label class="check"><input type="checkbox" id="n-staff" ${s.notify.remind_staff ? 'checked' : ''}>تذكير الموظف إذا ما سجّل حضور، أو نسي يسجّل انصراف</label>
        <label class="check"><input type="checkbox" id="n-mgr" ${s.notify.alert_manager ? 'checked' : ''}>تنبيهات للمدير: تأخير، غياب، بصمة مشبوهة، خروج مؤقت، طلب فسح أو نواقص، تذكرة جديدة</label>
        <label class="check"><input type="checkbox" id="n-acc" ${s.notify.staff_account ? 'checked' : ''}>إشعار الموظف عن حسابه: خصم، سلفة أو سداد، رد على تذكرته، قرار على طلبه</label>
        <label class="check"><input type="checkbox" id="n-sum" ${s.notify.daily_summary ? 'checked' : ''}>ملخص يومي للمدير: الحضور والتأخير والغياب، الطلبات حسب القناة، الأرقام اليومية، وما لم يُسجَّل</label>
      </div>
      <div class="row"><button type="button" class="btn ghost" id="n-test" style="flex:0 0 auto">إرسال رسالة تجربة لجوالي</button><button type="button" class="btn ghost" id="n-test-sum" style="flex:0 0 auto">أرسل ملخص اليوم الآن</button><a class="link" href="#/notifications" style="flex:0 0 auto;align-self:center">سجل الإشعارات</a></div>
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
        manager_phone: $('#n-phone', pg).value.trim(), summary_time: $('#n-time', pg).value, remind_after_minutes: $('#n-after', pg).value,
        remind_staff: $('#n-staff', pg).checked, alert_manager: $('#n-mgr', pg).checked, staff_account: $('#n-acc', pg).checked, daily_summary: $('#n-sum', pg).checked,
      },
    };
    if (await act(e.target, () => api('/api/settings', { method: 'PUT', body }), 'تم حفظ الإعدادات')) { staffCache = null; boot(); }
  };
};

startInk();
boot();
