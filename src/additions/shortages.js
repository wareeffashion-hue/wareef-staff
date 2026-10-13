// Products out of stock: code, quantity, optional photo, priority, who handles it and when it is
// expected. Supplied in full or in parts. A daily WhatsApp reminder lists what is still open,
// until someone presses «تم توفير الطلب». Supervisors, the warehouse and anyone given the
// reminder permission hear about it.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { audit } from '../db.js';
import { HttpError } from '../http.js';
import { localDate, localTime } from '../time.js';
import { idsWithPerms, link, msg, supervisorIds, toUser } from './alerts.js';
import { notifyManager } from '../notify.js';
import { isSup, needDate, num, text } from './util.js';

export const PRIORITY = { urgent: 'عاجل', high: 'مرتفع', normal: 'عادي', low: 'منخفض' };
export const STATUS = { open: 'غير متوفر', partial: 'متوفر جزئياً', done: 'تم التوفير', cancelled: 'ملغي' };
const REMIND_AT = '10:00';
const imgDir = () => join(dirname(config.dbPath), 'uploads', 'shortages');

export const canManage = (user) => isSup(user) || user.perms.includes('shortages');
export const canView = (user) => canManage(user) || user.perms.includes('stock') || user.perms.includes('shortages_notify');
const requireManage = (user) => { if (!canManage(user)) throw new HttpError(403, 'ليست لديك صلاحية إدارة النواقص'); };
const requireView = (user) => { if (!canView(user)) throw new HttpError(403, 'ليست لديك صلاحية النواقص'); };

/** Everyone who follows shortages: supervisors, the warehouse, the shortages people and anyone given the reminder permission. */
const followers = (db) => [...new Set([...supervisorIds(db), ...idsWithPerms(db, ['stock', 'shortages', 'shortages_notify'])])];

function tell(db, kind, body, key, { skip = null } = {}) {
  notifyManager(db, kind, body, key ? `${key}:mgr` : null);
  for (const id of followers(db)) if (id !== skip) toUser(db, id, kind, body, key ? `${key}:${id}` : null);
}

function saveImage(id, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'صيغة الصورة غير مدعومة');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3_000_000) throw new HttpError(400, 'الصورة كبيرة جداً');
  mkdirSync(imgDir(), { recursive: true });
  const file = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  writeFileSync(join(imgDir(), file), buf);
  return file;
}

const row = (db, id) => {
  const s = db.prepare(`SELECT s.*, a.name AS assignee_name, c.name AS created_name, d.name AS done_name FROM shortages s
    LEFT JOIN users a ON a.id = s.assignee_id LEFT JOIN users c ON c.id = s.created_by LEFT JOIN users d ON d.id = s.done_by WHERE s.id = ?`).get(Number(id));
  if (!s) throw new HttpError(404, 'الطلب غير موجود');
  return s;
};
const event = (db, id, user, kind, qty = 0, note = '') => db.prepare('INSERT INTO shortage_events (shortage_id, ts, user_id, kind, qty, note) VALUES (?, ?, ?, ?, ?, ?)')
  .run(id, Date.now(), user?.id ?? null, kind, qty, text(note, 300));
const remaining = (s) => Math.max(0, s.qty - s.qty_done);
const line = (s) => `${s.sku}${s.name ? ` (${s.name})` : ''} · ${remaining(s)} من ${s.qty}${s.priority === 'urgent' || s.priority === 'high' ? ` · ${PRIORITY[s.priority]}` : ''}`;

