// Internal chat: one-to-one or group conversations between staff. Whoever starts a chat picks
// its members. The owner and supervisors can read every conversation; only members can write.
// New messages reach members' phones as notifications (not WhatsApp). Kept for 180 days.
import { HttpError } from '../http.js';
import { localTime } from '../time.js';
import { pushTo } from '../push.js';
import { msg } from './alerts.js';
import { isSup, text } from './util.js';

const KEEP_DAYS = 180;
const member = (db, chatId, userId) => !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);

function getChat(db, user, id, { write = false } = {}) {
  const c = db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'المحادثة غير موجودة');
  const mine = member(db, c.id, user.id);
  if (!mine && (write || !isSup(user))) throw new HttpError(403, 'لست عضواً في هذه المحادثة');
  return { ...c, mine };
}

const membersOf = (db, chatId) => db.prepare('SELECT u.id, u.name FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY u.name').all(chatId);

/** My conversations (and, for supervisors with ?all, everyone's) with the last message and my unread count. */
export function listChats(db, user, { all = false } = {}) {
  const everyone = all && isSup(user);
  const rows = db.prepare(`SELECT c.*, m.last_read,
      (SELECT body FROM chat_messages x WHERE x.chat_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_body,
      (SELECT u.name FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id WHERE x.chat_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_by,
      (SELECT COUNT(*) FROM chat_messages x WHERE x.chat_id = c.id AND x.id > COALESCE(m.last_read, 0) AND x.user_id IS NOT ?) AS unread
    FROM chats c LEFT JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
    ${everyone ? '' : 'WHERE m.user_id IS NOT NULL'} ORDER BY c.last_at DESC LIMIT 200`).all(user.id, user.id);
  return {
    chats: rows.map((c) => {
      const members = membersOf(db, c.id);
      const others = members.filter((m) => m.id !== user.id);
      return {
        id: c.id, is_group: !!c.is_group, mine: c.last_read !== null,
        title: c.title || (c.is_group ? members.map((m) => m.name).join('، ') : others.map((m) => m.name).join('، ') || 'محادثة'),
        members, last_body: c.last_body || '', last_by: c.last_by || '', last_at: c.last_at, unread: c.last_read === null ? 0 : c.unread,
      };
    }),
  };
}

export const unreadTotal = (db, user) => db.prepare(`SELECT COUNT(*) n FROM chat_messages x JOIN chat_members m ON m.chat_id = x.chat_id AND m.user_id = ?
  WHERE x.id > m.last_read AND x.user_id IS NOT ?`).get(user.id, user.id).n;

export const chatPeople = (db, user) => ({
  people: db.prepare('SELECT id, name FROM users WHERE active = 1 AND id != ? ORDER BY role = \'admin\' DESC, name').all(user.id),
});

/** Start a chat. One other person and no title: reuse the existing one-to-one chat. */
export function startChat(db, user, body) {
  const ids = [...new Set((Array.isArray(body.user_ids) ? body.user_ids : []).map(Number))]
    .filter((id) => id !== user.id && db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(id));
  if (!ids.length) throw new HttpError(400, 'اختر شخصاً واحداً على الأقل');
  const title = text(body.title, 60);
  if (ids.length === 1 && !title) {
    const existing = db.prepare(`SELECT c.id FROM chats c WHERE c.is_group = 0
      AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?)
      AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?)
      AND (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) = 2`).get(user.id, ids[0]);
    if (existing) return { ok: true, id: existing.id, existing: true };
  }
  const now = Date.now();
  const id = Number(db.prepare('INSERT INTO chats (title, is_group, created_by, created_at, last_at) VALUES (?, ?, ?, ?, ?)')
    .run(title, ids.length > 1 || title ? 1 : 0, user.id, now, now).lastInsertRowid);
  const add = db.prepare('INSERT INTO chat_members (chat_id, user_id, last_read) VALUES (?, ?, 0)');
  for (const uid of [user.id, ...ids]) add.run(id, uid);
  return { ok: true, id };
}

export function chatMessages(db, user, id, { after = 0 } = {}) {
  const c = getChat(db, user, id);
  const rows = db.prepare(`SELECT * FROM (SELECT x.id, x.user_id, x.body, x.ts, u.name FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id
                           WHERE x.chat_id = ? AND x.id > ? ORDER BY x.id DESC LIMIT 200) ORDER BY id`).all(c.id, Number(after) || 0);
  if (c.mine && rows.length) db.prepare('UPDATE chat_members SET last_read = MAX(last_read, ?) WHERE chat_id = ? AND user_id = ?').run(rows[rows.length - 1].id, c.id, user.id);
  return { chat: { id: c.id, title: c.title, is_group: !!c.is_group, mine: c.mine, members: membersOf(db, c.id) }, messages: rows };
}

export function sendMessage(db, user, id, body) {
  const c = getChat(db, user, id, { write: true });
  const message = text(body.body, 2000);
  if (!message) throw new HttpError(400, 'اكتب الرسالة');
  const now = Date.now();
  const mid = Number(db.prepare('INSERT INTO chat_messages (chat_id, user_id, body, ts) VALUES (?, ?, ?, ?)').run(c.id, user.id, message, now).lastInsertRowid);
  db.prepare('UPDATE chats SET last_at = ? WHERE id = ?').run(now, c.id);
  db.prepare('UPDATE chat_members SET last_read = ? WHERE chat_id = ? AND user_id = ?').run(mid, c.id, user.id);
  // a notification on the others' phones, at most one per chat every two minutes
  const bucket = Math.floor(now / 120_000);
  for (const m of membersOf(db, c.id)) {
    if (m.id === user.id) continue;
    try {
      pushTo(db, { userId: m.id, kind: 'chat', key: `chat:${c.id}:${m.id}:${bucket}`,
        body: msg.card({ icon: '💬', title: c.is_group && c.title ? `${user.name} · ${c.title}` : user.name, lines: [message.slice(0, 160)] }) });
    } catch { /* a notification failure never blocks the message */ }
  }
  return { ok: true, message: { id: mid, user_id: user.id, body: message, ts: now, name: user.name, time: localTime(now) } };
}

/** Once a day: messages older than 180 days go, then chats left empty. */
export function chatRetentionTick(db, now = Date.now()) {
  if (localTime(now) !== '04:20') return 0;
  const r = db.prepare('DELETE FROM chat_messages WHERE ts < ?').run(now - KEEP_DAYS * 86_400_000);
  db.prepare('DELETE FROM chats WHERE last_at < ? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE chat_id = chats.id)').run(now - KEEP_DAYS * 86_400_000);
  return r.changes;
}
