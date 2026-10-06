// Aggregations shared by the dashboard, the printable daily report and CSV exports.
import { loadAttendance, summarize } from './attendance.js';
import { getSettings } from './settings.js';
import { localTime, monthBounds } from './time.js';
import { FLAG_LABELS } from './punch.js';

const round2 = (n) => Math.round(n * 100) / 100;

export const STATUS_LABELS = {
  present: 'حاضر', late: 'متأخر', absent: 'غائب', partial: 'غياب جزئي', excused: 'معذور',
  off: 'إجازة أسبوعية', off_worked: 'عمل في يوم إجازة', holiday: 'إجازة رسمية',
  upcoming: 'لم يبدأ الدوام', not_arrived: 'لم يصل بعد',
};
export const PUNCH_LABELS = { in: 'حضور', out: 'انصراف', leave: 'خروج مؤقت', back: 'عودة' };
export const DEDUCTION_LABELS = { late: 'تأخير', absence: 'غياب', early: 'انصراف مبكر', exit: 'خروج أثناء الدوام', violation: 'مخالفة', damage: 'تلف أو نقص', other: 'أخرى' };
export const TICKET_KINDS = { achievement: 'إنجاز يومي', note: 'ملاحظة', issue: 'مشكلة', request: 'طلب' };
export const TICKET_STATUS = { open: 'مفتوحة', in_progress: 'قيد المعالجة', closed: 'مغلقة' };
export const STOCK_KINDS = { merchant_return: 'مرتجع تجار', new_goods: 'بضاعة جديدة' };
export const EXCUSE_KINDS = { leave: 'إجازة', sick: 'مرضية', holiday: 'إجازة رسمية', excused: 'عذر مقبول' };

export function opsRows(db, from, to) {
  const { channels } = getSettings(db);
  return db.prepare('SELECT * FROM daily_ops WHERE date BETWEEN ? AND ? ORDER BY date DESC').all(from, to).map((r) => {
    const ch = JSON.parse(r.channels || '{}');
    const orders = channels.reduce((t, c) => t + (Number(ch[c.key]?.count) || 0), 0);
    const amount = channels.reduce((t, c) => t + (Number(ch[c.key]?.amount) || 0), 0);
    return { ...r, channels: ch, totalOrders: orders, totalAmount: round2(amount) };
  });
}

export function stockRows(db, from, to) {
  return db.prepare(`SELECT s.*, u.name AS created_by_name FROM stock_moves s LEFT JOIN users u ON u.id = s.created_by
                     WHERE s.date BETWEEN ? AND ? ORDER BY s.date DESC, s.id DESC`).all(from, to);
}

export function ticketRows(db, { from, to, userId = null, status = null }) {
  const where = ['t.date BETWEEN ? AND ?'];
  const args = [from, to];
  if (userId) { where.push('t.user_id = ?'); args.push(userId); }
  if (status) { where.push('t.status = ?'); args.push(status); }
  return db.prepare(`SELECT t.*, u.name AS user_name, (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS replies
                     FROM tickets t JOIN users u ON u.id = t.user_id WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC`).all(...args);
}

export function deductionRows(db, from, to, userId = null) {
  return db.prepare(`SELECT d.*, u.name AS user_name FROM deductions d JOIN users u ON u.id = d.user_id
                     WHERE d.date BETWEEN ? AND ? ${userId ? 'AND d.user_id = ?' : ''} ORDER BY d.date DESC, d.id DESC`)
    .all(from, to, ...(userId ? [userId] : []));
}

export function debtRows(db, userId = null) {
  return db.prepare(`SELECT d.*, u.name AS user_name FROM debts d JOIN users u ON u.id = d.user_id
                     ${userId ? 'WHERE d.user_id = ?' : ''} ORDER BY d.date DESC, d.id DESC`).all(...(userId ? [userId] : []));
}

