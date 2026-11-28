// HR file pages (2026-11-28): employee files and documents, overtime, end of service and social insurance,
// custody, the discipline ladder, the team calendar and the weekly roster. app.js hands over its helpers
// once through mountHr(); the owner sees everything here, supervisors see the calendar and the roster.

let C = null;
const me = () => C.me();
const isAdmin = () => me()?.role === 'admin';
const isSup = () => isAdmin() || !!me()?.manager;

const HR_ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 13h8"/>',
  otime: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6M19 4l1.5 1.5"/>',
  medal: '<path d="M8 3h8l-2 6h-4z"/><circle cx="12" cy="15" r="6"/><path d="M12 12v6M9.5 15h5"/>',
  keyset: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>',
  scale: '<path d="M12 4v16M6 20h12M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z"/>',
  roster: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11M3 14.5h18"/>',
};

export function hrNav(items) {
  if (!me()) return items;
  const add = [];
  if (isAdmin()) add.push(['documents', 'ملفات الموظفين', 'folder'], ['overtime', 'العمل الإضافي', 'otime'], ['eos', 'نهاية الخدمة والتأمينات', 'medal'], ['custody', 'العُهد', 'keyset'], ['discipline', 'لائحة الجزاءات', 'scale']);
  if (isSup()) add.push(['calendar', 'التقويم', 'cal'], ['roster', 'جدول الأسبوع', 'roster']);
  const keys = new Set(items.map(([k]) => k));
  return [...items, ...add.filter(([k]) => !keys.has(k))];
}

export function mountHr(ctx) {
  C = ctx;
  Object.assign(C.ICONS, HR_ICONS);
  Object.assign(C.PAGES, { documents, overtime, eos, custody, discipline, calendar, roster });
  const dash = C.PAGES.dashboard;
  if (dash) C.PAGES.dashboard = async () => { await dash(); await dashboardPanels(); };
}

// ------------------------------------------------------------------ small helpers
const SAR = (n) => `${C.money(n)} ر.س`;
const dmy = (d) => (d ? d.split('-').reverse().join('/') : '');
const neg = (n) => (n ? `−${C.money(n)}` : '0');
const initials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join(' ');
const dayPill = (days) => (days === null || days === undefined ? C.pill('بدون تاريخ', '')
  : days < 0 ? C.pill(`انتهت قبل ${-days} يوم`, 'bad') : days === 0 ? C.pill('تنتهي اليوم', 'bad')
    : days <= 30 ? C.pill(`باقي ${days} يوم`, 'warn') : C.pill(`باقي ${days} يوم`, 'good'));
const peopleOpts = (people, sel = '') => `${C.opt('', 'اختر الموظف', sel)}${people.map((p) => C.opt(p.id, p.name, sel)).join('')}`;
const confirmDel = (q) => window.confirm(q);
const ask = (q) => { const v = window.prompt(q); return v && v.trim().length >= 3 ? v.trim() : null; };

/** A file from an <input type=file> as a data URL; photos are scaled down so they travel light. */
async function readFile(input) {
  const f = input.files?.[0];
  if (!f) return null;
  if (f.type === 'application/pdf') {
    if (f.size > 3.5 * 1024 * 1024) throw new Error('ملف PDF أكبر من 3.5 ميجا');
    return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('تعذّرت قراءة الملف')); r.readAsDataURL(f); });
  }
  if (!f.type.startsWith('image/')) throw new Error('الملف لازم يكون صورة أو PDF');
  const img = await createImageBitmap(f);
  const k = Math.min(1, 2000 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k);
  cv.height = Math.round(img.height * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.85);
}

