// HR file (2026-11-28): the employee's record and salary parts, documents with expiry alerts, overtime pay,
// custody items, the discipline ladder, the team calendar, social insurance (GOSI) and end-of-service.
// Everything here is the owner's (admin) unless a route says otherwise; nothing changes the attendance engine.
import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { tx, audit } from '../db.js';
import { HttpError, parseJson, readBody, send } from '../http.js';
import { localDate, addDays, isDate } from '../time.js';
import { getSettings } from '../settings.js';
import { payMonthOf, payPeriod } from '../payperiod.js';
import { assertOpen } from '../monthly.js';
import { debtBalances, payroll } from '../reports.js';
import { notifyManager, appLink } from '../notify.js';
import * as msg from '../messages.js';
import { logChange } from '../additions/changelog.js';
import { text, num, needDate, requireSup } from '../additions/util.js';

const requireAdmin = (user) => { if (user.role !== 'admin') throw new HttpError(403, 'هذه الصفحة للمدير'); };
const round2 = (n) => Math.round(n * 100) / 100;
const optDate = (v) => { if (!v) return null; if (!isDate(v)) throw new HttpError(400, 'التاريخ غير صحيح'); return v; };

export const DOC_KINDS = { iqama: 'الإقامة', national_id: 'الهوية الوطنية', passport: 'الجواز', health: 'الشهادة الصحية', contract: 'عقد العمل', license: 'رخصة', other: 'أخرى' };
const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const docsDir = () => join(dirname(config.dbPath), 'uploads', 'documents');

