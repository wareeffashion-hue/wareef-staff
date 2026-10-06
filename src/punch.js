// Recording attendance punches and flagging signs of manipulation.
import { MIN } from './config.js';
import { HttpError } from './http.js';
import { localDate, at, isDate } from './time.js';
import { getSettings } from './settings.js';
import { audit } from './db.js';

export const NEXT = {
  none: ['in'],
  in: ['leave', 'out'],
  back: ['leave', 'out'],
  leave: ['back', 'out'],
  out: ['in'],
};

export const FLAG_LABELS = {
  ip_outside: 'بصمة من شبكة غير شبكة المحل',
  geo_outside: 'بصمة من خارج موقع العمل',
  geo_missing: 'بصمة بدون تحديد الموقع',
  shared_device: 'نفس الجهاز استُخدم لبصمة موظف آخر',
  new_device: 'بصمة من جهاز جديد',
  clock_skew: 'ساعة الجهاز مختلفة عن الوقت الفعلي',
  manager_entry: 'بصمة أدخلها المدير يدوياً',
  missing_out: 'لم يسجّل انصراف',
  no_return: 'خرج خروجاً مؤقتاً ولم يسجّل عودة',
  long_exit: 'خروج مؤقت أطول من المسموح',
  duplicate_in: 'تسجيل حضور مكرر',
};

export function lastPunch(db, userId, date) {
  return db.prepare('SELECT * FROM punches WHERE user_id = ? AND date = ? AND voided = 0 ORDER BY ts DESC LIMIT 1').get(userId, date) || null;
}

/** Metres between two coordinates. */
export function distance(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ipAllowed = (ip, list) => list.some((rule) => (rule.endsWith('.') || rule.endsWith(':') ? ip.startsWith(rule) : ip === rule));

export function recordPunch(db, user, body, { ip = '', device = '', userAgent = '', now = Date.now() } = {}) {
  const type = String(body.type || '');
  if (!['in', 'out', 'leave', 'back'].includes(type)) throw new HttpError(400, 'نوع البصمة غير معروف');
  const date = localDate(now);
  const last = lastPunch(db, user.id, date);
  const state = last ? last.type : 'none';
  if (!NEXT[state].includes(type)) {
    const msg = { in: 'سجّلت حضورك مسبقاً', out: 'سجّل حضورك أولاً', leave: 'لا يمكن الخروج المؤقت الآن', back: 'لم تسجّل خروجاً مؤقتاً' }[type];
    throw new HttpError(409, msg);
  }
  if (last && now - last.ts < MIN) throw new HttpError(429, 'انتظر دقيقة بين كل بصمة والتي بعدها');
  const note = String(body.note || '').trim().slice(0, 300);
  if (type === 'leave' && !note) throw new HttpError(400, 'اكتب سبب الخروج المؤقت');

  const { security } = getSettings(db);
  const lat = Number.isFinite(+body.lat) && body.lat !== null && body.lat !== '' ? +body.lat : null;
  const lng = Number.isFinite(+body.lng) && body.lng !== null && body.lng !== '' ? +body.lng : null;
  const accuracy = Number.isFinite(+body.accuracy) ? +body.accuracy : null;
  const hasGeo = lat !== null && lng !== null;
  if (security.require_geo && !hasGeo) throw new HttpError(400, 'فعّل تحديد الموقع في جوالك ثم أعد المحاولة');

  const flags = [];
  if (security.allowed_ips.length && !ipAllowed(ip, security.allowed_ips)) flags.push('ip_outside');
  if (security.geo) {
    if (!hasGeo) flags.push('geo_missing');
    else if (distance(security.geo, { lat, lng }) > security.geo.radius + Math.min(accuracy || 0, 100)) flags.push('geo_outside');
  }
  if (device) {
    const other = db.prepare('SELECT 1 FROM punches WHERE device = ? AND user_id != ? AND ts > ? LIMIT 1').get(device, user.id, now - 16 * 60 * MIN);
    if (other) flags.push('shared_device');
    const seen = db.prepare('SELECT 1 FROM punches WHERE device = ? AND user_id = ? LIMIT 1').get(device, user.id);
    const any = db.prepare('SELECT 1 FROM punches WHERE user_id = ? AND source = ? LIMIT 1').get(user.id, 'self');
    if (!seen && any) flags.push('new_device');
  }
  const clientTs = Number.isFinite(+body.client_ts) ? Math.round(+body.client_ts) : null;
  if (clientTs && Math.abs(clientTs - now) > security.max_clock_skew_minutes * MIN) flags.push('clock_skew');

  const r = db.prepare(`INSERT INTO punches (user_id, date, ts, type, note, source, created_by, ip, device, user_agent, lat, lng, accuracy, client_ts, flags, created_at)
                        VALUES (?, ?, ?, ?, ?, 'self', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, date, now, type, note, user.id, ip, device, String(userAgent).slice(0, 300), lat, lng, accuracy, clientTs, JSON.stringify(flags), now);
  return { id: Number(r.lastInsertRowid), date, ts: now, type, flags };
}

/** A manager adds a punch by hand (forgotten checkout, broken phone...). Always flagged and audited. */
export function managerPunch(db, manager, { user_id, date, time, type, note }) {
  const userId = Number(user_id);
  const target = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'employee'").get(userId);
  if (!target) throw new HttpError(404, 'الموظف غير موجود');
  if (!['in', 'out', 'leave', 'back'].includes(type)) throw new HttpError(400, 'نوع البصمة غير معروف');
  if (!isDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new HttpError(400, 'التاريخ أو الوقت غير صحيح');
  const reason = String(note || '').trim().slice(0, 300);
  if (!reason) throw new HttpError(400, 'اكتب سبب الإدخال اليدوي');
  const ts = at(date, time);
  if (ts > Date.now()) throw new HttpError(400, 'لا يمكن إدخال بصمة في وقت لم يأتِ بعد');
  const r = db.prepare(`INSERT INTO punches (user_id, date, ts, type, note, source, created_by, flags, created_at)
                        VALUES (?, ?, ?, ?, ?, 'manager', ?, ?, ?)`)
    .run(userId, date, ts, type, reason, manager.id, JSON.stringify(['manager_entry']), Date.now());
  audit(db, manager.id, 'punch.add', userId, { date, time, type, reason });
  return Number(r.lastInsertRowid);
}

export function voidPunch(db, manager, id, reason) {
  const p = db.prepare('SELECT * FROM punches WHERE id = ? AND voided = 0').get(Number(id));
  if (!p) throw new HttpError(404, 'البصمة غير موجودة');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw new HttpError(400, 'اكتب سبب إلغاء البصمة');
  db.prepare('UPDATE punches SET voided = 1 WHERE id = ?').run(p.id);
  audit(db, manager.id, 'punch.void', p.user_id, { id: p.id, date: p.date, ts: p.ts, type: p.type, reason: why });
}