// ------------------------------------------------------------------ employee files and documents
async function documents() {
  const d = await C.api('/api/hr/files');
  const st = sessionStorage.getItem('hr-doc-q') || '';
  const alerts = d.employees.flatMap((e) => e.documents.filter((x) => x.days !== null && x.days <= 30).map((x) => ({ ...x, name: e.name })))
    .concat(d.employees.filter((e) => e.contract_end).map((e) => ({ name: e.name, kind: 'contract_end', days: Math.round((Date.parse(e.contract_end) - Date.parse(d.today)) / 86_400_000) })).filter((x) => x.days <= 30));
  const card = (e) => {
    const missing = ['hire_date', 'national_id', 'iban', 'job_title'].filter((k) => !e[k]).length;
    return `<section class="panel hr-emp" data-name="${C.esc(e.name)}">
      <header><div class="hr-row" style="border:0;padding:0"><span class="av">${C.esc(initials(e.name))}</span><div class="who"><b>${C.esc(e.name)}</b><span>${C.esc(e.job_title || 'بدون مسمّى')}${e.active ? '' : ' · موقوف'}</span></div></div>
        <div class="acts"><button class="btn sm ghost" data-file="${e.id}">تعديل الملف</button><button class="btn sm" data-doc="${e.id}">+ وثيقة</button></div></header>
      <div class="money-split">
        <div><span>الراتب</span><b>${C.money(e.salary)}</b></div>
        <div><span>الأساسي</span><b>${C.money(e.parts.basic)}</b></div>
        <div><span>السكن</span><b>${C.money(e.parts.housing)}</b></div>
        <div><span>النقل</span><b>${C.money(e.parts.transport)}</b></div>
      </div>
      <p class="small muted" style="margin-top:8px">${e.hire_date ? `تاريخ التعيين ${dmy(e.hire_date)}` : 'تاريخ التعيين غير مسجّل'}${e.nationality ? ` · ${C.esc(e.nationality)}` : ''}${e.custody ? ` · ${e.custody} عهدة` : ''}${missing ? ` · <span style="color:var(--warn)">ناقص ${missing} من البيانات الأساسية</span>` : ''}</p>
      ${e.documents.length ? e.documents.map((x) => `<div class="hr-row"><span class="doc-ic">${C.icon('file')}</span><div class="who"><b>${C.esc(d.kinds[x.kind] || x.kind)}</b><span>${x.number ? `<bdi>${C.esc(x.number)}</bdi> · ` : ''}${x.expires_on ? `تنتهي ${dmy(x.expires_on)}` : 'بدون تاريخ انتهاء'}</span>
        <span class="hr-acts">${x.has_file ? `<a class="link" href="/hr/documents/${x.id}/file" target="_blank" rel="noopener">عرض الملف</a>` : ''}<button class="link" data-edoc="${x.id}" data-u="${e.id}">تعديل</button><button class="link bad" data-ddoc="${x.id}">حذف</button></span></div>
        ${dayPill(x.days)}</div>`).join('')
        : '<p class="empty" style="padding:12px">ما فيه وثائق مسجّلة</p>'}
    </section>`;
  };
  const pg = C.render(`
    <div class="topline"><h1>ملفات الموظفين</h1><div class="tools"><input type="search" id="hr-q" placeholder="ابحث بالاسم" value="${C.esc(st)}"></div></div>
    ${alerts.length ? `<div class="note-box warn"><b>تنبيه:</b> ${alerts.map((a) => `${C.esc(a.name)} (${a.kind === 'contract_end' ? 'نهاية العقد' : C.esc(d.kinds[a.kind] || a.kind)}، ${a.days < 0 ? 'منتهية' : `باقي ${a.days} يوم`})`).join(' · ')}</div>` : ''}
    <div class="hr-grid" id="hr-list">${d.employees.map(card).join('')}</div>`);
  const filter = () => { const q = C.$('#hr-q', pg).value.trim(); sessionStorage.setItem('hr-doc-q', q); C.$$('.hr-emp', pg).forEach((s) => { s.hidden = q && !s.dataset.name.includes(q); }); };
  C.$('#hr-q', pg).oninput = filter;
  filter();
  const byId = (id) => d.employees.find((e) => e.id === Number(id));
  C.$$('[data-file]', pg).forEach((b) => { b.onclick = () => fileModal(byId(b.dataset.file)); });
  C.$$('[data-doc]', pg).forEach((b) => { b.onclick = () => docModal(d, byId(b.dataset.doc)); });
  C.$$('[data-edoc]', pg).forEach((b) => { b.onclick = () => docModal(d, byId(b.dataset.u), byId(b.dataset.u).documents.find((x) => x.id === Number(b.dataset.edoc))); });
  C.$$('[data-ddoc]', pg).forEach((b) => { b.onclick = async () => { if (confirmDel('حذف الوثيقة وملفها؟') && await C.act(b, () => C.api(`/api/hr/documents/${b.dataset.ddoc}`, { method: 'DELETE' }), 'حُذفت الوثيقة')) C.refresh(); }; });
}

function fileModal(e) {
  const v = (k) => C.esc(e[k] ?? '');
  const d = C.modal(`ملف ${e.name}`, `<form class="form" id="hrF">
    <div class="row"><label class="f">المسمّى الوظيفي<input name="job_title" value="${v('job_title')}" maxlength="80"></label>
      <label class="f">تاريخ التعيين<input type="date" name="hire_date" value="${v('hire_date')}"></label></div>
    <div class="row"><label class="f">رقم الهوية أو الإقامة<input name="national_id" value="${v('national_id')}" inputmode="numeric" maxlength="20" dir="ltr"></label>
      <label class="f">الجنسية<input name="nationality" value="${v('nationality')}" maxlength="40"></label></div>
    <div class="row"><label class="f">تاريخ الميلاد<input type="date" name="birth_date" value="${v('birth_date')}"></label>
      <label class="f">نوع العقد<select name="contract_type">${C.opt('', 'غير محدد', e.contract_type)}${C.opt('fixed', 'محدد المدة', e.contract_type)}${C.opt('open', 'غير محدد المدة', e.contract_type)}</select></label>
      <label class="f">نهاية العقد<input type="date" name="contract_end" value="${v('contract_end')}"></label></div>
    <label class="f">الآيبان<input name="iban" value="${v('iban')}" placeholder="SA0000000000000000000000" dir="ltr" maxlength="34"></label>
    <label class="f">جهة اتصال للطوارئ<input name="emergency" value="${v('emergency')}" maxlength="80" placeholder="الاسم والجوال"></label>
    <h3>تقسيم الراتب (${C.money(e.salary)})</h3>
    <div class="row"><label class="f">الأساسي<input type="number" name="basic" step="0.01" min="0" value="${e.basic ?? ''}" placeholder="الباقي تلقائياً"></label>
      <label class="f">السكن<input type="number" name="housing" step="0.01" min="0" value="${e.housing || 0}"></label>
      <label class="f">النقل<input type="number" name="transport" step="0.01" min="0" value="${e.transport || 0}"></label></div>
    <label class="check"><input type="checkbox" name="saudi" ${e.saudi ? 'checked' : ''}>سعودي الجنسية</label>
    <label class="check"><input type="checkbox" name="gosi" ${e.gosi ? 'checked' : ''}>مسجّل في التأمينات الاجتماعية</label>
    <button class="btn" type="submit">حفظ الملف</button></form>`);
  const f = C.$('#hrF', d);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (await C.act(C.$('button[type=submit]', f), () => C.api(`/api/hr/files/${e.id}`, { method: 'PUT', body: C.formData(f) }), 'حُفظ الملف')) { d.close(); C.refresh(); }
  };
}