export function debtBalances(db) {
  return db.prepare(`SELECT u.id AS user_id, u.name,
                       COALESCE(SUM(CASE WHEN d.kind = 'loan' THEN d.amount END), 0) AS loans,
                       COALESCE(SUM(CASE WHEN d.kind = 'repayment' THEN d.amount END), 0) AS repaid
                     FROM users u LEFT JOIN debts d ON d.user_id = u.id
                     WHERE u.role = 'employee' GROUP BY u.id ORDER BY u.id`).all()
    .map((r) => ({ ...r, loans: round2(r.loans), repaid: round2(r.repaid), balance: round2(r.loans - r.repaid) }));
}

/** Month-end view per employee: attendance, deductions, salary repayments, net pay. */
export function payroll(db, month, now = Date.now()) {
  const { from, to } = monthBounds(month);
  const att = summarize(loadAttendance(db, { from, to, now }));
  const users = db.prepare("SELECT id, name, salary FROM users WHERE role = 'employee' AND active = 1 ORDER BY id").all();
  const ded = db.prepare('SELECT user_id, SUM(amount) s FROM deductions WHERE date BETWEEN ? AND ? GROUP BY user_id').all(from, to);
  const rep = db.prepare("SELECT user_id, SUM(amount) s FROM debts WHERE kind = 'repayment' AND from_salary = 1 AND date BETWEEN ? AND ? GROUP BY user_id").all(from, to);
  const bal = new Map(debtBalances(db).map((b) => [b.user_id, b.balance]));
  const dMap = new Map(ded.map((r) => [r.user_id, r.s]));
  const rMap = new Map(rep.map((r) => [r.user_id, r.s]));
  return users.map((u) => {
    const a = att.find((x) => x.userId === u.id) || {};
    const deductions = round2(dMap.get(u.id) || 0);
    const repayments = round2(rMap.get(u.id) || 0);
    return {
      userId: u.id, name: u.name, salary: u.salary,
      workDays: a.workDays || 0, presentDays: a.presentDays || 0, absentDays: a.absentDays || 0, lateDays: a.lateDays || 0,
      lateMinutes: a.lateMinutes || 0, earlyMinutes: a.earlyMinutes || 0, exitMinutes: a.exitMinutes || 0, overtimeMinutes: a.overtimeMinutes || 0,
      suggested: a.suggested || 0, deductions, repayments, debtBalance: bal.get(u.id) || 0,
      net: round2(u.salary - deductions - repayments),
    };
  });
}

/** Everything that happened on one day, for the dashboard and the daily report. */
export function dailyReport(db, date, now = Date.now()) {
  const attendance = loadAttendance(db, { from: date, to: date, now });
  const punches = db.prepare(`SELECT p.id, p.user_id, p.ts, p.type, p.note, p.source, p.flags, p.voided, p.ip, p.lat, p.lng, u.name AS user_name
                              FROM punches p JOIN users u ON u.id = p.user_id WHERE p.date = ? ORDER BY p.ts`).all(date)
    .map((p) => ({ ...p, flags: JSON.parse(p.flags) }));
  const settings = getSettings(db);
  return {
    date,
    attendance,
    punches,
    ops: opsRows(db, date, date)[0] || null,
    channels: settings.channels,
    stock: stockRows(db, date, date),
    tickets: ticketRows(db, { from: date, to: date }),
    deductions: deductionRows(db, date, date),
    debts: db.prepare('SELECT d.*, u.name AS user_name FROM debts d JOIN users u ON u.id = d.user_id WHERE d.date = ?').all(date),
  };
}

