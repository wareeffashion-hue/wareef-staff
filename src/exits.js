// Exit permission: the employee asks to step out for N minutes, the manager approves or rejects
// (from the dashboard or by WhatsApp), the employee taps "out now" and "I'm back".
// It is a leave_requests row of kind 'permission' with minutes > 0; once approved the attendance
// engine treats its window as covered time, so the outing isn't counted as an exit.
import { MIN } from './config.js';
import { HttpError } from './http.js';
import { at, localDate, localTime } from './time.js';
import { appLink, notifyManager, queue } from './notify.js';
import * as msg from './messages.js';

const hhmm = (ts) => localTime(ts);

/** Today's exit request worth showing on the punch screen: pending, approved and not finished, or decided in the last hour. */
export function currentExit(db, userId, now = Date.now()) {
  const q = db.prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND kind = 'permission' AND minutes > 0 AND from_date = ?
                        ORDER BY id DESC LIMIT 1`).get(userId, localDate(now));
  if (!q) return null;
  if (q.status === 'pending' || (q.status === 'approved' && !q.back_at)) return q;
  return now - q.updated_at < 60 * MIN ? q : null;
}

export function requestExit(db, user, { minutes, reason }, now = Date.now()) {
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 5 || m > 240) throw new HttpError(400, 'حدّد مدة الخروج بين 5 و240 دقيقة');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw new HttpError(400, 'اكتب سبب الخروج');
  const open = currentExit(db, user.id, now);
  if (open && (open.status === 'pending' || (open.status === 'approved' && !open.back_at))) throw new HttpError(400, 'عندك طلب خروج مفتوح');
  const date = localDate(now);
  const id = Number(db.prepare(`INSERT INTO leave_requests (user_id, kind, from_date, to_date, from_time, to_time, reason, minutes, created_at, updated_at)
                                VALUES (?, 'permission', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, date, date, hhmm(now), hhmm(Math.min(now + m * MIN, at(date, '23:59'))), why, m, now, now).lastInsertRowid);
  const q = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
  notifyManager(db, 'exit_request', msg.mgrExitRequest({ q, name: user.name, time: hhmm(now) }));
  return q;
}

/** The employee steps out on an approved request: the approved window starts now. */
export function startExit(db, user, id, now = Date.now()) {
  const q = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND user_id = ? AND kind = 'permission' AND minutes > 0").get(Number(id), user.id);
  if (!q) throw new HttpError(404, 'طلب الخروج غير موجود');
  if (q.status !== 'approved') throw new HttpError(400, q.status === 'pending' ? 'طلبك بانتظار موافقة المدير' : 'طلب الخروج مرفوض');
  if (q.left_at) throw new HttpError(400, 'استخدمت هذا الإذن مسبقاً');
  if (q.from_date !== localDate(now)) throw new HttpError(400, 'هذا الإذن لليوم اللي طلبته فيه فقط. اطلب إذناً جديداً');
  // the window ends at midnight at the latest (a wrap past 00:00 would make it empty)
  db.prepare('UPDATE leave_requests SET left_at = ?, from_time = ?, to_time = ?, updated_at = ? WHERE id = ?')
    .run(now, hhmm(now), hhmm(Math.min(now + q.minutes * MIN, at(localDate(now), '23:59'))), now, q.id);
  return { ...q, left_at: now };
}

/** On "back": closes the open approved exit, if any. Returns the outing, or null. */
export function endExit(db, user, now = Date.now()) {
  const q = db.prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND kind = 'permission' AND minutes > 0 AND status = 'approved'
                        AND left_at IS NOT NULL AND back_at IS NULL AND from_date = ? ORDER BY id DESC LIMIT 1`).get(user.id, localDate(now));
  if (!q) return null;
  db.prepare('UPDATE leave_requests SET back_at = ?, updated_at = ? WHERE id = ?').run(now, now, q.id);
  const used = Math.max(0, Math.round((now - q.left_at) / MIN));
  return { q, used, over: Math.max(0, used - q.minutes) };
}

/** Once a minute: someone out past their approved minutes gets a nudge, and the manager hears about it. */
export function exitTick(db, now = Date.now()) {
  const rows = db.prepare(`SELECT l.*, u.name, u.phone FROM leave_requests l JOIN users u ON u.id = l.user_id
                           WHERE l.kind = 'permission' AND l.minutes > 0 AND l.status = 'approved' AND l.left_at IS NOT NULL AND l.back_at IS NULL
                           AND l.from_date = ?`).all(localDate(now));
  for (const q of rows) {
    const due = q.left_at + q.minutes * MIN;
    if (now < due + 2 * MIN) continue;
    const over = Math.round((now - due) / MIN);
    queue(db, { to: q.phone, userId: q.user_id, kind: 'exit_over', key: `exit_over:${q.id}:employee`, body: msg.exitOver({ name: q.name, minutes: q.minutes, back: hhmm(due), link: appLink(db) }) });
    notifyManager(db, 'exit_over', msg.mgrExitOver({ name: q.name, minutes: q.minutes, left: hhmm(q.left_at), over }), `exit_over:${q.id}`);
  }
}

