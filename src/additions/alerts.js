// Who hears about what in the additions. Work alerts go out on WhatsApp and to the phone (push)
// whatever the "employee account" switch says, the same way exchange alerts do.
import { appLink, notifyManager, queue } from '../notify.js';
import * as msg from '../messages.js';
import { getSettings } from '../settings.js';

const phoneOf = (db, userId) => db.prepare('SELECT phone FROM users WHERE id = ? AND active = 1').get(userId)?.phone || '';

/** One employee: WhatsApp (if they have a number) and their phone notification. */
export function toUser(db, userId, kind, body, key = null) {
  if (!userId || !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) return false;
  return queue(db, { to: phoneOf(db, userId), userId, kind, body, key });
}

/** Supervisors (employees holding the "supervisor" permission). */
export const supervisorIds = (db) => db.prepare(`SELECT id FROM users WHERE role = 'employee' AND active = 1
  AND EXISTS (SELECT 1 FROM json_each(users.perms) WHERE value = 'supervisor')`).all().map((r) => r.id);

/** Users holding any of these permissions. */
export const idsWithPerms = (db, perms) => db.prepare(`SELECT DISTINCT u.id FROM users u, json_each(u.perms) p
  WHERE u.role = 'employee' AND u.active = 1 AND p.value IN (${perms.map(() => '?').join(',')})`).all(...perms).map((r) => r.id);

/** The owner (manager number + devices) and every supervisor. `skip` leaves someone out (e.g. who did it). */
export function toSupervisors(db, kind, body, key, { skip = null } = {}) {
  notifyManager(db, kind, body, key ? `${key}:mgr` : null);
  for (const id of supervisorIds(db)) if (id !== skip) toUser(db, id, kind, body, key ? `${key}:${id}` : null);
}

export const link = (db, hash = '') => {
  const base = appLink(db).replace(/\/$/, '');
  return base ? `${base}/${hash}` : undefined;
};

/** The employee's deduction notice; without the amount when the owner hides deductions from employees. */
export function deductionNotice(db, { amount, date, category, reason, link }) {
  if (!getSettings(db).hide_deductions) return msg.deduction({ amount, date, category, reason, link });
  return msg.card({ icon: '📄', title: 'إشعار خصم', lines: ['تم تسجيل خصم على حسابك.'], fields: [['التاريخ', date], ...(category ? [['البند', category]] : [])],
    quote: reason || undefined, steps: ['صافي راتبك في «سجلي»', 'لأي استفسار تواصل مع المدير'], link });
}

export { msg };
