// The additions (phase 1): change log, custom WhatsApp messages, decisions, chat, out-of-stock
// products, the employee's own page with correction requests, approvals, and the accounts page.
// app.js hands over its helpers once through mountAdditions(); nothing here changes existing pages.

let C = null; // helpers from app.js
const me = () => C.me();
const isSup = () => me().role === 'admin' || !!me().manager;
const has = (p) => me().role === 'admin' || me().perms.includes(p);
const isFinance = () => has('accountant');
const canShortages = () => isSup() || has('shortages') || has('stock') || has('shortages_notify');
const canRecord = () => isSup() || has('deduct_record');

const NEW_ICONS = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  mega: '<path d="M3 10v4h4l6 4V6L7 10z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  stamp: '<path d="M9 3h6v5l-1 3h4a2 2 0 0 1 2 2v3H4v-3a2 2 0 0 1 2-2h4L9 8z"/><path d="M4 20h16"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  pkg: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10M15 15l4 4M19 15l-4 4"/>',
  idcard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16a3.5 3.5 0 0 1 7 0M14 10h4M14 13h4"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v3M8 18h4"/>',
  note: '<path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h5"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17v.01"/>',
  shift: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
};

const CORR = { in: 'حضور', out: 'انصراف', leave: 'خروج مؤقت', back: 'عودة' };
const APPROVAL = { pending: ['بانتظار المراجعة', 'warn'], approved: ['معتمد', 'good'], rejected: ['مرفوض', 'bad'] };
const PRIORITY = { urgent: ['عاجل', 'bad'], high: ['مرتفع', 'warn'], normal: ['عادي', ''], low: ['منخفض', ''] };
const SHORT = { open: ['غير متوفر', 'bad'], partial: ['متوفر جزئياً', 'warn'], done: ['تم التوفير', 'good'], cancelled: ['ملغي', ''] };
const SEV = { create: 'أُضيف', update: 'تعديل', partial: 'توفير جزئي', done: 'تم التوفير', cancel: 'إلغاء' };
const LEAVE = { leave: 'إجازة', sick: 'مرضية', excused: 'عذر مقبول', permission: 'استئذان' };
const RQ = { pending: ['بانتظار المدير', 'warn'], approved: ['تمت الموافقة', 'info'], rejected: ['مرفوض', 'bad'], done: ['تم التنفيذ', 'good'] };
const TICKET = { open: ['مفتوحة', 'warn'], in_progress: ['قيد المعالجة', 'info'], closed: ['مغلقة', 'good'] };
const FILE = { pending: ['بالانتظار', 'warn'], sent: ['وصل الملف', 'good'], failed: ['تعثّر', 'bad'], no_phone: ['بدون رقم', 'bad'] };

const P = (map, k) => C.pill(...(map[k] || [k, '']));
const when = (ts) => (ts ? `${C.fmtDate(C.localIso(ts).slice(0, 10))} ${C.fmtT(ts)}` : '—');
const lines = (s) => C.esc(s).replace(/\n/g, '<br>');

/** Ask for the reason of an edit; null when cancelled. */
export function askReason(question = 'اكتب سبب التعديل') {
  for (;;) {
    const v = prompt(`${question} (يُحفظ في سجل التعديلات)`);
    if (v === null) return null;
    if (v.trim().length >= 3) return v.trim();
    alert('اكتب السبب بوضوح (3 أحرف على الأقل)');
  }
}

/** Add the new pages to the menu that app.js builds for this user. */
export function addNav(items) {
  if (!me()) return items;
  setTimeout(Chat.ensure, 0);
  const add = [];
  const emp = me().role === 'employee';
  if (emp) add.push(['profile', 'صفحتي', 'idcard']);
  else add.push(['profile', 'صفحات الموظفين', 'idcard']);
  if (isSup()) add.push(['cases', 'الحالات', 'alert'], ['approvals', 'طلبات الاعتماد', 'check']);
  else if (canRecord()) add.push(['record', 'خصم أو ملاحظة', 'note']);
  if (canShortages()) add.push(['shortages', 'المنتجات غير المتوفرة', 'pkg']);
  if (isSup()) add.push(['shifts', 'استثناءات الدوام', 'shift'], ['decisions', 'القرارات', 'stamp'], ['broadcast', 'رسالة واتساب', 'mega']);
  if (isFinance() && me().role !== 'admin') add.push(['finance', 'الحسابات', 'calc']);
  if (isSup() || isFinance()) add.push(['changes', 'سجل التعديلات', 'history']);
  const keys = new Set(items.map(([k]) => k));
  const fresh = add.filter(([k]) => !keys.has(k));
  const at = items.findIndex(([k]) => k === (me().role === 'admin' ? 'flags' : 'account'));
  return at < 0 ? [...items, ...fresh] : [...items.slice(0, at), ...fresh, ...items.slice(at)];
}

export function mountAdditions(ctx) {
  C = ctx;
  Object.assign(C.ICONS, NEW_ICONS);
  Object.assign(C.PAGES, { changes, broadcast, decisions, shortages, profile, approvals, record, finance, cases, shifts });
  // the owner's settings page gets one more panel: show or hide deduction amounts from employees
  const settingsPage = C.PAGES.settings;
  if (settingsPage) C.PAGES.settings = async () => { await settingsPage(); await settingsPanel(); };
}

// ------------------------------------------------------------------ people picker
const pickPeople = (people, name = 'uid', checked = []) => `<div class="ad-people">${people.map((p) => `<label class="check"><input type="checkbox" name="${name}" value="${p.id}" ${checked.includes(p.id) ? 'checked' : ''}>${C.esc(p.name)}</label>`).join('')}</div>`;
const picked = (root, name = 'uid') => C.$$(`input[name="${name}"]:checked`, root).map((x) => Number(x.value));

// ------------------------------------------------------------------ change log
async function changes() {
  const st = JSON.parse(sessionStorage.getItem('chg') || '{}');
  const q = new URLSearchParams({ area: st.area || '', user_id: st.user || '', from: st.from || '', to: st.to || '' });
  const [d, ppl] = await Promise.all([C.api(`/api/changes?${q}`), C.api('/api/staff-names')]);
  const areaName = (a) => d.areas[a] || a;
  const pg = C.render(`
    <div class="topline"><h1>سجل التعديلات</h1></div>
    <section class="panel"><form class="ad-filters" id="chF">
      <label class="f">القسم<select name="area">${C.opt('', 'كل الأقسام', st.area)}${Object.entries(d.areas).map(([k, v]) => C.opt(k, v, st.area)).join('')}</select></label>
      <label class="f">الموظف<select name="user">${C.opt('', 'الكل', st.user)}${ppl.people.map((p) => C.opt(p.id, p.name, st.user)).join('')}</select></label>
      <label class="f">من<input type="date" name="from" value="${d.from}"></label>
      <label class="f">إلى<input type="date" name="to" value="${d.to}"></label>
    </form></section>
    <section class="panel"><header><h2>${C.int(d.changes.length)} تعديل</h2><span class="muted small">كل تعديل محفوظ باسم من عدّله ووقته والقيمة قبل وبعد والسبب، ولا يُحذف</span></header>
      ${C.table(['الوقت', 'بواسطة', 'الإجراء', 'الموظف', 'التغيير', 'السبب'], d.changes.map((c) => `<tr>
        <td class="nowrap small">${when(c.ts)}</td><td>${C.esc(c.actor_name || '—')}</td><td><b>${C.esc(c.action)}</b><div class="muted small">${C.esc(areaName(c.area))}</div></td>
        <td>${C.esc(c.target_name || '—')}</td>
        <td class="wrap small"><span class="ad-before">${C.esc(c.before || '—')}</span> ← <span class="ad-after">${C.esc(c.after || '—')}</span>${c.ref ? `<div class="muted">${C.esc(c.ref)}</div>` : ''}</td>
        <td class="wrap small">${C.esc(c.reason)}</td></tr>`),
      { empty: 'لا توجد تعديلات في هذه الفترة' })}
    </section>`);
  C.$('#chF', pg).onchange = (e) => { sessionStorage.setItem('chg', JSON.stringify(C.formData(e.currentTarget))); C.refresh(); };
}

