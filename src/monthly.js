// Month-level work: closing payroll, the monthly report, employee of the month, and what runs on the 1st.
import { audit } from './db.js';
import { HttpError } from './http.js';
import { getSettings } from './settings.js';
import { localDate, localTime, monthBounds } from './time.js';
import { opsRows, payroll } from './reports.js';
import { performance, prevMonth, scoreDetails } from './performance.js';
import { appLink, notifyEmployee, queue } from './notify.js';
import * as msg from './messages.js';

// ------------------------------------------------------------------ payroll close
export const closedMonth = (db, month) => db.prepare('SELECT p.*, u.name AS closed_by_name FROM payroll_closes p LEFT JOIN users u ON u.id = p.closed_by WHERE month = ?').get(month) || null;

/** Money entries (deductions, loans, repayments) of a closed month can't change. */
export function assertOpen(db, date) {
  if (closedMonth(db, String(date).slice(0, 7))) throw new HttpError(400, `مسيّر شهر ${String(date).slice(0, 7)} مقفل. افتحه من «الرواتب» أولاً`);
}

export function payrollFor(db, month, now = Date.now()) {
  const c = closedMonth(db, month);
  if (c) return { rows: JSON.parse(c.snapshot), closed: { at: c.closed_at, by: c.closed_by_name || '' } };
  return { rows: payroll(db, month, now), closed: null };
}

export function closeMonth(db, admin, month, { send = true, now = Date.now() } = {}) {
  if (localDate(now) < monthBounds(month).to) throw new HttpError(400, 'لا يمكن إقفال شهر قبل نهايته');
  if (closedMonth(db, month)) throw new HttpError(400, 'الشهر مقفل مسبقاً');
  const rows = payroll(db, month, now);
  db.prepare('INSERT INTO payroll_closes (month, snapshot, closed_by, closed_at) VALUES (?, ?, ?, ?)').run(month, JSON.stringify(rows), admin.id, now);
  audit(db, admin.id, 'payroll.close', null, { month });
  let sent = 0;
  if (send) sent = sendPayslips(db, month);
  return { ok: true, sent };
}

export function sendPayslips(db, month) {
  const c = closedMonth(db, month);
  if (!c) throw new HttpError(400, 'أقفل الشهر أولاً');
  const link = appLink(db);
  let sent = 0;
  for (const r of JSON.parse(c.snapshot)) {
    if (notifyEmployee(db, r.userId, 'payslip', msg.payslip({ name: r.name, month, r, link }), `payslip:${month}:${r.userId}:${c.closed_at}`)) sent++;
  }
  return sent;
}

export function reopenMonth(db, admin, month) {
  if (!closedMonth(db, month)) throw new HttpError(400, 'الشهر غير مقفل');
  db.prepare('DELETE FROM payroll_closes WHERE month = ?').run(month);
  audit(db, admin.id, 'payroll.reopen', null, { month });
  return { ok: true };
}

// ------------------------------------------------------------------ employee of the month
export const awardOf = (db, month) => {
  const a = db.prepare('SELECT a.*, u.name FROM awards a LEFT JOIN users u ON u.id = a.user_id WHERE a.month = ?').get(month);
  return a ? { ...a, details: a.details } : null;
};

/** Picks the top score (or the employee the manager chose) and tells the whole team. */
export function announceAward(db, month, { userId = null, now = Date.now() } = {}) {
  const perf = performance(db, month, now);
  const pick = userId ? perf.find((r) => r.userId === Number(userId)) : perf.find((r) => r.score !== null);
  if (!pick) throw new HttpError(400, 'لا توجد بيانات كافية لهذا الشهر');
  const details = scoreDetails(pick);
  db.prepare(`INSERT INTO awards (month, user_id, score, details, announced_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(month) DO UPDATE SET user_id = excluded.user_id, score = excluded.score, details = excluded.details, announced_at = excluded.announced_at`)
    .run(month, pick.userId, pick.score ?? 0, details, now);
  for (const u of db.prepare("SELECT id FROM users WHERE role = 'employee' AND active = 1").all()) {
    notifyEmployee(db, u.id, 'award', msg.award({ name: pick.name, month, score: pick.score ?? 0, isYou: u.id === pick.userId, details: u.id === pick.userId ? details : '' }), `award:${month}:${pick.userId}:${u.id}`);
  }
  return { ok: true, award: awardOf(db, month) };
}