// ------------------------------------------------------------------ settings (one JSON row, key 'hr')
export const HR_DEFAULTS = {
  // Social insurance rates in percent. They change by law: the owner checks them against GOSI.
  gosi: { saudi_employee: 9.75, saudi_employer: 11.75, non_saudi_employer: 2, cap: 45000, deduct: false },
  // Discipline ladder: each violation's steps, repeated within `window_days` moves one step up.
  // pct = percent of a day's pay (salary ÷ 30); 0 = a warning only. Lateness, early leave, exits and
  // absence are already deducted automatically, so they are left out: one violation, one penalty.
  window_days: 180,
  violations: [
    { name: 'سوء التعامل مع العميلات أو الزملاء', steps: [0, 10, 25, 50] },
    { name: 'عدم الالتزام بالزي أو المظهر', steps: [0, 5, 10, 20] },
    { name: 'استخدام الجوال الشخصي أثناء خدمة العميلات', steps: [0, 5, 10, 25] },
    { name: 'الإهمال في المنتجات أو العرض', steps: [0, 10, 25, 50] },
    { name: 'مخالفة تعليمات العمل', steps: [0, 5, 15, 25] },
  ],
};
export function hrSettings(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'hr'").get();
  const v = row ? JSON.parse(row.value) : {};
  return { ...HR_DEFAULTS, ...v, gosi: { ...HR_DEFAULTS.gosi, ...(v.gosi || {}) } };
}
function saveHrSettings(db, user, b) {
  requireAdmin(user);
  const cur = hrSettings(db);
  const next = { ...cur };
  if (b.gosi) {
    next.gosi = {
      saudi_employee: num(b.gosi.saudi_employee ?? cur.gosi.saudi_employee, 0, 30),
      saudi_employer: num(b.gosi.saudi_employer ?? cur.gosi.saudi_employer, 0, 30),
      non_saudi_employer: num(b.gosi.non_saudi_employer ?? cur.gosi.non_saudi_employer, 0, 30),
      cap: num(b.gosi.cap ?? cur.gosi.cap, 0, 1e6),
      deduct: !!(b.gosi.deduct ?? cur.gosi.deduct),
    };
  }
  if (Array.isArray(b.violations)) {
    next.violations = b.violations.slice(0, 30).map((v) => ({
      name: text(v.name, 80),
      steps: (Array.isArray(v.steps) ? v.steps : []).slice(0, 6).map((p) => num(p || 0, 0, 100)),
    })).filter((v) => v.name && v.steps.length);
  }
  if ('window_days' in b) next.window_days = Math.round(num(b.window_days, 30, 365));
  db.prepare("INSERT INTO settings (key, value) VALUES ('hr', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  audit(db, user.id, 'hr.settings', null, next);
  return hrSettings(db);
}

// ------------------------------------------------------------------ employee file
const FILE_FIELDS = ['hire_date', 'birth_date', 'national_id', 'nationality', 'saudi', 'job_title', 'contract_type', 'contract_end', 'iban', 'emergency', 'basic', 'housing', 'transport', 'gosi'];
const fileView = (u) => ({
  id: u.id, name: u.name, active: !!u.active, salary: u.salary, phone: u.phone,
  hire_date: u.hire_date, birth_date: u.birth_date, national_id: u.national_id, nationality: u.nationality, saudi: !!u.saudi,
  job_title: u.job_title, contract_type: u.contract_type, contract_end: u.contract_end, iban: u.iban, emergency: u.emergency,
  basic: u.basic, housing: u.housing, transport: u.transport, gosi: !!u.gosi,
});
/** Salary parts: the basic defaults to what is left of the salary after housing and transport. */
export const salaryParts = (u) => {
  const housing = u.housing || 0;
  const transport = u.transport || 0;
  const basic = u.basic ?? Math.max(0, (u.salary || 0) - housing - transport);
  return { basic, housing, transport, other: round2(Math.max(0, (u.salary || 0) - basic - housing - transport)) };
};
function listFiles(db) {
  const today = localDate();
  const docs = db.prepare('SELECT id, user_id, kind, number, expires_on, note, file IS NOT NULL AS has_file FROM documents ORDER BY expires_on IS NULL, expires_on').all();
  const custody = db.prepare('SELECT user_id, COUNT(*) n FROM custody WHERE returned_on IS NULL GROUP BY user_id').all();
  const cMap = new Map(custody.map((c) => [c.user_id, c.n]));
  return {
    today,
    kinds: DOC_KINDS,
    employees: db.prepare("SELECT * FROM users WHERE role = 'employee' ORDER BY active DESC, id").all().map((u) => ({
      ...fileView(u), parts: salaryParts(u), custody: cMap.get(u.id) || 0,
      documents: docs.filter((d) => d.user_id === u.id).map((d) => ({ ...d, has_file: !!d.has_file, days: d.expires_on ? daysBetween(today, d.expires_on) : null })),
    })),
  };
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
function saveFile(db, user, id, b) {
  requireAdmin(user);
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(Number(id));
  if (!u) throw new HttpError(404, 'الموظف غير موجود');
  const out = {};
  for (const k of ['hire_date', 'birth_date', 'contract_end']) if (k in b) out[k] = optDate(b[k]);
  for (const k of ['national_id', 'nationality', 'job_title', 'emergency']) if (k in b) out[k] = text(b[k], 80);
  if ('contract_type' in b) out.contract_type = ['fixed', 'open', ''].includes(b.contract_type) ? b.contract_type : '';
  if ('iban' in b) {
    out.iban = String(b.iban || '').replace(/\s+/g, '').toUpperCase();
    if (out.iban && !/^SA\d{22}$/.test(out.iban)) throw new HttpError(400, 'الآيبان السعودي يبدأ بـ SA وبعده 22 رقماً');
  }
  if ('saudi' in b) out.saudi = b.saudi ? 1 : 0;
  if ('gosi' in b) out.gosi = b.gosi ? 1 : 0;
  if ('basic' in b) out.basic = b.basic === '' || b.basic === null ? null : num(b.basic, 0, 1e6);
  for (const k of ['housing', 'transport']) if (k in b) out[k] = num(b[k] || 0, 0, 1e6);
  const next = { ...u, ...out };
  const p = salaryParts(next);
  if (p.basic + p.housing + p.transport > (next.salary || 0) + 0.01) throw new HttpError(400, `مجموع الأساسي والسكن والنقل أكبر من الراتب (${next.salary})`);
  const keys = Object.keys(out).filter((k) => FILE_FIELDS.includes(k));
  if (!keys.length) return { ok: true };
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => out[k]), u.id);
  audit(db, user.id, 'hr.file', u.id, out);
  return { ok: true };
}

