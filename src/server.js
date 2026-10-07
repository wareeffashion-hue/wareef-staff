import { createServer } from 'node:http';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, DAY } from './config.js';
import { openDb, audit, tx } from './db.js';
import { HttpError, Router, clientIp, parseJson, rateLimiter, readBody, send } from './http.js';
import {
  bootstrap, can, currentUser, deviceId, hashPassword, login, logout, requireAdmin, requireOps, requirePerm,
  sessionCookie, validatePassword, validUsername, verifyPassword,
} from './auth.js';
import { getSettings, saveSettings, allPeriods, permissionList } from './settings.js';
import { localDate, isDate, addDays, monthBounds, localTime } from './time.js';
import { computeDay, loadAttendance, periodsFor, summarize } from './attendance.js';
import { FLAG_LABELS, NEXT, lastPunch, managerPunch, recordPunch, voidPunch } from './punch.js';
import {
  attendanceSection, dailyReport, debtBalances, debtRows, debtsSection, deductionRows, deductionsSection,
  opsRows, opsSection, payroll, payrollSection, punchesSection, requestRows, requestsSection, stockRows, stockSection, ticketRows, ticketsSection, toCsv,
} from './reports.js';
import { renderDailyReport } from './print.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
};

const num = (v, lo = 0, hi = 1e9) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'قيمة رقمية غير صحيحة');
  return Math.round(n * 100) / 100;
};
const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const needDate = (v, fallback) => {
  const d = v || fallback;
  if (!isDate(d)) throw new HttpError(400, 'التاريخ غير صحيح');
  return d;
};
const needMonth = (v) => {
  const m = v || localDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new HttpError(400, 'الشهر غير صحيح');
  return m;
};
const range = (url, days = 30) => {
  const to = needDate(url.searchParams.get('to'), localDate());
  const from = needDate(url.searchParams.get('from'), addDays(to, -(days - 1)));
  if (from > to) throw new HttpError(400, 'تاريخ البداية بعد تاريخ النهاية');
  return { from, to };
};
const csv = (res, name, sections) => send(res, 200, toCsv(sections), {
  'Content-Type': 'text/csv; charset=utf-8',
  'Content-Disposition': `attachment; filename="${name}.csv"`,
});

function userView(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, salary: u.salary,
    periods: u.periods ? JSON.parse(u.periods) : null, day_off: u.day_off, perms: JSON.parse(u.perms || '[]'),
    has_password: !!u.password_hash, created_at: u.created_at,
  };
}

function myToday(db, user, now = Date.now()) {
  const settings = getSettings(db);
  const date = localDate(now);
  const punches = db.prepare('SELECT id, ts, type, note, flags FROM punches WHERE user_id = ? AND date = ? AND voided = 0 ORDER BY ts').all(user.id, date)
    .map((p) => ({ ...p, flags: JSON.parse(p.flags) }));
  const holiday = !!db.prepare('SELECT 1 FROM excuses WHERE user_id IS NULL AND date = ?').get(date);
  const excuse = db.prepare('SELECT kind FROM excuses WHERE user_id = ? AND date = ?').get(user.id, date)?.kind || null;
  const day = computeDay({
    date, punches, periods: periodsFor(user, date, settings.schedule, holiday), excuse,
    grace: settings.grace_minutes, maxExit: settings.max_exit_minutes, salary: 0, now,
  });
  const last = lastPunch(db, user.id, date);
  return { now, date, day, punches, allowed: NEXT[last ? last.type : 'none'], geo: !!settings.security.geo, requireGeo: settings.security.require_geo };
}

