import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config, DAY } from './config.js';
import { HttpError, parseCookies } from './http.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'ws_session';
export const DEVICE_COOKIE = 'ws_device';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split(':');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'كلمة المرور يجب أن تكون 6 أحرف أو أرقام على الأقل');
}

export function validUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new HttpError(400, 'اسم المستخدم بالأحرف الإنجليزية أو الأرقام، من 3 إلى 30 حرفاً');
  return u;
}

export function login(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
  // Hash anyway so response time doesn't reveal whether the username exists.
  const ok = user?.password_hash ? verifyPassword(String(password || ''), user.password_hash) : (hashPassword('x'), false);
  if (!ok) throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  return { token: createSession(db, user.id), user };
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), userId, Date.now() + SESSION_DAYS * DAY);
  return token;
}

const cookieTail = () => `; Path=/; HttpOnly; SameSite=Lax${config.secureCookies ? '; Secure' : ''}`;

export function sessionCookie(token, maxAgeSeconds = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}${cookieTail()}`;
}

/** A long-lived random id per browser, to spot one phone punching for several people. */
export function deviceId(req) {
  const existing = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing)) return { id: existing, cookie: null };
  const id = randomBytes(18).toString('base64url');
  return { id, cookie: `${DEVICE_COOKIE}=${id}; Max-Age=${5 * 365 * 86400}${cookieTail()}` };
}

export function logout(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function currentUser(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.perms, u.salary, u.periods, u.day_off, u.created_at
                          FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(tokenHash(token), Date.now());
  return row ? { ...row, perms: JSON.parse(row.perms || '[]') } : null;
}

/** Managers can do everything; employees only what their permissions list. */
export function can(user, perm) {
  return user.role === 'admin' || user.perms.includes(perm);
}

export function requirePerm(user, perm) {
  if (!can(user, perm)) throw new HttpError(403, 'ليست لديك صلاحية لهذا الإجراء');
}

/** The owner, or an employee holding the "supervisor" permission (no money, staff or settings). */
export function isManager(user) {
  return user.role === 'admin' || user.perms.includes('supervisor');
}

export function requireManager(user) {
  if (!isManager(user)) throw new HttpError(403, 'هذه الصفحة للمدير أو المشرف فقط');
}

export function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'هذه الصفحة للمدير فقط');
}

/** Anyone who records any part of the daily operations. */
export function requireOps(user) {
  if (user.role !== 'admin' && !user.perms.some((p) => p === 'orders' || p === 'stock' || p.startsWith('m:'))) {
    throw new HttpError(403, 'ليست لديك صلاحية تسجيل العمليات اليومية');
  }
}

const STAFF = [
  ['abdullah', 'عبدالله', ['m:shipments', 'm:returns_warehouse', 'm:orders_prepared']],
  ['basem', 'باسم', ['requests', 'm:late_orders', 'm:late_available', 'm:late_unavailable']],
  ['monther', 'منذر', ['m:pending_issues', 'm:pending_chats']],
  ['safwan', 'صفوان', ['m:daily_edits']],
  ['ali', 'علي', []],
  ['abdulmalik', 'عبدالملك', ['orders', 'stock', 'm:returns_system']],
];

/** First boot: the manager account plus the six employees (no passwords until the manager sets them). */
export function bootstrap(db) {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return null;
  const now = Date.now();
  const password = config.adminPassword || randomBytes(6).toString('base64url');
  db.prepare("INSERT INTO users (username, name, role, password_hash, created_at) VALUES (?, ?, 'admin', ?, ?)")
    .run(config.adminUsername, config.adminName, hashPassword(password), now);
  const ins = db.prepare("INSERT INTO users (username, name, role, perms, created_at) VALUES (?, ?, 'employee', ?, ?)");
  for (const [u, n, perms] of STAFF) ins.run(u, n, JSON.stringify(perms), now);
  return { username: config.adminUsername, password: config.adminPassword ? null : password };
}
