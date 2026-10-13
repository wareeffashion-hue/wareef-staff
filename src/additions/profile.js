// The employee's own page: attendance, shift, tasks, leaves, salary, and the state of every request,
// plus punch-correction requests that a supervisor approves (the punch is then added) or rejects.
import { audit } from '../db.js';
import { HttpError } from '../http.js';
import { getSettings } from '../settings.js';
import { addDays, localDate, monthBounds, weekday } from '../time.js';
import { loadAttendance, periodsFor, summarize } from '../attendance.js';
import { managerPunch } from '../punch.js';
import { payrollFor } from '../monthly.js';
import { debtBalances, deductionRows } from '../reports.js';
import { link, msg, toSupervisors, toUser } from './alerts.js';
import { logChange } from './changelog.js';
import { myDecisions } from './decisions.js';
import { isFinance, isSup, needDate, text } from './util.js';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const TYPES = { in: 'حضور', out: 'انصراف', leave: 'خروج مؤقت', back: 'عودة' };

export function profile(db, user, { userId = null, month = null } = {}) {
  const id = Number(userId) || user.id;
  if (id !== user.id && !isSup(user) && !isFinance(user)) throw new HttpError(403, 'هذه صفحة موظف آخر');
  const u = db.prepare("SELECT id, name, username, role, salary, periods, day_off, phone, created_at FROM users WHERE id = ?").get(id);
  if (!u || u.role !== 'employee') throw new HttpError(404, 'الموظف غير موجود');
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : localDate().slice(0, 7);
  const { from, to } = monthBounds(m);
  const settings = getSettings(db);
  const today = localDate();
  const days = loadAttendance(db, { from, to: to < today ? to : today, userId: id });
  const money = id === user.id || isFinance(user);
  // the week's shifts (starting from Saturday)
  const week = [6, 0, 1, 2, 3, 4, 5].map((wd) => {
    const date = [...Array(7)].map((_, i) => addDays(today, i)).find((d) => weekday(d) === wd);
    return { day: DAYS[wd], periods: periodsFor(u, date, settings.schedule).map((p) => ({ name: p.name, start: p.start, end: p.end })) };
  });
  let salary = null;
  if (money) {
    const { rows, closed } = payrollFor(db, m);
    const row = rows.find((r) => r.userId === id);
    salary = {
      month: m, closed: !!closed, base: u.salary, deductions: row?.deductions || 0, repayments: row?.repayments || 0, net: row?.net ?? u.salary,
      list: deductionRows(db, from, to, id), loanBalance: debtBalances(db).find((b) => b.user_id === id)?.balance || 0,
    };
  }
  const recent = (sql) => db.prepare(sql).all(id);
  return {
    user: { id: u.id, name: u.name, username: u.username, since: localDate(u.created_at), day_off: u.day_off === null ? null : DAYS[u.day_off] },
    month: m,
    attendance: { days: days.map(({ suggested, ...d }) => d), summary: summarize(days).map(({ suggested, ...s }) => s)[0] || null },
    shift: { week, grace: settings.grace_minutes },
    tasks: {
      shortages: recent("SELECT id, sku, name, qty, qty_done, priority, due_date, status FROM shortages WHERE assignee_id = ? AND status IN ('open', 'partial') ORDER BY id DESC"),
      tickets: recent("SELECT id, title, status, date FROM tickets WHERE user_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 20"),
      decisions: id === user.id ? myDecisions(db, user).filter((d) => !d.ack_at) : [],
    },
    leaves: recent(`SELECT date, kind, note FROM excuses WHERE user_id = ? AND kind IN ('leave', 'sick', 'excused') AND date >= '${today.slice(0, 4)}-01-01' ORDER BY date DESC`),
    salary,
    requests: {
      corrections: recent('SELECT * FROM corrections WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
      leaves: recent('SELECT id, kind, from_date, to_date, from_time, to_time, minutes, status, response FROM leave_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
      requests: recent('SELECT id, kind, sku, quantity, status, response, date FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
      tickets: recent('SELECT id, title, status, date FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
    },
    decisions: id === user.id ? myDecisions(db, user) : [],
    canSeeMoney: money,
  };
}

// ------------------------------------------------------------------ correction requests
export function requestCorrection(db, user, body) {
  if (user.role !== 'employee') throw new HttpError(400, 'طلبات التصحيح للموظفين');
  const date = needDate(body.date);
  const today = localDate();
  if (date > today || date < addDays(today, -31)) throw new HttpError(400, 'التصحيح متاح لآخر 31 يوماً');
  if (!TYPES[body.type]) throw new HttpError(400, 'اختر نوع البصمة');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || '')) throw new HttpError(400, 'الوقت غير صحيح');
  const reason = text(body.reason, 400);
  if (reason.length < 3) throw new HttpError(400, 'اكتب سبب التصحيح');
  if (db.prepare("SELECT 1 FROM corrections WHERE user_id = ? AND date = ? AND type = ? AND status = 'pending'").get(user.id, date, body.type)) throw new HttpError(409, 'عندك طلب تصحيح بانتظار المراجعة لنفس اليوم والنوع');
  const id = Number(db.prepare('INSERT INTO corrections (user_id, date, type, time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, date, body.type, body.time, reason, Date.now()).lastInsertRowid);
  toSupervisors(db, 'correction_request', msg.card({ manager: true, icon: '🕘', title: `طلب تصحيح بصمة: ${user.name}`,
    fields: [['اليوم', date], ['البصمة', `${TYPES[body.type]} ${body.time}`]], quote: reason, steps: ['راجعه من «طلبات الاعتماد» في النظام'], link: link(db, '#/approvals') }),
  `correction:${id}`, { skip: user.id });
  return { ok: true, id };
}

export function listCorrections(db, user, { status = 'pending' } = {}) {
  const all = isSup(user);
  const where = [status === 'pending' ? "c.status = 'pending'" : status === 'done' ? "c.status != 'pending'" : '1=1', ...(all ? [] : ['c.user_id = ?'])];
  return {
    corrections: db.prepare(`SELECT c.*, u.name, d.name AS decided_name FROM corrections c JOIN users u ON u.id = c.user_id LEFT JOIN users d ON d.id = c.decided_by
                             WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT 200`).all(...(all ? [] : [user.id])),
  };
}

export function decideCorrection(db, user, id, body) {
  if (!isSup(user)) throw new HttpError(403, 'الاعتماد للمشرف');
  const c = db.prepare('SELECT * FROM corrections WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'الطلب غير موجود');
  if (c.status !== 'pending') throw new HttpError(400, 'الطلب مُراجع مسبقاً');
  if (user.role !== 'admin' && c.user_id === user.id) throw new HttpError(403, 'ما تقدر تعتمد طلبك بنفسك، هذا عند المدير');
  const status = body.status === 'approved' ? 'approved' : body.status === 'rejected' ? 'rejected' : null;
  if (!status) throw new HttpError(400, 'اختر موافقة أو رفض');
  const response = text(body.response, 300);
  if (status === 'rejected' && !response) throw new HttpError(400, 'اكتب سبب الرفض');
  let punchId = null;
  if (status === 'approved') {
    punchId = managerPunch(db, user, { user_id: c.user_id, date: c.date, time: c.time, type: c.type, note: `تصحيح معتمد: ${c.reason}` });
    logChange(db, { actor: user, area: 'attendance', action: 'اعتماد طلب تصحيح بصمة', target: c.user_id, ref: c.date, before: 'بدون بصمة', after: `${TYPES[c.type]} ${c.time}`, reason: c.reason });
  }
  db.prepare('UPDATE corrections SET status = ?, decided_by = ?, decided_at = ?, response = ?, punch_id = ? WHERE id = ?').run(status, user.id, Date.now(), response, punchId, c.id);
  audit(db, user.id, 'correction.decide', c.user_id, { id: c.id, status });
  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(c.user_id)?.name || '';
  toUser(db, c.user_id, 'correction_status', msg.card({ icon: status === 'approved' ? '✅' : '⛔', title: status === 'approved' ? 'تم اعتماد تصحيح البصمة' : 'رُفض طلب تصحيح البصمة',
    hello: `${name}،`, fields: [['اليوم', c.date], ['البصمة', `${TYPES[c.type]} ${c.time}`]], quote: response || undefined, link: link(db, '#/profile') }), `correction_status:${c.id}`);
  return { ok: true };
}