// ------------------------------------------------------------------ custom WhatsApp message
async function broadcast() {
  const [d, ppl] = await Promise.all([C.api('/api/broadcasts'), C.api('/api/staff-names')]);
  const pg = C.render(`
    <div class="topline"><h1>رسالة واتساب للموظفين</h1></div>
    <div class="grid2">
      <section class="panel"><header><h2>رسالة جديدة</h2></header>
        <form class="form" id="bcF">
          <label class="f">العنوان<input name="title" maxlength="80" placeholder="رسالة من الإدارة"></label>
          <label class="f">نص الرسالة<textarea name="body" rows="5" maxlength="1500" required placeholder="مثال: اجتماع للجميع الساعة 4 العصر"></textarea></label>
          <div class="seg" role="radiogroup" aria-label="المستلمون"><button type="button" class="on" data-to="all">كل الموظفين</button><button type="button" data-to="some">موظفين محددين</button></div>
          <div id="bc-some" hidden>${pickPeople(ppl.people)}</div>
          <button class="btn" type="submit">${C.icon('mega')}إرسال</button>
          <p class="muted small">توصل الرسالة على واتساب كل موظف مختار وكإشعار على جواله، بالتصميم المعتاد لرسائل النظام.</p>
        </form></section>
      <section class="panel"><header><h2>آخر الرسائل</h2></header>
        ${d.broadcasts.length ? `<div class="list">${d.broadcasts.map((b) => `<div class="item">
          <div class="top"><b class="small">${when(b.created_at)}</b><span class="muted small">${C.esc(b.by_name || '')}</span></div>
          <div class="ad-msg">${lines(b.body)}</div>
          <div class="ad-chips">${b.recipients.map((r) => `<span class="pill ${r.status === 'sent' ? 'good' : r.status === 'failed' || r.status === 'no_phone' ? 'bad' : 'warn'}" title="${C.esc(r.error)}">${C.esc(r.name)} · ${C.esc(r.label)}</span>`).join('')}</div>
        </div>`).join('')}</div>` : '<p class="empty">ما أرسلت رسائل بعد</p>'}
      </section>
    </div>`);
  const f = C.$('#bcF', pg);
  let to = 'all';
  C.$$('[data-to]', f).forEach((b) => { b.onclick = () => { to = b.dataset.to; C.$$('[data-to]', f).forEach((x) => x.classList.toggle('on', x === b)); C.$('#bc-some', f).hidden = to === 'all'; }; });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { ...C.formData(f), user_ids: to === 'all' ? 'all' : picked(f) };
    if (to === 'all' && !confirm('إرسال الرسالة لكل الموظفين؟')) return;
    const r = await C.act(C.$('button[type=submit]', f), () => C.api('/api/broadcasts', { method: 'POST', body }));
    if (r) { C.toast(`أُرسلت لـ ${r.recipients} موظف${r.noPhone.length ? ` · بدون رقم: ${r.noPhone.join('، ')}` : ''}`, !!r.noPhone.length); C.refresh(); }
  };
}

// ------------------------------------------------------------------ decisions
async function decisions() {
  const [d, ppl] = await Promise.all([C.api('/api/decisions'), C.api('/api/staff-names')]);
  const pg = C.render(`
    <div class="topline"><h1>القرارات الإدارية</h1><div class="tools"><button class="btn" id="dc-new" type="button">${C.icon('stamp')}قرار جديد</button></div></div>
    <section class="panel"><header><h2>القرارات</h2><span class="muted small">القرار يصدر بالقالب الرسمي برقم تسلسلي، ويوصل الموظف رابط يقرأه ويقرّ بالاطلاع، وملف PDF على واتساب</span></header>
      ${d.decisions.length ? `<div class="list">${d.decisions.map((x) => `<div class="item">
        <div class="top"><b>${C.esc(x.title)}</b>${x.status === 'issued' ? C.pill(x.number, 'good') : C.pill('مسودة', 'warn')}</div>
        <div class="muted small">${x.status === 'issued' ? `صدر ${when(x.issued_at)} · ${C.int(x.recipients)} موظف · الملف وصل ${C.int(x.files_sent)} · فتحه ${C.int(x.seen)} · أقرّ ${C.int(x.acked)}` : `أُنشئ ${when(x.created_at)}${x.by_name ? ` · ${C.esc(x.by_name)}` : ''}`}</div>
        ${x.status === 'issued' ? `<div class="ad-bar"><i style="width:${x.recipients ? Math.round((x.acked / x.recipients) * 100) : 0}%"></i></div>` : ''}
        <div class="acts"><a class="link" href="/decision/${x.id}" target="_blank" rel="noopener">معاينة</a><a class="link" href="/decision/${x.id}/pdf" target="_blank" rel="noopener">PDF</a>
          ${x.status === 'draft' ? `<button class="link" data-edit="${x.id}">تعديل</button><button class="link" data-issue="${x.id}"><b>إصدار وإرسال</b></button><button class="link bad" data-del="${x.id}">حذف</button>`
            : `<button class="link" data-track="${x.id}">متابعة الإقرارات</button>`}</div>
      </div>`).join('')}</div>` : '<p class="empty">ما في قرارات بعد. اضغط «قرار جديد»</p>'}
    </section>`);
  C.$('#dc-new', pg).onclick = () => decisionEditor(null);
  C.$$('[data-edit]', pg).forEach((b) => { b.onclick = async () => { const r = await C.act(b, () => C.api(`/api/decisions/${b.dataset.edit}`)); if (r) decisionEditor(r.decision); }; });
  C.$$('[data-del]', pg).forEach((b) => { b.onclick = async () => { if (confirm('حذف المسودة؟') && await C.act(b, () => C.api(`/api/decisions/${b.dataset.del}`, { method: 'DELETE' }), 'حُذفت المسودة')) C.refresh(); }; });
  C.$$('[data-issue]', pg).forEach((b) => { b.onclick = () => issueDialog(+b.dataset.issue, ppl.people); });
  C.$$('[data-track]', pg).forEach((b) => { b.onclick = () => trackDialog(+b.dataset.track); });
}

function decisionEditor(dec) {
  const arts = dec ? JSON.parse(dec.articles || '[]') : [{ title: '', body: '' }];
  const artHtml = (a = {}) => `<fieldset class="ad-art"><div class="row"><label class="f">عنوان المادة<input name="a_title" value="${C.esc(a.title || '')}" maxlength="100"></label>
      <label class="check"><input type="checkbox" name="a_warn" ${a.warn ? 'checked' : ''}>تنبيه (تظهر بلون مميز)</label></div>
    <label class="f">نص المادة<textarea name="a_body" rows="3" maxlength="3000" placeholder="اكتب **كلمة** للتغميق، وابدأ السطر بـ - للنقاط">${C.esc(a.body || '')}</textarea></label>
    <button type="button" class="link bad" data-rm>حذف المادة</button></fieldset>`;
  C.modal(dec ? 'تعديل مسودة القرار' : 'قرار إداري جديد', `<form class="form" id="dcF">
      <label class="f">عنوان القرار<input name="title" required maxlength="140" value="${C.esc(dec?.title || '')}" placeholder="مثال: تنظيم أوقات الدوام"></label>
      <label class="f">عنوان فرعي<input name="subtitle" maxlength="140" value="${C.esc(dec?.subtitle || '')}"></label>
      <label class="f">الديباجة<textarea name="preamble" rows="2" maxlength="1500" placeholder="بناءً على مصلحة العمل…">${C.esc(dec?.preamble || '')}</textarea></label>
      <div class="row"><label class="f">تاريخ الإصدار<input type="date" name="issued_date" value="${dec?.issued_date || C.today()}"></label>
        <label class="f">يُعمل به من<input type="date" name="effective_date" value="${dec?.effective_date || C.today()}"></label></div>
      <div id="dc-arts">${arts.map(artHtml).join('')}</div>
      <button type="button" class="btn ghost" id="dc-add">+ إضافة مادة</button>
      <p class="muted small">رقم القرار يُعطى عند الإصدار. المسودة تقدر تعدّلها وتعاينها قبل الإرسال.</p>
      <button class="btn" type="submit">حفظ المسودة</button>
    </form>`, (dl) => {
    const box = C.$('#dc-arts', dl);
    const wire = () => C.$$('[data-rm]', box).forEach((b) => { b.onclick = () => { if (C.$$('.ad-art', box).length > 1) b.closest('.ad-art').remove(); }; });
    wire();
    C.$('#dc-add', dl).onclick = () => { box.insertAdjacentHTML('beforeend', artHtml()); wire(); C.$$('.ad-art', box).at(-1).querySelector('input').focus(); };
    C.$('#dcF', dl).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        title: f.title.value, subtitle: f.subtitle.value, preamble: f.preamble.value, issued_date: f.issued_date.value, effective_date: f.effective_date.value,
        articles: C.$$('.ad-art', box).map((a) => ({ title: C.$('[name=a_title]', a).value, body: C.$('[name=a_body]', a).value, warn: C.$('[name=a_warn]', a).checked })),
      };
      const r = await C.act(C.$('button[type=submit]', f), () => C.api(dec ? `/api/decisions/${dec.id}` : '/api/decisions', { method: dec ? 'PUT' : 'POST', body }), 'حُفظت المسودة');
      if (r) { dl.close(); C.refresh(); }
    };
  });
}

