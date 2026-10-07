import { createServer } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, DAY } from './config.js';
import { openDb, audit, tx } from './db.js';
import { HttpError, Router, clientIp, parseJson, rateLimiter, readBody, send } from './http.js';
import {
  bootstrap, can, isManager, requireManager, currentUser, deviceId, hashPassword, login, logout, requireAdmin, requireOps, requirePerm,
  sessionCookie, validatePassword, validUsername, verifyPassword,
} from './auth.js';
import { getSettings, saveSettings, allPeriods, permissionList } from './settings.js';
import { localDate, isDate, addDays, monthBounds, localTime, at } from './time.js';
import { computeDay, loadAttendance, periodsFor, summarize } from './attendance.js';
import { FLAG_LABELS, NEXT, lastPunch, managerPunch, recordPunch, voidPunch } from './punch.js';
import {
  attendanceSection, dailyReport, scansSection, debtBalances, debtRows, debtsSection, deductionRows, deductionsSection,
  opsRows, opsSection, payroll, payrollSection, punchesSection, requestRows, requestsSection, stockRows, stockSection, ticketRows, ticketsSection, toCsv,
} from './reports.js';
import { renderDailyReport } from './print.js';
import { waAutoStart, waLogout, waOnMessage, waQrSvg, waStart, waStatus } from './wa.js';
import { appLink, dailyPdf, flush, normalizePhone, notifyActivity, notifyEmployee, notifyManager, providerStatus, queue, startNotifier, dailySummary } from './notify.js';
import { decideLeave, decideRequest } from './decisions.js';
import { announceAward, assertOpen, awardOf, closeMonth, closedMonth, monthlyData, monthlyTick, payrollFor, reopenMonth, sendPayslips } from './monthly.js';
import { performance } from './performance.js';
import { handleIncoming } from './commands.js';
import { currentExit, endExit, exitTick, requestExit, startExit } from './exits.js';
import { SCAN_KINDS, SCAN_METRIC, addScan, removeScan, scanCounts, scanList } from './scans.js';
import { pushTo, removeSubscription, saveSubscription, vapidKeys } from './push.js';
import { renderMonthlyReport, renderPayslip } from './print.js';
import * as msg from './messages.js';
import { DEDUCTION_LABELS, TICKET_KINDS, PUNCH_LABELS } from './reports.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(self)',
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

export { decideLeave };

/** Supervisors see attendance without the suggested deduction (salary-derived). */
const hideMoney = (user, rows) => (user.role === 'admin' ? rows : rows.map(({ suggested, ...r }) => r));

function userView(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, salary: u.salary,
    periods: u.periods ? JSON.parse(u.periods) : null, day_off: u.day_off, perms: JSON.parse(u.perms || '[]'),
    has_password: !!u.password_hash, created_at: u.created_at, phone: u.phone || '', push_devices: u.push_devices || 0,
  };
}