function docModal(data, e, doc = null) {
  const d = C.modal(doc ? 'تعديل الوثيقة' : `وثيقة جديدة · ${e.name}`, `<form class="form" id="hrD">
    ${doc ? '' : `<label class="f">النوع<select name="kind">${Object.entries(data.kinds).map(([k, l]) => C.opt(k, l)).join('')}</select></label>`}
    <div class="row"><label class="f">الرقم<input name="number" value="${C.esc(doc?.number || '')}" maxlength="40" dir="ltr"></label>
      <label class="f">تاريخ الانتهاء<input type="date" name="expires_on" value="${C.esc(doc?.expires_on || '')}"></label></div>
    ${doc ? '' : '<label class="f">صورة أو PDF (اختياري)<input type="file" name="file" accept="image/*,application/pdf"></label>'}
    <label class="f">ملاحظة<input name="note" value="${C.esc(doc?.note || '')}" maxlength="200"></label>
    <p class="muted small">ننبّهك قبل الانتهاء بـ 30 يوم ثم 7 أيام ثم يوم الانتهاء.</p>
    <button class="btn" type="submit">حفظ</button></form>`);
  const f = C.$('#hrD', d);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = C.$('button[type=submit]', f);
    const ok = await C.act(btn, async () => {
      const body = { number: f.number.value, expires_on: f.expires_on.value, note: f.note.value };
      if (doc) return C.api(`/api/hr/documents/${doc.id}`, { method: 'PUT', body });
      return C.api('/api/hr/documents', { method: 'POST', body: { ...body, user_id: e.id, kind: f.kind.value, file: await readFile(f.file) } });
    }, 'حُفظت الوثيقة');
    if (ok) { d.close(); C.refresh(); }
  };
}

// ------------------------------------------------------------------ overtime
async function overtime() {
  const month = sessionStorage.getItem('hr-ot-m') || '';
  const d = await C.api(`/api/hr/overtime${month ? `?month=${month}` : ''}`);
  const people = d.rows.map((r) => ({ id: r.userId, name: r.name }));
  const pg = C.render(`
    <div class="topline"><h1>العمل الإضافي</h1><div class="tools"><input type="month" id="ot-m" value="${d.month}"></div></div>
    <p class="muted small">الفترة من ${dmy(d.period.from)} إلى ${dmy(d.period.to)}. أجر الساعة الإضافية حسب نظام العمل: أجر الساعة + 50% من أجر الساعة الأساسي.</p>
    <div class="grid2">
      <section class="panel"><header><h2>اعتماد ساعات إضافية</h2></header>
        <form class="form" id="otF">
          <div class="row"><label class="f">الموظف<select name="user_id" required>${peopleOpts(people)}</select></label>
            <label class="f">اليوم<input type="date" name="date" value="${C.today()}" required></label></div>
          <div class="row"><label class="f">المدة بالدقائق<input type="number" name="minutes" min="1" step="1" required></label>
            <label class="f">المبلغ (فاضي = يُحسب تلقائياً)<input type="number" name="amount" min="0" step="0.01"></label></div>
          <p class="muted small" id="ot-hint"></p>
          <label class="f">ملاحظة<input name="note" maxlength="200" placeholder="مثال: جرد نهاية الموسم"></label>
          <button class="btn" type="submit">اعتماد وإضافته للراتب</button>
        </form></section>
      <section class="panel"><header><h2>الشهر</h2></header>
        ${C.table(['الموظف', 'إضافي من البصمة', 'المعتمد', 'المبلغ', 'أجر الساعة'], d.rows.map((r) => `<tr><td>${C.esc(r.name)}</td><td>${C.mn(r.overtimeMinutes)}</td><td>${C.mn(r.approvedMinutes)}</td><td>${r.approvedPay ? SAR(r.approvedPay) : '—'}</td><td>${C.money(r.rate)}</td></tr>`))}
      </section>
    </div>
    <section class="panel"><header><h2>المعتمد هذا الشهر</h2></header>
      ${C.table(['اليوم', 'الموظف', 'المدة', 'المبلغ', 'ملاحظة', ''], d.records.map((o) => `<tr><td>${C.fmtDate(o.date)}</td><td>${C.esc(o.name)}</td><td>${C.mn(o.minutes)}</td><td>${SAR(o.amount)}</td><td>${C.esc(o.note)}</td><td><button class="link bad" data-del="${o.id}">حذف</button></td></tr>`), { empty: 'ما فيه ساعات إضافية معتمدة' })}
    </section>`);
  C.$('#ot-m', pg).onchange = (e) => { sessionStorage.setItem('hr-ot-m', e.target.value); C.refresh(); };
  const f = C.$('#otF', pg);
  const hint = () => { const r = d.rows.find((x) => x.userId === Number(f.user_id.value)); const m = Number(f.minutes.value); C.$('#ot-hint', f).textContent = r && m ? `المبلغ التلقائي ${SAR(Math.round(r.rate * m / 60 * 100) / 100)}` : ''; };
  f.user_id.onchange = hint; f.minutes.oninput = hint;
  f.onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button[type=submit]', f), () => C.api('/api/hr/overtime', { method: 'POST', body: C.formData(f) }), 'اعتُمد وأُضيف للراتب')) C.refresh(); };
  C.$$('[data-del]', pg).forEach((b) => { b.onclick = async () => { const reason = ask('سبب الحذف'); if (reason && await C.act(b, () => C.api(`/api/hr/overtime/${b.dataset.del}`, { method: 'DELETE', body: { reason } }), 'حُذف')) C.refresh(); }; });
}