function issueDialog(id, people) {
  C.modal('إصدار القرار وإرساله', `<form class="form" id="isF">
      <div class="seg" role="radiogroup"><button type="button" class="on" data-to="all">كل الموظفين</button><button type="button" data-to="some">موظفين محددين</button></div>
      <div id="is-some" hidden>${pickPeople(people)}</div>
      <p class="muted small">بعد الإصدار يأخذ القرار رقمه ولا يُعدّل. كل موظف يوصله على واتساب رابط القرار ليقرّ بالاطلاع، ثم ملف PDF في رسالة مستقلة.</p>
      <button class="btn" type="submit">إصدار وإرسال</button></form>`, (dl) => {
    const f = C.$('#isF', dl);
    let to = 'all';
    C.$$('[data-to]', f).forEach((b) => { b.onclick = () => { to = b.dataset.to; C.$$('[data-to]', f).forEach((x) => x.classList.toggle('on', x === b)); C.$('#is-some', f).hidden = to === 'all'; }; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const r = await C.act(C.$('button[type=submit]', f), () => C.api(`/api/decisions/${id}/issue`, { method: 'POST', body: { user_ids: to === 'all' ? 'all' : picked(f) } }));
      if (r) { dl.close(); C.toast(`صدر القرار ${r.number || ''} وأُرسل`); C.refresh(); }
    };
  });
}

async function trackDialog(id) {
  const d = await C.api(`/api/decisions/${id}`).catch((e) => { C.toast(e.message, true); return null; });
  if (!d) return;
  C.modal(`متابعة: ${d.decision.title}`, `<p class="muted small">${C.esc(d.decision.number)}</p>
    ${C.table(['الموظف', 'ملف PDF', 'فتح الرابط', 'الإقرار'], d.recipients.map((r) => `<tr><td>${C.esc(r.name)}</td><td>${P(FILE, r.file_status)}${r.file_error ? `<div class="muted small">${C.esc(r.file_error)}</div>` : ''}</td>
      <td class="small">${r.seen_at ? when(r.seen_at) : '—'}</td><td>${r.ack_at ? C.pill(`أقرّ ${when(r.ack_at)}`, 'good') : C.pill('لم يقرّ', 'warn')}</td></tr>`))}
    <div class="acts"><button class="btn ghost" id="tr-resend" type="button">إعادة إرسال الملف لمن تعثّر</button></div>`, (dl) => {
    C.$('#tr-resend', dl).onclick = async (e) => { const r = await C.act(e.target, () => C.api(`/api/decisions/${id}/resend`, { method: 'POST', body: {} })); if (r) { C.toast(`أُعيد ${r.queued ?? 0} ملف للإرسال`); dl.close(); } };
  });
}

// ------------------------------------------------------------------ out-of-stock products
async function shortages() {
  const status = sessionStorage.getItem('sh-status') || 'active';
  const d = await C.api(`/api/shortages?status=${status}`);
  const pg = C.render(`
    <div class="topline"><h1>المنتجات غير المتوفرة</h1><div class="tools">
      <div class="seg" role="tablist">${[['active', 'قيد المتابعة'], ['done', 'تم توفيرها'], ['all', 'الكل']].map(([k, l]) => `<button type="button" data-st="${k}" class="${k === status ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
    <div class="kpis">
      <div class="kpi ${d.counts.active ? 'bad' : 'good'}"><b>${C.int(d.counts.active)}</b><span>منتج غير متوفر</span></div>
      <div class="kpi ${d.counts.partial ? 'warn' : ''}"><b>${C.int(d.counts.partial)}</b><span>متوفر جزئياً</span></div>
      <div class="kpi ${d.counts.late ? 'bad' : ''}"><b>${C.int(d.counts.late)}</b><span>تجاوز الموعد المتوقع</span></div>
    </div>
    ${d.canManage ? `<section class="panel"><header><h2>إضافة منتج غير متوفر</h2><span class="muted small">يوصل تذكير يومي على واتساب الساعة 10 صباحاً حتى تضغط «تم توفير الطلب»</span></header>
      <form class="form" id="shF">
        <div class="row"><label class="f">كود المنتج<input name="sku" dir="ltr" required autocomplete="off"></label><label class="f">اسم المنتج<input name="name" maxlength="120"></label></div>
        <div class="row"><label class="f">الكمية<input type="number" name="qty" min="1" value="1" required></label>
          <label class="f">الأولوية<select name="priority">${Object.entries(PRIORITY).map(([k, [v]]) => C.opt(k, v, 'normal')).join('')}</select></label></div>
        <div class="row"><label class="f">المسؤول عن توفيره<select name="assignee_id">${C.opt('', 'بدون')}${d.people.map((p) => C.opt(p.id, p.name)).join('')}</select></label>
          <label class="f">موعد التوفير المتوقع<input type="date" name="due_date"></label></div>
        <label class="f">ملاحظة<input name="note" maxlength="500"></label>
        <label class="f">صورة المنتج (اختياري)<input type="file" accept="image/*" id="sh-img"></label>
        <button class="btn" type="submit">إضافة</button>
      </form></section>` : ''}
    <section class="panel"><header><h2>${status === 'active' ? 'قيد المتابعة' : status === 'done' ? 'المغلقة' : 'كل الطلبات'}</h2></header>
      ${d.shortages.length ? `<div class="list">${d.shortages.map((s) => `<div class="item ad-sh${s.late ? ' over' : ''}">
        <div class="top"><b dir="ltr" class="num">${C.esc(s.sku)}</b><span>${P(SHORT, s.status)} ${P(PRIORITY, s.priority)}</span></div>
        <div class="ad-shrow">${s.image ? `<a href="/shortage-image/${s.id}" target="_blank" rel="noopener"><img class="ad-thumb" src="/shortage-image/${s.id}" alt="" loading="lazy"></a>` : ''}
          <div>${s.name ? `<div>${C.esc(s.name)}</div>` : ''}
            <div class="small">توفّر <b>${C.int(s.qty_done)}</b> من <b>${C.int(s.qty)}</b>${s.assignee_name ? ` · المسؤول: ${C.esc(s.assignee_name)}` : ''}${s.due_date ? ` · المتوقع ${C.fmtDate(s.due_date)}${s.late ? ' (متأخر)' : ''}` : ''}</div>
            <div class="ad-bar"><i style="width:${Math.round((s.qty_done / s.qty) * 100)}%"></i></div>
            <div class="muted small">أضافه ${C.esc(s.created_name || '')} ${when(s.created_at)}${s.done_at ? ` · وفّره ${C.esc(s.done_name || '')} ${when(s.done_at)}` : ''}</div>
            ${s.note ? `<div class="exnote small">📝 ${C.esc(s.note)}</div>` : ''}</div></div>
        ${s.events.length > 1 ? `<details class="small"><summary>السجل (${s.events.length})</summary><ul class="ad-ev">${s.events.map((e) => `<li>${when(e.ts)} · ${SEV[e.kind] || e.kind}${e.qty && e.kind !== 'create' ? ` ${e.qty}` : ''} · ${C.esc(e.name || '')}${e.note ? ` · ${C.esc(e.note)}` : ''}</li>`).join('')}</ul></details>` : ''}
        ${d.canManage && (s.status === 'open' || s.status === 'partial') ? `<div class="acts"><button class="btn sm" data-done="${s.id}">تم توفير الطلب</button>
          ${s.qty - s.qty_done > 1 ? `<button class="link" data-part="${s.id}">توفير جزئي</button>` : ''}<button class="link" data-edit="${s.id}">تعديل</button><button class="link bad" data-cancel="${s.id}">إلغاء</button></div>` : ''}
      </div>`).join('')}</div>` : `<p class="empty">${status === 'active' ? 'كل المنتجات متوفرة 👌' : 'لا توجد طلبات'}</p>`}
    </section>`);
  C.$$('[data-st]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('sh-status', b.dataset.st); C.refresh(); }; });
  const row = (id) => d.shortages.find((x) => x.id === +id);
  const f = C.$('#shF', pg);
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const body = C.formData(f);
    const file = C.$('#sh-img', f).files[0];
    const r = await C.act(C.$('button[type=submit]', f), async () => {
      if (file) body.image = await shrink(file);
      return C.api('/api/shortages', { method: 'POST', body });
    }, 'أُضيف المنتج ووصل التنبيه');
    if (r) C.refresh();
  };
  C.$$('[data-done]', pg).forEach((b) => { b.onclick = async () => { if (confirm(`تم توفير ${row(b.dataset.done).sku} بالكامل؟`) && await C.act(b, () => C.api(`/api/shortages/${b.dataset.done}/supply`, { method: 'POST', body: { all: true } }), 'تم التوفير ووقف التذكير')) C.refresh(); }; });
  C.$$('[data-part]', pg).forEach((b) => { b.onclick = async () => {
    const s = row(b.dataset.part);
    const v = prompt(`كم قطعة توفرت من ${s.sku}؟ (المتبقي ${s.qty - s.qty_done})`);
    if (v && await C.act(b, () => C.api(`/api/shortages/${s.id}/supply`, { method: 'POST', body: { qty: Number(v) } }), 'تم التسجيل')) C.refresh();
  }; });
  C.$$('[data-cancel]', pg).forEach((b) => { b.onclick = async () => { const why = prompt('سبب الإلغاء'); if (why && await C.act(b, () => C.api(`/api/shortages/${b.dataset.cancel}/cancel`, { method: 'POST', body: { reason: why } }), 'أُلغي الطلب')) C.refresh(); }; });
  C.$$('[data-edit]', pg).forEach((b) => { b.onclick = () => {
    const s = row(b.dataset.edit);
    C.modal(`تعديل ${s.sku}`, `<form class="form" id="seF">
        <div class="row"><label class="f">اسم المنتج<input name="name" value="${C.esc(s.name)}"></label><label class="f">الكمية<input type="number" name="qty" min="${Math.max(1, s.qty_done)}" value="${s.qty}"></label></div>
        <div class="row"><label class="f">الأولوية<select name="priority">${Object.entries(PRIORITY).map(([k, [v]]) => C.opt(k, v, s.priority)).join('')}</select></label>
          <label class="f">المسؤول<select name="assignee_id">${C.opt('', 'بدون', s.assignee_id || '')}${d.people.map((p) => C.opt(p.id, p.name, s.assignee_id || '')).join('')}</select></label></div>
        <label class="f">موعد التوفير المتوقع<input type="date" name="due_date" value="${s.due_date || ''}"></label>
        <label class="f">ملاحظة<input name="note" value="${C.esc(s.note)}"></label>
        <label class="f">تغيير الصورة<input type="file" accept="image/*" id="se-img"></label>
        <button class="btn" type="submit">حفظ</button></form>`, (dl) => {
      C.$('#seF', dl).onsubmit = async (e) => {
        e.preventDefault();
        const body = C.formData(e.target);
        const file = C.$('#se-img', dl).files[0];
        const r = await C.act(C.$('button[type=submit]', e.target), async () => { if (file) body.image = await shrink(file); return C.api(`/api/shortages/${s.id}`, { method: 'PUT', body }); }, 'تم الحفظ');
        if (r) { dl.close(); C.refresh(); }
      };
    });
  }; });
}

/** Photos from the phone camera are large: scale to 1280px and JPEG before upload. */
function shrink(file, max = 1280) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      ok(cv.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => fail(new Error('تعذّر قراءة الصورة'));
    // a data: URL, since the page's security policy allows no blob: images
    const rd = new FileReader();
    rd.onload = () => { img.src = rd.result; };
    rd.onerror = () => fail(new Error('تعذّر قراءة الصورة'));
    rd.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------ the employee's page
async function profile() {
  const viewer = isSup() || isFinance();
  const month = sessionStorage.getItem('pf-month') || C.today().slice(0, 7);
  let uid = sessionStorage.getItem('pf-user') || '';
  const ppl = viewer ? (await C.api('/api/profile/people')).people : [];
  if (me().role === 'admin' && !uid && ppl.length) uid = String(ppl[0].id);
  const d = await C.api(`/api/profile?month=${month}${uid ? `&user_id=${uid}` : ''}`);
  const self = d.user.id === me().id;
  const s = d.attendance.summary || {};
  const pend = (list) => list.filter((x) => x.status === 'pending').length;
  const reqs = [
    ...d.requests.corrections.map((x) => `<div class="item"><div class="top"><b>تصحيح ${CORR[x.type]} ${x.time}</b>${P(APPROVAL, x.status)}</div><div class="small">${C.fmtDate(x.date)} · ${C.esc(x.reason)}</div>${x.response ? `<div class="muted small">الرد: ${C.esc(x.response)}</div>` : ''}</div>`),
    ...d.requests.leaves.map((x) => `<div class="item"><div class="top"><b>${LEAVE[x.kind] || x.kind} ${x.from_date}${x.to_date && x.to_date !== x.from_date ? ` → ${x.to_date}` : ''}</b>${P(APPROVAL, x.status)}</div>${x.response ? `<div class="muted small">الرد: ${C.esc(x.response)}</div>` : ''}</div>`),
    ...d.requests.requests.map((x) => `<div class="item"><div class="top"><b>${x.kind === 'release' ? 'فسح' : 'نواقص'} <span dir="ltr">${C.esc(x.sku)}</span></b>${P(RQ, x.status)}</div><div class="small">${C.esc(x.date)}</div></div>`),
    ...d.requests.tickets.map((x) => `<div class="item"><div class="top"><b>🎫 ${C.esc(x.title)}</b>${P(TICKET, x.status)}</div></div>`),
  ];
  const pg = C.render(`
    <div class="topline"><h1>${self ? 'صفحتي' : `صفحة ${C.esc(d.user.name)}`}</h1><div class="tools">
      ${viewer ? `<select id="pf-user" aria-label="الموظف">${me().role === 'employee' ? C.opt('', 'صفحتي', uid) : ''}${ppl.filter((p) => p.id !== me().id).map((p) => C.opt(p.id, p.name, uid)).join('')}</select>` : ''}
      <input type="month" id="pf-month" value="${d.month}" aria-label="الشهر"></div></div>
    <section class="panel ad-hero"><div class="ad-avatar">${C.esc(d.user.name.slice(0, 1))}</div>
      <div><h2>${C.esc(d.user.name)}</h2><div class="muted small">@${C.esc(d.user.username)} · معنا من ${C.esc(d.user.since)}${d.user.day_off ? ` · الإجازة الأسبوعية: ${C.esc(d.user.day_off)}` : ''}</div></div></section>
    <div class="kpis">
      <div class="kpi good"><b>${C.int(s.presentDays)}</b><span>أيام الحضور</span></div>
      <div class="kpi ${s.absentDays ? 'bad' : ''}"><b>${C.int(s.absentDays)}</b><span>أيام الغياب</span></div>
      <div class="kpi ${s.lateMinutes ? 'warn' : ''}"><b>${C.int(s.lateMinutes)}</b><span>دقائق التأخير</span></div>
      <div class="kpi"><b>${C.int((s.exitMinutes || 0) + (s.earlyMinutes || 0))}</b><span>دقائق الخروج والانصراف المبكر</span></div>
      ${d.salary ? `<div class="kpi"><b>${C.money(d.salary.net)}</b><span>صافي الراتب (ر.س)</span></div>` : ''}
    </div>
    <div class="grid2">
      <section class="panel"><header><h2>الدوام هذا الأسبوع</h2><span class="muted small">السماح ${C.int(d.shift.grace)} دقيقة</span></header>
        ${C.table(['اليوم', 'الفترات'], d.shift.week.map((w) => `<tr><td>${w.day}${w.changed ? ` ${C.pill('دوام معدّل', 'info')}` : ''}</td><td>${w.periods.length ? w.periods.map((p) => `<span class="pill" dir="ltr">${p.start}–${p.end}</span>`).join(' ') : '<span class="muted">إجازة</span>'}</td></tr>`))}
      </section>
      <section class="panel"><header><h2>المهام</h2></header>
        ${d.tasks.decisions.length || d.tasks.shortages.length || d.tasks.tickets.length || d.tasks.cases.length ? `<div class="list">
          ${d.tasks.cases.map((x) => `<div class="item"><div class="top"><b>${x.kind === 'missing_out' ? `🕘 لم تسجّل انصراف ${C.esc(x.period_name)}` : `🚪 خروج بدون إذن ${x.minutes} دقيقة`}</b>${C.pill('بانتظار المراجعة', 'warn')}</div><div class="small">${C.fmtDate(x.date)} · إذا نسيت البصمة قدّم طلب تصحيح تحت</div></div>`).join('')}
          ${d.tasks.decisions.map((x) => `<div class="item"><div class="top"><b>📜 ${C.esc(x.title)}</b>${C.pill('بانتظار إقرارك', 'warn')}</div><div class="acts"><a class="link" href="/ack/${encodeURIComponent(x.token)}" target="_blank" rel="noopener">قراءة القرار</a><button class="link" data-ack="${x.id}"><b>أقرّ بالاطلاع</b></button></div></div>`).join('')}
          ${d.tasks.shortages.map((x) => `<div class="item"><div class="top"><b>📦 توفير <span dir="ltr">${C.esc(x.sku)}</span></b>${P(PRIORITY, x.priority)}</div><div class="small">${C.esc(x.name || '')} · ${C.int(x.qty_done)} من ${C.int(x.qty)}${x.due_date ? ` · المتوقع ${C.fmtDate(x.due_date)}` : ''}</div></div>`).join('')}
          ${d.tasks.tickets.map((x) => `<div class="item"><div class="top"><b>🎫 ${C.esc(x.title)}</b>${P(TICKET, x.status)}</div></div>`).join('')}
        </div>` : '<p class="empty">ما عليك مهام مفتوحة 👌</p>'}
      </section>
    </div>
    ${d.salary ? `<section class="panel"><header><h2>الراتب · ${C.esc(d.salary.month)}</h2>${d.salary.closed ? C.pill('مقفل', 'good') : C.pill('مفتوح، الأرقام تتحدث', 'warn')}</header>
      <div class="ad-money"><div><span>الراتب الأساسي</span><b>${C.money(d.salary.base)}</b></div>${d.salary.hidden ? '' : `<div><span>الخصومات</span><b class="bad">− ${C.money(d.salary.deductions)}</b></div>`}
        <div><span>أقساط السلف</span><b class="bad">− ${C.money(d.salary.repayments)}</b></div><div class="net"><span>الصافي</span><b>${C.money(d.salary.net)}</b></div><div><span>متبقي السلف</span><b>${C.money(d.salary.loanBalance)}</b></div></div>
      ${d.salary.list.length ? C.table(['التاريخ', 'الخصم', 'المبلغ', 'التفاصيل'], d.salary.list.map((x) => `<tr><td>${x.date}</td><td>${C.esc(C.DED[x.category] || x.category)}</td><td>${C.money(x.amount)}</td><td class="wrap">${C.esc(x.reason)}</td></tr>`)) : ''}
    </section>` : ''}
    <div class="grid2">
      <section class="panel"><header><h2>حالة الطلبات</h2>${pend([...d.requests.corrections, ...d.requests.leaves]) ? C.pill(`${pend([...d.requests.corrections, ...d.requests.leaves])} بانتظار المراجعة`, 'warn') : ''}</header>
        ${reqs.length ? `<div class="list">${reqs.join('')}</div>` : '<p class="empty">لا توجد طلبات</p>'}
      </section>
      ${self && me().role === 'employee' ? `<section class="panel"><header><h2>طلب تصحيح بصمة</h2><span class="muted small">لآخر 31 يوماً · يراجعه المشرف</span></header>
        <form class="form" id="crF">
          <div class="row"><label class="f">اليوم<input type="date" name="date" max="${C.today()}" value="${C.today()}" required></label>
            <label class="f">البصمة<select name="type">${Object.entries(CORR).map(([k, v]) => C.opt(k, v)).join('')}</select></label></div>
          <label class="f">الوقت الصحيح<input type="time" name="time" required></label>
          <label class="f">السبب<input name="reason" required maxlength="400" placeholder="مثال: نسيت أبصم الانصراف"></label>
          <button class="btn" type="submit">إرسال الطلب</button>
        </form></section>` : `<section class="panel"><header><h2>الإجازات هذه السنة</h2></header>
        ${C.table(['التاريخ', 'النوع', 'ملاحظة'], d.leaves.map((x) => `<tr><td>${C.fmtDate(x.date)}</td><td>${LEAVE[x.kind] || x.kind}</td><td class="wrap">${C.esc(x.note || '')}</td></tr>`), { empty: 'لا توجد إجازات مسجلة' })}</section>`}
    </div>
    ${self && me().role === 'employee' ? `<section class="panel"><header><h2>الإجازات هذه السنة</h2><span class="muted small">يضيفها المشرف</span></header>
      ${C.table(['التاريخ', 'النوع', 'ملاحظة'], d.leaves.map((x) => `<tr><td>${C.fmtDate(x.date)}</td><td>${LEAVE[x.kind] || x.kind}</td><td class="wrap">${C.esc(x.note || '')}</td></tr>`), { empty: 'لا توجد إجازات مسجلة' })}</section>` : ''}
    ${d.decisions.length ? `<section class="panel"><header><h2>القرارات</h2></header><div class="list">${d.decisions.map((x) => `<div class="item"><div class="top"><b>${C.esc(x.title)}</b>${x.ack_at ? C.pill(`أقررت ${when(x.ack_at)}`, 'good') : C.pill('بانتظار إقرارك', 'warn')}</div>
      <div class="muted small">${C.esc(x.number)}${x.effective_date ? ` · يُعمل به من ${C.esc(x.effective_date)}` : ''}</div><div class="acts"><a class="link" href="/ack/${encodeURIComponent(x.token)}" target="_blank" rel="noopener">قراءة</a><a class="link" href="/ack/${encodeURIComponent(x.token)}/pdf" target="_blank" rel="noopener">PDF</a>${x.ack_at ? '' : `<button class="link" data-ack="${x.id}"><b>أقرّ بالاطلاع</b></button>`}</div></div>`).join('')}</div></section>` : ''}
    <section class="panel"><header><h2>أيام ${C.esc(d.month)}</h2></header>
      ${C.table(['اليوم', 'الحالة', 'الحضور', 'الانصراف', 'تأخير', 'خروج'], d.attendance.days.slice().reverse().map((r) => `<tr><td>${C.fmtDate(r.date)}</td><td>${C.statusPill(r.status)}</td><td>${C.fmtT(r.firstIn)}</td><td>${C.fmtT(r.lastOut)}</td><td>${C.mn(r.lateMinutes)}</td><td>${C.mn((r.exitMinutes || 0) + (r.earlyMinutes || 0))}</td></tr>`), { empty: 'لا توجد أيام' })}
    </section>`);
  C.$('#pf-month', pg).onchange = (e) => { sessionStorage.setItem('pf-month', e.target.value || C.today().slice(0, 7)); C.refresh(); };
  const sel = C.$('#pf-user', pg);
  if (sel) sel.onchange = () => { sessionStorage.setItem('pf-user', sel.value); C.refresh(); };
  C.$$('[data-ack]', pg).forEach((b) => { b.onclick = async () => { if (await C.act(b, () => C.api(`/api/my/decisions/${b.dataset.ack}/ack`, { method: 'POST' }), 'تم تسجيل إقرارك')) C.refresh(); }; });
  const f = C.$('#crF', pg);
  if (f) f.onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button', f), () => C.api('/api/corrections', { method: 'POST', body: C.formData(f) }), 'وصل طلبك للمشرف')) C.refresh(); };
}

// ------------------------------------------------------------------ approvals (supervisors)
async function approvals() {
  const [cr, dr, notes, dg] = await Promise.all([C.api('/api/corrections'), C.api('/api/deduction-requests'), C.api('/api/notes'), C.api('/api/delegates')]);
  const pg = C.render(`
    <div class="topline"><h1>طلبات الاعتماد</h1></div>
    <div class="kpis"><div class="kpi ${cr.corrections.length ? 'warn' : ''}"><b>${C.int(cr.corrections.length)}</b><span>تصحيح بصمة</span></div>
      <div class="kpi ${dr.requests.length ? 'warn' : ''}"><b>${C.int(dr.requests.length)}</b><span>خصم بانتظار الاعتماد</span></div></div>
    <section class="panel"><header><h2>طلبات تصحيح البصمة</h2></header>
      ${cr.corrections.length ? `<div class="list">${cr.corrections.map((c) => `<div class="item"><div class="top"><b>${C.esc(c.name)}</b><span class="small">${C.fmtDate(c.date)} · ${CORR[c.type]} <b dir="ltr">${c.time}</b></span></div>
        <div class="small">${C.esc(c.reason)}</div><div class="muted small">طُلب ${when(c.created_at)}</div>
        <div class="acts">${c.user_id === me().id && me().role !== 'admin' ? '<span class="muted small">طلبك يعتمده المدير</span>' : `<button class="btn sm" data-cok="${c.id}">اعتماد وإضافة البصمة</button><button class="link bad" data-cno="${c.id}">رفض</button>`}</div></div>`).join('')}</div>` : '<p class="empty">ما في طلبات تصحيح</p>'}
    </section>
    <section class="panel"><header><h2>خصومات مسجّلة بانتظار الاعتماد</h2><span class="muted small">ما يدخل الخصم في الراتب إلا بعد اعتمادك. ما تعتمد خصماً سجّلته أنت أو عليك</span></header>
      ${dr.requests.length ? `<div class="list">${dr.requests.map((r) => `<div class="item"><div class="top"><b>${C.esc(r.name)} · ${C.money(r.amount)} ر.س</b><span class="small">${C.esc(dr.labels[r.category] || r.category)} · ${C.fmtDate(r.date)}</span></div>
        <div class="small">${C.esc(r.reason)}</div><div class="muted small">سجّله ${C.esc(r.created_name || '')} ${when(r.created_at)}</div>
        <div class="acts">${r.created_by === me().id || r.user_id === me().id ? '<span class="muted small">يعتمده مشرف آخر أو المدير</span>' : `<button class="btn sm" data-dok="${r.id}">اعتماد الخصم</button><button class="link bad" data-dno="${r.id}">رفض</button>`}</div></div>`).join('')}</div>` : '<p class="empty">ما في خصومات بانتظار الاعتماد</p>'}
    </section>
    <div class="grid2">
      <section class="panel"><header><h2>تسجيل خصم أو ملاحظة</h2></header>${recordForms(dg.people, dr.labels)}</section>
      <section class="panel"><header><h2>صلاحية تسجيل الخصومات والملاحظات</h2><span class="muted small">الموظف المفوّض يسجّل، وأنت تعتمد</span></header>
        <div class="list">${dg.people.filter((p) => p.id !== me().id).map((p) => { const on = dg.delegates.some((x) => x.id === p.id); return `<div class="item"><div class="top"><b>${C.esc(p.name)}</b>${on ? `<span>${C.pill('مفوّض', 'good')} <button class="link bad" data-dg="${p.id}" data-on="0">سحب</button></span>` : `<button class="link" data-dg="${p.id}" data-on="1">منح الصلاحية</button>`}</div></div>`; }).join('')}</div>
      </section>
    </div>
    <section class="panel"><header><h2>الملاحظات على الموظفين</h2></header>
      ${C.table(['الوقت', 'الموظف', 'الملاحظة', 'رفعها'], notes.notes.map((n) => `<tr><td class="nowrap small">${when(n.created_at)}</td><td>${C.esc(n.name)}</td><td class="wrap">${C.esc(n.body)}</td><td>${C.esc(n.created_name || '')}</td></tr>`), { empty: 'لا توجد ملاحظات' })}
    </section>`);
  const decide = (sel, url, status, ok) => C.$$(sel, pg).forEach((b) => { b.onclick = async () => {
    const id = Object.values(b.dataset)[0];
    let response = '';
    if (status === 'rejected') { response = prompt('سبب الرفض'); if (!response) return; }
    if (await C.act(b, () => C.api(`${url}/${id}`, { method: 'PUT', body: { status, response } }), ok)) C.refresh();
  }; });
  decide('[data-cok]', '/api/corrections', 'approved', 'اعتُمد وأُضيفت البصمة');
  decide('[data-cno]', '/api/corrections', 'rejected', 'رُفض الطلب');
  decide('[data-dok]', '/api/deduction-requests', 'approved', 'اعتُمد الخصم');
  decide('[data-dno]', '/api/deduction-requests', 'rejected', 'رُفض الخصم');
  C.$$('[data-dg]', pg).forEach((b) => { b.onclick = async () => { if (await C.act(b, () => C.api('/api/delegates', { method: 'PUT', body: { user_id: +b.dataset.dg, on: b.dataset.on === '1' } }), 'تم')) C.refresh(); }; });
  wireRecord(pg);
}

const recordForms = (people, labels) => `<div class="seg" role="tablist" id="rc-tab"><button type="button" class="on" data-t="ded">خصم</button><button type="button" data-t="note">ملاحظة</button></div>
  <form class="form" id="rcD">
    <div class="row"><label class="f">الموظف<select name="user_id" required>${C.opt('', 'اختر الموظف')}${people.filter((p) => p.id !== me().id).map((p) => C.opt(p.id, p.name)).join('')}</select></label>
      <label class="f">النوع<select name="category">${Object.entries(labels).map(([k, v]) => C.opt(k, v, 'other')).join('')}</select></label></div>
    <div class="row"><label class="f">المبلغ (ر.س)<input type="number" name="amount" min="0.01" step="0.01" required></label><label class="f">التاريخ<input type="date" name="date" value="${C.today()}" required></label></div>
    <label class="f">السبب<input name="reason" required maxlength="300"></label>
    <button class="btn" type="submit">تسجيل (بانتظار الاعتماد)</button></form>
  <form class="form" id="rcN" hidden>
    <label class="f">الموظف<select name="user_id" required>${C.opt('', 'اختر الموظف')}${people.filter((p) => p.id !== me().id).map((p) => C.opt(p.id, p.name)).join('')}</select></label>
    <label class="f">الملاحظة<textarea name="body" rows="3" required maxlength="1000"></textarea></label>
    <button class="btn" type="submit">رفع الملاحظة</button></form>`;

function wireRecord(pg) {
  C.$$('#rc-tab [data-t]', pg).forEach((b) => { b.onclick = () => { C.$$('#rc-tab [data-t]', pg).forEach((x) => x.classList.toggle('on', x === b)); C.$('#rcD', pg).hidden = b.dataset.t !== 'ded'; C.$('#rcN', pg).hidden = b.dataset.t !== 'note'; }; });
  C.$('#rcD', pg).onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button', e.target), () => C.api('/api/deduction-requests', { method: 'POST', body: C.formData(e.target) }), 'سُجّل الخصم ووصل المشرف للاعتماد')) C.refresh(); };
  C.$('#rcN', pg).onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button', e.target), () => C.api('/api/notes', { method: 'POST', body: C.formData(e.target) }), 'وصلت الملاحظة للمشرف')) C.refresh(); };
}

// ------------------------------------------------------------------ delegated recorder
async function record() {
  const [ppl, dr, notes] = await Promise.all([C.api('/api/staff-names'), C.api('/api/deduction-requests?status=all'), C.api('/api/notes')]);
  const pg = C.render(`
    <div class="topline"><h1>تسجيل خصم أو ملاحظة</h1></div>
    <div class="grid2">
      <section class="panel"><header><h2>جديد</h2><span class="muted small">الخصم ما يدخل الراتب إلا بعد اعتماد المشرف</span></header>${recordForms(ppl.people, dr.labels)}</section>
      <section class="panel"><header><h2>ما سجّلته</h2></header>
        ${dr.requests.length ? `<div class="list">${dr.requests.map((r) => `<div class="item"><div class="top"><b>${C.esc(r.name)} · ${C.money(r.amount)} ر.س</b>${P(APPROVAL, r.status)}</div><div class="small">${C.esc(r.reason)}</div>${r.response ? `<div class="muted small">الرد: ${C.esc(r.response)}</div>` : ''}</div>`).join('')}</div>` : '<p class="empty">ما سجّلت خصومات</p>'}
        ${notes.notes.length ? `<h3 class="small">الملاحظات</h3>${C.table(['الوقت', 'الموظف', 'الملاحظة'], notes.notes.map((n) => `<tr><td class="small nowrap">${when(n.created_at)}</td><td>${C.esc(n.name)}</td><td class="wrap">${C.esc(n.body)}</td></tr>`))}` : ''}
      </section>
    </div>`);
  wireRecord(pg);
}

// ------------------------------------------------------------------ accounts
async function finance() {
  const month = sessionStorage.getItem('fn-month') || C.today().slice(0, 7);
  const d = await C.api(`/api/finance?month=${month}`);
  const sum = (k) => d.payroll.reduce((t, r) => t + (r[k] || 0), 0);
  const DEBT = { loan: ['سلفة', 'warn'], repayment: ['سداد', 'good'] };
  const pg = C.render(`
    <div class="topline"><h1>الحسابات</h1><div class="tools"><input type="month" id="fn-month" value="${d.month}" aria-label="الشهر"></div></div>
    <section class="panel closebar ${d.closed ? 'done' : ''}"><p>${d.closed ? `${C.pill('مقفل', 'good')} الشهر مقفل والأرقام مجمّدة.` : `${C.pill('مفتوح', 'warn')} الأرقام تتحدث مع كل بصمة وخصم.`}
      ${d.canLock ? (d.closed ? '<button class="btn sm ghost" id="fn-open" type="button">فتح الشهر للتعديل</button>' : '<button class="btn sm" id="fn-close" type="button">إقفال الشهر</button>') : ''}</p></section>
    <section class="panel"><header><h2>مسيّر الرواتب</h2></header>
      ${C.table(['الموظف', 'الراتب', 'حضور', 'غياب', 'الخصومات', 'أقساط السلف', 'الصافي', 'متبقي السلف', ''], d.payroll.map((r) => `<tr><td><b>${C.esc(r.name)}</b></td><td>${C.money(r.salary)}</td><td>${r.presentDays}/${r.workDays}</td><td>${r.absentDays}</td>
        <td>${C.money(r.deductions)}</td><td>${C.money(r.repayments)}</td><td><b>${C.money(r.net)}</b></td><td>${C.money(r.debtBalance)}</td><td><a class="link" href="/finance/payslip?month=${d.month}&user_id=${r.userId}" target="_blank" rel="noopener">القسيمة</a></td></tr>`),
      { foot: ['الإجمالي', C.money(sum('salary')), '', '', C.money(sum('deductions')), C.money(sum('repayments')), C.money(sum('net')), C.money(sum('debtBalance')), ''] })}
    </section>
    <div class="grid2">
      <section class="panel"><header><h2>تسجيل سلفة أو سداد</h2></header>
        <form class="form" id="fnL">
          <div class="row"><label class="f">الموظف<select name="user_id" required>${C.opt('', 'اختر الموظف')}${d.people.filter((p) => p.id !== me().id).map((p) => C.opt(p.id, p.name)).join('')}</select></label>
            <label class="f">النوع<select name="kind" id="fn-kind">${C.opt('loan', 'سلفة جديدة')}${C.opt('repayment', 'سداد / قسط')}</select></label></div>
          <div class="row"><label class="f">المبلغ (ر.س)<input type="number" name="amount" min="0.01" step="0.01" required></label><label class="f">التاريخ<input type="date" name="date" value="${C.today()}" required></label></div>
          <label class="check" id="fn-sal-l" hidden><input type="checkbox" name="from_salary" checked>يُخصم من الراتب (وإلا فهو سداد نقدي)</label>
          <label class="f">ملاحظة<input name="note" maxlength="300"></label>
          <button class="btn" type="submit">حفظ</button></form></section>
      <section class="panel"><header><h2>أرصدة السلف</h2></header>
        ${C.table(['الموظف', 'المتبقي'], d.balances.map((b) => `<tr><td>${C.esc(b.name)}</td><td><b>${C.money(b.balance)}</b></td></tr>`), { empty: 'لا توجد سلف' })}</section>
    </div>
    <section class="panel"><header><h2>الخصومات المعتمدة</h2></header>
      ${C.table(['التاريخ', 'الموظف', 'النوع', 'المبلغ', 'التفاصيل'], d.deductions.map((x) => `<tr><td>${x.date}</td><td>${C.esc(x.user_name)}</td><td>${C.esc(C.DED[x.category] || x.category)}</td><td><b>${C.money(x.amount)}</b></td><td class="wrap">${C.esc(x.reason)}</td></tr>`), { empty: 'لا توجد خصومات هذا الشهر' })}
    </section>
    <section class="panel"><header><h2>السلف والسداد هذا الشهر</h2></header>
      ${C.table(['التاريخ', 'الموظف', 'النوع', 'المبلغ', 'ملاحظة'], d.debts.map((x) => `<tr><td>${x.date}</td><td>${C.esc(x.user_name)}</td><td>${P(DEBT, x.kind)}</td><td>${C.money(x.amount)}</td><td class="wrap">${C.esc(x.note)}</td></tr>`), { empty: 'لا توجد حركات' })}
    </section>`);
  C.$('#fn-month', pg).onchange = (e) => { sessionStorage.setItem('fn-month', e.target.value || C.today().slice(0, 7)); C.refresh(); };
  const reopen = C.$('#fn-open', pg);
  if (reopen) reopen.onclick = async () => { const reason = askReason('سبب فتح الشهر المقفل'); if (reason && await C.act(reopen, () => C.api(`/api/payroll/close/${d.month}`, { method: 'DELETE', body: { reason } }), 'فُتح الشهر')) C.refresh(); };
  const lock = C.$('#fn-close', pg);
  if (lock) lock.onclick = async () => { if (confirm(`إقفال مسيّر ${d.month}؟ تتجمّد الأرقام وتوصل القسائم للموظفين.`) && await C.act(lock, () => C.api('/api/payroll/close', { method: 'POST', body: { month: d.month } }), 'أُقفل الشهر')) C.refresh(); };
  C.$('#fn-kind', pg).onchange = (e) => { C.$('#fn-sal-l', pg).hidden = e.target.value !== 'repayment'; };
  C.$('#fnL', pg).onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button[type=submit]', e.target), () => C.api('/api/finance/debts', { method: 'POST', body: C.formData(e.target) }), 'تم الحفظ ووصل الموظف إشعار')) C.refresh(); };
}

// ------------------------------------------------------------------ review cases
async function cases() {
  const status = sessionStorage.getItem('cs-status') || 'pending';
  const d = await C.api(`/api/cases?status=${status}`);
  const range = (c) => (c.kind === 'unauthorized_exit' ? `${C.fmtT(c.started_at)} ← ${C.fmtT(c.ended_at)} · ${c.minutes} دقيقة` : `${C.esc(c.period_name)} · انتهت ${C.fmtT(c.started_at)}${c.note ? ` · ${C.esc(c.note)}` : ''}`);
  const CS = { pending: ['بانتظار المراجعة', 'warn'], approved: ['معتمدة', 'bad'], dismissed: ['ملغاة', 'good'] };
  const pg = C.render(`
    <div class="topline"><h1>الحالات</h1><div class="tools">
      <div class="seg" role="tablist">${[['pending', 'بانتظار المراجعة'], ['done', 'تمت مراجعتها']].map(([k, l]) => `<button type="button" data-st="${k}" class="${k === status ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
    <div class="kpis"><div class="kpi ${d.counts.missing ? 'warn' : ''}"><b>${C.int(d.counts.missing)}</b><span>لم يسجّل انصراف</span></div>
      <div class="kpi ${d.counts.exits ? 'warn' : ''}"><b>${C.int(d.counts.exits)}</b><span>خروج بدون إذن</span></div></div>
    <section class="panel"><header><h2>${status === 'pending' ? 'بانتظار قرارك' : 'آخر الحالات'}</h2><span class="muted small">عدم تسجيل الانصراف: الاعتماد يحسب الفترة غياب. الخروج بدون إذن: الاعتماد يسجّل الخصم (ريال لكل ${d.lateRate} دقائق)</span></header>
      ${d.cases.length ? `<div class="list">${d.cases.map((c) => `<div class="item"><div class="top"><b>${C.esc(c.name)} · ${C.esc(d.kinds[c.kind])}</b>${P(CS, c.status)}</div>
        <div class="small">${C.fmtDate(c.date)} · ${range(c)}</div>
        ${c.kind === 'unauthorized_exit' ? `<div class="small">الخصم ${c.status === 'pending' ? 'المقترح' : ''}: <b>${C.money(c.amount)} ر.س</b></div>` : ''}
        ${c.status !== 'pending' ? `<div class="muted small">${C.esc(c.decided_name || '')} ${when(c.decided_at)}${c.response ? ` · ${C.esc(c.response)}` : ''}</div>` : ''}
        ${c.status === 'pending' ? `<div class="acts">${c.user_id === me().id && me().role !== 'admin' ? '<span class="muted small">حالتك يراجعها المدير</span>'
          : c.kind === 'unauthorized_exit' ? `<label class="ad-amt">الخصم<input type="number" min="0" step="0.5" value="${c.amount}" data-amt="${c.id}"></label><button class="btn sm" data-ok="${c.id}">اعتماد الخصم</button><button class="link" data-no="${c.id}">إلغاء (بعذر)</button>`
          : `<button class="btn sm" data-ok="${c.id}">اعتماد الغياب</button><button class="link" data-no="${c.id}">إلغاء (كان حاضراً)</button>`}</div>` : ''}
      </div>`).join('')}</div>` : `<p class="empty">${status === 'pending' ? 'ما في حالات بانتظار المراجعة 👌' : 'لا توجد حالات'}</p>`}
    </section>`);
  C.$$('[data-st]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('cs-status', b.dataset.st); C.refresh(); }; });
  C.$$('[data-ok]', pg).forEach((b) => { b.onclick = async () => {
    const amt = C.$(`[data-amt="${b.dataset.ok}"]`, pg);
    if (await C.act(b, () => C.api(`/api/cases/${b.dataset.ok}`, { method: 'PUT', body: { status: 'approved', ...(amt ? { amount: amt.value } : {}) } }), 'تم الاعتماد')) C.refresh();
  }; });
  C.$$('[data-no]', pg).forEach((b) => { b.onclick = async () => {
    const response = prompt('سبب الإلغاء');
    if (response && await C.act(b, () => C.api(`/api/cases/${b.dataset.no}`, { method: 'PUT', body: { status: 'dismissed', response } }), 'أُلغيت الحالة')) C.refresh();
  }; });
}

// ------------------------------------------------------------------ shift exceptions
async function shifts() {
  const d = await C.api('/api/shift-exceptions');
  const regular = (date) => d.schedule.days[new Date(`${date}T00:00:00Z`).getUTCDay()] || [];
  const row = (p = {}) => `<div class="row ad-per"><input type="hidden" name="pid" value="${C.esc(p.id || '')}"><label class="f">الفترة<input name="pname" value="${C.esc(p.name || '')}" placeholder="مثال: الصباحية"></label>
    <label class="f">من<input type="time" name="pstart" value="${p.start || ''}" required></label><label class="f">إلى<input type="time" name="pend" value="${p.end || ''}" required></label><button type="button" class="link bad" data-rm>حذف</button></div>`;
  const show = (list) => (list.length ? list.map((p) => `<span class="pill" dir="ltr">${p.start}–${p.end}</span>`).join(' ') : C.pill('بدون دوام', 'warn'));
  const pg = C.render(`
    <div class="topline"><h1>استثناءات الدوام</h1></div>
    <div class="grid2">
      <section class="panel"><header><h2>استثناء جديد</h2><span class="muted small">يتقدّم على الجدول المعتاد لهذا اليوم فقط</span></header>
        <form class="form" id="shxF">
          <div class="row"><label class="f">اليوم<input type="date" name="date" id="shx-date" value="${C.today()}" required></label>
            <label class="f">لمن<select name="user_id" id="shx-user">${C.opt('', 'كل الموظفين')}${d.people.filter((p) => me().role === 'admin' || p.id !== me().id).map((p) => C.opt(p.id, p.name)).join('')}</select></label></div>
          <label class="check"><input type="checkbox" name="off" id="shx-off">بدون دوام هذا اليوم</label>
          <div id="shx-pers"></div>
          <button type="button" class="btn ghost" id="shx-add">+ فترة</button>
          <label class="f">السبب<input name="note" required maxlength="200" placeholder="مثال: جرد المستودع، دوام رمضان، يوم بديل"></label>
          <button class="btn" type="submit">حفظ وإبلاغ الموظفين</button>
        </form></section>
      <section class="panel"><header><h2>الاستثناءات</h2></header>
        ${d.exceptions.length ? `<div class="list">${d.exceptions.map((e) => `<div class="item"><div class="top"><b>${C.fmtDate(e.date)} · ${e.user_id ? C.esc(e.name) : 'كل الموظفين'}</b><span>${show(e.periods)}</span></div>
          <div class="small">${C.esc(e.note)}</div><div class="muted small">${C.esc(e.created_name || '')} ${when(e.created_at)}</div>
          ${e.date >= C.today() ? `<div class="acts"><button class="link bad" data-del="${e.id}">حذف</button></div>` : ''}</div>`).join('')}</div>` : '<p class="empty">ما في استثناءات. الدوام يمشي على الجدول المعتاد</p>'}
      </section>
    </div>`);
  const f = C.$('#shxF', pg);
  const box = C.$('#shx-pers', f);
  const wire = () => C.$$('[data-rm]', box).forEach((b) => { b.onclick = () => b.closest('.ad-per').remove(); });
  const fill = () => { box.innerHTML = (C.$('#shx-off', f).checked ? [] : regular(f.date.value)).map(row).join(''); wire(); };
  fill();
  f.date.onchange = fill;
  C.$('#shx-off', f).onchange = () => { fill(); C.$('#shx-add', f).hidden = C.$('#shx-off', f).checked; };
  C.$('#shx-add', f).onclick = () => { box.insertAdjacentHTML('beforeend', row()); wire(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const periods = C.$$('.ad-per', box).map((r) => ({ id: C.$('[name=pid]', r).value, name: C.$('[name=pname]', r).value, start: C.$('[name=pstart]', r).value, end: C.$('[name=pend]', r).value }));
    const body = { date: f.date.value, user_id: f.user_id.value || null, off: C.$('#shx-off', f).checked, periods, note: f.note.value };
    if (await C.act(C.$('button[type=submit]', f), () => C.api('/api/shift-exceptions', { method: 'POST', body }), 'حُفظ الاستثناء ووصل الموظفين')) C.refresh();
  };
  C.$$('[data-del]', pg).forEach((b) => { b.onclick = async () => { const reason = askReason('سبب حذف الاستثناء'); if (reason && await C.act(b, () => C.api(`/api/shift-exceptions/${b.dataset.del}`, { method: 'DELETE', body: { reason } }), 'حُذف')) C.refresh(); }; });
}

// ------------------------------------------------------------------ a panel on the owner's settings page
async function settingsPanel() {
  if (me()?.role !== 'admin' || C.$('#ad-set')) return;
  const s = await C.api('/api/addition-settings').catch(() => null);
  const main = document.getElementById('page');
  if (!s || !main) return;
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = 'ad-set';
  panel.innerHTML = `<header><h2>الخصومات في حسابات الموظفين</h2></header>
    <label class="check"><input type="checkbox" id="ad-hide" ${s.hide_deductions ? 'checked' : ''}>إخفاء مبالغ الخصومات عن الموظفين (يشوف الصافي فقط في «سجلي» والقسيمة والرسائل)</label>
    <p class="muted small">المدير والحسابات يشوفون كل التفاصيل دائماً.</p>`;
  (C.$('.topline', main)?.nextElementSibling ? main.insertBefore(panel, C.$('.topline', main).nextElementSibling) : main.append(panel));
  const cb = C.$('#ad-hide', panel);
  cb.onchange = async () => {
    const r = await C.act(null, () => C.api('/api/addition-settings', { method: 'PUT', body: { hide_deductions: cb.checked } }), cb.checked ? 'أُخفيت الخصومات عن الموظفين' : 'الخصومات ظاهرة للموظفين');
    if (!r) cb.checked = !cb.checked;
  };
}

// ------------------------------------------------------------------ floating chat
const Chat = {
  el: null, open: false, view: 'list', chatId: null, lastId: 0, all: false, poll: null, badge: null,
  ensure() {
    const host = document.getElementById('app');
    if (!me() || !document.querySelector('.shell')) { Chat.teardown(); return; }
    if (Chat.el?.isConnected) return;
    Chat.el = document.createElement('div');
    Chat.el.className = 'cw';
    Chat.el.innerHTML = `<button type="button" class="cw-btn" aria-label="المحادثات">${C.icon('chat')}<span class="cw-badge" hidden>0</span></button><div class="cw-panel" hidden role="dialog" aria-label="المحادثات"></div>`;
    host.append(Chat.el);
    C.$('.cw-btn', Chat.el).onclick = () => (Chat.open ? Chat.close() : Chat.show());
    clearInterval(Chat.badge);
    Chat.badge = setInterval(() => { if (document.visibilityState === 'visible') Chat.unread(); }, 30000);
    Chat.unread();
  },
  teardown() { clearInterval(Chat.badge); clearInterval(Chat.poll); Chat.el?.remove(); Chat.el = null; Chat.open = false; },
  async unread() {
    if (!Chat.el) return;
    try {
      const { unread } = await Chat.get('/api/chat/unread');
      const b = C.$('.cw-badge', Chat.el);
      if (!b) return;
      b.hidden = !unread; b.textContent = unread > 99 ? '99+' : unread;
    } catch { /* offline or signed out */ }
  },
  // chat requests are not tied to the page on screen, so a page change must not drop them
  async get(path) {
    const res = await fetch(path, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'تعذّر تنفيذ الطلب');
    return data;
  },
  panel() { return C.$('.cw-panel', Chat.el); },
  show() { Chat.open = true; Chat.panel().hidden = false; Chat.el.classList.add('on'); Chat.list(); },
  close() { Chat.open = false; clearInterval(Chat.poll); Chat.panel().hidden = true; Chat.el.classList.remove('on'); Chat.unread(); },
  head(title, back = false) {
    return `<div class="cw-head">${back ? '<button type="button" class="cw-back" aria-label="رجوع">›</button>' : ''}<b>${C.esc(title)}</b><button type="button" class="cw-x" aria-label="إغلاق">×</button></div>`;
  },
  wireHead() {
    C.$('.cw-x', Chat.panel()).onclick = Chat.close;
    const back = C.$('.cw-back', Chat.panel());
    if (back) back.onclick = Chat.list;
  },
  async list() {
    clearInterval(Chat.poll);
    Chat.view = 'list';
    const p = Chat.panel();
    let d;
    try { d = await Chat.get(`/api/chat${Chat.all ? '?all=1' : ''}`); } catch (e) { C.toast(e.message, true); return; }
    if (!Chat.open || Chat.view !== 'list') return;
    p.innerHTML = `${Chat.head('المحادثات')}
      <div class="cw-tools"><button type="button" class="btn sm" id="cw-new">+ محادثة جديدة</button>${isSup() ? `<label class="check small"><input type="checkbox" id="cw-all" ${Chat.all ? 'checked' : ''}>كل محادثات الفريق</label>` : ''}</div>
      <div class="cw-list">${d.chats.length ? d.chats.map((c) => `<button type="button" class="cw-row${c.unread ? ' new' : ''}" data-c="${c.id}">
        <span class="cw-av">${c.is_group ? '👥' : C.esc(c.title.slice(0, 1))}</span>
        <span class="cw-meta"><b>${C.esc(c.title)}</b><small>${c.last_by ? `${C.esc(c.last_by)}: ` : ''}${C.esc(c.last_body.slice(0, 60)) || '<i>لا رسائل بعد</i>'}</small></span>
        <span class="cw-side"><small>${C.fmtT(c.last_at)}</small>${c.unread ? `<em>${c.unread}</em>` : ''}${c.mine ? '' : '<small class="muted">اطلاع</small>'}</span></button>`).join('') : '<p class="empty">ما عندك محادثات. ابدأ واحدة 👋</p>'}</div>`;
    Chat.wireHead();
    C.$('#cw-new', p).onclick = Chat.compose;
    const all = C.$('#cw-all', p);
    if (all) all.onchange = () => { Chat.all = all.checked; Chat.list(); };
    C.$$('[data-c]', p).forEach((b) => { b.onclick = () => Chat.thread(+b.dataset.c); });
    Chat.poll = setInterval(() => { if (Chat.open && Chat.view === 'list' && document.visibilityState === 'visible') Chat.list(); }, 20000);
  },
  async compose() {
    clearInterval(Chat.poll);
    Chat.view = 'new';
    const p = Chat.panel();
    let d;
    try { d = await Chat.get('/api/chat/people'); } catch (e) { C.toast(e.message, true); return; }
    p.innerHTML = `${Chat.head('محادثة جديدة', true)}<form class="cw-new" id="cwF">
      <input name="q" placeholder="ابحث بالاسم" autocomplete="off">
      <div class="cw-pick">${d.people.map((x) => `<label class="check"><input type="checkbox" name="uid" value="${x.id}"><span>${C.esc(x.name)}</span></label>`).join('')}</div>
      <input name="title" maxlength="60" placeholder="اسم المجموعة (اختياري، لأكثر من شخص)">
      <button class="btn" type="submit">ابدأ المحادثة</button></form>`;
    Chat.wireHead();
    const f = C.$('#cwF', p);
    f.q.oninput = () => C.$$('.cw-pick label', f).forEach((l) => { l.hidden = !l.textContent.includes(f.q.value.trim()); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const r = await C.act(C.$('button', f), () => C.api('/api/chat', { method: 'POST', body: { user_ids: picked(f), title: f.title.value } }));
      if (r) Chat.thread(r.id);
    };
  },
  async thread(id) {
    clearInterval(Chat.poll);
    Chat.view = 'thread'; Chat.chatId = id; Chat.lastId = 0;
    const p = Chat.panel();
    let d;
    try { d = await Chat.get(`/api/chat/${id}`); } catch (e) { C.toast(e.message, true); return; }
    if (!Chat.open || Chat.chatId !== id) return;
    const title = d.chat.title || d.chat.members.filter((m) => m.id !== me().id).map((m) => m.name).join('، ');
    p.innerHTML = `${Chat.head(title, true)}<div class="cw-sub small muted">${d.chat.members.map((m) => C.esc(m.name)).join('، ')}</div>
      <div class="cw-msgs" aria-live="polite"></div>
      ${d.chat.mine ? `<form class="cw-send" id="cwS"><textarea name="body" rows="1" maxlength="2000" placeholder="اكتب رسالة" required></textarea><button class="btn sm" type="submit">إرسال</button></form>` : '<p class="cw-ro small muted">تطّلع على المحادثة بصفتك مشرفاً، ولا تقدر تكتب فيها</p>'}`;
    Chat.wireHead();
    Chat.append(d.messages);
    const f = C.$('#cwS', p);
    if (f) {
      const ta = f.body;
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        const r = await C.act(C.$('button', f), () => C.api(`/api/chat/${id}`, { method: 'POST', body: { body: text } }));
        if (r) { ta.value = ''; Chat.append([r.message]); ta.focus(); }
      };
      ta.focus();
    }
    Chat.poll = setInterval(async () => {
      if (!Chat.open || Chat.view !== 'thread' || Chat.chatId !== id || document.visibilityState !== 'visible') return;
      try { const n = await Chat.get(`/api/chat/${id}?after=${Chat.lastId}`); if (Chat.chatId === id) Chat.append(n.messages); } catch { /* try again next tick */ }
    }, 4000);
  },
  append(msgs) {
    const box = C.$('.cw-msgs', Chat.panel());
    if (!box) return;
    const fresh = msgs.filter((m) => m.id > Chat.lastId);
    if (!fresh.length) { if (!box.children.length) box.innerHTML = '<p class="empty small">ابدأ المحادثة</p>'; return; }
    C.$('.empty', box)?.remove();
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.insertAdjacentHTML('beforeend', fresh.map((m) => `<div class="cw-m${m.user_id === me().id ? ' me' : ''}">${m.user_id === me().id ? '' : `<b>${C.esc(m.name || '')}</b>`}<p>${lines(m.body)}</p><small>${C.fmtT(m.ts)}</small></div>`).join(''));
    Chat.lastId = fresh[fresh.length - 1].id;
    if (nearEnd || fresh.some((m) => m.user_id === me().id) || fresh.length === msgs.length) box.scrollTop = box.scrollHeight;
  },
};