// ------------------------------------------------------------------ documents
function parseDocFile(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m || !FILE_TYPES[m[1]]) throw new HttpError(400, 'الملف لازم يكون صورة أو PDF');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4_000_000) throw new HttpError(400, 'الملف أكبر من 4 ميجا');
  return { buf, ext: FILE_TYPES[m[1]] };
}
function addDocument(db, user, b) {
  requireAdmin(user);
  const userId = Number(b.user_id);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(userId)) throw new HttpError(400, 'اختر الموظف');
  const kind = DOC_KINDS[b.kind] ? b.kind : 'other';
  const expires = optDate(b.expires_on);
  const file = parseDocFile(b.file);
  const id = Number(db.prepare('INSERT INTO documents (user_id, kind, number, expires_on, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, kind, text(b.number, 40), expires, text(b.note, 200), user.id, Date.now()).lastInsertRowid);
  if (file) {
    mkdirSync(docsDir(), { recursive: true });
    const name = `${id}.${file.ext}`;
    writeFileSync(join(docsDir(), name), file.buf);
    db.prepare('UPDATE documents SET file = ? WHERE id = ?').run(name, id);
  }
  audit(db, user.id, 'hr.document.add', userId, { kind, expires });
  return { id };
}
function updateDocument(db, user, id, b) {
  requireAdmin(user);
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
  if (!d) throw new HttpError(404, 'الوثيقة غير موجودة');
  db.prepare('UPDATE documents SET number = ?, expires_on = ?, note = ? WHERE id = ?')
    .run('number' in b ? text(b.number, 40) : d.number, 'expires_on' in b ? optDate(b.expires_on) : d.expires_on, 'note' in b ? text(b.note, 200) : d.note, d.id);
  audit(db, user.id, 'hr.document.update', d.user_id, b);
  return { ok: true };
}
function deleteDocument(db, user, id) {
  requireAdmin(user);
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
  if (!d) throw new HttpError(404, 'الوثيقة غير موجودة');
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  if (d.file) { const f = join(docsDir(), d.file); if (existsSync(f)) unlinkSync(f); }
  audit(db, user.id, 'hr.document.delete', d.user_id, { kind: d.kind, number: d.number });
  return { ok: true };
}
function documentFile(db, user, id) {
  requireAdmin(user);
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
  if (!d?.file) throw new HttpError(404, 'لا يوجد ملف');
  const f = join(docsDir(), d.file);
  if (!existsSync(f)) throw new HttpError(404, 'لا يوجد ملف');
  const ext = d.file.split('.').pop();
  const type = Object.entries(FILE_TYPES).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
  return { buf: readFileSync(f), type };
}

/** Documents and contracts ending within `days` (supervisors see names and dates, no numbers). */
export function expiring(db, days = 60, today = localDate()) {
  const until = addDays(today, days);
  const docs = db.prepare(`SELECT d.id, d.user_id, d.kind, d.expires_on, u.name FROM documents d JOIN users u ON u.id = d.user_id
                           WHERE u.active = 1 AND d.expires_on IS NOT NULL AND d.expires_on <= ? ORDER BY d.expires_on`).all(until)
    .map((d) => ({ ...d, label: DOC_KINDS[d.kind] || d.kind, days: daysBetween(today, d.expires_on) }));
  const contracts = db.prepare("SELECT id AS user_id, name, contract_end AS expires_on FROM users WHERE role = 'employee' AND active = 1 AND contract_end IS NOT NULL AND contract_end <= ? ORDER BY contract_end").all(until)
    .map((c) => ({ ...c, kind: 'contract_end', label: 'نهاية العقد', days: daysBetween(today, c.expires_on) }));
  return [...docs, ...contracts].sort((a, b) => a.expires_on.localeCompare(b.expires_on));
}

/** Once a day: tell the owner 30 days, 7 days and on the day a document or contract ends. */
export function documentsTick(db, now = Date.now()) {
  const today = localDate(now);
  for (const d of expiring(db, 30, today)) {
    const mark = d.days <= 0 ? 0 : d.days <= 7 ? 7 : 30;
    const ref = d.kind === 'contract_end' ? `contract:${d.user_id}:${d.expires_on}` : `doc:${d.id}:${d.expires_on}`;
    const when = d.days < 0 ? `انتهت قبل ${-d.days} يوم` : d.days === 0 ? 'تنتهي اليوم' : `تنتهي بعد ${d.days} يوم`;
    notifyManager(db, 'hr_expiry', msg.card({ icon: '📄', title: `${d.label} · ${d.name}`, fields: [['تاريخ الانتهاء', d.expires_on], ['المدة', when]], quote: 'جدّدها قبل انتهائها لتفادي المخالفات', link: appLink(db) ? `${appLink(db)}/#/documents` : '' }), `hr_expiry:${ref}:${mark}`);
  }
}

// ------------------------------------------------------------------ overtime (Saudi labour law: hour's pay + 50% of the basic hour)
const DAY_HOURS = 8;
export const overtimeRate = (u) => {
  const p = salaryParts(u);
  return round2((u.salary || 0) / 30 / DAY_HOURS + 0.5 * (p.basic / 30 / DAY_HOURS));
};
function listOvertime(db, user, month) {
  requireAdmin(user);
  const m = month || payMonthOf(db, localDate());
  const { from, to } = payPeriod(db, m);
  const rows = payroll(db, m);
  const users = new Map(db.prepare("SELECT * FROM users WHERE role = 'employee'").all().map((u) => [u.id, u]));
  return {
    month: m, period: { from, to },
    rows: rows.map((r) => ({ userId: r.userId, name: r.name, overtimeMinutes: r.overtimeMinutes, approvedMinutes: r.overtimeApproved, approvedPay: r.overtimePay, rate: overtimeRate(users.get(r.userId) || {}) })),
    records: db.prepare('SELECT o.*, u.name FROM overtime o JOIN users u ON u.id = o.user_id WHERE o.date BETWEEN ? AND ? ORDER BY o.date DESC, o.id DESC').all(from, to),
  };
}
function addOvertime(db, user, b) {
  requireAdmin(user);
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(Number(b.user_id));
  if (!u) throw new HttpError(400, 'اختر الموظف');
  const date = needDate(b.date, localDate());
  assertOpen(db, date);
  const minutes = Math.round(num(b.minutes, 1, 24 * 60 * 31));
  const amount = b.amount === '' || b.amount === undefined || b.amount === null ? round2(overtimeRate(u) * minutes / 60) : num(b.amount, 0, 1e6);
  const id = Number(db.prepare('INSERT INTO overtime (user_id, date, minutes, amount, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, date, minutes, amount, text(b.note, 200), user.id, Date.now()).lastInsertRowid);
  logChange(db, { actor: user, area: 'salary', action: 'اعتماد عمل إضافي', target: u.id, ref: date, before: '—', after: `${minutes} دقيقة · ${amount} ر.س`, reason: b.note });
  return { id, amount };
}
function deleteOvertime(db, user, id, b) {
  requireAdmin(user);
  const o = db.prepare('SELECT * FROM overtime WHERE id = ?').get(Number(id));
  if (!o) throw new HttpError(404, 'غير موجود');
  assertOpen(db, o.date);
  db.prepare('DELETE FROM overtime WHERE id = ?').run(o.id);
  logChange(db, { actor: user, area: 'salary', action: 'حذف عمل إضافي', target: o.user_id, ref: o.date, before: `${o.minutes} دقيقة · ${o.amount} ر.س`, after: '—', reason: b?.reason });
  return { ok: true };
}

// ------------------------------------------------------------------ custody
function listCustody(db, user) {
  requireAdmin(user);
  return { items: db.prepare('SELECT c.*, u.name FROM custody c JOIN users u ON u.id = c.user_id ORDER BY c.returned_on IS NOT NULL, c.given_on DESC').all() };
}
function addCustody(db, user, b) {
  requireAdmin(user);
  const userId = Number(b.user_id);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(userId)) throw new HttpError(400, 'اختر الموظف');
  const item = text(b.item, 80);
  if (!item) throw new HttpError(400, 'اكتب اسم العهدة');
  const id = Number(db.prepare('INSERT INTO custody (user_id, item, serial, value, given_on, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, item, text(b.serial, 60), num(b.value || 0, 0, 1e6), needDate(b.given_on, localDate()), text(b.note, 200), user.id, Date.now()).lastInsertRowid);
  audit(db, user.id, 'hr.custody.add', userId, { item });
  return { id };
}
function returnCustody(db, user, id, b) {
  requireAdmin(user);
  const c = db.prepare('SELECT * FROM custody WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'غير موجود');
  db.prepare('UPDATE custody SET returned_on = ? WHERE id = ?').run(b.undo ? null : needDate(b.date, localDate()), c.id);
  audit(db, user.id, b.undo ? 'hr.custody.unreturn' : 'hr.custody.return', c.user_id, { item: c.item });
  return { ok: true };
}
function deleteCustody(db, user, id) {
  requireAdmin(user);
  const c = db.prepare('SELECT * FROM custody WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'غير موجود');
  db.prepare('DELETE FROM custody WHERE id = ?').run(c.id);
  audit(db, user.id, 'hr.custody.delete', c.user_id, { item: c.item });
  return { ok: true };
}

// ------------------------------------------------------------------ discipline ladder
function listDiscipline(db, user) {
  requireAdmin(user);
  return {
    settings: hrSettings(db),
    records: db.prepare('SELECT d.*, u.name FROM discipline d JOIN users u ON u.id = d.user_id ORDER BY d.date DESC, d.id DESC LIMIT 300').all(),
  };
}
/** The step this violation reaches now: one more than its count in the window, capped at the last step. */
export function nextStep(db, userId, violation, date, s = hrSettings(db)) {
  const v = s.violations.find((x) => x.name === violation);
  if (!v) throw new HttpError(400, 'اختر المخالفة من اللائحة');
  const since = addDays(date, -s.window_days);
  const n = db.prepare('SELECT COUNT(*) n FROM discipline WHERE user_id = ? AND violation = ? AND date > ? AND date <= ?').get(userId, violation, since, date).n;
  const step = Math.min(n + 1, v.steps.length);
  const pct = v.steps[step - 1];
  return { step, pct, action: pct ? `خصم ${pct}% من أجر يوم` : step === 1 ? 'إنذار كتابي' : 'إنذار' };
}
function addDiscipline(db, user, b) {
  requireAdmin(user);
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(Number(b.user_id));
  if (!u) throw new HttpError(400, 'اختر الموظف');
  const date = needDate(b.date, localDate());
  const violation = text(b.violation, 80);
  const s = hrSettings(db);
  const { step, pct, action } = nextStep(db, u.id, violation, date, s);
  if (b.preview) return { step, pct, action, amount: round2((u.salary || 0) / 30 * pct / 100) };
  const amount = round2((u.salary || 0) / 30 * pct / 100);
  const note = text(b.note, 300);
  const id = tx(db, () => {
    let dedId = null;
    if (amount > 0) {
      assertOpen(db, date);
      dedId = Number(db.prepare("INSERT INTO deductions (user_id, date, amount, category, reason, created_by, created_at) VALUES (?, ?, ?, 'violation', ?, ?, ?)")
        .run(u.id, date, amount, `${violation} (المرة ${step})${note ? ` · ${note}` : ''}`, user.id, Date.now()).lastInsertRowid);
    }
    return Number(db.prepare('INSERT INTO discipline (user_id, date, violation, step, action, amount, deduction_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.id, date, violation, step, action, amount, dedId, note, user.id, Date.now()).lastInsertRowid);
  });
  logChange(db, { actor: user, area: 'salary', action: 'جزاء من اللائحة', target: u.id, ref: date, before: '—', after: `${violation} · ${action}${amount ? ` (${amount} ر.س)` : ''}`, reason: note });
  return { id, step, action, amount };
}
function deleteDiscipline(db, user, id, b) {
  requireAdmin(user);
  const d = db.prepare('SELECT * FROM discipline WHERE id = ?').get(Number(id));
  if (!d) throw new HttpError(404, 'غير موجود');
  tx(db, () => {
    if (d.deduction_id) { assertOpen(db, d.date); db.prepare('DELETE FROM deductions WHERE id = ?').run(d.deduction_id); }
    db.prepare('DELETE FROM discipline WHERE id = ?').run(d.id);
  });
  logChange(db, { actor: user, area: 'salary', action: 'إلغاء جزاء', target: d.user_id, ref: d.date, before: `${d.violation} · ${d.action}`, after: '—', reason: b?.reason });
  return { ok: true };
}

// ------------------------------------------------------------------ calendar
const FIXED_DAYS = [['02-22', 'يوم التأسيس'], ['09-23', 'اليوم الوطني']];
function calendar(db, user, month) {
  requireSup(user);
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : localDate().slice(0, 7);
  const from = `${m}-01`;
  const to = addDays(`${m === '9999-12' ? m : nextMonth(m)}-01`, -1);
  const items = [];
  const push = (date, kind, title) => items.push({ date, kind, title });
  // the day the payroll month closes (the day before the start day), in this calendar month
  const start = Number(getSettings(db).payroll_start_day) || 1;
  const close = start === 1 ? to : `${m}-${String(start - 1).padStart(2, '0')}`;
  push(close, 'pay', 'إقفال الرواتب');
  for (const [md, t] of FIXED_DAYS) if (md.slice(0, 2) === m.slice(5)) push(`${m}-${md.slice(3)}`, 'hol', t);
  for (const e of db.prepare(`SELECT e.date, e.kind, e.unpaid, e.note, u.name FROM excuses e LEFT JOIN users u ON u.id = e.user_id WHERE e.date BETWEEN ? AND ? ORDER BY e.date`).all(from, to)) {
    if (!e.name) push(e.date, 'hol', e.note || 'عطلة رسمية');
    else push(e.date, 'lv', `${e.name} · ${e.kind === 'sick' ? 'مرضية' : e.kind === 'excused' ? 'عذر' : e.unpaid ? 'إجازة بدون راتب' : 'إجازة'}`);
  }
  for (const e of db.prepare('SELECT id, date, title FROM events WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to)) items.push({ ...e, kind: 'ev' });
  const admin = user.role === 'admin';
  for (const u of db.prepare("SELECT id, name, birth_date, hire_date FROM users WHERE role = 'employee' AND active = 1").all()) {
    if (u.birth_date && u.birth_date.slice(5, 7) === m.slice(5)) push(`${m}-${u.birth_date.slice(8)}`, 'ev', `🎂 ميلاد ${u.name}`);
    if (u.hire_date && u.hire_date.slice(5, 7) === m.slice(5) && u.hire_date.slice(0, 4) < m.slice(0, 4)) push(`${m}-${u.hire_date.slice(8)}`, 'ev', `${u.name} · ${Number(m.slice(0, 4)) - Number(u.hire_date.slice(0, 4))} سنة معنا`);
  }
  if (admin) for (const d of expiring(db, 400, from).filter((x) => x.expires_on >= from && x.expires_on <= to)) push(d.expires_on, 'doc', `${d.label} · ${d.name}`);
  return { month: m, from, to, today: localDate(), items: items.filter((i) => i.date >= from && i.date <= to).sort((a, b) => a.date.localeCompare(b.date)) };
}
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
function addEvent(db, user, b) {
  requireAdmin(user);
  const title = text(b.title, 80);
  if (!title) throw new HttpError(400, 'اكتب عنوان المناسبة');
  return { id: Number(db.prepare('INSERT INTO events (date, title, created_by, created_at) VALUES (?, ?, ?, ?)').run(needDate(b.date), title, user.id, Date.now()).lastInsertRowid) };
}
function deleteEvent(db, user, id) {
  requireAdmin(user);
  db.prepare('DELETE FROM events WHERE id = ?').run(Number(id));
  return { ok: true };
}

// ------------------------------------------------------------------ social insurance and end of service
export function gosiRow(u, s = HR_DEFAULTS.gosi) {
  const p = salaryParts(u);
  const base = Math.min(p.basic + p.housing, s.cap || Infinity);
  if (!u.gosi) return { base: 0, employee: 0, employer: 0 };
  const employee = u.saudi ? round2(base * s.saudi_employee / 100) : 0;
  const employer = round2(base * (u.saudi ? s.saudi_employer : s.non_saudi_employer) / 100);
  return { base: round2(base), employee, employer };
}
function gosiReport(db, user) {
  requireAdmin(user);
  const s = hrSettings(db).gosi;
  const rows = db.prepare("SELECT * FROM users WHERE role = 'employee' AND active = 1 ORDER BY id").all()
    .map((u) => ({ userId: u.id, name: u.name, saudi: !!u.saudi, registered: !!u.gosi, salary: u.salary, ...salaryParts(u), ...gosiRow(u, s) }));
  return { settings: s, rows };
}

/** Saudi labour law, articles 84, 85 and 87. `reason`: resign | end (contract end, dismissal without art. 80, force majeure) | art80. */
export function endOfService({ salary, start, end, reason }) {
  if (!isDate(start) || !isDate(end) || end < start) throw new HttpError(400, 'أدخل تاريخ التعيين وتاريخ نهاية الخدمة');
  const days = daysBetween(start, end) + 1;
  const years = days / 365;
  const first = Math.min(years, 5);
  const rest = Math.max(0, years - 5);
  const full = round2(salary / 2 * first + salary * rest);
  let share = 1;
  let rule = 'مكافأة كاملة (انتهاء العقد أو إنهاء من صاحب العمل أو قوة قاهرة)';
  if (reason === 'art80') { share = 0; rule = 'لا مكافأة: فصل وفق المادة 80'; }
  else if (reason === 'resign') {
    if (years < 2) { share = 0; rule = 'استقالة قبل سنتين: لا مكافأة (المادة 85)'; }
    else if (years < 5) { share = 1 / 3; rule = 'استقالة بين سنتين و5 سنوات: ثلث المكافأة (المادة 85)'; }
    else if (years < 10) { share = 2 / 3; rule = 'استقالة بين 5 و10 سنوات: ثلثا المكافأة (المادة 85)'; }
    else rule = 'استقالة بعد 10 سنوات: المكافأة كاملة (المادة 85)';
  }
  return { days, years: round2(years), full, share: round2(share), amount: round2(full * share), rule };
}
function eos(db, user, q) {
  requireAdmin(user);
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(Number(q.user_id));
  if (!u) throw new HttpError(400, 'اختر الموظف');
  const end = needDate(q.end, localDate());
  const start = q.start || u.hire_date;
  if (!start) throw new HttpError(400, 'أدخل تاريخ التعيين في ملف الموظف أولاً');
  const reason = ['resign', 'end', 'art80'].includes(q.reason) ? q.reason : 'end';
  const award = endOfService({ salary: u.salary || 0, start, end, reason });
  // final settlement: days of the last pay period worked, open loans, custody still with the employee
  const m = payMonthOf(db, end);
  const { from } = payPeriod(db, m);
  const workedDays = Math.max(0, daysBetween(from, end) + 1);
  const lastPay = round2((u.salary || 0) / 30 * Math.min(workedDays, 30));
  const loans = debtBalances(db).find((x) => x.user_id === u.id)?.balance || 0;
  const pendingDed = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM deductions WHERE user_id = ? AND date BETWEEN ? AND ?').get(u.id, from, end).s;
  const custody = db.prepare('SELECT item, serial, value FROM custody WHERE user_id = ? AND returned_on IS NULL').all(u.id);
  const total = round2(award.amount + lastPay - pendingDed - loans);
  return { user: { id: u.id, name: u.name, salary: u.salary, hire_date: u.hire_date }, start, end, reason, award, settlement: { period_from: from, workedDays, lastPay, deductions: round2(pendingDed), loans, custody, total } };
}

// ------------------------------------------------------------------ dashboard summary
function summary(db, user) {
  requireSup(user);
  const today = localDate();
  const onLeave = db.prepare("SELECT e.kind, e.unpaid, u.name, (SELECT MAX(x.date) FROM excuses x WHERE x.user_id = e.user_id AND x.date >= e.date) AS until FROM excuses e JOIN users u ON u.id = e.user_id WHERE e.date = ?").all(today);
  return {
    today,
    expiring: user.role === 'admin' ? expiring(db, 45, today).slice(0, 8) : [],
    onLeave,
    custodyOpen: user.role === 'admin' ? db.prepare('SELECT COUNT(*) n FROM custody WHERE returned_on IS NULL').get().n : 0,
    events: db.prepare('SELECT date, title FROM events WHERE date BETWEEN ? AND ? ORDER BY date LIMIT 5').all(today, addDays(today, 30)),
  };
}

// ------------------------------------------------------------------ routes
export const hrJobs = [documentsTick];

export function registerHr(r, db) {
  const body = async (req) => parseJson(await readBody(req));
  const auth = { auth: true };
  r.get('/api/hr/summary', ({ user }) => summary(db, user), auth);
  r.get('/api/hr/settings', ({ user }) => { requireAdmin(user); return hrSettings(db); }, auth);
  r.put('/api/hr/settings', async ({ req, user }) => saveHrSettings(db, user, await body(req)), auth);
  r.get('/api/hr/files', ({ user }) => { requireAdmin(user); return listFiles(db); }, auth);
  r.put('/api/hr/files/:id', async ({ req, params, user }) => saveFile(db, user, params.id, await body(req)), auth);
  r.post('/api/hr/documents', async ({ req, user }) => addDocument(db, user, await body(req)), auth);
  r.put('/api/hr/documents/:id', async ({ req, params, user }) => updateDocument(db, user, params.id, await body(req)), auth);
  r.delete('/api/hr/documents/:id', ({ params, user }) => deleteDocument(db, user, params.id), auth);
  r.get('/hr/documents/:id/file', ({ params, res, user }) => {
    const f = documentFile(db, user, params.id);
    send(res, 200, f.buf, { 'Content-Type': f.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  }, { auth: true, page: true });
  r.get('/api/hr/overtime', ({ url, user }) => listOvertime(db, user, url.searchParams.get('month')), auth);
  r.post('/api/hr/overtime', async ({ req, user }) => addOvertime(db, user, await body(req)), auth);
  r.delete('/api/hr/overtime/:id', async ({ req, params, user }) => deleteOvertime(db, user, params.id, await body(req)), auth);
  r.get('/api/hr/custody', ({ user }) => listCustody(db, user), auth);
  r.post('/api/hr/custody', async ({ req, user }) => addCustody(db, user, await body(req)), auth);
  r.post('/api/hr/custody/:id/return', async ({ req, params, user }) => returnCustody(db, user, params.id, await body(req)), auth);
  r.delete('/api/hr/custody/:id', ({ params, user }) => deleteCustody(db, user, params.id), auth);
  r.get('/api/hr/discipline', ({ user }) => listDiscipline(db, user), auth);
  r.post('/api/hr/discipline', async ({ req, user }) => addDiscipline(db, user, await body(req)), auth);
  r.delete('/api/hr/discipline/:id', async ({ req, params, user }) => deleteDiscipline(db, user, params.id, await body(req)), auth);
  r.get('/api/hr/calendar', ({ url, user }) => calendar(db, user, url.searchParams.get('month')), auth);
  r.post('/api/hr/events', async ({ req, user }) => addEvent(db, user, await body(req)), auth);
  r.delete('/api/hr/events/:id', ({ params, user }) => deleteEvent(db, user, params.id), auth);
  r.get('/api/hr/gosi', ({ user }) => gosiReport(db, user), auth);
  r.get('/api/hr/eos', ({ url, user }) => eos(db, user, Object.fromEntries(url.searchParams)), auth);
}