export function listShortages(db, user, { status = 'active' } = {}) {
  requireView(user);
  const where = status === 'active' ? "WHERE s.status IN ('open', 'partial')" : status === 'done' ? "WHERE s.status IN ('done', 'cancelled')" : '';
  const rows = db.prepare(`SELECT s.*, a.name AS assignee_name, c.name AS created_name, d.name AS done_name FROM shortages s
    LEFT JOIN users a ON a.id = s.assignee_id LEFT JOIN users c ON c.id = s.created_by LEFT JOIN users d ON d.id = s.done_by ${where}
    ORDER BY CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, s.due_date IS NULL, s.due_date, s.id DESC LIMIT 500`).all();
  const today = localDate();
  const counts = db.prepare("SELECT SUM(status IN ('open','partial')) active, SUM(status = 'partial') partial, SUM(status IN ('open','partial') AND due_date < ?) late FROM shortages").get(today);
  return {
    shortages: rows.map((s) => ({ ...s, remaining: remaining(s), late: (s.status === 'open' || s.status === 'partial') && !!s.due_date && s.due_date < today,
      events: db.prepare('SELECT e.*, u.name FROM shortage_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.shortage_id = ? ORDER BY e.ts DESC LIMIT 20').all(s.id) })),
    counts: { active: counts.active || 0, partial: counts.partial || 0, late: counts.late || 0 },
    canManage: canManage(user),
    people: canManage(user) ? db.prepare('SELECT id, name FROM users WHERE active = 1 AND role = \'employee\' ORDER BY name').all() : [],
  };
}

function fields(db, body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'sku' in body) { out.sku = text(body.sku, 60); if (!out.sku) throw new HttpError(400, 'اكتب كود المنتج'); }
  if (!partial || 'name' in body) out.name = text(body.name, 120);
  if (!partial || 'qty' in body) out.qty = Math.round(num(body.qty || 1, 1, 100000));
  if (!partial || 'priority' in body) out.priority = PRIORITY[body.priority] ? body.priority : 'normal';
  if (!partial || 'assignee_id' in body) {
    const a = Number(body.assignee_id) || null;
    if (a && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(a)) throw new HttpError(400, 'المسؤول غير موجود');
    out.assignee_id = a;
  }
  if (!partial || 'due_date' in body) out.due_date = body.due_date ? needDate(body.due_date) : null;
  if (!partial || 'note' in body) out.note = text(body.note, 500);
  return out;
}

export function addShortage(db, user, body) {
  requireManage(user);
  const f = fields(db, body);
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO shortages (sku, name, qty, priority, assignee_id, due_date, note, created_by, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(f.sku, f.name, f.qty, f.priority, f.assignee_id, f.due_date, f.note, user.id, now, now).lastInsertRowid);
  if (body.image) db.prepare('UPDATE shortages SET image = ? WHERE id = ?').run(saveImage(id, body.image), id);
  event(db, id, user, 'create', f.qty, f.note);
  audit(db, user.id, 'shortage.add', null, { id, sku: f.sku, qty: f.qty });
  const s = row(db, id);
  tell(db, 'shortage_new', msg.card({ icon: '📦', title: `منتج غير متوفر${s.priority === 'urgent' ? ' · عاجل' : ''}`,
    fields: [['الكود', s.sku], ...(s.name ? [['المنتج', s.name]] : []), ['الكمية', String(s.qty)], ['الأولوية', PRIORITY[s.priority]],
      ...(s.assignee_name ? [['المسؤول', s.assignee_name]] : []), ...(s.due_date ? [['التوفير المتوقع', s.due_date]] : []), ['سجّله', user.name]],
    quote: s.note || undefined, link: link(db, '#/shortages') }), `shortage_new:${id}`, { skip: user.id });
  return { ok: true, id: s.id, shortage: s };
}

export function updateShortage(db, user, id, body) {
  requireManage(user);
  const s = row(db, id);
  if (s.status === 'done' || s.status === 'cancelled') throw new HttpError(400, 'الطلب مقفل');
  const f = fields(db, body, { partial: true });
  if ('qty' in f && f.qty < s.qty_done) throw new HttpError(400, 'الكمية أقل من الموفّر فعلاً');
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE shortages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), Date.now(), s.id);
  if (body.image) db.prepare('UPDATE shortages SET image = ? WHERE id = ?').run(saveImage(s.id, body.image), s.id);
  event(db, s.id, user, 'update', 0, keys.length ? `تعديل: ${keys.join('، ')}` : 'صورة');
  return { ok: true, shortage: row(db, s.id) };
}