// ------------------------------------------------------------------ monthly report
export function monthlyData(db, month, now = Date.now()) {
  const { from, to } = monthBounds(month);
  const s = getSettings(db);
  const ops = opsRows(db, from, to);
  const channels = s.channels.map((c) => ({
    ...c,
    count: ops.reduce((t, d) => t + (Number(d.channels[c.key]?.count) || 0), 0),
    amount: Math.round(ops.reduce((t, d) => t + (Number(d.channels[c.key]?.amount) || 0), 0)),
  }));
  const metrics = s.metrics.map((m) => ({
    ...m,
    total: ops.reduce((t, d) => t + (Number(d.metrics[m.key]?.value) || 0), 0),
    days: ops.filter((d) => d.metrics[m.key]).length,
  }));
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const stock = {
    invoices: one("SELECT COUNT(DISTINCT party || '|' || invoice_no || '|' || date) n, COALESCE(SUM(quantity), 0) q, COALESCE(SUM(value), 0) v FROM stock_moves WHERE kind = 'new_goods' AND date BETWEEN ? AND ?", from, to),
    returns: one("SELECT COUNT(*) n, COALESCE(SUM(quantity), 0) q, SUM(status = 'ready') ready, SUM(status = 'sent') sent, SUM(status = 'settled') settled FROM stock_moves WHERE kind = 'merchant_return' AND date BETWEEN ? AND ?", from, to),
  };
  const requests = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM requests WHERE date BETWEEN ? AND ? GROUP BY status').all(from, to).map((r) => [r.status, r.n]));
  const tickets = Object.fromEntries(db.prepare('SELECT kind, COUNT(*) n FROM tickets WHERE date BETWEEN ? AND ? GROUP BY kind').all(from, to).map((r) => [r.kind, r.n]));
  const leaves = Object.fromEntries(db.prepare("SELECT kind, COUNT(*) n FROM leave_requests WHERE status = 'approved' AND from_date BETWEEN ? AND ? GROUP BY kind").all(from, to).map((r) => [r.kind, r.n]));
  const pay = payrollFor(db, month, now);
  const perf = performance(db, month, now);
  return {
    month, from, to, channels, metrics, stock, requests, tickets, leaves,
    totalOrders: channels.reduce((t, c) => t + c.count, 0), totalAmount: channels.reduce((t, c) => t + c.amount, 0),
    payroll: pay.rows, closed: pay.closed, performance: perf, award: awardOf(db, month), days: ops.length,
  };
}

export function monthlySummary(db, month, now = Date.now()) {
  const d = monthlyData(db, month, now);
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const att = d.payroll.reduce((t, r) => ({ late: t.late + r.lateMinutes, absent: t.absent + r.absentDays, ded: t.ded + r.deductions, net: t.net + r.net }), { late: 0, absent: 0, ded: 0, net: 0 });
  const lines = ['*🛒 الطلبات*', `▫️ الإجمالي: *${num(d.totalOrders)} طلب* · *${num(d.totalAmount)} ر.س*`];
  for (const c of d.channels) if (c.count) lines.push(`   ${c.name}: ${num(c.count)}`);
  const ms = d.metrics.filter((m) => m.total);
  if (ms.length) lines.push('', '*📦 العمليات*', ...ms.map((m) => `▫️ ${m.name}: *${num(m.total)}*`));
  lines.push('', '*👥 الفريق*', `▫️ دقائق التأخير: *${num(att.late)}*`, `▫️ أيام الغياب: *${num(att.absent)}*`, `▫️ الخصومات: *${num(att.ded)} ر.س*`, `▫️ صافي الرواتب: *${num(Math.round(att.net))} ر.س*`);
  const top = d.performance.filter((r) => r.score !== null).slice(0, 3);
  if (top.length) lines.push('', '*🏆 الأعلى تقييماً*', ...top.map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${r.name}: *${r.score}*`));
  lines.push('', `▫️ الفسح والنواقص: ${num(Object.values(d.requests).reduce((a, b) => a + b, 0))} · التذاكر: ${num(Object.values(d.tickets).reduce((a, b) => a + b, 0))} · مرتجعات التجار: ${num(d.stock.returns.n)}`);
  const link = appLink(db);
  return msg.card({ manager: true, icon: '📅', title: `تقرير شهر ${msg.monthName(month)}`, lines, link: link ? `${link.replace(/\/$/, '')}/report/monthly?month=${month}` : undefined });
}

/** On the 1st of each month, from 09:00: last month's report to the manager and its employee of the month to everyone. */
export function monthlyTick(db, now = Date.now()) {
  const n = getSettings(db).notify;
  const today = localDate(now);
  if (!n.monthly_auto || today.slice(8) !== '01' || localTime(now) < '09:00') return;
  const month = prevMonth(today.slice(0, 7));
  if (n.manager_phone && n.alert_manager) queue(db, { to: n.manager_phone, kind: 'monthly', key: `monthly:${month}`, body: monthlySummary(db, month, now) });
  if (!awardOf(db, month)?.announced_at) {
    try { announceAward(db, month, { now }); } catch { /* no data that month */ }
  }
}
