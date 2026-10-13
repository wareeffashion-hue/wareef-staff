// Custom WhatsApp messages from a supervisor to chosen employees (or everyone).
import { HttpError } from '../http.js';
import { audit } from '../db.js';
import { link, msg, toUser } from './alerts.js';
import { requireSup, text } from './util.js';

const STATUS = { pending: 'بالانتظار', sent: 'وصلت', failed: 'تعثّرت', skipped: 'لم تُرسل' };

export function sendBroadcast(db, user, body) {
  requireSup(user);
  const message = text(body.body, 1500);
  if (message.length < 2) throw new HttpError(400, 'اكتب نص الرسالة');
  const all = body.user_ids === 'all';
  const ids = all
    ? db.prepare("SELECT id FROM users WHERE role = 'employee' AND active = 1").all().map((r) => r.id)
    : [...new Set((Array.isArray(body.user_ids) ? body.user_ids : []).map(Number))].filter((id) => db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee' AND active = 1").get(id));
  if (!ids.length) throw new HttpError(400, 'اختر موظفاً واحداً على الأقل');
  const id = Number(db.prepare('INSERT INTO broadcasts (created_by, created_at, body, recipients) VALUES (?, ?, ?, ?)')
    .run(user.id, Date.now(), message, JSON.stringify(ids)).lastInsertRowid);
  let queued = 0;
  const noPhone = [];
  for (const uid of ids) {
    const u = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(uid);
    if (!u.phone) noPhone.push(u.name);
    const card = msg.card({ icon: '📣', title: text(body.title, 80) || 'رسالة من الإدارة', hello: `${u.name}،`, lines: message.split('\n'), link: link(db) });
    if (toUser(db, uid, 'custom', card, `custom:${id}:${uid}`)) queued++;
  }
  db.prepare('UPDATE broadcasts SET queued = ? WHERE id = ?').run(queued, id);
  audit(db, user.id, 'broadcast.send', null, { id, recipients: ids.length });
  return { ok: true, id, recipients: ids.length, queued, noPhone };
}

/** Recent messages with each recipient's delivery state (from the WhatsApp queue). */
export function listBroadcasts(db, user) {
  requireSup(user);
  const rows = db.prepare(`SELECT b.*, u.name AS by_name FROM broadcasts b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 30`).all();
  return {
    broadcasts: rows.map((b) => ({
      ...b,
      recipients: JSON.parse(b.recipients).map((uid) => {
        const n = db.prepare('SELECT status, error FROM notifications WHERE dedupe_key = ?').get(`custom:${b.id}:${uid}`);
        const u = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(uid) || {};
        return { id: uid, name: u.name || '', status: n ? n.status : (u.phone ? 'pending' : 'no_phone'), label: n ? STATUS[n.status] : (u.phone ? STATUS.pending : 'بدون رقم'), error: n?.error || '' };
      }),
    })),
  };
}
