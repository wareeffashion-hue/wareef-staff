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
export const STOCK_KINDS = { merchant_return: 'مرتجع للتاجر', new_goods: 'فاتورة بضاعة جديدة' };
export const REQUEST_KINDS = { release: 'طلب فسح لإرجاع منتجات', shortage: 'طلب نواقص' };
export const REQUEST_STATUS = { pending: 'بانتظار المدير', approved: 'تمت الموافقة', rejected: 'مرفوض', done: 'تم التنفيذ' };
export const EXCUSE_KINDS = { leave: 'إجازة', sick: 'مرضية', holiday: 'إجازة رسمية', excused: 'عذر مقبول' };

/** One row per day that has any operations data: channel orders plus every daily metric. */
export function opsRows(db, from, to) {
  const { channels } = getSettings(db);
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, channels: {}, notes: '', metrics: {}, totalOrders: 0, totalAmount: 0 });
    return days.get(date);
  };
  for (const r of db.prepare('SELECT * FROM daily_ops WHERE date BETWEEN ? AND ?').all(from, to)) {
    const d = day(r.date);
    d.channels = JSON.parse(r.channels || '{}');
    d.notes = r.notes;
    d.totalOrders = channels.reduce((t, c) => t + (Number(d.channels[c.key]?.count) || 0), 0);
    d.totalAmount = round2(channels.reduce((t, c) => t + (Number(d.channels[c.key]?.amount) || 0), 0));
  }
  for (const m of db.prepare(`SELECT m.*, u.name AS by_name FROM daily_metrics m LEFT JOIN users u ON u.id = m.updated_by
                              WHERE m.date BETWEEN ? AND ?`).all(from, to)) {
    day(m.date).metrics[m.key] = { value: m.value, note: m.note, by: m.by_name || '' };
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
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

export function requestRows(db, from, to) {
  return db.prepare(`SELECT q.*, u.name AS user_name FROM requests q JOIN users u ON u.id = q.user_id
                     WHERE q.date BETWEEN ? AND ? ORDER BY q.created_at DESC`).all(from, to);
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
    metrics: settings.metrics,
    stock: stockRows(db, date, date),
    requests: requestRows(db, date, date),
    tickets: ticketRows(db, { from: date, to: date }),
    deductions: deductionRows(db, date, date),
    debts: db.prepare('SELECT d.*, u.name AS user_name FROM debts d JOIN users u ON u.id = d.user_id WHERE d.date = ?').all(date),
    scans: db.prepare('SELECT s.*, u.name AS user_name FROM scans s LEFT JOIN users u ON u.id = s.user_id WHERE s.date = ? ORDER BY s.ts').all(date),
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

export function attendanceSection(rows, title = 'الحضور والانصراف', money = true) {
  return {
    title,
    head: ['التاريخ', 'الموظف', 'الحالة', 'أول حضور', 'آخر انصراف', 'دقائق التأخير', 'انصراف مبكر (د)', 'خروج أثناء الدوام (د)', 'ساعات العمل', 'إضافي', ...(money ? ['الخصم المقترح'] : []), 'ملاحظات'],
    rows: rows.map((r) => [r.date, r.name, STATUS_LABELS[r.status] || r.status, t(r.firstIn), t(r.lastOut), r.lateMinutes, r.earlyMinutes, r.exitMinutes,
      hm(r.presentMinutes), hm(r.overtimeMinutes), ...(money ? [r.suggested] : []), r.flags.map((f) => FLAG_LABELS[f] || f).join(' / ')]),
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

export function opsSection(rows, channels, metrics = []) {
  return {
    title: 'العمليات اليومية',
    head: ['التاريخ', ...channels.flatMap((c) => [`طلبات ${c.name}`, `مبلغ ${c.name}`]), 'إجمالي الطلبات', 'إجمالي المبالغ',
      ...metrics.flatMap((m) => (m.note ? [m.name, `ملاحظات: ${m.name}`] : [m.name])), 'ملاحظات اليوم'],
    rows: rows.map((r) => [r.date, ...channels.flatMap((c) => [r.channels[c.key]?.count || 0, r.channels[c.key]?.amount || 0]), r.totalOrders, r.totalAmount,
      ...metrics.flatMap((m) => (m.note ? [r.metrics[m.key]?.value ?? '', r.metrics[m.key]?.note || ''] : [r.metrics[m.key]?.value ?? ''])), r.notes]),
  };
}

export function stockSection(rows) {
  return {
    title: 'فواتير البضائع ومرتجعات التجار',
    head: ['التاريخ', 'النوع', 'التاجر', 'رقم الفاتورة', 'كود المنتج', 'الوصف', 'العدد', 'القيمة', 'ملاحظة', 'سجّلها', 'حالة المرتجع'],
    rows: rows.map((r) => [r.date, STOCK_KINDS[r.kind], r.party, r.invoice_no, r.sku, r.description, r.quantity, r.value, r.note, r.created_by_name || '',
      { ready: 'جاهز للإرسال', sent: 'أُرسل للتاجر', settled: 'تمت التسوية' }[r.status] || '']),
  };
}

export function requestsSection(rows) {
  return {
    title: 'طلبات الفسح والنواقص',
    head: ['رقم', 'التاريخ', 'الموظف', 'النوع', 'كود المنتج', 'العدد', 'السبب', 'الحالة', 'رد المدير'],
    rows: rows.map((r) => [r.id, r.date, r.user_name, REQUEST_KINDS[r.kind], r.sku, r.quantity, r.reason, REQUEST_STATUS[r.status], r.response]),
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

export function scansSection(rows) {
  return {
    title: 'المسح بالباركود',
    head: ['التاريخ', 'الوقت', 'النوع', 'الكود', 'بواسطة'],
    rows: rows.map((r) => [r.date, t(r.ts), r.kind === 'shipment' ? 'شحنة طالعة' : 'مرتجع من عميل', r.code, r.user_name || '']),
  };
}

export function payrollSection(rows, month) {
  return {
    title: `مسيّر شهر ${month}`,
    head: ['الموظف', 'الراتب', 'أيام العمل', 'أيام الحضور', 'أيام الغياب', 'أيام التأخير', 'دقائق التأخير', 'انصراف مبكر (د)', 'خروج أثناء الدوام (د)', 'الخصم المقترح', 'الخصومات المعتمدة', 'أقساط السلف', 'صافي الراتب', 'المتبقي من السلف'],
    rows: rows.map((r) => [r.name, r.salary, r.workDays, r.presentDays, r.absentDays, r.lateDays, r.lateMinutes, r.earlyMinutes, r.exitMinutes, r.suggested, r.deductions, r.repayments, r.net, r.debtBalance]),
  };
}
