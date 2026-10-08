// Phone notifications (Web Push): the system's own alerts on the lock screen, with sound and vibration,
// even when the app is closed. Works on Android (Chrome) and on iPhone once added to the home screen.
// Keys are generated on first use and kept in the settings table; nothing to configure.
import webpush from 'web-push';
import { getSettings } from './settings.js';

let keys = null;
export function vapidKeys(db) {
  if (keys) return keys;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'push_vapid'").get();
  if (row) keys = JSON.parse(row.value);
  else {
    keys = webpush.generateVAPIDKeys();
    db.prepare("INSERT INTO settings (key, value) VALUES ('push_vapid', ?)").run(JSON.stringify(keys));
  }
  return keys;
}

export function saveSubscription(db, userId, sub, userAgent = '') {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('اشتراك غير صالح'), { status: 400 });
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, fails = 0`)
    .run(userId, endpoint, p256dh, auth, String(userAgent).slice(0, 200), Date.now());
  return db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
}
export const removeSubscription = (db, userId, endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || '')).changes;

// The WhatsApp card → a short notification: "⏰ منبّه الفترة الصباحية" + the first lines of the message.
export function cardToPush(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^━+$/.test(l) && !/^\*وريف · فريق العمل\*$/.test(l) && !/^_وريف · لوحة المدير_$/.test(l) && !/^✨ _/.test(l) && !/^🔗/.test(l));
  const strip = (l) => l.replace(/^(▫️|▸|>)\s*/, '').replace(/[*_]/g, '').trim();
  const title = strip(lines.shift() || 'وريف');
  const body = lines.map(strip).filter(Boolean).slice(0, 4).join('\n').slice(0, 240);
  return { title, body };
}

const URGENT = new Set(['alarm_start', 'alarm_break', 'alarm_end', 'remind_in', 'remind_out', 'exit_over', 'exit_request', 'leave_status']);
const ROUTE = { alarm_start: '#/today', alarm_break: '#/today', alarm_end: '#/today', remind_in: '#/today', remind_out: '#/today', exit_over: '#/today',
  leave_status: '#/leaves', request_status: '#/requests', ticket_reply: '#/tickets', deduction: '#/mine', debt_loan: '#/mine', debt_repayment: '#/mine',
  payslip: '#/mine', award: '#/mine', exchange_arrived: '#/exchanges', exchange_due: '#/exchanges', exit_request: '#/dashboard', leave_request: '#/leaves', request: '#/requests', ticket: '#/tickets', summary: '#/dashboard' };

let sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
export const setPushSender = (fn) => { sender = fn; };   // tests

/**
 * Send to one employee (userId) or to the managers (userId null). `key` makes it once-only, like the WhatsApp queue.
 * Never throws: a dead device is removed, anything else is logged.
 */
export function pushTo(db, { userId = null, kind, body, key = null }) {
  if (kind === 'otp' || kind === 'backup' || kind === 'test') return 0;
  if (getSettings(db).notify.push === false) return 0;
  if (key && db.prepare('INSERT OR IGNORE INTO push_sent (key, ts) VALUES (?, ?)').run(`push:${key}`, Date.now()).changes === 0) return 0;
  const subs = userId
    ? db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)
    : db.prepare("SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.role = 'admin' AND u.active = 1").all();
  if (!subs.length) return 0;
  const { title, body: text } = cardToPush(body);
  const urgent = URGENT.has(kind);
  const payload = JSON.stringify({ title, body: text, tag: key || `${kind}:${Date.now()}`, url: `/${ROUTE[kind] || ''}`, urgent });
  const k = vapidKeys(db);
  const app = getSettings(db).notify.app_url;
  const opts = { TTL: 6 * 3600, urgency: 'high', vapidDetails: { subject: /^https:\/\//.test(app) ? app : 'mailto:notifications@wareef.invalid', publicKey: k.publicKey, privateKey: k.privateKey } };
  for (const s of subs) {
    Promise.resolve()
      .then(() => sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts))
      .then(() => db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fails = 0 WHERE id = ?').run(Date.now(), s.id))
      .catch((e) => {
        if (e?.statusCode === 404 || e?.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else { db.prepare('UPDATE push_subscriptions SET fails = fails + 1 WHERE id = ?').run(s.id); console.error('push', e?.statusCode || '', e?.message); }
      });
  }
  // keep the once-only log short
  if (Math.random() < .02) db.prepare('DELETE FROM push_sent WHERE ts < ?').run(Date.now() - 3 * 86_400_000);
  return subs.length;
}
