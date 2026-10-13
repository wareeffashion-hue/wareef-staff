// Verification selfie and "may have left" alerts (privacy-minded):
// - Taken only at the moment of a suspicious punch (new device, outside the work location or the
//   shop network). Nothing is tracked between punches and nothing outside working hours.
// - The photo goes to the supervisors on WhatsApp and stays in the system for 30 days, viewable by
//   the owner and supervisors only. Then it is deleted.
// - Supervisors hear right away when a punch looks like the employee is away from work, or when
//   someone steps out without permission.
import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { localTime } from '../time.js';
import { FLAG_LABELS } from '../punch.js';
import { waConnected, waSendImage } from '../wa.js';
import { getSettings } from '../settings.js';
import { link, msg, supervisorIds, toUser } from './alerts.js';
import { requireSup } from './util.js';

const KEEP_DAYS = 30;
const PUNCH = { in: 'حضور', out: 'انصراف', leave: 'خروج مؤقت', back: 'عودة' };
const dir = () => join(dirname(config.dbPath), 'uploads', 'selfies');

/** Check the photo sent with a punch: a JPEG/PNG/WebP data URL under ~1.5 MB. */
export function parseSelfie(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, 'صورة التحقق غير صالحة');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 2000) throw new HttpError(400, 'صورة التحقق غير واضحة، صوّر مرة ثانية');
  if (buf.length > 1_500_000) throw new HttpError(400, 'صورة التحقق كبيرة جداً');
  return { buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}

const phonesOfSupervisors = (db) => {
  const mgr = String(getSettings(db).notify.manager_phone || '');
  const list = supervisorIds(db).map((id) => db.prepare('SELECT phone FROM users WHERE id = ?').get(id)?.phone).filter(Boolean);
  return [...new Set([mgr, ...list].filter(Boolean))];
};

/** Keep the photo with the punch and send it to the supervisors (the WhatsApp photo is best-effort). */
export function saveSelfie(db, user, punch, selfie) {
  if (!selfie) return;
  mkdirSync(dir(), { recursive: true });
  const file = `${punch.id}.${selfie.ext}`;
  writeFileSync(join(dir(), file), selfie.buf);
  db.prepare('INSERT OR REPLACE INTO punch_selfies (punch_id, user_id, file, flags, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(punch.id, user.id, file, JSON.stringify(punch.flags), punch.ts);
  const reasons = punch.flags.filter((f) => FLAG_LABELS[f]).map((f) => FLAG_LABELS[f]);
  const caption = `📸 صورة تحقق: ${user.name}\n${PUNCH[punch.type] || punch.type} الساعة ${localTime(punch.ts)}\n${reasons.join('، ')}`;
  if (waConnected()) {
    (async () => {
      let ok = 0;
      for (const to of phonesOfSupervisors(db)) { try { await waSendImage(to, selfie.buf, caption); ok++; } catch (e) { console.error('selfie send', e.message); } }
      if (ok) db.prepare('UPDATE punch_selfies SET sent = 1 WHERE punch_id = ?').run(punch.id);
    })();
  }
}

/** Right after a punch: tell supervisors when it suggests the employee is away, or left without permission. */
export function suspicionAlert(db, user, punch, { permitted = false, selfie = false } = {}) {
  const away = punch.flags.filter((f) => f === 'geo_outside' || f === 'ip_outside');
  const leftNoPermit = punch.type === 'leave' && !permitted;
  if (!away.length && !leftNoPermit) return 0;
  const body = msg.card({ manager: true, icon: away.length ? '📍' : '🚪', title: away.length ? `اشتباه أن ${user.name} خارج موقع العمل` : `${user.name} خرج بدون إذن`,
    fields: [['البصمة', `${PUNCH[punch.type] || punch.type} ${localTime(punch.ts)}`], ...(away.length ? [['السبب', away.map((f) => FLAG_LABELS[f]).join('، ')]] : []),
      ...(selfie ? [['صورة التحقق', 'وصلت مع البصمة']] : [])],
    steps: [away.length ? 'تأكد منه بالاتصال أو راجع الصورة في «الحالات»' : 'الخروج بدون إذن يفتح حالة للمراجعة بعد رجوعه'], link: link(db, '#/cases') });
  let n = 0;
  for (const id of supervisorIds(db)) if (id !== user.id && toUser(db, id, 'suspect_away', body, `suspect:${punch.id}:${id}`)) n++;
  return n;
}

/** Recent photos for the supervisors' review page. */
export function listSelfies(db, user) {
  requireSup(user);
  return {
    selfies: db.prepare(`SELECT s.punch_id, s.user_id, s.flags, s.sent, s.created_at, u.name, p.type FROM punch_selfies s JOIN users u ON u.id = s.user_id
                         LEFT JOIN punches p ON p.id = s.punch_id WHERE s.created_at > ? ORDER BY s.created_at DESC LIMIT 200`).all(Date.now() - KEEP_DAYS * 86_400_000)
      .map((s) => ({ ...s, flags: JSON.parse(s.flags).filter((f) => FLAG_LABELS[f]).map((f) => FLAG_LABELS[f]) })),
    keepDays: KEEP_DAYS,
  };
}

export function selfieImage(db, user, punchId) {
  requireSup(user);
  const s = db.prepare('SELECT * FROM punch_selfies WHERE punch_id = ?').get(Number(punchId));
  if (!s || !existsSync(join(dir(), s.file))) throw new HttpError(404, 'الصورة غير موجودة أو انتهت مدة حفظها');
  return { buf: readFileSync(join(dir(), s.file)), type: s.file.endsWith('.png') ? 'image/png' : s.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
}

/** Once a day: photos older than 30 days are deleted. */
export function selfieRetentionTick(db, now = Date.now()) {
  if (localTime(now) !== '04:30') return 0;
  const old = db.prepare('SELECT punch_id, file FROM punch_selfies WHERE created_at < ?').all(now - KEEP_DAYS * 86_400_000);
  for (const s of old) {
    try { unlinkSync(join(dir(), s.file)); } catch { /* already gone */ }
    db.prepare('DELETE FROM punch_selfies WHERE punch_id = ?').run(s.punch_id);
  }
  return old.length;
}