/** Part (or all) of the quantity arrived. `all` = the «تم توفير الطلب» button. */
export function supplyShortage(db, user, id, body) {
  requireManage(user);
  const s = row(db, id);
  if (s.status === 'done' || s.status === 'cancelled') throw new HttpError(400, 'الطلب مقفل');
  const qty = body.all ? remaining(s) : Math.round(num(body.qty, 1, remaining(s)));
  const done = s.qty_done + qty;
  const finished = done >= s.qty;
  const now = Date.now();
  db.prepare('UPDATE shortages SET qty_done = ?, status = ?, updated_at = ?, done_at = ?, done_by = ? WHERE id = ?')
    .run(done, finished ? 'done' : 'partial', now, finished ? now : null, finished ? user.id : null, s.id);
  event(db, s.id, user, finished ? 'done' : 'partial', qty, body.note);
  const n = row(db, s.id);
  tell(db, finished ? 'shortage_done' : 'shortage_partial', msg.card({
    icon: finished ? '✅' : '🟡', title: finished ? 'تم توفير الطلب' : 'توفير جزئي',
    fields: [['الكود', n.sku], ...(n.name ? [['المنتج', n.name]] : []), ['تم توفير', `${qty}`], ['الإجمالي', `${n.qty_done} من ${n.qty}`], ['بواسطة', user.name]],
    quote: text(body.note, 200) || undefined, link: link(db, '#/shortages') }), `shortage_supply:${s.id}:${n.qty_done}`, { skip: user.id });
  return { ok: true, shortage: n };
}

export function cancelShortage(db, user, id, body) {
  requireManage(user);
  const s = row(db, id);
  if (s.status === 'done' || s.status === 'cancelled') throw new HttpError(400, 'الطلب مقفل');
  const why = text(body.reason, 300);
  if (!why) throw new HttpError(400, 'اكتب سبب الإلغاء');
  db.prepare("UPDATE shortages SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), s.id);
  event(db, s.id, user, 'cancel', 0, why);
  return { ok: true };
}

export function shortageImage(db, user, id) {
  requireView(user);
  const s = row(db, id);
  if (!s.image) throw new HttpError(404, 'لا توجد صورة');
  const file = join(imgDir(), s.image);
  if (!existsSync(file)) throw new HttpError(404, 'لا توجد صورة');
  return { buf: readFileSync(file), type: s.image.endsWith('.png') ? 'image/png' : s.image.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
}

/** Every morning at 10:00: everyone who follows shortages gets the list of what is still not supplied. */
let lastDaily = '';
export function shortageDailyTick(db, now = Date.now()) {
  if (localTime(now) < REMIND_AT) return 0;
  const date = localDate(now);
  if (lastDaily === date) return 0;
  lastDaily = date;
  const open = db.prepare(`SELECT * FROM shortages WHERE status IN ('open', 'partial')
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id`).all();
  if (!open.length) return 0;
  const late = open.filter((s) => s.due_date && s.due_date < date).length;
  const body = msg.card({ icon: '⏰', title: `منتجات غير متوفرة: ${open.length}`,
    lines: [late ? `منها *${late}* تجاوزت موعد التوفير.` : 'هذي الطلبات ما اكتملت للحين:', '', ...open.slice(0, 15).map((s) => `• ${line(s)}`), ...(open.length > 15 ? [`… و${open.length - 15} غيرها`] : [])],
    steps: ['تابع توفيرها، وأول ما تتوفر اضغط «تم توفير الطلب» في النظام', 'التذكير يتكرر يومياً لين تكتمل'], link: link(db, '#/shortages') });
  tell(db, 'shortage_daily', body, `shortage_daily:${date}`);
  return open.length;
}