export function createApp(db) {
  const r = new Router();
  const loginLimit = rateLimiter({ limit: 10, windowMs: 15 * 60_000 });

  // ------------------------------------------------------------ session
  r.post('/api/login', async ({ req, res }) => {
    if (!loginLimit(clientIp(req))) throw new HttpError(429, 'محاولات كثيرة. حاول بعد ربع ساعة');
    const body = parseJson(await readBody(req));
    const { token, user } = login(db, body.username, body.password);
    send(res, 200, { ok: true, role: user.role }, { 'Set-Cookie': sessionCookie(token) });
  });
  r.post('/api/logout', ({ req, res }) => {
    logout(db, req);
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  });
  r.get('/api/me', ({ user }) => {
    const s = getSettings(db);
    return {
      user: { id: user.id, name: user.name, username: user.username, role: user.role, perms: user.perms },
      today: localDate(), now: Date.now(), tzOffset: config.tzOffsetMinutes,
      channels: s.channels, metrics: s.metrics, periods: allPeriods(s.schedule),
    };
  }, { auth: true });
  r.post('/api/me/password', async ({ req, user }) => {
    const body = parseJson(await readBody(req));
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
    validatePassword(body.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), user.id);
    return { ok: true };
  }, { auth: true });

  // ------------------------------------------------------------ employee self-service
  r.get('/api/my/today', ({ user }) => myToday(db, user), { auth: true });
  r.post('/api/punch', async ({ req, res, user }) => {
    if (user.role !== 'employee') throw new HttpError(403, 'البصمة للموظفين فقط');
    const body = parseJson(await readBody(req));
    const dev = deviceId(req);
    recordPunch(db, user, body, { ip: clientIp(req), device: dev.id, userAgent: req.headers['user-agent'] || '' });
    send(res, 200, myToday(db, user), dev.cookie ? { 'Set-Cookie': dev.cookie } : {});
  }, { auth: true });
  r.get('/api/my/month', ({ url, user }) => {
    const month = needMonth(url.searchParams.get('month'));
    const { from, to } = monthBounds(month);
    const days = loadAttendance(db, { from, to, userId: user.id });
    const balance = debtBalances(db).find((b) => b.user_id === user.id);
    return {
      month, days: days.map(({ suggested, ...d }) => d), summary: summarize(days).map(({ suggested, ...s }) => s)[0] || null,
      deductions: deductionRows(db, from, to, user.id), debts: debtRows(db, user.id), balance: balance?.balance || 0,
    };
  }, { auth: true });

  // ------------------------------------------------------------ tickets
  r.get('/api/tickets', ({ url, user }) => {
    const { from, to } = range(url, 60);
    const userId = user.role === 'admin' ? (Number(url.searchParams.get('user_id')) || null) : user.id;
    const status = ['open', 'in_progress', 'closed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : null;
    return { tickets: ticketRows(db, { from, to, userId, status }) };
  }, { auth: true });
  r.post('/api/tickets', async ({ req, user }) => {
    const b = parseJson(await readBody(req));
    const kind = ['achievement', 'note', 'issue', 'request'].includes(b.kind) ? b.kind : 'note';
    const priority = ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal';
    const title = text(b.title, 140);
    if (!title) throw new HttpError(400, 'اكتب عنواناً للتذكرة');
    const now = Date.now();
    const res = db.prepare('INSERT INTO tickets (user_id, date, kind, title, body, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, localDate(now), kind, title, text(b.body, 4000), priority, now, now);
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  const ticketFor = (id, user) => {
    const t = db.prepare('SELECT t.*, u.name AS user_name FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(Number(id));
    if (!t || (user.role !== 'admin' && t.user_id !== user.id)) throw new HttpError(404, 'التذكرة غير موجودة');
    return t;
  };
  r.get('/api/tickets/:id', ({ params, user }) => {
    const t = ticketFor(params.id, user);
    const replies = db.prepare('SELECT r.*, u.name AS user_name, u.role FROM ticket_replies r LEFT JOIN users u ON u.id = r.user_id WHERE r.ticket_id = ? ORDER BY r.created_at').all(t.id);
    return { ticket: t, replies };
  }, { auth: true });
  r.post('/api/tickets/:id/replies', async ({ req, params, user }) => {
    const t = ticketFor(params.id, user);
    const body = text(parseJson(await readBody(req)).body, 4000);
    if (!body) throw new HttpError(400, 'اكتب الرد');
    const now = Date.now();
    db.prepare('INSERT INTO ticket_replies (ticket_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(t.id, user.id, body, now);
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, t.id);
    return { ok: true };
  }, { auth: true });
  r.put('/api/tickets/:id', async ({ req, params, user }) => {
    requireAdmin(user);
    const t = ticketFor(params.id, user);
    const status = parseJson(await readBody(req)).status;
    if (!['open', 'in_progress', 'closed'].includes(status)) throw new HttpError(400, 'حالة غير معروفة');
    db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), t.id);
    return { ok: true };
  }, { auth: true });

  // ------------------------------------------------------------ daily operations
  // Each part is gated by its own permission: channel orders ("orders"), invoices and merchant
  // returns ("stock"), and every daily number ("m:<key>").
  r.get('/api/ops', ({ url, user }) => {
    requireOps(user);
    const { from, to } = range(url, 31);
    const s = getSettings(db);
    return { ops: opsRows(db, from, to), stock: stockRows(db, from, to), channels: s.channels, metrics: s.metrics };
  }, { auth: true });
  r.put('/api/ops/:date', async ({ req, params, user }) => {
    requireOps(user);
    const date = needDate(params.date);
    if (date > localDate()) throw new HttpError(400, 'لا يمكن التسجيل لتاريخ لم يأتِ بعد');
    if (user.role !== 'admin' && date < addDays(localDate(), -3)) throw new HttpError(403, 'التعديل متاح لآخر 3 أيام فقط. تواصل مع المدير');
    const b = parseJson(await readBody(req));
    const { channels, metrics } = getSettings(db);
    const now = Date.now();
    tx(db, () => {
      if (b.channels !== undefined || b.notes !== undefined) {
        requirePerm(user, 'orders');
        const prev = db.prepare('SELECT * FROM daily_ops WHERE date = ?').get(date);
        const ch = prev ? JSON.parse(prev.channels) : {};
        if (b.channels) {
          for (const c of channels) {
            const v = b.channels[c.key];
            if (v) ch[c.key] = { count: Math.round(num(v.count || 0, 0, 100000)), amount: num(v.amount || 0, 0, 1e8) };
          }
        }
        const notes = b.notes !== undefined ? text(b.notes, 2000) : (prev?.notes || '');
        db.prepare(`INSERT INTO daily_ops (date, channels, notes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(date) DO UPDATE SET channels = excluded.channels, notes = excluded.notes,
                    updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(date, JSON.stringify(ch), notes, user.id, now);
        if (prev) audit(db, user.id, 'ops.update', null, { date });
      }
      for (const [key, v] of Object.entries(b.metrics || {})) {
        const m = metrics.find((x) => x.key === key);
        if (!m) throw new HttpError(400, 'رقم يومي غير معروف');
        requirePerm(user, `m:${key}`);
        const prev = db.prepare('SELECT value FROM daily_metrics WHERE date = ? AND key = ?').get(date, key);
        db.prepare(`INSERT INTO daily_metrics (date, key, value, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date, key) DO UPDATE SET value = excluded.value, note = excluded.note,
                    updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(date, key, num(v?.value || 0, 0, 1e6), m.note ? text(v?.note, 1000) : '', user.id, now);
        if (prev) audit(db, user.id, 'metric.update', null, { date, key, from: prev.value, to: num(v?.value || 0, 0, 1e6) });
      }
    });
    return { ok: true };
  }, { auth: true });
  r.post('/api/stock', async ({ req, user }) => {
    requirePerm(user, 'stock');
    const b = parseJson(await readBody(req));
    const kind = ['merchant_return', 'new_goods'].includes(b.kind) ? b.kind : null;
    if (!kind) throw new HttpError(400, 'اختر النوع');
    const date = needDate(b.date, localDate());
    const lines = Array.isArray(b.lines) && b.lines.length ? b.lines : [b];
    const party = text(b.party, 120);
    const invoice = text(b.invoice_no, 60);
    if (!party) throw new HttpError(400, 'اكتب اسم التاجر');
    const ins = db.prepare(`INSERT INTO stock_moves (date, kind, party, invoice_no, sku, description, quantity, value, note, created_by, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = tx(db, () => lines.slice(0, 100).map((l) => {
      const sku = text(l.sku, 60);
      const qty = num(l.quantity || 0, 0, 1e7);
      if (!sku && !text(l.description)) throw new HttpError(400, 'اكتب كود المنتج لكل صنف');
      if (!qty) throw new HttpError(400, `اكتب العدد للصنف ${sku}`);
      return Number(ins.run(date, kind, party, invoice, sku, text(l.description, 300), qty, num(l.value || 0, 0, 1e9), text(b.note, 500), user.id, Date.now()).lastInsertRowid);
    }));
    return { ids };
  }, { auth: true });

  // ------------------------------------------------------------ release / shortage requests
  r.get('/api/requests', ({ url, user }) => {
    const isAdmin = user.role === 'admin';
    if (!isAdmin) requirePerm(user, 'requests');
    const status = ['pending', 'approved', 'rejected', 'done'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : null;
    const where = [];
    const args = [];
    if (!isAdmin) { where.push('q.user_id = ?'); args.push(user.id); }
    if (status) { where.push('q.status = ?'); args.push(status); }
    return {
      requests: db.prepare(`SELECT q.*, u.name AS user_name, h.name AS handled_by_name FROM requests q JOIN users u ON u.id = q.user_id
                            LEFT JOIN users h ON h.id = q.handled_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                            ORDER BY (q.status = 'pending') DESC, q.created_at DESC LIMIT 300`).all(...args),
    };
  }, { auth: true });
  r.post('/api/requests', async ({ req, user }) => {
    requirePerm(user, 'requests');
    const b = parseJson(await readBody(req));
    const kind = ['release', 'shortage'].includes(b.kind) ? b.kind : null;
    if (!kind) throw new HttpError(400, 'اختر نوع الطلب');
    const sku = text(b.sku, 60);
    if (!sku) throw new HttpError(400, 'اكتب كود المنتج');
    const reason = text(b.reason, 1000);
    if (!reason) throw new HttpError(400, 'اكتب السبب');
    const now = Date.now();
    const res = db.prepare('INSERT INTO requests (user_id, date, kind, sku, quantity, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, localDate(now), kind, sku, num(b.quantity, 1, 1e6), reason, now, now);
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.put('/api/requests/:id', async ({ req, params, user }) => {
    requireAdmin(user);
    const q = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(params.id));
    if (!q) throw new HttpError(404, 'الطلب غير موجود');
    const b = parseJson(await readBody(req));
    const status = ['pending', 'approved', 'rejected', 'done'].includes(b.status) ? b.status : q.status;
    db.prepare('UPDATE requests SET status = ?, response = ?, handled_by = ?, updated_at = ? WHERE id = ?')
      .run(status, b.response !== undefined ? text(b.response, 1000) : q.response, user.id, Date.now(), q.id);
    audit(db, user.id, 'request.update', q.user_id, { id: q.id, status });
    return { ok: true };
  }, { auth: true });
  r.delete('/api/stock/:id', ({ params, user }) => {
    requireAdmin(user);
    const row = db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(Number(params.id));
    if (!row) throw new HttpError(404, 'السجل غير موجود');
    db.prepare('DELETE FROM stock_moves WHERE id = ?').run(row.id);
    audit(db, user.id, 'stock.delete', null, row);
    return { ok: true };
  }, { auth: true });

  // ------------------------------------------------------------ manager: attendance
  r.get('/api/dashboard', ({ url, user }) => {
    requireAdmin(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    const rep = dailyReport(db, date);
    const openTickets = db.prepare("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'").get().n;
    const pendingRequests = db.prepare("SELECT COUNT(*) n FROM requests WHERE status = 'pending'").get().n;
    return { ...rep, openTickets, pendingRequests, flagLabels: FLAG_LABELS, now: Date.now() };
  }, { auth: true });
  r.get('/api/attendance', ({ url, user }) => {
    requireAdmin(user);
    const { from, to } = range(url, 7);
    const rows = loadAttendance(db, { from, to, userId: Number(url.searchParams.get('user_id')) || null });
    return { from, to, rows, summary: summarize(rows) };
  }, { auth: true });
  r.get('/api/punches', ({ url, user }) => {
    requireAdmin(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    const userId = Number(url.searchParams.get('user_id')) || null;
    const rows = db.prepare(`SELECT p.*, u.name AS user_name, c.name AS created_by_name FROM punches p JOIN users u ON u.id = p.user_id
                             LEFT JOIN users c ON c.id = p.created_by WHERE p.date = ? ${userId ? 'AND p.user_id = ?' : ''} ORDER BY p.ts`)
      .all(date, ...(userId ? [userId] : [])).map((p) => ({ ...p, flags: JSON.parse(p.flags) }));
    return { punches: rows };
  }, { auth: true });
  r.post('/api/punches', async ({ req, user }) => {
    requireAdmin(user);
    return { id: managerPunch(db, user, parseJson(await readBody(req))) };
  }, { auth: true });
  r.delete('/api/punches/:id', async ({ req, params, user }) => {
    requireAdmin(user);
    voidPunch(db, user, params.id, parseJson(await readBody(req)).reason);
    return { ok: true };
  }, { auth: true });
  r.get('/api/flags', ({ url, user }) => {
    requireAdmin(user);
    const { from, to } = range(url, 14);
    const punches = db.prepare(`SELECT p.id, p.user_id, p.date, p.ts, p.type, p.note, p.source, p.flags, p.ip, p.lat, p.lng, p.voided, u.name AS user_name
                                FROM punches p JOIN users u ON u.id = p.user_id WHERE p.date BETWEEN ? AND ? AND p.flags != '[]' ORDER BY p.ts DESC`)
      .all(from, to).map((p) => ({ ...p, flags: JSON.parse(p.flags) }));
    const days = loadAttendance(db, { from, to }).filter((d) => d.flags.length)
      .map((d) => ({ userId: d.userId, name: d.name, date: d.date, flags: d.flags }));
    const auditRows = db.prepare(`SELECT a.*, u.name AS actor_name, t.name AS target_name FROM audit_log a
                                  LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN users t ON t.id = a.target_user_id
                                  ORDER BY a.ts DESC LIMIT 200`).all();
    return { punches, days, audit: auditRows, labels: FLAG_LABELS };
  }, { auth: true });
  r.get('/api/excuses', ({ url, user }) => {
    requireAdmin(user);
    const { from, to } = range(url, 60);
    return {
      excuses: db.prepare(`SELECT e.*, u.name AS user_name FROM excuses e LEFT JOIN users u ON u.id = e.user_id
                           WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC`).all(from, to),
    };
  }, { auth: true });
  r.post('/api/excuses', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    const kind = ['leave', 'sick', 'holiday', 'excused'].includes(b.kind) ? b.kind : null;
    if (!kind) throw new HttpError(400, 'اختر نوع الإجازة');
    const from = needDate(b.from);
    const to = needDate(b.to, from);
    if (to < from || addDays(from, 60) < to) throw new HttpError(400, 'المدة غير صحيحة (60 يوماً كحد أقصى)');
    const userId = kind === 'holiday' ? null : Number(b.user_id);
    if (kind !== 'holiday' && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(userId)) throw new HttpError(400, 'اختر الموظف');
    tx(db, () => {
      for (let d = from; d <= to; d = addDays(d, 1)) {
        db.prepare(`DELETE FROM excuses WHERE date = ? AND ${userId === null ? 'user_id IS NULL' : 'user_id = ?'}`).run(d, ...(userId === null ? [] : [userId]));
        db.prepare('INSERT INTO excuses (user_id, date, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, d, kind, text(b.note, 300), user.id, Date.now());
      }
      audit(db, user.id, 'excuse.add', userId, { kind, from, to, note: text(b.note, 300) });
    });
    return { ok: true };
  }, { auth: true });
  r.delete('/api/excuses/:id', ({ params, user }) => {
    requireAdmin(user);
    const e = db.prepare('SELECT * FROM excuses WHERE id = ?').get(Number(params.id));
    if (!e) throw new HttpError(404, 'غير موجود');
    db.prepare('DELETE FROM excuses WHERE id = ?').run(e.id);
    audit(db, user.id, 'excuse.delete', e.user_id, e);
    return { ok: true };
  }, { auth: true });

  // ------------------------------------------------------------ manager: money
  r.get('/api/deductions', ({ url, user }) => {
    requireAdmin(user);
    const { from, to } = range(url, 31);
    return { deductions: deductionRows(db, from, to, Number(url.searchParams.get('user_id')) || null) };
  }, { auth: true });
  r.post('/api/deductions', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    const userId = Number(b.user_id);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(userId)) throw new HttpError(400, 'اختر الموظف');
    const category = ['late', 'absence', 'early', 'exit', 'violation', 'damage', 'other'].includes(b.category) ? b.category : 'other';
    const amount = num(b.amount, 0.01, 1e6);
    const date = needDate(b.date, localDate());
    const res = db.prepare('INSERT INTO deductions (user_id, date, amount, category, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, date, amount, category, text(b.reason, 300), user.id, Date.now());
    audit(db, user.id, 'deduction.add', userId, { date, amount, category, reason: text(b.reason, 300) });
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.delete('/api/deductions/:id', ({ params, user }) => {
    requireAdmin(user);
    const d = db.prepare('SELECT * FROM deductions WHERE id = ?').get(Number(params.id));
    if (!d) throw new HttpError(404, 'الخصم غير موجود');
    db.prepare('DELETE FROM deductions WHERE id = ?').run(d.id);
    audit(db, user.id, 'deduction.delete', d.user_id, d);
    return { ok: true };
  }, { auth: true });
  r.get('/api/debts', ({ url, user }) => {
    requireAdmin(user);
    return { debts: debtRows(db, Number(url.searchParams.get('user_id')) || null), balances: debtBalances(db) };
  }, { auth: true });
  r.post('/api/debts', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    const userId = Number(b.user_id);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'employee'").get(userId)) throw new HttpError(400, 'اختر الموظف');
    const kind = b.kind === 'repayment' ? 'repayment' : 'loan';
    const amount = num(b.amount, 0.01, 1e7);
    const date = needDate(b.date, localDate());
    const res = db.prepare('INSERT INTO debts (user_id, date, kind, amount, note, from_salary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, date, kind, amount, text(b.note, 300), b.from_salary === false ? 0 : 1, user.id, Date.now());
    audit(db, user.id, `debt.${kind}`, userId, { date, amount, note: text(b.note, 300) });
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.delete('/api/debts/:id', ({ params, user }) => {
    requireAdmin(user);
    const d = db.prepare('SELECT * FROM debts WHERE id = ?').get(Number(params.id));
    if (!d) throw new HttpError(404, 'السجل غير موجود');
    db.prepare('DELETE FROM debts WHERE id = ?').run(d.id);
    audit(db, user.id, 'debt.delete', d.user_id, d);
    return { ok: true };
  }, { auth: true });
  r.get('/api/payroll', ({ url, user }) => {
    requireAdmin(user);
    const month = needMonth(url.searchParams.get('month'));
    return { month, rows: payroll(db, month) };
  }, { auth: true });

  // ------------------------------------------------------------ manager: staff & settings
  r.get('/api/users', ({ user }) => {
    requireAdmin(user);
    const st = getSettings(db);
    return { users: db.prepare('SELECT * FROM users ORDER BY role, id').all().map(userView), periods: allPeriods(st.schedule), permissions: permissionList(st) };
  }, { auth: true });
  const applyUser = (b, existing = null) => {
    const out = {};
    if ('name' in b) { out.name = text(b.name, 60); if (!out.name) throw new HttpError(400, 'اكتب الاسم'); }
    if ('username' in b) {
      out.username = validUsername(b.username);
      const clash = db.prepare('SELECT id FROM users WHERE username = ?').get(out.username);
      if (clash && clash.id !== existing?.id) throw new HttpError(409, 'اسم المستخدم مستخدم لموظف آخر');
    }
    if ('salary' in b) out.salary = num(b.salary || 0, 0, 1e6);
    if ('periods' in b) out.periods = Array.isArray(b.periods) ? JSON.stringify(b.periods.map(String)) : null;
    if ('day_off' in b) out.day_off = b.day_off === null || b.day_off === '' ? null : Math.round(num(b.day_off, 0, 6));
    if ('perms' in b) {
      const valid = new Set(permissionList(getSettings(db)).map((p) => p.key));
      out.perms = JSON.stringify((Array.isArray(b.perms) ? b.perms : []).map(String).filter((p) => valid.has(p)));
    }
    if ('active' in b && existing?.role !== 'admin') out.active = b.active ? 1 : 0;
    if (b.password) { validatePassword(b.password); out.password_hash = hashPassword(b.password); }
    return out;
  };
  r.post('/api/users', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    const f = applyUser({ ...b, username: b.username, name: b.name });
    const res = db.prepare(`INSERT INTO users (username, name, role, password_hash, salary, periods, day_off, perms, created_at)
                            VALUES (?, ?, 'employee', ?, ?, ?, ?, ?, ?)`)
      .run(f.username, f.name, f.password_hash || null, f.salary || 0, f.periods ?? null, f.day_off ?? null, f.perms || '[]', Date.now());
    audit(db, user.id, 'user.add', Number(res.lastInsertRowid), { name: f.name, username: f.username });
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.put('/api/users/:id', async ({ req, params, user }) => {
    requireAdmin(user);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!existing) throw new HttpError(404, 'الموظف غير موجود');
    const f = applyUser(parseJson(await readBody(req)), existing);
    const keys = Object.keys(f);
    if (!keys.length) return { ok: true };
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), existing.id);
    if (f.password_hash || f.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(existing.id, user.id);
    const changed = keys.map((k) => (k === 'password_hash' ? 'password' : k));
    audit(db, user.id, 'user.update', existing.id, { changed, salary: 'salary' in f ? { from: existing.salary, to: f.salary } : undefined });
    return { ok: true };
  }, { auth: true });
  r.get('/api/settings', ({ req, user }) => { requireAdmin(user); return { ...getSettings(db), your_ip: clientIp(req) }; }, { auth: true });
  r.put('/api/settings', async ({ req, user }) => {
    requireAdmin(user);
    const s = saveSettings(db, parseJson(await readBody(req)));
    audit(db, user.id, 'settings.update', null, '');
    return s;
  }, { auth: true });

  // ------------------------------------------------------------ exports
  const exp = (path, fn) => r.get(path, ({ url, res, user }) => { requireAdmin(user); return fn(url, res); }, { auth: true });
  exp('/api/export/daily', (url, res) => {
    const date = needDate(url.searchParams.get('date'), localDate());
    const d = dailyReport(db, date);
    csv(res, `wareef-daily-${date}`, [
      attendanceSection(d.attendance), punchesSection(d.punches),
      opsSection(d.ops ? [d.ops] : [], d.channels, d.metrics), stockSection(d.stock), requestsSection(d.requests),
      ticketsSection(d.tickets), deductionsSection(d.deductions), debtsSection(d.debts),
    ]);
  });
  exp('/api/export/attendance', (url, res) => {
    const { from, to } = range(url, 31);
    csv(res, `wareef-attendance-${from}_${to}`, [attendanceSection(loadAttendance(db, { from, to }))]);
  });
  exp('/api/export/payroll', (url, res) => {
    const month = needMonth(url.searchParams.get('month'));
    const { from, to } = monthBounds(month);
    csv(res, `wareef-payroll-${month}`, [payrollSection(payroll(db, month), month), deductionsSection(deductionRows(db, from, to)),
      debtsSection(debtRows(db).filter((d) => d.date >= from && d.date <= to))]);
  });
  exp('/api/export/ops', (url, res) => {
    const { from, to } = range(url, 31);
    const st = getSettings(db);
    csv(res, `wareef-operations-${from}_${to}`, [opsSection(opsRows(db, from, to), st.channels, st.metrics), stockSection(stockRows(db, from, to)), requestsSection(requestRows(db, from, to))]);
  });
  exp('/api/export/tickets', (url, res) => {
    const { from, to } = range(url, 31);
    csv(res, `wareef-tickets-${from}_${to}`, [ticketsSection(ticketRows(db, { from, to }))]);
  });
  exp('/api/export/debts', (url, res) => csv(res, 'wareef-debts', [debtsSection(debtRows(db))]));
  exp('/api/backup', async (url, res) => {
    const file = join(dirname(config.dbPath), `export-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const buf = await readFile(file);
    await rm(file, { force: true });
    send(res, 200, buf, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="wareef-staff-${localDate()}.db"` });
  });

  // Printable daily report (open in the browser, print or save as PDF).
  r.get('/report/daily', ({ url, res, user }) => {
    requireAdmin(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    send(res, 200, renderDailyReport(dailyReport(db, date)), { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  }, { auth: true, page: true });

  r.get('/health', () => ({ ok: true, time: localTime(Date.now()) }));

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      const m = r.match(req.method, pathname);
      if (m?.handler) {
        // CSRF: cookie-authenticated writes must carry a header a cross-site form can't set.
        const write = pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (write && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'missing X-Requested-With header');
        let user = null;
        if (m.opts.auth) {
          user = currentUser(db, req);
          if (!user) {
            if (m.opts.page) { res.writeHead(302, { Location: '/' }); res.end(); return; }
            throw new HttpError(401, 'يرجى تسجيل الدخول');
          }
        }
        const out = await m.handler({ req, res, url, params: m.params, user });
        if (!res.headersSent && out !== undefined) send(res, 200, out, { 'Cache-Control': 'no-store' });
        return;
      }
      if (m?.methodNotAllowed) throw new HttpError(405, 'method not allowed');
      if (req.method === 'GET' && !pathname.startsWith('/api/')) return await serveStatic(res, pathname);
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'حدث خطأ غير متوقع' : err.message });
    }
  };
}

async function serveStatic(res, pathname) {
  const rel = normalize(pathname).replace(/^([/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !extname(rel) || !existsSync(file)) file = join(PUBLIC_DIR, 'index.html');
  const ext = extname(file);
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(ext === '.html' ? SECURITY_HEADERS : {}),
  });
  res.end(body);
}

async function dailyBackup(db) {
  const dir = join(dirname(config.dbPath), 'backups');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `staff-${localDate()}.db`);
  if (!existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const cutoff = localDate(Date.now() - config.backupKeepDays * DAY);
  for (const f of await readdir(dir)) {
    const m = /^staff-(\d{4}-\d{2}-\d{2})\.db$/.exec(f);
    if (m && m[1] < cutoff) await rm(join(dir, f), { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(config.dbPath);
  const boot = bootstrap(db);
  if (boot) {
    console.log(`حساب المدير: ${boot.username}${boot.password ? ` / كلمة المرور المؤقتة: ${boot.password}` : ''}`);
  }
  const backup = () => dailyBackup(db).catch((e) => console.error('backup failed', e));
  backup();
  setInterval(backup, 6 * 3600_000).unref();
  createServer(createApp(db)).listen(config.port, () => console.log(`نظام وريف للموظفين يعمل على http://localhost:${config.port}`));
}
