// Money for the accounts employee, and deductions recorded by a delegated employee.
// - Accountant ("accountant" permission): payroll, payslips, deductions and loans; records loans
//   and repayments. Cannot approve deductions or touch attendance, staff or settings.
// - Delegated recorder ("deduct_record" permission, granted by a supervisor): records a deduction
//   with its reason, or raises a note on an employee. A deduction reaches the payroll only after a
//   supervisor approves it, and nobody approves a deduction they recorded or one on themselves.
import { audit, tx } from '../db.js';
import { HttpError } from '../http.js';
import { localDate, monthBounds } from '../time.js';
import { assertOpen, payrollFor } from '../monthly.js';
import { DEDUCTION_LABELS, debtBalances, debtRows, deductionRows } from '../reports.js';
import { link, msg, toSupervisors, toUser } from './alerts.js';
import { logChange } from './changelog.js';
import { isFinance, isSup, needDate, num, requireFinance, requireSup, text } from './util.js';

const employee = (db, id) => {
  const u = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'employee'").get(Number(id));
  if (!u) throw new HttpError(400, 'اختر الموظف');
  return u;
};

// ------------------------------------------------------------------ accountant
export function financeOverview(db, user, { month }) {
  requireFinance(user);
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : localDate().slice(0, 7);
  const { from, to } = monthBounds(m);
  const { rows, closed } = payrollFor(db, m);
  return {
    month: m, payroll: rows, closed,
    deductions: deductionRows(db, from, to),
    debts: debtRows(db).filter((d) => d.date >= from && d.date <= to),
    balances: debtBalances(db),
    people: db.prepare("SELECT id, name FROM users WHERE role = 'employee' AND active = 1 ORDER BY name").all(),
  };
}

/** A loan or repayment recorded by the accounts employee (same rules as the owner's money page). */
export function addDebt(db, user, body) {
  requireFinance(user);
  const u = employee(db, body.user_id);
  if (u.id === user.id) throw new HttpError(403, 'ما تقدر تسجّل سلفة لنفسك');
  const kind = body.kind === 'repayment' ? 'repayment' : 'loan';
  const amount = num(body.amount, 0.01, 1e7);
  const date = needDate(body.date, localDate());
  assertOpen(db, date);
  const note = text(body.note, 300);
  const id = Number(db.prepare('INSERT INTO debts (user_id, date, kind, amount, note, from_salary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, date, kind, amount, note, body.from_salary === false ? 0 : 1, user.id, Date.now()).lastInsertRowid);
  audit(db, user.id, `debt.${kind}`, u.id, { date, amount, note });
  logChange(db, { actor: user, area: 'salary', action: kind === 'loan' ? 'سلفة' : 'سداد سلفة', target: u.id, ref: date, before: '—', after: `${amount} ر.س`, reason: note });
  const bal = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'loan' THEN amount ELSE -amount END), 0) b FROM debts WHERE user_id = ?").get(u.id).b;
  toUser(db, u.id, `debt_${kind}`, msg.debt({ kind, amount, balance: Math.round(bal * 100) / 100, note, link: link(db) }), `debt:${id}`);
  return { ok: true, id };
}

// ------------------------------------------------------------------ delegation (supervisor grants the recording permission)
export function setDelegate(db, user, body) {
  requireSup(user);
  const u = employee(db, body.user_id);
  if (u.id === user.id && user.role !== 'admin') throw new HttpError(403, 'ما تقدر تمنح الصلاحية لنفسك');
  const row = db.prepare('SELECT perms FROM users WHERE id = ?').get(u.id);
  const perms = new Set(JSON.parse(row.perms || '[]'));
  if (body.on) perms.add('deduct_record'); else perms.delete('deduct_record');
  db.prepare('UPDATE users SET perms = ? WHERE id = ?').run(JSON.stringify([...perms]), u.id);
  audit(db, user.id, body.on ? 'delegate.grant' : 'delegate.revoke', u.id, { perm: 'deduct_record' });
  return { ok: true };
}

export const delegates = (db) => db.prepare(`SELECT u.id, u.name FROM users u WHERE u.role = 'employee' AND u.active = 1
  AND EXISTS (SELECT 1 FROM json_each(u.perms) WHERE value = 'deduct_record') ORDER BY u.name`).all();

// ------------------------------------------------------------------ delegated deductions
const canRecord = (user) => isSup(user) || user.perms.includes('deduct_record');