// ------------------------------------------------------------------ end of service and social insurance
async function eos() {
  const [g, files] = await Promise.all([C.api('/api/hr/gosi'), C.api('/api/hr/files')]);
  const people = files.employees.filter((e) => e.active);
  const t = g.rows.reduce((a, r) => ({ e: a.e + r.employee, r: a.r + r.employer }), { e: 0, r: 0 });
  const pg = C.render(`
    <div class="topline"><h1>نهاية الخدمة والتأمينات</h1></div>
    <div class="grid2">
      <section class="panel"><header><h2>حاسبة نهاية الخدمة</h2><span class="muted small">المواد 84 و85 و87 من نظام العمل</span></header>
        <form class="form" id="eosF">
          <label class="f">الموظف<select name="user_id" required>${peopleOpts(people)}</select></label>
          <div class="row"><label class="f">آخر يوم عمل<input type="date" name="end" value="${C.today()}" required></label>
            <label class="f">السبب<select name="reason">${C.opt('end', 'انتهاء العقد أو إنهاء من المنشأة')}${C.opt('resign', 'استقالة')}${C.opt('art80', 'فصل وفق المادة 80')}</select></label></div>
          <button class="btn" type="submit">احسب</button>
        </form>
        <div id="eosR"></div></section>
      <section class="panel"><header><h2>التأمينات الاجتماعية</h2><button class="btn sm ghost" id="gosiSet">النسب</button></header>
        <p class="muted small">على الأساسي + السكن، بحد أعلى ${C.money(g.settings.cap)}. ${g.settings.deduct ? 'حصة الموظف تُخصم من الراتب.' : 'للاطلاع فقط، ما تُخصم من الراتب.'}</p>
        ${C.table(['الموظف', 'الأجر الخاضع', 'حصة الموظف', 'حصة المنشأة'], g.rows.map((r) => `<tr><td>${C.esc(r.name)} ${r.registered ? '' : C.pill('غير مسجّل', 'warn')}</td><td>${C.money(r.base)}</td><td>${C.money(r.employee)}</td><td>${C.money(r.employer)}</td></tr>`),
          { foot: ['المجموع', '', C.money(t.e), C.money(t.r)] })}
      </section>
    </div>`);
  const f = C.$('#eosF', pg);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await C.act(C.$('button[type=submit]', f), () => C.api(`/api/hr/eos?${new URLSearchParams(C.formData(f))}`));
    if (!r) return;
    const s = r.settlement;
    C.$('#eosR', pg).innerHTML = `<div class="note-box" style="margin-top:12px">${C.esc(r.award.rule)}. مدة الخدمة ${r.award.years} سنة (${C.int(r.award.days)} يوم) من ${dmy(r.start)}.</div>
      <div class="money-split" style="margin-top:10px">
        <div><span>المكافأة</span><b>${C.money(r.award.amount)}</b></div>
        <div><span>راتب الأيام الأخيرة (${s.workedDays} يوم)</span><b>${C.money(s.lastPay)}</b></div>
        <div><span>خصومات الفترة</span><b>${neg(s.deductions)}</b></div>
        <div><span>سلف متبقية</span><b>${neg(s.loans)}</b></div>
        <div class="tot"><span>صافي المخالصة (ر.س)</span><b>${C.money(s.total)}</b></div>
      </div>
      ${s.custody.length ? `<div class="note-box warn" style="margin-top:10px">عهد لم تُسلَّم: ${s.custody.map((c) => C.esc(c.item)).join('، ')}</div>` : ''}
      <p class="muted small" style="margin-top:8px">الحساب تقديري للمساعدة، وما يشمل رصيد الإجازات لأن الإجازة عندكم يدوية.</p>`;
  };
  C.$('#gosiSet', pg).onclick = () => {
    const s = g.settings;
    const d = C.modal('نسب التأمينات', `<form class="form" id="gF">
      <div class="row"><label class="f">السعودي (الموظف) %<input type="number" step="0.01" name="saudi_employee" value="${s.saudi_employee}"></label>
        <label class="f">السعودي (المنشأة) %<input type="number" step="0.01" name="saudi_employer" value="${s.saudi_employer}"></label></div>
      <div class="row"><label class="f">غير السعودي (المنشأة) %<input type="number" step="0.01" name="non_saudi_employer" value="${s.non_saudi_employer}"></label>
        <label class="f">الحد الأعلى للأجر<input type="number" name="cap" value="${s.cap}"></label></div>
      <p class="muted small">النسب تتغيّر بالأنظمة، راجعها مع موقع التأمينات.</p>
      <button class="btn" type="submit">حفظ</button></form>`);
    const gf = C.$('#gF', d);
    gf.onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button', gf), () => C.api('/api/hr/settings', { method: 'PUT', body: { gosi: { ...C.formData(gf), deduct: s.deduct } } }), 'حُفظت النسب')) { d.close(); C.refresh(); } };
  };
}