function myToday(db, user, now = Date.now()) {
  const settings = getSettings(db);
  const date = localDate(now);
  const punches = db.prepare('SELECT id, ts, type, note, flags FROM punches WHERE user_id = ? AND date = ? AND voided = 0 ORDER BY ts').all(user.id, date)
    .map((p) => ({ ...p, flags: JSON.parse(p.flags) }));
  const holiday = !!db.prepare('SELECT 1 FROM excuses WHERE user_id IS NULL AND date = ?').get(date);
  const excuse = db.prepare('SELECT kind FROM excuses WHERE user_id = ? AND date = ?').get(user.id, date)?.kind || null;
  const permits = db.prepare("SELECT from_time, to_time FROM leave_requests WHERE user_id = ? AND from_date = ? AND kind = 'permission' AND status = 'approved'")
    .all(user.id, date).map((p) => [at(date, p.from_time), at(date, p.to_time)]);
  const day = computeDay({
    date, punches, periods: periodsFor(user, date, settings.schedule, holiday), excuse, permits,
    grace: settings.grace_minutes, maxExit: settings.max_exit_minutes, salary: 0, now,
  });
  const last = lastPunch(db, user.id, date);
  return { now, date, day, punches, allowed: NEXT[last ? last.type : 'none'], geo: !!settings.security.geo, requireGeo: settings.security.require_geo, exit: currentExit(db, user.id, now) };
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
      user: { id: user.id, name: user.name, username: user.username, role: user.role, perms: user.perms, manager: isManager(user) },
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

  // Forgotten password: a 6-digit code to the WhatsApp number on file, valid 10 minutes, 5 tries.
  const resetLimit = rateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const otpHash = (userId, code) => createHash('sha256').update(`${userId}:${code}`).digest('hex');
  const resetUser = (username) => db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
  r.post('/api/reset/request', async ({ req }) => {
    if (!resetLimit(clientIp(req))) throw new HttpError(429, 'محاولات كثيرة. حاول بعد ربع ساعة');
    const u = resetUser(parseJson(await readBody(req)).username);
    const phone = u ? (u.role === 'admin' ? getSettings(db).notify.manager_phone : u.phone) : '';
    if (u && phone) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      db.prepare(`INSERT INTO otp_codes (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
                  ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`)
        .run(u.id, otpHash(u.id, code), Date.now() + 10 * 60_000);
      queue(db, { to: phone, body: msg.otp({ code }), kind: 'otp', userId: u.id });
      flush(db).catch(() => {});
    }
    // Same answer either way, so the form can't be used to discover usernames.
    return { ok: true };
  });
  r.post('/api/reset/confirm', async ({ req }) => {
    if (!resetLimit(clientIp(req))) throw new HttpError(429, 'محاولات كثيرة. حاول بعد ربع ساعة');
    const b = parseJson(await readBody(req));
    const u = resetUser(b.username);
    const row = u && db.prepare('SELECT * FROM otp_codes WHERE user_id = ?').get(u.id);
    if (!row || row.expires_at < Date.now() || row.attempts >= 5) throw new HttpError(400, 'الرمز منتهي. اطلب رمزاً جديداً');
    if (otpHash(u.id, String(b.code || '').replace(/\D/g, '')) !== row.code_hash) {
      db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE user_id = ?').run(u.id);
      throw new HttpError(400, 'الرمز غير صحيح');
    }
    validatePassword(b.password);
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
      db.prepare('DELETE FROM otp_codes WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(db, u.id, 'password.reset', u.id, '');
    });
    if (u.role !== 'admin') notifyActivity(db, 'password_reset', msg.mgrPasswordReset({ name: u.name }));
    return { ok: true };
  });

  // ------------------------------------------------------------ employee self-service
  r.get('/api/my/today', ({ user }) => myToday(db, user), { auth: true });
  r.post('/api/punch', async ({ req, res, user }) => {
    if (user.role !== 'employee') throw new HttpError(403, 'البصمة للموظفين فقط');
    const body = parseJson(await readBody(req));
    const dev = deviceId(req);
    // Stepping out on an approved exit permission: the reason comes from the request.
    let permit = null;
    if (body.type === 'leave' && body.exit_id) {
      permit = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND user_id = ? AND minutes > 0 AND status = 'approved' AND left_at IS NULL").get(Number(body.exit_id), user.id);
      if (!permit) throw new HttpError(400, 'إذن الخروج غير صالح');
      body.note = `بإذن ${permit.minutes} دقيقة: ${permit.reason}`;
    }
    const p = recordPunch(db, user, body, { ip: clientIp(req), device: dev.id, userAgent: req.headers['user-agent'] || '' });
    if (permit) startExit(db, user, permit.id, p.ts);
    const back = p.type === 'back' ? endExit(db, user, p.ts) : null;
    const serious = p.flags.filter((f) => f !== 'new_device');
    if (serious.length) {
      notifyManager(db, 'flag', msg.mgrFlag({ name: user.name, type: p.type, time: localTime(p.ts), reasons: serious.map((f) => FLAG_LABELS[f]) }));
    }
    if (p.type === 'leave') notifyManager(db, 'leave', msg.mgrLeave({ name: user.name, time: localTime(p.ts), reason: permit ? text(body.note, 200) : `بدون إذن مسبق: ${text(body.note, 200)}` }));
    const today = myToday(db, user);
    if (p.type === 'back') notifyManager(db, 'back', msg.mgrBack({ name: user.name, time: localTime(p.ts), minutes: back?.q.minutes || 0, used: back?.used || 0, over: back?.over || 0 }));
    else if (p.type !== 'leave') notifyActivity(db, 'punch', msg.mgrPunch({ name: user.name, type: p.type, time: localTime(p.ts), late: p.type === 'in' ? today.day.lateMinutes : 0 }));
    send(res, 200, today, dev.cookie ? { 'Set-Cookie': dev.cookie } : {});
  }, { auth: true });
  r.post('/api/exit-requests', async ({ req, user }) => {
    if (user.role !== 'employee') throw new HttpError(403, 'للموظفين فقط');
    if (!['in', 'back'].includes(lastPunch(db, user.id, localDate())?.type)) throw new HttpError(400, 'سجّل حضورك أولاً');
    requestExit(db, user, parseJson(await readBody(req)));
    return myToday(db, user);
  }, { auth: true });
  r.delete('/api/exit-requests/:id', ({ params, user }) => {
    const q = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND user_id = ? AND minutes > 0 AND status = 'pending'").get(Number(params.id), user.id);
    if (!q) throw new HttpError(404, 'لا يوجد طلب بانتظار الموافقة');
    db.prepare('DELETE FROM leave_requests WHERE id = ?').run(q.id);
    return myToday(db, user);
  }, { auth: true });
  r.get('/api/my/month', ({ url, user }) => {
    const month = needMonth(url.searchParams.get('month'));
    const { from, to } = monthBounds(month);
    const days = loadAttendance(db, { from, to, userId: user.id });
    const balance = debtBalances(db).find((b) => b.user_id === user.id);
    return {
      month, days: days.map(({ suggested, ...d }) => d), summary: summarize(days).map(({ suggested, ...s }) => s)[0] || null,
      deductions: deductionRows(db, from, to, user.id), debts: debtRows(db, user.id), balance: balance?.balance || 0,
      closed: !!closedMonth(db, month), award: awardOf(db, month),
    };
  }, { auth: true });

  // ------------------------------------------------------------ tickets
  r.get('/api/tickets', ({ url, user }) => {
    const { from, to } = range(url, 60);
    const userId = isManager(user) ? (Number(url.searchParams.get('user_id')) || null) : user.id;
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
    if (!isManager(user)) {
      notifyManager(db, 'ticket', msg.mgrTicket({ name: user.name, title, kind: TICKET_KINDS[kind], high: priority === 'high' }));
    }
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  const ticketFor = (id, user) => {
    const t = db.prepare('SELECT t.*, u.name AS user_name FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(Number(id));
    if (!t || (!isManager(user) && t.user_id !== user.id)) throw new HttpError(404, 'التذكرة غير موجودة');
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
    if (isManager(user) && t.user_id !== user.id) notifyEmployee(db, t.user_id, 'ticket_reply', msg.ticketReply({ title: t.title, reply: body.slice(0, 500), link: appLink(db) }));
    else if (!isManager(user)) notifyActivity(db, 'ticket_reply', msg.mgrTicketReply({ name: user.name, title: t.title, reply: body.slice(0, 500) }));
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, t.id);
    return { ok: true };
  }, { auth: true });
  r.put('/api/tickets/:id', async ({ req, params, user }) => {
    requireManager(user);
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
    return { ops: opsRows(db, from, to), stock: stockRows(db, from, to), channels: s.channels, metrics: s.metrics, scans: scanCounts(db, from, to) };
  }, { auth: true });
  r.put('/api/ops/:date', async ({ req, params, user }) => {
    requireOps(user);
    const date = needDate(params.date);
    if (date > localDate()) throw new HttpError(400, 'لا يمكن التسجيل لتاريخ لم يأتِ بعد');
    if (user.role !== 'admin' && date < addDays(localDate(), -3)) throw new HttpError(403, 'التعديل متاح لآخر 3 أيام فقط. تواصل مع المدير');
    const b = parseJson(await readBody(req));
    const { channels, metrics } = getSettings(db);
    const now = Date.now();
    const said = [];
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
        if (b.channels) {
          const total = channels.reduce((t, c) => t + (Number(ch[c.key]?.count) || 0), 0);
          said.push(`▫️ طلبات القنوات: *${total}*  (${channels.filter((c) => ch[c.key]?.count).map((c) => `${c.name} ${ch[c.key].count}`).join('، ') || '—'})`);
        }
      }
      for (const [key, v] of Object.entries(b.metrics || {})) {
        const m = metrics.find((x) => x.key === key);
        if (!m) throw new HttpError(400, 'رقم يومي غير معروف');
        requirePerm(user, `m:${key}`);
        const scanKind = Object.keys(SCAN_METRIC).find((k) => SCAN_METRIC[k] === key);
        if (scanKind && db.prepare('SELECT 1 FROM scans WHERE date = ? AND kind = ?').get(date, scanKind)) {
          throw new HttpError(400, `«${m.name}» لهذا اليوم يُحسب من الباركود ولا يُعدَّل يدوياً`);
        }
        const prev = db.prepare('SELECT value FROM daily_metrics WHERE date = ? AND key = ?').get(date, key);
        db.prepare(`INSERT INTO daily_metrics (date, key, value, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date, key) DO UPDATE SET value = excluded.value, note = excluded.note,
                    updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(date, key, num(v?.value || 0, 0, 1e6), m.note ? text(v?.note, 1000) : '', user.id, now);
        if (prev) audit(db, user.id, 'metric.update', null, { date, key, from: prev.value, to: num(v?.value || 0, 0, 1e6) });
        if (!prev || prev.value !== num(v?.value || 0, 0, 1e6) || (m.note && v?.note)) {
          said.push(`▫️ ${m.name}: *${num(v?.value || 0, 0, 1e6)}*${prev && prev.value !== num(v?.value || 0, 0, 1e6) ? ` (كان ${prev.value})` : ''}${m.note && v?.note ? `\n> ${text(v.note, 300).replace(/\n/g, '\n> ')}` : ''}`);
        }
      }
    });
    if (said.length && !isManager(user)) notifyActivity(db, 'entry', msg.mgrEntry({ name: user.name, date, lines: said }));
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
    const ins = db.prepare(`INSERT INTO stock_moves (date, kind, party, invoice_no, sku, description, quantity, value, note, created_by, created_at, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = tx(db, () => lines.slice(0, 100).map((l) => {
      const sku = text(l.sku, 60);
      const qty = num(l.quantity || 0, 0, 1e7);
      if (!sku && !text(l.description)) throw new HttpError(400, 'اكتب كود المنتج لكل صنف');
      if (!qty) throw new HttpError(400, `اكتب العدد للصنف ${sku}`);
      return Number(ins.run(date, kind, party, invoice, sku, text(l.description, 300), qty, num(l.value || 0, 0, 1e9), text(b.note, 500), user.id, Date.now(), kind === 'merchant_return' ? 'ready' : '').lastInsertRowid);
    }));
    if (!isManager(user)) {
      notifyActivity(db, 'stock', msg.mgrStock({ name: user.name, kind, party, invoice,
        lines: lines.slice(0, 100).map((l) => ({ sku: text(l.sku, 60), description: text(l.description, 300), quantity: num(l.quantity || 0, 0, 1e7) })) }));
    }
    return { ids };
  }, { auth: true });
  // Merchant returns: ready → sent → settled.
  r.put('/api/stock/:id/status', async ({ req, params, user }) => {
    if (!isManager(user)) requirePerm(user, 'stock');
    const row = db.prepare("SELECT * FROM stock_moves WHERE id = ? AND kind = 'merchant_return'").get(Number(params.id));
    if (!row) throw new HttpError(404, 'المرتجع غير موجود');
    const b = parseJson(await readBody(req));
    const status = ['ready', 'sent', 'settled'].includes(b.status) ? b.status : null;
    if (!status) throw new HttpError(400, 'حالة غير معروفة');
    const note = b.note !== undefined ? text(b.note, 300) : row.status_note;
    // A whole invoice moves together unless one line is asked for.
    const ids = b.all ? db.prepare("SELECT id FROM stock_moves WHERE kind = 'merchant_return' AND date = ? AND party = ? AND invoice_no = ?").all(row.date, row.party, row.invoice_no).map((x) => x.id) : [row.id];
    const upd = db.prepare('UPDATE stock_moves SET status = ?, status_note = ?, status_at = ? WHERE id = ?');
    tx(db, () => { for (const id of ids) upd.run(status, note, Date.now(), id); });
    audit(db, user.id, 'stock.status', null, { ids, status });
    if (status !== row.status) {
      const qty = db.prepare(`SELECT SUM(quantity) q FROM stock_moves WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).q;
      notifyActivity(db, 'stock_status', msg.mgrReturnStatus({ name: user.name, party: row.party, sku: ids.length > 1 ? `${ids.length} أصناف` : row.sku, qty, status, note }));
    }
    return { ok: true, ids };
  }, { auth: true });

  // ------------------------------------------------------------ phone notifications (Web Push)
  r.get('/api/push/key', () => ({ key: vapidKeys(db).publicKey }), { auth: true });
  r.post('/api/push/subscribe', async ({ req, user }) => {
    try { return { ok: true, devices: saveSubscription(db, user.id, parseJson(await readBody(req)).subscription, req.headers['user-agent']) }; } catch (e) { throw new HttpError(e.status || 400, e.message); }
  }, { auth: true });
  r.post('/api/push/unsubscribe', async ({ req, user }) => ({ ok: true, removed: removeSubscription(db, user.id, parseJson(await readBody(req)).endpoint) }), { auth: true });
  r.post('/api/push/test', ({ user }) => {
    const n = pushTo(db, { userId: user.id, kind: 'alarm_start', body: msg.card({ icon: '🔔', title: 'تنبيهات الجوال تعمل', lines: ['من الآن يوصلك منبّه الدوام وكل الإشعارات هنا مباشرة.'] }) });
    if (!n) throw new HttpError(400, 'فعّل التنبيهات على هذا الجوال أولاً');
    return { ok: true, devices: n };
  }, { auth: true });

  // ------------------------------------------------------------ barcode scans
  const scanAccess = (user) => { if (!can(user, 'scan') && !isManager(user)) throw new HttpError(403, 'ليست لديك صلاحية المسح بالباركود'); };
  r.get('/api/scans', ({ url, user }) => {
    scanAccess(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    const kind = SCAN_KINDS[url.searchParams.get('kind')] ? url.searchParams.get('kind') : null;
    const counts = scanCounts(db, date, date)[date] || {};
    return { date, scans: scanList(db, date, kind), counts: { shipment: counts.shipment || 0, return: counts.return || 0 }, kinds: SCAN_KINDS };
  }, { auth: true });
  r.post('/api/scans', async ({ req, user }) => {
    scanAccess(user);
    try {
      return addScan(db, user, parseJson(await readBody(req)));
    } catch (e) {
      if (e.dup) notifyActivity(db, 'scan_dup', msg.mgrScanDup({ name: user.name, reason: e.message }));
      throw e;
    }
  }, { auth: true });
  r.delete('/api/scans/:id', ({ params, user }) => {
    scanAccess(user);
    return removeScan(db, user, params.id, isManager(user));
  }, { auth: true });

  // ------------------------------------------------------------ release / shortage requests
  r.get('/api/requests', ({ url, user }) => {
    const isAdmin = isManager(user);
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
    const qty = num(b.quantity, 1, 1e6);
    const res = db.prepare('INSERT INTO requests (user_id, date, kind, sku, quantity, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, localDate(now), kind, sku, qty, reason, now, now);
    notifyManager(db, 'request', msg.mgrRequest({ id: Number(res.lastInsertRowid), name: user.name, kind, sku, qty, reason: reason.slice(0, 300) }));
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.put('/api/requests/:id', async ({ req, params, user }) => {
    requireManager(user);
    const b = parseJson(await readBody(req));
    return decideRequest(db, user, Number(params.id), b.status, b.response);
  }, { auth: true });
  r.delete('/api/stock/:id', ({ params, user }) => {
    requireManager(user);
    const row = db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(Number(params.id));
    if (!row) throw new HttpError(404, 'السجل غير موجود');
    db.prepare('DELETE FROM stock_moves WHERE id = ?').run(row.id);
    audit(db, user.id, 'stock.delete', null, row);
    return { ok: true };
  }, { auth: true });

  // ------------------------------------------------------------ leave & permission requests
  r.get('/api/leaves', ({ url, user }) => {
    const all = isManager(user);
    const status = ['pending', 'approved', 'rejected'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : null;
    const where = [];
    const args = [];
    if (!all) { where.push('l.user_id = ?'); args.push(user.id); }
    if (status) { where.push('l.status = ?'); args.push(status); }
    return {
      leaves: db.prepare(`SELECT l.*, u.name AS user_name, h.name AS handled_by_name FROM leave_requests l JOIN users u ON u.id = l.user_id
                          LEFT JOIN users h ON h.id = l.handled_by ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                          ORDER BY (l.status = 'pending') DESC, l.from_date DESC, l.id DESC LIMIT 300`).all(...args),
    };
  }, { auth: true });
  r.post('/api/leaves', async ({ req, user }) => {
    if (user.role === 'admin') throw new HttpError(400, 'طلبات الإجازة للموظفين');
    const b = parseJson(await readBody(req));
    const kind = ['leave', 'sick', 'permission'].includes(b.kind) ? b.kind : null;
    if (!kind) throw new HttpError(400, 'اختر نوع الطلب');
    const from = needDate(b.from_date);
    const to = kind === 'permission' ? from : needDate(b.to_date, from);
    if (to < from || addDays(from, 30) < to) throw new HttpError(400, 'المدة غير صحيحة (30 يوماً كحد أقصى)');
    if (from < addDays(localDate(), -7)) throw new HttpError(400, 'لا يمكن طلب إجازة لتاريخ مضى عليه أكثر من أسبوع');
    let fromTime = '';
    let toTime = '';
    if (kind === 'permission') {
      fromTime = String(b.from_time || '');
      toTime = String(b.to_time || '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fromTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(toTime) || fromTime >= toTime) throw new HttpError(400, 'حدّد وقت بداية ونهاية الاستئذان');
    }
    const reason = text(b.reason, 500);
    if (!reason) throw new HttpError(400, 'اكتب السبب');
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO leave_requests (user_id, kind, from_date, to_date, from_time, to_time, reason, created_at, updated_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, kind, from, to, fromTime, toTime, reason, now, now).lastInsertRowid);
    const q = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    notifyManager(db, 'leave_request', msg.mgrLeaveRequest({ q, name: user.name }));
    return { id };
  }, { auth: true });
  r.put('/api/leaves/:id', async ({ req, params, user }) => {
    requireManager(user);
    const b = parseJson(await readBody(req));
    return decideLeave(db, user, Number(params.id), b.status, b.response);
  }, { auth: true });

  // ------------------------------------------------------------ manager: attendance
  r.get('/api/dashboard', ({ url, user }) => {
    requireManager(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    const rep = dailyReport(db, date);
    const openTickets = db.prepare("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'").get().n;
    const pendingRequests = db.prepare("SELECT COUNT(*) n FROM requests WHERE status = 'pending'").get().n;
    const pendingLeaves = db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE status = 'pending'").get().n;
    const money = user.role === 'admin';
    return {
      ...rep, attendance: hideMoney(user, rep.attendance), deductions: money ? rep.deductions : [], debts: money ? rep.debts : [],
      openTickets, pendingRequests, pendingLeaves, flagLabels: FLAG_LABELS,
      exits: db.prepare(`SELECT l.*, u.name AS user_name FROM leave_requests l JOIN users u ON u.id = l.user_id
                         WHERE l.kind = 'permission' AND l.minutes > 0 AND l.from_date = ? AND (l.status = 'pending' OR (l.status = 'approved' AND l.back_at IS NULL))
                         ORDER BY l.id`).all(date), now: Date.now(),
    };
  }, { auth: true });
  r.get('/api/attendance', ({ url, user }) => {
    requireManager(user);
    const { from, to } = range(url, 7);
    const rows = loadAttendance(db, { from, to, userId: Number(url.searchParams.get('user_id')) || null });
    return { from, to, rows: hideMoney(user, rows), summary: hideMoney(user, summarize(rows)) };
  }, { auth: true });
  r.get('/api/punches', ({ url, user }) => {
    requireManager(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    const userId = Number(url.searchParams.get('user_id')) || null;
    const rows = db.prepare(`SELECT p.*, u.name AS user_name, c.name AS created_by_name FROM punches p JOIN users u ON u.id = p.user_id
                             LEFT JOIN users c ON c.id = p.created_by WHERE p.date = ? ${userId ? 'AND p.user_id = ?' : ''} ORDER BY p.ts`)
      .all(date, ...(userId ? [userId] : [])).map((p) => ({ ...p, flags: JSON.parse(p.flags) }));
    return { punches: rows };
  }, { auth: true });
  r.post('/api/punches', async ({ req, user }) => {
    requireManager(user);
    return { id: managerPunch(db, user, parseJson(await readBody(req))) };
  }, { auth: true });
  r.delete('/api/punches/:id', async ({ req, params, user }) => {
    requireManager(user);
    voidPunch(db, user, params.id, parseJson(await readBody(req)).reason);
    return { ok: true };
  }, { auth: true });
  r.get('/api/flags', ({ url, user }) => {
    requireManager(user);
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
    requireManager(user);
    const { from, to } = range(url, 60);
    return {
      excuses: db.prepare(`SELECT e.*, u.name AS user_name FROM excuses e LEFT JOIN users u ON u.id = e.user_id
                           WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC`).all(from, to),
    };
  }, { auth: true });
  r.post('/api/excuses', async ({ req, user }) => {
    requireManager(user);
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
    requireManager(user);
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
    assertOpen(db, date);
    const res = db.prepare('INSERT INTO deductions (user_id, date, amount, category, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, date, amount, category, text(b.reason, 300), user.id, Date.now());
    audit(db, user.id, 'deduction.add', userId, { date, amount, category, reason: text(b.reason, 300) });
    notifyEmployee(db, userId, 'deduction', msg.deduction({ amount, date, category: DEDUCTION_LABELS[category], reason: text(b.reason, 200), link: appLink(db) }));
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.delete('/api/deductions/:id', ({ params, user }) => {
    requireAdmin(user);
    const d = db.prepare('SELECT * FROM deductions WHERE id = ?').get(Number(params.id));
    if (!d) throw new HttpError(404, 'الخصم غير موجود');
    assertOpen(db, d.date);
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
    assertOpen(db, date);
    const res = db.prepare('INSERT INTO debts (user_id, date, kind, amount, note, from_salary, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, date, kind, amount, text(b.note, 300), b.from_salary === false ? 0 : 1, user.id, Date.now());
    audit(db, user.id, `debt.${kind}`, userId, { date, amount, note: text(b.note, 300) });
    const bal = db.prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'loan' THEN amount ELSE -amount END), 0) b FROM debts WHERE user_id = ?").get(userId).b;
    notifyEmployee(db, userId, `debt_${kind}`, msg.debt({ kind, amount, balance: Math.round(bal * 100) / 100, note: text(b.note, 200), link: appLink(db) }));
    return { id: Number(res.lastInsertRowid) };
  }, { auth: true });
  r.delete('/api/debts/:id', ({ params, user }) => {
    requireAdmin(user);
    const d = db.prepare('SELECT * FROM debts WHERE id = ?').get(Number(params.id));
    if (!d) throw new HttpError(404, 'السجل غير موجود');
    assertOpen(db, d.date);
    db.prepare('DELETE FROM debts WHERE id = ?').run(d.id);
    audit(db, user.id, 'debt.delete', d.user_id, d);
    return { ok: true };
  }, { auth: true });
  r.get('/api/payroll', ({ url, user }) => {
    requireAdmin(user);
    const month = needMonth(url.searchParams.get('month'));
    return { month, ...payrollFor(db, month) };
  }, { auth: true });
  r.post('/api/payroll/close', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    return closeMonth(db, user, needMonth(b.month), { send: b.send !== false });
  }, { auth: true });
  r.post('/api/payroll/payslips', async ({ req, user }) => {
    requireAdmin(user);
    return { ok: true, sent: sendPayslips(db, needMonth(parseJson(await readBody(req)).month)) };
  }, { auth: true });
  r.delete('/api/payroll/close/:month', ({ params, user }) => {
    requireAdmin(user);
    return reopenMonth(db, user, needMonth(params.month));
  }, { auth: true });

  // ------------------------------------------------------------ performance & analytics
  r.get('/api/performance', ({ url, user }) => {
    requireManager(user);
    const month = needMonth(url.searchParams.get('month'));
    return { month, rows: performance(db, month), award: awardOf(db, month) };
  }, { auth: true });
  r.post('/api/awards', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    return announceAward(db, needMonth(b.month), { userId: b.user_id || null });
  }, { auth: true });
  r.get('/api/analytics', ({ url, user }) => {
    requireManager(user);
    const { from, to } = range(url, 30);
    if (addDays(from, 400) < to) throw new HttpError(400, 'المدة طويلة جداً');
    const s = getSettings(db);
    const ops = new Map(opsRows(db, from, to).map((d) => [d.date, d]));
    const att = loadAttendance(db, { from, to });
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const o = ops.get(d);
      const a = att.filter((x) => x.date === d);
      days.push({
        date: d,
        orders: o?.totalOrders || 0, amount: o?.totalAmount || 0,
        channels: Object.fromEntries(s.channels.map((c) => [c.key, Number(o?.channels[c.key]?.count) || 0])),
        metrics: Object.fromEntries(s.metrics.map((m) => [m.key, o?.metrics[m.key] ? Number(o.metrics[m.key].value) : null])),
        scheduled: a.filter((x) => x.scheduledMinutes > 0 && x.status !== 'excused').length,
        present: a.filter((x) => ['present', 'late', 'partial', 'off_worked'].includes(x.status)).length,
        absent: a.filter((x) => x.status === 'absent').length,
        lateMinutes: a.reduce((t, x) => t + x.lateMinutes, 0),
      });
    }
    return { from, to, days, channels: s.channels, metrics: s.metrics };
  }, { auth: true });

  // ------------------------------------------------------------ manager: staff & settings
  r.get('/api/staff', ({ user }) => {
    requireManager(user);
    return { users: db.prepare("SELECT id, name, active FROM users WHERE role = 'employee' ORDER BY id").all().map((u) => ({ ...u, active: !!u.active })) };
  }, { auth: true });
  r.get('/api/users', ({ user }) => {
    requireAdmin(user);
    const st = getSettings(db);
    return { users: db.prepare('SELECT u.*, (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS push_devices FROM users u ORDER BY role, id').all().map(userView), periods: allPeriods(st.schedule), permissions: permissionList(st) };
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
    if ('phone' in b) {
      out.phone = b.phone ? normalizePhone(b.phone) : '';
      if (b.phone && !out.phone) throw new HttpError(400, 'رقم الجوال غير صحيح. اكتبه مثل 0501234567');
    }
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
    const res = db.prepare(`INSERT INTO users (username, name, role, password_hash, salary, periods, day_off, perms, phone, created_at)
                            VALUES (?, ?, 'employee', ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.username, f.name, f.password_hash || null, f.salary || 0, f.periods ?? null, f.day_off ?? null, f.perms || '[]', f.phone || '', Date.now());
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
  r.get('/api/settings', ({ req, user }) => { requireAdmin(user); return { ...getSettings(db), your_ip: clientIp(req), whatsapp: providerStatus() }; }, { auth: true });
  r.get('/api/notifications', ({ user }) => {
    requireAdmin(user);
    return {
      whatsapp: providerStatus(),
      notifications: db.prepare(`SELECT n.id, n.to_phone, n.body, n.kind, n.status, n.error, n.created_at, n.sent_at, u.name AS user_name
                                 FROM notifications n LEFT JOIN users u ON u.id = n.user_id ORDER BY n.id DESC LIMIT 100`).all(),
    };
  }, { auth: true });
  // Direct WhatsApp link: start, poll for the QR / status, unlink.
  r.get('/api/whatsapp', async ({ user }) => {
    requireAdmin(user);
    return { ...waStatus(), provider: providerStatus().provider, qr: await waQrSvg() };
  }, { auth: true });
  r.post('/api/whatsapp/connect', async ({ user }) => {
    requireAdmin(user);
    if (providerStatus().provider !== 'qr') throw new HttpError(400, 'النظام مضبوط على مزوّد خارجي من متغيرات Railway. احذف متغيرات WHATSAPP_ لاستخدام الربط بالـ QR');
    await waStart();
    audit(db, user.id, 'whatsapp.connect', null, '');
    return waStatus();
  }, { auth: true });
  r.post('/api/whatsapp/logout', async ({ user }) => {
    requireAdmin(user);
    await waLogout();
    audit(db, user.id, 'whatsapp.logout', null, '');
    return waStatus();
  }, { auth: true });
  r.get('/api/notifications/preview', ({ user }) => {
    requireAdmin(user);
    const link = appLink(db) || 'https://wareef-staff.up.railway.app';
    const today = localDate();
    return {
      samples: [
        ['منبّه قبل الدوام', msg.alarmStart({ name: 'عبدالله', period: 'الفترة الصباحية', start: '07:00', now: '06:50', grace: getSettings(db).grace_minutes, link })],
        ['وقت الاستراحة', msg.alarmBreak({ name: 'عبدالله', period: 'الفترة الصباحية', nextStart: '13:00', link })],
        ['نهاية الدوام', msg.alarmEnd({ name: 'عبدالله', end: '21:00', link })],
        ['تذكير بالحضور', msg.remindIn({ name: 'باسم', period: 'الفترة المسائية', start: '13:00', link })],
        ['إشعار خصم', msg.deduction({ amount: 50, date: today, category: 'تأخير', reason: 'تأخير 45 دقيقة يوم السبت', link })],
        ['سلفة', msg.debt({ kind: 'loan', amount: 1000, balance: 1000, note: 'تُخصم على 4 أشهر', link })],
        ['قرار على طلب', msg.requestStatus({ id: 12, kind: 'release', sku: 'AB-1042', qty: 3, status: 'approved', response: 'رجّعها للتاجر يوم الخميس', link })],
        ['للمدير: لم يصل', msg.mgrLate({ name: 'منذر', period: 'الفترة الصباحية', start: '07:00', now: '07:10' })],
        ['للمدير: بصمة مشبوهة', msg.mgrFlag({ name: 'علي', type: 'in', time: '07:02', reasons: ['نفس الجهاز استُخدم لبصمة موظف آخر'] })],
        ['للمدير: طلب فسح', msg.mgrRequest({ name: 'باسم', kind: 'release', sku: 'AB-1042', qty: 3, reason: 'عيب مصنعي في الخياطة' })],
        ['للمدير: طلب إجازة', msg.mgrLeaveRequest({ name: 'صفوان', q: { id: 3, kind: 'leave', from_date: today, to_date: addDays(today, 1), reason: 'ظرف عائلي' } })],
        ['للمدير: طلب إذن خروج', msg.mgrExitRequest({ name: 'علي', time: '10:05', q: { id: 14, minutes: 30, reason: 'مراجعة بنك' } })],
        ['للموظف: موافقة على الخروج', msg.exitDecision({ q: { minutes: 30, status: 'approved', response: '' }, link })],
        ['للمدير: رجع للمكتب', msg.mgrBack({ name: 'علي', time: '10:41', minutes: 30, used: 34, over: 4 })],
        ['للمدير: كل حركة', msg.mgrEntry({ name: 'باسم', date: today, lines: ['▫️ الطلبات المتأخرة: *7*', '▫️ منها متوفرة: *5*', '▫️ منها غير متوفرة: *2*\n> مقاس 56 أسود نافد عند المورد'] })],
        ['رد على أمر واتساب', msg.commandDone({ what: 'طلب الفسح رقم 12', status: 'approved', name: 'باسم', detail: 'AB-1042 × 3' })],
        ['قسيمة الراتب', msg.payslip({ name: 'علي', month: today.slice(0, 7), r: { salary: 4000, presentDays: 25, workDays: 26, absentDays: 1, lateMinutes: 35, deductions: 150, repayments: 500, net: 3350, debtBalance: 1000 }, link })],
        ['موظف الشهر', msg.award({ name: 'عبدالله', month: today.slice(0, 7), score: 96, isYou: false })],
        ['الملخص اليومي', dailySummary(db, today, loadAttendance(db, { from: today, to: today }))],
      ],
    };
  }, { auth: true });
  r.post('/api/notifications/test', async ({ req, user }) => {
    requireAdmin(user);
    const b = parseJson(await readBody(req));
    const to = normalizePhone(b.to || getSettings(db).notify.manager_phone);
    if (!to) throw new HttpError(400, 'اكتب رقم جوال المدير في إعدادات الإشعارات أولاً');
    if (!providerStatus().configured) throw new HttpError(400, 'اربط حساب واتساب أولاً بمسح رمز QR من إعدادات الإشعارات');
    const body = b.kind === 'summary' ? dailySummary(db, localDate(), loadAttendance(db, { from: localDate(), to: localDate() })) : msg.test({ link: appLink(db) });
    const kind = b.kind === 'summary' ? 'summary' : 'test';
    queue(db, { to, body, kind });
    await flush(db);
    const last = db.prepare('SELECT status, error FROM notifications WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
    if (last.status !== 'sent') throw new HttpError(502, `ما وصلت الرسالة: ${last.error || last.status}`);
    return { ok: true };
  }, { auth: true });
  r.put('/api/settings', async ({ req, user }) => {
    requireAdmin(user);
    const s = saveSettings(db, parseJson(await readBody(req)));
    audit(db, user.id, 'settings.update', null, '');
    return s;
  }, { auth: true });

  // ------------------------------------------------------------ exports
  const MONEY_EXPORTS = new Set(['/api/export/payroll', '/api/export/debts', '/api/backup']);
  const exp = (path, fn) => r.get(path, ({ url, res, user }) => {
    if (MONEY_EXPORTS.has(path)) requireAdmin(user); else requireManager(user);
    return fn(url, res, user);
  }, { auth: true });
  exp('/api/export/daily', (url, res, user) => {
    const date = needDate(url.searchParams.get('date'), localDate());
    const d = dailyReport(db, date);
    const money = user.role === 'admin';
    csv(res, `wareef-daily-${date}`, [
      attendanceSection(d.attendance, undefined, money), punchesSection(d.punches),
      opsSection(d.ops ? [d.ops] : [], d.channels, d.metrics), scansSection(d.scans), stockSection(d.stock), requestsSection(d.requests),
      ticketsSection(d.tickets), ...(money ? [deductionsSection(d.deductions), debtsSection(d.debts)] : []),
    ]);
  });
  exp('/api/export/attendance', (url, res, user) => {
    const { from, to } = range(url, 31);
    csv(res, `wareef-attendance-${from}_${to}`, [attendanceSection(loadAttendance(db, { from, to }), undefined, user.role === 'admin')]);
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
    csv(res, `wareef-operations-${from}_${to}`, [opsSection(opsRows(db, from, to), st.channels, st.metrics),
      scansSection(db.prepare('SELECT s.*, u.name AS user_name FROM scans s LEFT JOIN users u ON u.id = s.user_id WHERE s.date BETWEEN ? AND ? ORDER BY s.ts').all(from, to)),
      stockSection(stockRows(db, from, to)), requestsSection(requestRows(db, from, to))]);
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
  r.get('/report/daily.pdf', async ({ url, res, user }) => {
    requireManager(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    let pdf;
    try { pdf = await dailyPdf(db, date); } catch (e) { throw new HttpError(503, `تعذّر إنشاء PDF: ${e.message}`); }
    send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="wareef-daily-${date}.pdf"` });
  }, { auth: true, page: true });
  r.get('/report/daily', ({ url, res, user }) => {
    requireManager(user);
    const date = needDate(url.searchParams.get('date'), localDate());
    send(res, 200, renderDailyReport(dailyReport(db, date)), { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  }, { auth: true, page: true });

  // Payslip: employees see their own once the month is closed; the manager sees anyone's, closed or not.
  r.get('/payslip', ({ url, res, user }) => {
    const month = needMonth(url.searchParams.get('month'));
    const userId = user.role === 'admin' ? Number(url.searchParams.get('user_id')) : user.id;
    const { rows, closed } = payrollFor(db, month);
    if (!closed && user.role !== 'admin') throw new HttpError(404, 'مسيّر هذا الشهر لم يُعتمد بعد');
    const row = rows.find((x) => x.userId === userId);
    if (!row) throw new HttpError(404, 'لا توجد قسيمة');
    const { from, to } = monthBounds(month);
    send(res, 200, renderPayslip({ month, row, closed, deductions: deductionRows(db, from, to, userId), debts: debtRows(db, userId).filter((d) => d.date >= from && d.date <= to) }),
      { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  }, { auth: true, page: true });
  r.get('/report/monthly', ({ url, res, user }) => {
    requireManager(user);
    const d = monthlyData(db, needMonth(url.searchParams.get('month')));
    if (user.role !== 'admin') d.payroll = d.payroll.map(({ salary, suggested, deductions, repayments, net, debtBalance, ...r }) => r);
    send(res, 200, renderMonthlyReport(d, user.role === 'admin'), { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
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
      if (req.method === 'GET' && !pathname.startsWith('/api/')) return await serveStatic(res, pathname, req.headers.range);
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'حدث خطأ غير متوقع' : err.message });
    }
  };
}

async function serveStatic(res, pathname, range = '') {
  const rel = normalize(pathname).replace(/^([/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !extname(rel) || !existsSync(file)) file = join(PUBLIC_DIR, 'index.html');
  const ext = extname(file);
  const body = await readFile(file);
  // audio needs byte ranges so the browser can loop and rewind it
  const m = ext === '.mp3' && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? +m[1] : Math.max(0, body.length - +m[2]);
    const end = m[1] && m[2] ? Math.min(+m[2], body.length - 1) : body.length - 1;
    if (start > end || start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); res.end(); return; }
    res.writeHead(206, { 'Content-Type': MIME[ext], 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, {
    ...(ext === '.mp3' ? { 'Accept-Ranges': 'bytes' } : {}),
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || rel === 'sw.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600',
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
  startNotifier(db, [monthlyTick, exitTick]);
  waOnMessage((phone, text) => handleIncoming(db, phone, text));
  waAutoStart();
  const backup = () => dailyBackup(db).catch((e) => console.error('backup failed', e));
  backup();
  setInterval(backup, 6 * 3600_000).unref();
  createServer(createApp(db)).listen(config.port, () => console.log(`نظام وريف للموظفين يعمل على http://localhost:${config.port}`));
}
