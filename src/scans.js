// Barcode scanning: each scanned label is one shipment out or one customer return in.
// The scanner types the code and presses Enter, like a keyboard. A code counts once per kind.
// The day's count replaces the manual number ("الشحنات المرسلة" / "مرتجعات دخلت المستودع").
import { audit } from './db.js';
import { HttpError } from './http.js';
import { localDate, localTime } from './time.js';
import { matchReturn, unmatchScan } from './exchanges.js';

export const SCAN_KINDS = { shipment: 'شحنة طالعة', return: 'مرتجع من عميل' };
export const SCAN_METRIC = { shipment: 'shipments', return: 'returns_warehouse' };
const UNDO_MS = 10 * 60_000;
const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;

export function cleanCode(raw) {
  const code = String(raw ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  if (!code) throw new HttpError(400, 'ما وصل كود');
  if (code.length > 80) throw new HttpError(400, 'الكود طويل جداً');
  return code;
}

/** The metric for that day = the number of scans, recorded by whoever scanned last. */
export function syncMetric(db, date, kind, userId) {
  const n = db.prepare('SELECT COUNT(*) n FROM scans WHERE date = ? AND kind = ?').get(date, kind).n;
  const key = SCAN_METRIC[kind];
  if (!n) { db.prepare('DELETE FROM daily_metrics WHERE date = ? AND key = ?').run(date, key); return 0; }
  db.prepare(`INSERT INTO daily_metrics (date, key, value, note, updated_by, updated_at) VALUES (?, ?, ?, '', ?, ?)
              ON CONFLICT(date, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(date, key, n, userId, Date.now());
  return n;
}

export function addScan(db, user, { kind, code }, now = Date.now()) {
  if (!SCAN_KINDS[kind]) throw new HttpError(400, 'نوع المسح غير معروف');
  const c = cleanCode(code);
  const dup = db.prepare('SELECT s.*, u.name AS user_name FROM scans s LEFT JOIN users u ON u.id = s.user_id WHERE s.kind = ? AND s.code = ?').get(kind, c);
  if (dup) {
    throw Object.assign(new HttpError(409, `مسجّل مسبقاً يوم ${dm(dup.date)} الساعة ${localTime(dup.ts)}${dup.user_name ? ` بواسطة ${dup.user_name}` : ''}`), { dup: true });
  }
  const date = localDate(now);
  const id = Number(db.prepare('INSERT INTO scans (kind, code, date, ts, user_id) VALUES (?, ?, ?, ?, ?)').run(kind, c, date, now, user.id).lastInsertRowid);
  const count = syncMetric(db, date, kind, user.id);
  // a return of something we shipped (or the other way round) is worth knowing
  const other = db.prepare('SELECT date FROM scans WHERE kind = ? AND code = ?').get(kind === 'return' ? 'shipment' : 'return', c);
  let note = other ? (kind === 'return' ? `شُحن يوم ${dm(other.date)}` : `سبق تسجيله كمرتجع يوم ${dm(other.date)}`) : '';
  // a return customer service is waiting for (replacement already shipped)
  const ex = kind === 'return' ? matchReturn(db, { id, code: c, ts: now }, user, now) : null;
  if (ex) note = [`إرجاع ينتظره ${ex.created_name || 'خدمة العملاء'}${ex.order_no ? ` · طلب ${ex.order_no}` : ''} · وصله إشعار`, note].filter(Boolean).join(' · ');
  return { id, code: c, kind, date, ts: now, count, note, exchange: ex ? ex.id : null };
}

export function removeScan(db, user, id, isManager, now = Date.now()) {
  const s = db.prepare('SELECT * FROM scans WHERE id = ?').get(Number(id));
  if (!s) throw new HttpError(404, 'غير موجود');
  if (!isManager && (s.user_id !== user.id || now - s.ts > UNDO_MS)) throw new HttpError(403, 'تقدر تلغي مسحك خلال 10 دقائق فقط. للأقدم تواصل مع المدير');
  db.prepare('DELETE FROM scans WHERE id = ?').run(s.id);
  unmatchScan(db, s.id);
  audit(db, user.id, 'scan.delete', s.user_id, { kind: s.kind, code: s.code, date: s.date });
  return { ok: true, count: syncMetric(db, s.date, s.kind, user.id) };
}

export function scanList(db, date, kind = null) {
  return db.prepare(`SELECT s.id, s.kind, s.code, s.date, s.ts, s.user_id, u.name AS user_name FROM scans s LEFT JOIN users u ON u.id = s.user_id
                     WHERE s.date = ? ${kind ? 'AND s.kind = ?' : ''} ORDER BY s.ts DESC`).all(date, ...(kind ? [kind] : []));
}

/** { date: { shipment: n, return: n } } for a range. */
export function scanCounts(db, from, to) {
  const out = {};
  for (const r of db.prepare('SELECT date, kind, COUNT(*) n FROM scans WHERE date BETWEEN ? AND ? GROUP BY date, kind').all(from, to)) {
    (out[r.date] ||= {})[r.kind] = r.n;
  }
  return out;
}