// ------------------------------------------------------------------ custody
async function custody() {
  const [d, files] = await Promise.all([C.api('/api/hr/custody'), C.api('/api/hr/files')]);
  const open = d.items.filter((c) => !c.returned_on);
  const pg = C.render(`
    <div class="topline"><h1>العُهد</h1></div>
    <div class="grid2">
      <section class="panel"><header><h2>تسليم عهدة</h2></header>
        <form class="form" id="cuF">
          <label class="f">الموظف<select name="user_id" required>${peopleOpts(files.employees.filter((e) => e.active))}</select></label>
          <div class="row"><label class="f">العهدة<input name="item" required maxlength="80" placeholder="مثال: جهاز نقاط البيع، مفتاح المعرض"></label>
            <label class="f">الرقم التسلسلي<input name="serial" maxlength="60" dir="ltr"></label></div>
          <div class="row"><label class="f">القيمة<input type="number" name="value" min="0" step="0.01"></label>
            <label class="f">تاريخ التسليم<input type="date" name="given_on" value="${C.today()}"></label></div>
          <label class="f">ملاحظة<input name="note" maxlength="200"></label>
          <button class="btn" type="submit">تسجيل</button>
        </form></section>
      <section class="panel"><header><h2>مع الموظفين الآن</h2>${C.pill(`${open.length}`, open.length ? 'info' : '')}</header>
        ${open.length ? open.map((c) => `<div class="hr-row"><span class="av">${C.esc(initials(c.name))}</span><div class="who"><b>${C.esc(c.item)}</b><span>${C.esc(c.name)} · من ${dmy(c.given_on)}${c.serial ? ` · <bdi>${C.esc(c.serial)}</bdi>` : ''}${c.value ? ` · ${SAR(c.value)}` : ''}</span></div>
          <button class="btn sm ghost" data-ret="${c.id}">استلام</button></div>`).join('') : '<p class="empty">كل العهد مُستلمة</p>'}
      </section>
    </div>
    <section class="panel"><header><h2>السجل</h2></header>
      ${C.table(['العهدة', 'الموظف', 'التسليم', 'الاستلام', ''], d.items.filter((c) => c.returned_on).map((c) => `<tr><td>${C.esc(c.item)}</td><td>${C.esc(c.name)}</td><td>${dmy(c.given_on)}</td><td>${dmy(c.returned_on)}</td><td><button class="link" data-undo="${c.id}">تراجع</button> <button class="link bad" data-del="${c.id}">حذف</button></td></tr>`), { empty: 'ما فيه عهد مُستلمة بعد' })}
    </section>`);
  const f = C.$('#cuF', pg);
  f.onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button[type=submit]', f), () => C.api('/api/hr/custody', { method: 'POST', body: C.formData(f) }), 'سُجّلت العهدة')) C.refresh(); };
  C.$$('[data-ret]', pg).forEach((b) => { b.onclick = async () => { if (await C.act(b, () => C.api(`/api/hr/custody/${b.dataset.ret}/return`, { method: 'POST', body: {} }), 'استُلمت')) C.refresh(); }; });
  C.$$('[data-undo]', pg).forEach((b) => { b.onclick = async () => { if (await C.act(b, () => C.api(`/api/hr/custody/${b.dataset.undo}/return`, { method: 'POST', body: { undo: true } }), 'رجعت مع الموظف')) C.refresh(); }; });
  C.$$('[data-del]', pg).forEach((b) => { b.onclick = async () => { if (confirmDel('حذف العهدة من السجل؟') && await C.act(b, () => C.api(`/api/hr/custody/${b.dataset.del}`, { method: 'DELETE' }), 'حُذفت')) C.refresh(); }; });
}

