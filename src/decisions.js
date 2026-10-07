// Manager decisions that can come from the web page or from a WhatsApp reply.
import { audit, tx } from './db.js';
import { HttpError } from './http.js';
import { addDays } from './time.js';
import { appLink, notifyEmployee, notifyUsersWithPerm } from './notify.js';
import * as msg from './messages.js';

/** Approve or reject a leave request. Approved days become excuses; approved permissions are read by the attendance engine. */
export function decideLeave(db, manager, id, status, response) {
  const q = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
  if (!q) throw new HttpError(404, 'الطلب غير موجود');
  if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'حالة غير معروفة');
  if (q.minutes && q.left_at) throw new HttpError(400, 'الموظف خرج فعلاً بهذا الإذن');
  const resp = response !== undefined ? String(response || '').trim().slice(0, 500) : q.response;
  const marker = `طلب إجازة #${q.id}`;
  tx(db, () => {
    db.prepare('UPDATE leave_requests SET status = ?, response = ?, handled_by = ?, updated_at = ? WHERE id = ?').run(status, resp, manager.id, Date.now(), q.id);
    db.prepare('DELETE FROM excuses WHERE note = ? AND user_id = ?').run(marker, q.user_id);
    if (status === 'approved' && q.kind !== 'permission') {
      for (let d = q.from_date; d <= q.to_date; d = addDays(d, 1)) {
        db.prepare('DELETE FROM excuses WHERE user_id = ? AND date = ?').run(q.user_id, d);
        db.prepare('INSERT INTO excuses (user_id, date, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(q.user_id, d, q.kind === 'sick' ? 'sick' : 'leave', marker, manager.id, Date.now());
      }
    }
    audit(db, manager.id, 'leave.decide', q.user_id, { id: q.id, status });
  });
  const next = { ...q, status, response: resp };
  if (status !== q.status) notifyEmployee(db, q.user_id, 'leave_status', q.minutes ? msg.exitDecision({ q: next, link: appLink(db) }) : msg.leaveDecision({ q: next, link: appLink(db) }));
  return { ok: true, leave: next };
}

export const REQUEST_STATES = ['pending', 'approved', 'rejected', 'done'];

/**
 * Change a release/shortage request. The employee who raised it hears about it, and so does
 * whoever handles stock and requests (Abdulmalik and Basem), so the warehouse can act at once.
 */
export function decideRequest(db, manager, id, status, response) {
  const q = db.prepare('SELECT q.*, u.name AS user_name FROM requests q JOIN users u ON u.id = q.user_id WHERE q.id = ?').get(id);
  if (!q) throw new HttpError(404, 'الطلب غير موجود');
  const next = REQUEST_STATES.includes(status) ? status : q.status;
  const resp = response !== undefined ? String(response || '').trim().slice(0, 1000) : q.response;
  db.prepare('UPDATE requests SET status = ?, response = ?, handled_by = ?, updated_at = ? WHERE id = ?').run(next, resp, manager.id, Date.now(), q.id);
  audit(db, manager.id, 'request.update', q.user_id, { id: q.id, status: next });
  if (next !== q.status) {
    const base = { id: q.id, kind: q.kind, sku: q.sku, qty: q.quantity, status: next, response: resp.slice(0, 300), link: appLink(db) };
    notifyEmployee(db, q.user_id, 'request_status', msg.requestStatus(base), `request:${q.id}:${next}:${q.user_id}`);
    for (const perm of ['stock', 'requests']) {
      notifyUsersWithPerm(db, perm, 'request_status', (uid) => (uid === q.user_id ? null : msg.requestStatus({ ...base, by: q.user_name })), `request:${q.id}:${next}`);
    }
  }
  return { ok: true, request: { ...q, status: next, response: resp } };
}
