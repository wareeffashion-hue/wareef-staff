// Exchanges shipped ahead: customer service sends the replacement before the customer's piece comes back,
// and records the return shipment's tracking number. When the warehouse scans that return, it is matched here
// and customer service hears about it. Anything still out after DUE_DAYS days is flagged for follow-up.
import { audit } from './db.js';
import { HttpError } from './http.js';
import { DAY } from './config.js';
import { localDate, localTime } from './time.js';
import { appLink, normalizePhone, notifyActivity, notifyManager, queue } from './notify.js';
import * as msg from './messages.js';

export const EX_KINDS = { exchange: 'استبدال', refund: 'استرجاع' };
export const DUE_DAYS = 5;

/** Tracking numbers compare without spaces, dashes or case. */
export const normTrack = (s) => String(s ?? '').replace(/[\u0000-\u001f\s\-_]/g, '').toUpperCase();
const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const daysSince = (date, now) => Math.max(0, Math.round((Date.parse(`${localDate(now)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY));
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/** Work alerts for customer service: WhatsApp + phone notification, whatever the "employee account" switch says. */
function toStaff(db, userId, kind, body, key) {
  const u = db.prepare('SELECT phone FROM users WHERE id = ? AND active = 1').get(userId);
  if (!u) return false;
  return queue(db, { to: u.phone || '', userId, kind, body, key });
}

const SELECT = `SELECT e.*, c.name AS created_name, r.name AS received_name FROM exchanges e
  LEFT JOIN users c ON c.id = e.created_by LEFT JOIN users r ON r.id = e.received_by`;

function view(e, now) {
  const days = daysSince(e.date, now);
  return { ...e, days, overdue: !e.received_at && days >= DUE_DAYS, waited: e.received_at ? daysSince(e.date, e.received_at) : null };
}

/** Mark received and tell the person who registered it (and the manager). */
function receive(db, e, scan, by, now) {
  db.prepare('UPDATE exchanges SET received_at = ?, received_scan_id = ?, received_by = ? WHERE id = ? AND received_at IS NULL')
    .run(scan?.ts ?? now, scan?.id ?? null, by?.id ?? null, e.id);
  const days = daysSince(e.date, scan?.ts ?? now);
  const info = { tracking: e.tracking, order: e.order_no, customer: e.customer, kind: EX_KINDS[e.kind], by: by?.name || '', days };
  if (e.created_by) toStaff(db, e.created_by, 'exchange_arrived', msg.exchangeArrived({ ...info, link: appLink(db) }), `exchange_arrived:${e.id}:${scan?.id ?? 'manual'}`);
  notifyActivity(db, 'exchange_arrived', msg.mgrExchangeArrived(info), `exchange_arrived:${e.id}:${scan?.id ?? 'manual'}:mgr`);
}

/** Customer service registers a return shipment it is waiting for. */
export function addExchange(db, user, body, now = Date.now()) {
  const tracking = normTrack(body.tracking);
  if (tracking.length < 4) throw new HttpError(400, 'اكتب رقم شحنة الإرجاع');
  if (tracking.length > 60) throw new HttpError(400, 'رقم الشحنة طويل جداً');
  const kind = EX_KINDS[body.kind] ? body.kind : 'exchange';
  const old = db.prepare(`${SELECT} WHERE e.tracking = ?`).get(tracking);
  if (old) throw new HttpError(409, `رقم الشحنة مسجّل مسبقاً يوم ${dm(old.date)}${old.created_name ? ` بواسطة ${old.created_name}` : ''}`);
  const row = {
    tracking, kind, order_no: text(body.order_no, 40), customer: text(body.customer, 80),
    phone: normalizePhone(body.phone) || text(body.phone, 20), note: text(body.note, 300),
  };
  const id = Number(db.prepare(`INSERT INTO exchanges (kind, tracking, order_no, customer, phone, note, created_by, created_at, date)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.kind, tracking, row.order_no, row.customer, row.phone, row.note, user.id, now, localDate(now)).lastInsertRowid);
  audit(db, user.id, 'exchange.add', null, { id, tracking });
  notifyActivity(db, 'exchange_new', msg.mgrExchangeNew({ name: user.name, kind: EX_KINDS[kind], tracking, order: row.order_no, customer: row.customer }));
  // the warehouse may have scanned it before it was registered
  const scan = db.prepare('SELECT s.*, u.name AS user_name FROM scans s LEFT JOIN users u ON u.id = s.user_id WHERE s.kind = ? ORDER BY s.ts DESC').all('return')
    .find((s) => normTrack(s.code) === tracking);
  const e = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(id);
  if (scan) receive(db, e, scan, scan.user_id ? { id: scan.user_id, name: scan.user_name } : null, now);
  return { ok: true, exchange: getExchange(db, id, now) };
}

export function getExchange(db, id, now = Date.now()) {
  const e = db.prepare(`${SELECT} WHERE e.id = ?`).get(Number(id));
  return e ? view(e, now) : null;
}

/** Called for every customer return scanned at the warehouse. Returns the matched exchange, if any. */
export function matchReturn(db, scan, user, now = Date.now()) {
  const tracking = normTrack(scan.code);
  const e = db.prepare('SELECT e.*, c.name AS created_name FROM exchanges e LEFT JOIN users c ON c.id = e.created_by WHERE e.tracking = ? AND e.received_at IS NULL').get(tracking);
  if (!e) return null;
  receive(db, e, scan, user, now);
  return e;
}

/** A deleted scan puts its exchange back to "not arrived". */
export function unmatchScan(db, scanId) {
  db.prepare('UPDATE exchanges SET received_at = NULL, received_scan_id = NULL, received_by = NULL WHERE received_scan_id = ?').run(scanId);
}

export function listExchanges(db, { status = 'open' } = {}, now = Date.now()) {
  const where = status === 'open' ? 'WHERE e.received_at IS NULL' : status === 'received' ? 'WHERE e.received_at IS NOT NULL' : '';
  const order = status === 'received' ? 'e.received_at DESC' : 'e.received_at IS NOT NULL, e.created_at ASC';
  const rows = db.prepare(`${SELECT} ${where} ORDER BY ${order} LIMIT 500`).all().map((e) => view(e, now));
  const c = db.prepare(`SELECT SUM(received_at IS NULL) open, SUM(received_at IS NULL AND date <= ?) overdue,
                        SUM(received_at IS NOT NULL AND received_at >= ?) received30 FROM exchanges`)
    .get(new Date(Date.parse(`${localDate(now)}T00:00:00Z`) - DUE_DAYS * DAY).toISOString().slice(0, 10), now - 30 * DAY);
  return { rows, counts: { open: c.open || 0, overdue: c.overdue || 0, received30: c.received30 || 0 }, dueDays: DUE_DAYS };
}

/** Follow-up note ("كلمت العميل..."), by whoever registered it or a manager. */
export function updateExchange(db, user, id, body, isManager) {
  const e = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(Number(id));
  if (!e) throw new HttpError(404, 'غير موجود');
  if (!isManager && e.created_by !== user.id && !user.perms.includes('exchanges')) throw new HttpError(403, 'ليست لديك صلاحية');
  const note = text(body.note, 300);
  db.prepare('UPDATE exchanges SET note = ? WHERE id = ?').run(note, e.id);
  audit(db, user.id, 'exchange.note', null, { id: e.id });
  return { ok: true, exchange: getExchange(db, e.id) };
}

/** The manager confirms a return that came back without a readable label. */
export function receiveManually(db, user, id, now = Date.now()) {
  const e = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(Number(id));
  if (!e) throw new HttpError(404, 'غير موجود');
  if (e.received_at) throw new HttpError(400, 'مسجّلة كواصلة مسبقاً');
  receive(db, e, null, user, now);
  audit(db, user.id, 'exchange.receive', null, { id: e.id });
  return { ok: true, exchange: getExchange(db, e.id, now) };
}

export function removeExchange(db, user, id, isManager) {
  const e = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(Number(id));
  if (!e) throw new HttpError(404, 'غير موجود');
  if (!isManager && e.created_by !== user.id) throw new HttpError(403, 'يحذفها اللي سجّلها أو المدير');
  if (e.received_at && !isManager) throw new HttpError(400, 'الشحنة وصلت، ما تنحذف');
  db.prepare('DELETE FROM exchanges WHERE id = ?').run(e.id);
  audit(db, user.id, 'exchange.delete', null, { id: e.id, tracking: e.tracking });
  return { ok: true };
}

/** Once a minute: a return still out after DUE_DAYS days → customer service follows up with the customer (once, from 9am). */
export function exchangeTick(db, now = Date.now()) {
  if (localTime(now) < '09:00') return 0;
  const cutoff = new Date(Date.parse(`${localDate(now)}T00:00:00Z`) - DUE_DAYS * DAY).toISOString().slice(0, 10);
  const rows = db.prepare(`${SELECT} WHERE e.received_at IS NULL AND e.due_notified_at IS NULL AND e.date <= ?`).all(cutoff);
  for (const e of rows) {
    db.prepare('UPDATE exchanges SET due_notified_at = ? WHERE id = ?').run(now, e.id);
    const info = { tracking: e.tracking, order: e.order_no, customer: e.customer, phone: e.phone, kind: EX_KINDS[e.kind], days: daysSince(e.date, now), date: dm(e.date) };
    if (e.created_by) toStaff(db, e.created_by, 'exchange_due', msg.exchangeDue({ ...info, link: appLink(db) }), `exchange_due:${e.id}`);
    notifyManager(db, 'exchange_due', msg.mgrExchangeDue({ ...info, name: e.created_name || '' }), `exchange_due:${e.id}:mgr`);
  }
  return rows.length;
}
