// Cases a supervisor reviews, shift exceptions, and the "hide deductions" switch.
// - Missing checkout: half an hour after a period ends, an employee still checked in (no "out")
//   opens a case. Until it is decided the day shows "غياب بانتظار المراجعة". Approved = the period
//   counts as absence; dismissed = the day stays as it was.
// - Exit without permission: a temporary exit inside working hours not covered by an approved
//   permission opens a case with a proposed deduction priced like lateness (1 SAR per N minutes).
//   Approved = the deduction is recorded.
// Nobody decides a case about themselves (except the owner).
import { MIN } from '../config.js';
import { audit, tx } from '../db.js';
import { HttpError } from '../http.js';
import { getSettings, saveSettings } from '../settings.js';
import { at, localDate, localTime } from '../time.js';
import { exceptionOf, loadExceptions, periodsFor } from '../attendance.js';
import { assertOpen } from '../monthly.js';
import { DEDUCTION_LABELS } from '../reports.js';
import { deductionNotice, link, msg, toSupervisors, toUser } from './alerts.js';
import { logChange } from './changelog.js';
import { isSup, needDate, num, requireSup, text } from './util.js';

const DELAY = 30; // minutes after a period ends before a missing checkout opens a case
const round2 = (n) => Math.round(n * 100) / 100;
const KIND = { missing_out: 'لم يسجّل انصراف', unauthorized_exit: 'خروج بدون إذن' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ------------------------------------------------------------------ detection
/** Once a minute: open cases for today's missing checkouts and exits without permission. */
export function reviewTick(db, now = Date.now()) {
  const date = localDate(now);
  const settings = getSettings(db);
  const lateRate = settings.late_minutes_per_riyal ?? 3;
  if (db.prepare('SELECT 1 FROM excuses WHERE user_id IS NULL AND date = ?').get(date)) return 0;
  const exceptions = loadExceptions(db, date, date);
  const users = db.prepare("SELECT id, name, salary, periods, day_off, created_at FROM users WHERE role = 'employee' AND active = 1").all();
  let opened = 0;
  for (const u of users) {
    if (localDate(u.created_at) > date) continue;
    if (db.prepare('SELECT 1 FROM excuses WHERE user_id = ? AND date = ?').get(u.id, date)) continue;
    const periods = periodsFor(u, date, settings.schedule, false, exceptionOf(exceptions, u.id, date)).map((p) => ({ ...p, s: at(date, p.start), e: at(date, p.end) }));
    if (!periods.length) continue;
    const punches = db.prepare('SELECT ts, type FROM punches WHERE user_id = ? AND date = ? AND voided = 0 ORDER BY ts').all(u.id, date);
    if (!punches.length) continue;

    // missing checkout: still in at end + DELAY, having come in before the period ended
    for (const p of periods) {
      const check = p.e + DELAY * MIN;
      if (now < check) continue;
      const upto = punches.filter((x) => x.ts <= check);
      const last = upto[upto.length - 1];
      if (!last || (last.type !== 'in' && last.type !== 'back')) continue;
      if (last.ts >= p.e) continue; // came in after this period: it belongs to the next one
      opened += open(db, u, { date, kind: 'missing_out', ref: p.id, period_name: p.name, started_at: p.e, note: `آخر بصمة ${localTime(last.ts)}` }, now);
    }

    // exits without permission, counted inside working periods only
    const permits = db.prepare("SELECT from_time, to_time FROM leave_requests WHERE user_id = ? AND from_date = ? AND kind = 'permission' AND status = 'approved'")
      .all(u.id, date).map((x) => [at(date, x.from_time), at(date, x.to_time)]);
    const scheduled = periods.reduce((t, p) => t + (p.e - p.s) / MIN, 0);
    for (let i = 0; i < punches.length; i++) {
      const l = punches[i];
      if (l.type !== 'leave') continue;
      const next = punches[i + 1];
      const within = periods.find((p) => l.ts >= p.s && l.ts < p.e);
      let end;
      if (next && (next.type === 'back' || next.type === 'out')) end = next.ts;
      else if (!next && within && now >= within.e + DELAY * MIN) end = within.e; // never came back: up to the end of that period
      else continue;
      const minutes = Math.round(uncovered([l.ts, end], periods, permits) / MIN);
      if (minutes < 1) continue;
      const amount = lateRate > 0 ? round2(minutes / lateRate) : round2(scheduled > 0 ? (u.salary / 30 / scheduled) * minutes : 0);
      opened += open(db, u, { date, kind: 'unauthorized_exit', ref: String(l.ts), period_name: within?.name || '', started_at: l.ts, ended_at: end, minutes, amount }, now);
    }
  }
  return opened;
}

/** Milliseconds of [a, b] inside working periods and outside approved permissions. */
function uncovered([a, b], periods, permits) {
  let total = 0;
  for (const p of periods) {
    const s = Math.max(a, p.s);
    const e = Math.min(b, p.e);
    if (e <= s) continue;
    let covered = 0;
    const parts = permits.map(([x, y]) => [Math.max(x, s), Math.min(y, e)]).filter(([x, y]) => y > x).sort((m, n) => m[0] - n[0]);
    let cur = s;
    for (const [x, y] of parts) { const from = Math.max(x, cur); if (y > from) { covered += y - from; cur = y; } }
    total += e - s - covered;
  }
  return total;
}

function open(db, u, c, now) {
  const r = db.prepare(`INSERT OR IGNORE INTO review_cases (user_id, date, kind, ref, period_name, started_at, ended_at, minutes, amount, note, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(u.id, c.date, c.kind, c.ref, c.period_name || '', c.started_at ?? null, c.ended_at ?? null, c.minutes || 0, c.amount || 0, c.note || '', now);
  if (!r.changes) return 0;
  const id = Number(r.lastInsertRowid);
  const exit = c.kind === 'unauthorized_exit';
  const when = exit ? `${localTime(c.started_at)} ← ${localTime(c.ended_at)}` : `نهاية ${c.period_name} ${localTime(c.started_at)}`;
  toSupervisors(db, 'review_case', msg.card({ manager: true, icon: exit ? '🚪' : '🕘', title: `${KIND[c.kind]}: ${u.name}`,
    fields: [['اليوم', c.date], [exit ? 'الخروج' : 'الفترة', when], ...(exit ? [['المدة', `${c.minutes} دقيقة`], ['الخصم المقترح', `${c.amount} ر.س`]] : [['الحالة', 'غياب بانتظار المراجعة']])],
    steps: ['راجعها من «الحالات» في النظام: اعتماد أو إلغاء'], link: link(db, '#/cases') }), `case:${id}`, { skip: u.id });
  toUser(db, u.id, 'review_case_employee', msg.card({ icon: exit ? '🚪' : '🕘', title: exit ? 'خروج بدون إذن مسجّل عليك' : 'ما سجّلت انصراف',
    hello: `${u.name}،`, fields: [['اليوم', c.date], [exit ? 'الخروج' : 'الفترة', when], ...(exit ? [['المدة', `${c.minutes} دقيقة`]] : [])],
    lines: [exit ? 'الخروج أثناء الدوام بدون إذن معتمد يُحسب كتأخير، والمشرف يراجعه.' : 'الفترة مسجّلة «غياب بانتظار المراجعة» إلى أن يراجعها المشرف.'],
    steps: ['إذا عندك عذر أو نسيت البصمة، قدّم طلب تصحيح من «صفحتي»'], link: link(db, '#/profile') }), `case_emp:${id}`);
  return 1;
}

// ------------------------------------------------------------------ list & decide
export function listCases(db, user, { status = 'pending', userId = null } = {}) {
  const all = isSup(user);
  const where = [status === 'pending' ? "c.status = 'pending'" : status === 'done' ? "c.status != 'pending'" : '1=1'];
  const args = [];
  if (!all) { where.push('c.user_id = ?'); args.push(user.id); } else if (userId) { where.push('c.user_id = ?'); args.push(Number(userId)); }
  const rows = db.prepare(`SELECT c.*, u.name, d.name AS decided_name FROM review_cases c JOIN users u ON u.id = c.user_id LEFT JOIN users d ON d.id = c.decided_by
                           WHERE ${where.join(' AND ')} ORDER BY c.status = 'pending' DESC, c.date DESC, c.id DESC LIMIT 300`).all(...args);
  const counts = db.prepare("SELECT SUM(kind = 'missing_out') missing, SUM(kind = 'unauthorized_exit') exits FROM review_cases WHERE status = 'pending'" + (all ? '' : ' AND user_id = ?')).get(...(all ? [] : [user.id]));
  return { cases: rows, counts: { missing: counts.missing || 0, exits: counts.exits || 0 }, kinds: KIND, lateRate: getSettings(db).late_minutes_per_riyal ?? 3 };
}

export function decideCase(db, user, id, body) {
  requireSup(user);
  const c = db.prepare('SELECT c.*, u.name FROM review_cases c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'الحالة غير موجودة');
  if (c.status !== 'pending') throw new HttpError(400, 'الحالة مُراجعة مسبقاً');
  if (c.user_id === user.id && user.role !== 'admin') throw new HttpError(403, 'ما تقدر تراجع حالة عليك، هذي عند المدير');
  const status = body.status === 'approved' ? 'approved' : body.status === 'dismissed' ? 'dismissed' : null;
  if (!status) throw new HttpError(400, 'اختر اعتماد أو إلغاء');
  const response = text(body.response, 300);
  if (status === 'dismissed' && response.length < 2) throw new HttpError(400, 'اكتب سبب الإلغاء');
  const exit = c.kind === 'unauthorized_exit';
  const amount = exit && status === 'approved' ? (body.amount === undefined || body.amount === '' ? c.amount : num(body.amount, 0, 1e5)) : 0;
  let dedId = null;
  tx(db, () => {
    if (exit && status === 'approved' && amount > 0) {
      assertOpen(db, c.date);
      const reason = `خروج بدون إذن ${c.minutes} دقيقة (${localTime(c.started_at)}–${localTime(c.ended_at)})${response ? ` · ${response}` : ''}`;
      dedId = Number(db.prepare('INSERT INTO deductions (user_id, date, amount, category, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.user_id, c.date, amount, 'exit', reason, user.id, Date.now()).lastInsertRowid);
      audit(db, user.id, 'deduction.add', c.user_id, { date: c.date, amount, category: 'exit', reason, case: c.id });
      logChange(db, { actor: user, area: 'salary', action: 'خصم خروج بدون إذن', target: c.user_id, ref: c.date, before: '—', after: `${amount} ر.س`, reason });
    }
    if (!exit) {
      logChange(db, { actor: user, area: 'attendance', action: status === 'approved' ? 'اعتماد غياب لعدم تسجيل الانصراف' : 'إلغاء حالة عدم تسجيل الانصراف', target: c.user_id,
        ref: `${c.date} · ${c.period_name}`, before: 'غياب بانتظار المراجعة', after: status === 'approved' ? 'غياب' : 'حضور', reason: response || 'لم يسجّل انصراف' });
    }
    db.prepare('UPDATE review_cases SET status = ?, decided_by = ?, decided_at = ?, response = ?, amount = ?, deduction_id = ? WHERE id = ?')
      .run(status, user.id, Date.now(), response, exit && status === 'approved' ? amount : c.amount, dedId, c.id);
    audit(db, user.id, 'case.decide', c.user_id, { id: c.id, kind: c.kind, status, amount });
  });
  if (dedId) toUser(db, c.user_id, 'deduction', deductionNotice(db, { amount, date: c.date, category: DEDUCTION_LABELS.exit, reason: `خروج بدون إذن ${c.minutes} دقيقة`, link: link(db) }), `case_ded:${c.id}`);
  else toUser(db, c.user_id, 'review_case_status', msg.card({ icon: status === 'approved' ? '📌' : '✅', hello: `${c.name}،`,
    title: status === 'approved' ? (exit ? 'اعتُمد الخروج بدون إذن' : `اعتُمد غياب ${c.period_name}`) : 'أُلغيت الحالة المسجّلة عليك',
    fields: [['اليوم', c.date], ['الحالة', KIND[c.kind]]], quote: response || undefined, link: link(db, '#/profile') }), `case_status:${c.id}`);
  return { ok: true, deduction_id: dedId };
}

/** An approved correction that adds the missing checkout closes that day's open case. */
export function closeCasesByCorrection(db, userId, date, user) {
  return db.prepare("UPDATE review_cases SET status = 'dismissed', decided_by = ?, decided_at = ?, response = 'صُحّحت البصمة بطلب تصحيح معتمد' WHERE user_id = ? AND date = ? AND kind = 'missing_out' AND status = 'pending'")
    .run(user.id, Date.now(), userId, date).changes;
}

// ------------------------------------------------------------------ shift exceptions
export function listExceptions(db, user, { from } = {}) {
  requireSup(user);
  const f = needDate(from, localDate(Date.now() - 30 * 86_400_000));
  const settings = getSettings(db);
  return {
    exceptions: db.prepare(`SELECT e.*, u.name, c.name AS created_name FROM shift_exceptions e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users c ON c.id = e.created_by
                            WHERE e.date >= ? ORDER BY e.date, e.user_id IS NOT NULL, u.name`).all(f).map((e) => ({ ...e, periods: JSON.parse(e.periods) })),
    schedule: settings.schedule,
    people: db.prepare("SELECT id, name FROM users WHERE role = 'employee' AND active = 1 ORDER BY name").all(),
  };
}

export function saveException(db, user, body) {
  requireSup(user);
  const date = needDate(body.date);
  if (date < localDate(Date.now() - 31 * 86_400_000)) throw new HttpError(400, 'الاستثناء لتاريخ قديم جداً');
  const userId = Number(body.user_id) || null;
  if (userId) {
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(userId)) throw new HttpError(400, 'الموظف غير موجود');
    if (userId === user.id && user.role !== 'admin') throw new HttpError(403, 'ما تقدر تعدّل دوامك بنفسك، هذا عند المدير');
  }
  let n = 0;
  const periods = body.off ? [] : (Array.isArray(body.periods) ? body.periods : []).slice(0, 4).map((p) => {
    if (!HHMM.test(p.start) || !HHMM.test(p.end) || p.start >= p.end) throw new HttpError(400, 'وقت الفترة غير صحيح');
    const id = /^[a-z0-9_-]{1,20}$/i.test(p.id || '') ? p.id : `x${++n}`;
    return { id, name: text(p.name, 40) || 'فترة', start: p.start, end: p.end };
  }).sort((a, b) => a.start.localeCompare(b.start));
  if (!body.off && !periods.length) throw new HttpError(400, 'أضف فترة واحدة على الأقل، أو اختر «بدون دوام»');
  for (let i = 1; i < periods.length; i++) if (periods[i].start < periods[i - 1].end) throw new HttpError(400, 'الفترات متداخلة');
  const note = text(body.note, 200);
  if (note.length < 2) throw new HttpError(400, 'اكتب سبب الاستثناء');
  const prev = db.prepare('SELECT periods FROM shift_exceptions WHERE date = ? AND COALESCE(user_id, 0) = ?').get(date, userId || 0);
  tx(db, () => {
    db.prepare('DELETE FROM shift_exceptions WHERE date = ? AND COALESCE(user_id, 0) = ?').run(date, userId || 0);
    db.prepare('INSERT INTO shift_exceptions (date, user_id, periods, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(date, userId, JSON.stringify(periods), note, user.id, Date.now());
  });
  const show = (list) => (list.length ? list.map((p) => `${p.start}–${p.end}`).join(' و ') : 'بدون دوام');
  logChange(db, { actor: user, area: 'attendance', action: userId ? 'استثناء دوام لموظف' : 'استثناء دوام للجميع', target: userId, ref: date,
    before: prev ? show(JSON.parse(prev.periods)) : 'الدوام المعتاد', after: show(periods), reason: note });
  const ids = userId ? [userId] : db.prepare("SELECT id FROM users WHERE role = 'employee' AND active = 1").all().map((r) => r.id);
  for (const id of ids) {
    toUser(db, id, 'shift_exception', msg.card({ icon: '🗓️', title: 'تغيير في الدوام', fields: [['اليوم', date], ['الدوام', show(periods)]], quote: note, link: link(db) }),
      `shift_exc:${date}:${userId || 0}:${id}:${Date.now()}`);
  }
  return { ok: true };
}

export function deleteException(db, user, id, body = {}) {
  requireSup(user);
  const e = db.prepare('SELECT * FROM shift_exceptions WHERE id = ?').get(Number(id));
  if (!e) throw new HttpError(404, 'الاستثناء غير موجود');
  if (e.user_id === user.id && user.role !== 'admin') throw new HttpError(403, 'ما تقدر تعدّل دوامك بنفسك');
  db.prepare('DELETE FROM shift_exceptions WHERE id = ?').run(e.id);
  logChange(db, { actor: user, area: 'attendance', action: 'حذف استثناء دوام', target: e.user_id, ref: e.date, before: JSON.parse(e.periods).map((p) => `${p.start}–${p.end}`).join(' و ') || 'بدون دوام', after: 'الدوام المعتاد', reason: text(body.reason, 300) });
  return { ok: true };
}

// ------------------------------------------------------------------ the owner's switch
export function additionSettings(db, user) {
  if (user.role !== 'admin') throw new HttpError(403, 'للمدير فقط');
  return { hide_deductions: !!getSettings(db).hide_deductions };
}
export function saveAdditionSettings(db, user, body) {
  if (user.role !== 'admin') throw new HttpError(403, 'للمدير فقط');
  const before = !!getSettings(db).hide_deductions;
  const next = saveSettings(db, { hide_deductions: !!body.hide_deductions });
  if (before !== next.hide_deductions) logChange(db, { actor: user, area: 'salary', action: 'إظهار الخصومات للموظفين', before: before ? 'مخفية' : 'ظاهرة', after: next.hide_deductions ? 'مخفية' : 'ظاهرة', reason: text(body.reason, 300) || 'إعداد' });
  return { ok: true, hide_deductions: next.hide_deductions };
}