// ------------------------------------------------------------------ discipline ladder
async function discipline() {
  const [d, files] = await Promise.all([C.api('/api/hr/discipline'), C.api('/api/hr/files')]);
  const s = d.settings;
  const stepText = (p, i) => (p ? `خصم ${p}% من أجر يوم` : i === 0 ? 'إنذار كتابي' : 'إنذار');
  const pg = C.render(`
    <div class="topline"><h1>لائحة الجزاءات</h1></div>
    <div class="note-box">التأخير والخروج المبكر والغياب تُخصم تلقائياً من البصمة، فما هي في اللائحة: مخالفة واحدة، جزاء واحد. تكرار المخالفة خلال ${s.window_days} يوم ينقلها للدرجة التالية.</div>
    <div class="grid2">
      <section class="panel"><header><h2>تسجيل مخالفة</h2></header>
        <form class="form" id="dsF">
          <div class="row"><label class="f">الموظف<select name="user_id" required>${peopleOpts(files.employees.filter((e) => e.active))}</select></label>
            <label class="f">اليوم<input type="date" name="date" value="${C.today()}" required></label></div>
          <label class="f">المخالفة<select name="violation" required>${C.opt('', 'اختر من اللائحة')}${s.violations.map((v) => C.opt(v.name, v.name)).join('')}</select></label>
          <div class="note-box warn" id="ds-prev" hidden></div>
          <label class="f">التفاصيل<input name="note" maxlength="300" placeholder="ماذا حدث"></label>
          <button class="btn" type="submit">تسجيل الجزاء</button>
        </form></section>
      <section class="panel"><header><h2>اللائحة</h2><button class="btn sm ghost" id="dsEdit">تعديل</button></header>
        ${(() => { const n = Math.max(...s.violations.map((v) => v.steps.length)); return C.table(['المخالفة', ...Array.from({ length: n }, (_, i) => `المرة ${i + 1}`)], s.violations.map((v) => `<tr><td>${C.esc(v.name)}</td>${Array.from({ length: n }, (_, i) => `<td>${i < v.steps.length ? (v.steps[i] ? `${v.steps[i]}%` : C.pill('إنذار', 'info')) : ''}</td>`).join('')}</tr>`), { cls: 'ladder-t' }); })()}
        <p class="muted small" style="margin-top:8px">النسبة من أجر يوم واحد (الراتب ÷ 30). المرة الأولى إنذار كتابي.</p>
      </section>
    </div>
    <section class="panel"><header><h2>السجل</h2></header>
      ${C.table(['اليوم', 'الموظف', 'المخالفة', 'الدرجة', 'الجزاء', ''], d.records.map((r) => `<tr><td>${C.fmtDate(r.date)}</td><td>${C.esc(r.name)}</td><td>${C.esc(r.violation)}${r.note ? `<div class="muted small">${C.esc(r.note)}</div>` : ''}</td><td>${r.step}</td><td>${C.esc(r.action)}${r.amount ? ` (${SAR(r.amount)})` : ''}</td><td><button class="link bad" data-del="${r.id}">إلغاء</button></td></tr>`), { empty: 'ما فيه مخالفات مسجّلة' })}
    </section>`);
  const f = C.$('#dsF', pg);
  const preview = async () => {
    const box = C.$('#ds-prev', f);
    if (!f.user_id.value || !f.violation.value) { box.hidden = true; return; }
    const r = await C.api('/api/hr/discipline', { method: 'POST', body: { ...C.formData(f), preview: true } }).catch(() => null);
    if (!r) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = `هذه المرة ${r.step}: ${r.action}${r.amount ? ` = ${SAR(r.amount)} تُضاف لخصومات الشهر` : ''}`;
  };
  f.user_id.onchange = preview; f.violation.onchange = preview; f.date.onchange = preview;
  f.onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button[type=submit]', f), () => C.api('/api/hr/discipline', { method: 'POST', body: C.formData(f) }), 'سُجّل الجزاء')) C.refresh(); };
  C.$$('[data-del]', pg).forEach((b) => { b.onclick = async () => { const reason = ask('سبب إلغاء الجزاء'); if (reason && await C.act(b, () => C.api(`/api/hr/discipline/${b.dataset.del}`, { method: 'DELETE', body: { reason } }), 'أُلغي الجزاء وخصمه')) C.refresh(); }; });
  C.$('#dsEdit', pg).onclick = () => {
    const d2 = C.modal('تعديل اللائحة', `<form class="form" id="lF">
      <p class="muted small">سطر لكل مخالفة: الاسم ثم نسب الخصم لكل مرة مفصولة بفواصل (0 = إنذار). مثال:<br><bdi>التأخر في فتح المعرض: 0, 10, 25, 50</bdi></p>
      <textarea name="lines" rows="8">${C.esc(s.violations.map((v) => `${v.name}: ${v.steps.join(', ')}`).join('\n'))}</textarea>
      <label class="f">مدة احتساب التكرار (يوم)<input type="number" name="window_days" min="30" max="365" value="${s.window_days}"></label>
      <button class="btn" type="submit">حفظ</button></form>`);
    const lf = C.$('#lF', d2);
    lf.onsubmit = async (e) => {
      e.preventDefault();
      const violations = lf.lines.value.split('\n').map((l) => l.split(':')).filter((p) => p.length >= 2 && p[0].trim())
        .map(([name, ...rest]) => ({ name: name.trim(), steps: rest.join(':').split(/[,،]/).map((x) => Number(x.trim()) || 0) }));
      if (await C.act(C.$('button', lf), () => C.api('/api/hr/settings', { method: 'PUT', body: { violations, window_days: lf.window_days.value } }), 'حُفظت اللائحة')) { d2.close(); C.refresh(); }
    };
  };
}