export function recordDeduction(db, user, body) {
  if (!canRecord(user)) throw new HttpError(403, 'ليست لديك صلاحية تسجيل الخصومات');
  const u = employee(db, body.user_id);
  if (u.id === user.id) throw new HttpError(403, 'ما تقدر تسجّل خصماً على نفسك');
  const category = DEDUCTION_LABELS[body.category] ? body.category : 'other';
  const amount = num(body.amount, 0.01, 1e6);
  const date = needDate(body.date, localDate());
  assertOpen(db, date);
  const reason = text(body.reason, 300);
  if (reason.length < 3) throw new HttpError(400, 'اكتب سبب الخصم');
  const id = Number(db.prepare('INSERT INTO deduction_requests (user_id, amount, category, date, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, amount, category, date, reason, user.id, Date.now()).lastInsertRowid);
  audit(db, user.id, 'deduction_request.add', u.id, { id, amount, category });
  toSupervisors(db, 'deduction_request', msg.card({ manager: true, icon: '🧾', title: `خصم بانتظار الاعتماد: ${u.name}`,
    fields: [['المبلغ', `${amount} ر.س`], ['النوع', DEDUCTION_LABELS[category]], ['التاريخ', date], ['سجّله', user.name]], quote: reason,
    steps: ['اعتمده أو ارفضه من «طلبات الاعتماد» في النظام'], link: link(db, '#/approvals') }), `deduction_request:${id}`, { skip: user.id });
  return { ok: true, id };
}

export function listDeductionRequests(db, user, { status = 'pending' } = {}) {
  if (!canRecord(user) && !isFinance(user)) throw new HttpError(403, 'ليست لديك صلاحية');
  const all = isSup(user) || isFinance(user);
  const where = [status === 'pending' ? "r.status = 'pending'" : status === 'done' ? "r.status != 'pending'" : '1=1', ...(all ? [] : ['r.created_by = ?'])];
  return {
    requests: db.prepare(`SELECT r.*, u.name, c.name AS created_name, d.name AS decided_name FROM deduction_requests r JOIN users u ON u.id = r.user_id
                          LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users d ON d.id = r.decided_by
                          WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 200`).all(...(all ? [] : [user.id])),
    labels: DEDUCTION_LABELS,
  };
}

export function decideDeduction(db, user, id, body) {
  if (!isSup(user)) throw new HttpError(403, 'الاعتماد للمشرف');
  const r = db.prepare('SELECT * FROM deduction_requests WHERE id = ?').get(Number(id));
  if (!r) throw new HttpError(404, 'الطلب غير موجود');
  if (r.status !== 'pending') throw new HttpError(400, 'الطلب مُراجع مسبقاً');
  if (r.created_by === user.id) throw new HttpError(403, 'ما تقدر تعتمد خصماً سجّلته بنفسك');
  if (r.user_id === user.id) throw new HttpError(403, 'ما تقدر تعتمد خصماً عليك');
  const status = body.status === 'approved' ? 'approved' : body.status === 'rejected' ? 'rejected' : null;
  if (!status) throw new HttpError(400, 'اختر اعتماد أو رفض');
  const response = text(body.response, 300);
  if (status === 'rejected' && !response) throw new HttpError(400, 'اكتب سبب الرفض');
  const recorder = db.prepare('SELECT name FROM users WHERE id = ?').get(r.created_by)?.name || '';
  tx(db, () => {
    let dedId = null;
    if (status === 'approved') {
      assertOpen(db, r.date);
      dedId = Number(db.prepare('INSERT INTO deductions (user_id, date, amount, category, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(r.user_id, r.date, r.amount, r.category, r.reason, user.id, Date.now()).lastInsertRowid);
      audit(db, user.id, 'deduction.add', r.user_id, { date: r.date, amount: r.amount, category: r.category, reason: r.reason, request: r.id });
      logChange(db, { actor: user, area: 'salary', action: 'اعتماد خصم مسجّل', target: r.user_id, ref: `${r.date} · سجّله ${recorder}`, before: 'بانتظار الاعتماد', after: `${r.amount} ر.س · ${DEDUCTION_LABELS[r.category]}`, reason: r.reason });
    }
    db.prepare('UPDATE deduction_requests SET status = ?, decided_by = ?, decided_at = ?, response = ?, deduction_id = ? WHERE id = ?')
      .run(status, user.id, Date.now(), response, dedId, r.id);
  });
  if (status === 'approved') {
    toUser(db, r.user_id, 'deduction', msg.deduction({ amount: r.amount, date: r.date, category: DEDUCTION_LABELS[r.category], reason: r.reason.slice(0, 200), link: link(db) }), `deduction_request_ok:${r.id}`);
  }
  toUser(db, r.created_by, 'deduction_request_status', msg.card({ icon: status === 'approved' ? '✅' : '⛔', title: status === 'approved' ? 'اعتُمد الخصم المسجّل' : 'رُفض الخصم المسجّل',
    fields: [['الموظف', db.prepare('SELECT name FROM users WHERE id = ?').get(r.user_id)?.name || ''], ['المبلغ', `${r.amount} ر.س`]], quote: response || undefined }), `deduction_request_status:${r.id}`);
  return { ok: true };
}

// ------------------------------------------------------------------ notes on employees
export function addNote(db, user, body) {
  if (!canRecord(user)) throw new HttpError(403, 'ليست لديك صلاحية رفع الملاحظات');
  const u = employee(db, body.user_id);
  if (u.id === user.id) throw new HttpError(403, 'ما تقدر ترفع ملاحظة على نفسك');
  const note = text(body.body, 1000);
  if (note.length < 3) throw new HttpError(400, 'اكتب الملاحظة');
  const id = Number(db.prepare('INSERT INTO employee_notes (user_id, body, created_by, created_at) VALUES (?, ?, ?, ?)').run(u.id, note, user.id, Date.now()).lastInsertRowid);
  audit(db, user.id, 'note.add', u.id, { id });
  toSupervisors(db, 'employee_note', msg.card({ manager: true, icon: '📝', title: `ملاحظة على ${u.name}`, fields: [['رفعها', user.name]], quote: note, link: link(db, '#/approvals') }),
    `employee_note:${id}`, { skip: user.id });
  return { ok: true, id };
}

export function listNotes(db, user, { userId = null } = {}) {
  const all = isSup(user);
  if (!all && !canRecord(user)) throw new HttpError(403, 'ليست لديك صلاحية');
  const args = [];
  const where = [];
  if (!all) { where.push('n.created_by = ?'); args.push(user.id); }
  if (userId) { where.push('n.user_id = ?'); args.push(Number(userId)); }
  return {
    notes: db.prepare(`SELECT n.*, u.name, c.name AS created_name FROM employee_notes n JOIN users u ON u.id = n.user_id LEFT JOIN users c ON c.id = n.created_by
                       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY n.id DESC LIMIT 200`).all(...args),
  };
}