// ------------------------------------------------------------------ CSV
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Excel-friendly CSV (UTF-8 BOM so Arabic opens correctly). sections: [{title, head, rows}] */
export function toCsv(sections) {
  const lines = [];
  for (const [i, s] of sections.entries()) {
    if (i) lines.push('');
    if (s.title) lines.push(cell(s.title));
    lines.push(s.head.map(cell).join(','));
    for (const r of s.rows) lines.push(r.map(cell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const t = (ts) => (ts ? localTime(ts) : '');
const hm = (m) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '0');

export function attendanceSection(rows, title = 'الحضور والانصراف') {
  return {
    title,
    head: ['التاريخ', 'الموظف', 'الحالة', 'أول حضور', 'آخر انصراف', 'دقائق التأخير', 'انصراف مبكر (د)', 'خروج أثناء الدوام (د)', 'ساعات العمل', 'إضافي', 'الخصم المقترح', 'ملاحظات'],
    rows: rows.map((r) => [r.date, r.name, STATUS_LABELS[r.status] || r.status, t(r.firstIn), t(r.lastOut), r.lateMinutes, r.earlyMinutes, r.exitMinutes,
      hm(r.presentMinutes), hm(r.overtimeMinutes), r.suggested, r.flags.map((f) => FLAG_LABELS[f] || f).join(' / ')]),
  };
}

export function punchesSection(punches) {
  return {
    title: 'سجل البصمات',
    head: ['الوقت', 'الموظف', 'النوع', 'المصدر', 'ملاحظة', 'مؤشرات', 'ملغاة'],
    rows: punches.map((p) => [t(p.ts), p.user_name, PUNCH_LABELS[p.type], p.source === 'manager' ? 'المدير' : 'الموظف', p.note,
      p.flags.map((f) => FLAG_LABELS[f] || f).join(' / '), p.voided ? 'نعم' : '']),
  };
}

export function opsSection(rows, channels) {
  return {
    title: 'العمليات اليومية',
    head: ['التاريخ', ...channels.flatMap((c) => [`طلبات ${c.name}`, `مبلغ ${c.name}`]), 'إجمالي الطلبات', 'إجمالي المبالغ', 'الشحنات', 'المرتجعات', 'ملاحظات'],
    rows: rows.map((r) => [r.date, ...channels.flatMap((c) => [r.channels[c.key]?.count || 0, r.channels[c.key]?.amount || 0]), r.totalOrders, r.totalAmount, r.shipments, r.returns, r.notes]),
  };
}

export function stockSection(rows) {
  return {
    title: 'مرتجعات التجار والبضائع الجديدة',
    head: ['التاريخ', 'النوع', 'التاجر / المورد', 'الوصف', 'الكمية', 'القيمة', 'ملاحظة', 'سجّلها'],
    rows: rows.map((r) => [r.date, STOCK_KINDS[r.kind], r.party, r.description, r.quantity, r.value, r.note, r.created_by_name || '']),
  };
}

export function ticketsSection(rows) {
  return {
    title: 'الملاحظات والإنجازات',
    head: ['رقم', 'التاريخ', 'الموظف', 'النوع', 'العنوان', 'التفاصيل', 'الأولوية', 'الحالة'],
    rows: rows.map((r) => [r.id, r.date, r.user_name, TICKET_KINDS[r.kind], r.title, r.body, { low: 'منخفضة', normal: 'عادية', high: 'عالية' }[r.priority], TICKET_STATUS[r.status]]),
  };
}

export function deductionsSection(rows) {
  return {
    title: 'الخصومات',
    head: ['التاريخ', 'الموظف', 'السبب', 'المبلغ', 'التفاصيل'],
    rows: rows.map((r) => [r.date, r.user_name, DEDUCTION_LABELS[r.category], r.amount, r.reason]),
  };
}

export function debtsSection(rows) {
  return {
    title: 'السلف والمديونيات',
    head: ['التاريخ', 'الموظف', 'النوع', 'المبلغ', 'من الراتب', 'ملاحظة'],
    rows: rows.map((r) => [r.date, r.user_name, r.kind === 'loan' ? 'سلفة' : 'سداد', r.amount, r.kind === 'repayment' ? (r.from_salary ? 'نعم' : 'نقداً') : '', r.note]),
  };
}

export function payrollSection(rows, month) {
  return {
    title: `مسيّر شهر ${month}`,
    head: ['الموظف', 'الراتب', 'أيام العمل', 'أيام الحضور', 'أيام الغياب', 'أيام التأخير', 'دقائق التأخير', 'انصراف مبكر (د)', 'خروج أثناء الدوام (د)', 'الخصم المقترح', 'الخصومات المعتمدة', 'أقساط السلف', 'صافي الراتب', 'المتبقي من السلف'],
    rows: rows.map((r) => [r.name, r.salary, r.workDays, r.presentDays, r.absentDays, r.lateDays, r.lateMinutes, r.earlyMinutes, r.exitMinutes, r.suggested, r.deductions, r.repayments, r.net, r.debtBalance]),
  };
}
