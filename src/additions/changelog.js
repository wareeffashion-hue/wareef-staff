// Change log: every edit to attendance, salary and returns, with who, when, the value before and
// after, and the reason. Existing edit routes call logChange(); the page lists and filters it.
import { HttpError } from '../http.js';
import { addDays, at, localDate } from '../time.js';
import { isFinance, isSup, needDate, text } from './util.js';

export const AREAS = { attendance: 'الحضور والانصراف', salary: 'الرواتب والخصومات', returns: 'الاسترجاع والمرتجعات' };

const show = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? Object.entries(v).filter(([, x]) => x !== '' && x !== null && x !== undefined).map(([k, x]) => `${k}: ${x}`).join(' · ') : String(v));

/**
 * @param {object} c
 * @param {object} c.actor   the user making the change
 * @param {'attendance'|'salary'|'returns'} c.area
 * @param {string} c.action  short Arabic label of what happened
 * @param {number|null} [c.target] employee the change is about
 * @param {string} [c.ref]   what was changed (e.g. "بصمة 07:02", "طلب 5521")
 * @param {*} [c.before]     value before (string or object)
 * @param {*} [c.after]      value after
 * @param {string} [c.reason]
 */
export function logChange(db, { actor, area, action, target = null, ref = '', before = '', after = '', reason = '' }) {
  if (!AREAS[area]) throw new Error(`unknown change area ${area}`);
  db.prepare(`INSERT INTO change_log (ts, actor_id, area, action, target_user_id, ref, before, after, reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Date.now(), actor?.id ?? null, area, text(action, 120), target || null, text(ref, 200), text(show(before), 600), text(show(after), 600), text(reason, 400) || 'بدون سبب');
}

/** Areas a user may read: salary for the owner and accounts; attendance and returns for supervisors too. */
export const areasFor = (user) => [
  ...(isSup(user) ? ['attendance', 'returns'] : []),
  ...(isFinance(user) ? ['salary'] : []),
  ...(user.role === 'admin' ? ['attendance', 'returns'] : []),
].filter((a, i, all) => all.indexOf(a) === i);

export function listChanges(db, user, { area = '', userId = null, from, to } = {}) {
  const allowed = areasFor(user);
  if (!allowed.length) throw new HttpError(403, 'ليست لديك صلاحية سجل التعديلات');
  if (area && !allowed.includes(area)) throw new HttpError(403, 'ليست لديك صلاحية هذا القسم');
  const f = needDate(from, addDays(localDate(), -30));
  const t = needDate(to, localDate());
  const areas = area ? [area] : allowed;
  const rows = db.prepare(`SELECT c.*, a.name AS actor_name, u.name AS target_name FROM change_log c
                           LEFT JOIN users a ON a.id = c.actor_id LEFT JOIN users u ON u.id = c.target_user_id
                           WHERE c.area IN (${areas.map(() => '?').join(',')}) AND c.ts >= ? AND c.ts < ?
                           ${userId ? 'AND c.target_user_id = ?' : ''} ORDER BY c.ts DESC LIMIT 1000`)
    .all(...areas, at(f, '00:00'), at(addDays(t, 1), '00:00'), ...(userId ? [userId] : []));
  return { changes: rows, areas: Object.fromEntries(allowed.map((a) => [a, AREAS[a]])), from: f, to: t };
}