// ------------------------------------------------------------------ calendar
const KIND_NAME = { pay: 'الرواتب', hol: 'عطلة', lv: 'إجازة', doc: 'وثيقة', ev: 'مناسبة' };
async function calendar() {
  const m = sessionStorage.getItem('hr-cal') || '';
  const d = await C.api(`/api/hr/calendar${m ? `?month=${m}` : ''}`);
  const first = new Date(`${d.from}T12:00:00Z`);
  const lead = (first.getUTCDay() + 1) % 7; // weeks start on Saturday
  const days = Number(d.to.slice(8));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="d o"></div>');
  for (let n = 1; n <= days; n++) {
    const date = `${d.month}-${String(n).padStart(2, '0')}`;
    const its = d.items.filter((x) => x.date === date);
    cells.push(`<div class="d ${date === d.today ? 't' : ''}"><b>${n}</b>${its.map((x) => `<i class="${x.kind}" title="${C.esc(x.title)}">${C.esc(x.title)}</i>`).join('')}</div>`);
  }
  const title = first.toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (k) => { const [y, mo] = d.month.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + k, 1)); return t.toISOString().slice(0, 7); };
  const pg = C.render(`
    <div class="topline"><h1>التقويم</h1><div class="tools"><button class="btn sm ghost" data-go="-1">السابق</button><b>${C.esc(title)}</b><button class="btn sm ghost" data-go="1">التالي</button>${isAdmin() ? '<button class="btn sm" id="evAdd">+ مناسبة</button>' : ''}</div></div>
    <section class="panel"><div class="cal">${['سبت', 'أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة'].map((x) => `<div class="h">${x}</div>`).join('')}${cells.join('')}</div></section>
    <section class="panel"><header><h2>هذا الشهر</h2></header>
      ${d.items.length ? `<div class="cal-list">${d.items.map((x) => `<div><b>${C.esc(x.date.slice(8))}</b><i class="dot ${x.kind}" title="${KIND_NAME[x.kind] || ''}"></i><span>${C.esc(x.title)}</span>${x.kind === 'ev' && x.id && isAdmin() ? `<button class="link bad" data-del="${x.id}">حذف</button>` : ''}</div>`).join('')}</div>` : '<p class="empty">ما فيه شي هذا الشهر</p>'}
    </section>`);
  C.$$('[data-go]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('hr-cal', shift(Number(b.dataset.go))); C.refresh(); }; });
  C.$$('[data-del]', pg).forEach((b) => { b.onclick = async () => { if (await C.act(b, () => C.api(`/api/hr/events/${b.dataset.del}`, { method: 'DELETE' }), 'حُذفت')) C.refresh(); }; });
  const add = C.$('#evAdd', pg);
  if (add) add.onclick = () => {
    const dl = C.modal('مناسبة جديدة', `<form class="form" id="evF"><label class="f">اليوم<input type="date" name="date" value="${C.today()}" required></label>
      <label class="f">العنوان<input name="title" required maxlength="80" placeholder="مثال: اجتماع الفريق، جرد"></label><button class="btn" type="submit">إضافة</button></form>`);
    const ef = C.$('#evF', dl);
    ef.onsubmit = async (e) => { e.preventDefault(); if (await C.act(C.$('button', ef), () => C.api('/api/hr/events', { method: 'POST', body: C.formData(ef) }), 'أُضيفت')) { dl.close(); C.refresh(); } };
  };
}

