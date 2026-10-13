// Small helpers shared by the additions (kept here so the additions don't reach into server.js).
import { HttpError } from '../http.js';
import { isDate } from '../time.js';
import { isManager } from '../auth.js';

export const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);

export const num = (v, lo = 0, hi = 1e9) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'قيمة رقمية غير صحيحة');
  return Math.round(n * 100) / 100;
};

export const needDate = (v, fallback) => {
  const d = v || fallback;
  if (!isDate(d)) throw new HttpError(400, 'التاريخ غير صحيح');
  return d;
};

/** The owner or a supervisor. */
export const isSup = (user) => isManager(user);
export const requireSup = (user) => { if (!isSup(user)) throw new HttpError(403, 'هذه الصفحة للمشرف'); };

/** The owner or the accounts employee: money pages. */
export const isFinance = (user) => user.role === 'admin' || user.perms.includes('accountant');
export const requireFinance = (user) => { if (!isFinance(user)) throw new HttpError(403, 'هذه الصفحة للحسابات والمالية'); };

export const nameOf = (db, id) => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || '';

/** Active employees (and the owner) for pickers. */
export const people = (db) => db.prepare("SELECT id, name, role FROM users WHERE active = 1 ORDER BY role = 'admin' DESC, id").all();

/** HTML pages served by the additions carry the same protections as the app's own pages. */
export const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