// ------------------------------------------------------------------ weekly roster (built on the shift exceptions)
async function roster() {
  const start = sessionStorage.getItem('hr-ros') || saturdayOf(C.today());
  const d = await C.api(`/api/shift-exceptions?from=${start}`);
  const dates = Array.from({ length: 7 }, (_, i) => addDay(start, i));
  const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const regular = (date) => d.schedule.days[dow(date)] || [];
  const exc = (date, uid) => d.exceptions.find((e) => e.date === date && e.user_id === uid) || d.exceptions.find((e) => e.date === date && !e.user_id);
  const short = (p) => (p.name || `${p.start}–${p.end}`).replace(/^الفترة\s+/, '').replace(/^دوام\s+/, '');
  const label = (ps) => (ps.length ? ps.map(short).join(' + ') : 'إجازة');
  const people = d.people.filter((p) => isAdmin() || p.id !== me().id);
  const cell = (p, date) => {
    const e = exc(date, p.id);
    const reg = regular(date);
    const cur = e ? (e.periods.length ? 'custom' : 'off') : 'reg';
    const own = e && e.user_id === p.id;
    const options = [C.opt('reg', reg.length ? 'المعتاد' : 'المعتاد (إجازة)', cur), C.opt('off', 'إجازة', cur), ...(reg.length > 1 ? reg.map((x) => C.opt(`only:${x.id}`, `${short(x)} فقط`, '')) : [])];
    if (cur === 'custom') options.push(C.opt('custom', label(e.periods), 'custom'));
    return `<td class="${cur === 'off' ? 'off' : ''}"><select data-u="${p.id}" data-d="${date}" data-e="${own ? e.id : ''}" ${date < C.today() ? 'disabled' : ''}>${options.join('')}</select></td>`;
  };
  const pg = C.render(`
    <div class="topline"><h1>جدول الأسبوع</h1><div class="tools"><button class="btn sm ghost" data-go="-7">السابق</button><b>${C.fmtDate(dates[0])} ← ${C.fmtDate(dates[6])}</b><button class="btn sm ghost" data-go="7">التالي</button></div></div>
    <p class="muted small">غيّر دوام أي يوم من القائمة، ويوصل الموظف إشعار بالتغيير. «المعتاد» يعني جدول الدوام (${C.esc(label(regular(dates[0])))}).</p>
    <section class="panel roster"><div class="tbl"><table><thead><tr><th>الموظف</th>${dates.map((x) => `<th>${C.fmtDate(x)}</th>`).join('')}</tr></thead>
      <tbody>${people.map((p) => `<tr><td>${C.esc(p.name)}</td>${dates.map((x) => cell(p, x)).join('')}</tr>`).join('')}</tbody></table></div></section>`);
  C.$$('[data-go]', pg).forEach((b) => { b.onclick = () => { sessionStorage.setItem('hr-ros', addDay(start, Number(b.dataset.go))); C.refresh(); }; });
  C.$$('select[data-u]', pg).forEach((s) => {
    s.onchange = async () => {
      const v = s.value;
      const date = s.dataset.d;
      let ok;
      if (v === 'reg') {
        if (!s.dataset.e) { C.toast('هذا اليوم على استثناء للجميع، عدّله من «استثناءات الدوام»', true); C.refresh(); return; }
        ok = await C.act(null, () => C.api(`/api/shift-exceptions/${s.dataset.e}`, { method: 'DELETE', body: { reason: 'من جدول الأسبوع' } }), 'رجع للدوام المعتاد');
      } else {
        const periods = v.startsWith('only:') ? regular(date).filter((x) => x.id === v.slice(5)) : [];
        ok = await C.act(null, () => C.api('/api/shift-exceptions', { method: 'POST', body: { date, user_id: Number(s.dataset.u), off: v === 'off', periods, note: 'من جدول الأسبوع' } }), 'حُفظ ووصل الموظف');
      }
      if (ok !== undefined) C.refresh(); else C.refresh();
    };
  });
}
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const saturdayOf = (date) => addDay(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 1) % 7));

// ------------------------------------------------------------------ dashboard: what HR needs today
async function dashboardPanels() {
  if (!isSup() || C.$('#hr-dash')) return;
  const s = await C.api('/api/hr/summary').catch(() => null);
  const main = document.getElementById('page');
  if (!s || !main || C.$('#hr-dash')) return;
  if (!s.expiring.length && !s.onLeave.length && !s.events.length) return;
  const box = document.createElement('div');
  box.className = 'hr-grid';
  box.id = 'hr-dash';
  const LV = { leave: 'إجازة', sick: 'مرضية', excused: 'عذر' };
  box.innerHTML = [
    s.expiring.length ? `<section class="panel"><header><h2>وثائق تنتهي قريباً</h2><a class="link" href="#/documents">الملفات</a></header>${s.expiring.map((x) => `<div class="hr-row"><span class="doc-ic">${C.icon('file')}</span><div class="who"><b>${C.esc(x.label)}</b><span>${C.esc(x.name)} · ${dmy(x.expires_on)}</span></div>${dayPill(x.days)}</div>`).join('')}</section>` : '',
    s.onLeave.length ? `<section class="panel"><header><h2>في إجازة اليوم</h2></header>${s.onLeave.map((x) => `<div class="hr-row"><span class="av">${C.esc(initials(x.name))}</span><div class="who"><b>${C.esc(x.name)}</b><span>${LV[x.kind] || x.kind}${x.unpaid ? ' بدون راتب' : ''}${x.until && x.until !== s.today ? ` حتى ${dmy(x.until)}` : ''}</span></div></div>`).join('')}</section>` : '',
    s.events.length ? `<section class="panel"><header><h2>مناسبات قادمة</h2><a class="link" href="#/calendar">التقويم</a></header>${s.events.map((x) => `<div class="hr-row"><span class="pill">${C.esc(x.date.slice(5).split('-').reverse().join('/'))}</span><div class="who"><b>${C.esc(x.title)}</b></div></div>`).join('')}</section>` : '',
  ].join('');
  const hero = C.$('.hero', main);
  if (hero) hero.after(box); else main.append(box);
}
