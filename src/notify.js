// WhatsApp notifications: a queue in the database, a sender that talks to the provider, and a
// once-a-minute scheduler for reminders and the daily summary.
//
// Default: a WhatsApp account linked directly by scanning a QR code from the settings page (see wa.js).
// Alternatively an external gateway, whose credentials live in environment variables, never in the database:
//   UltraMsg:  WHATSAPP_PROVIDER=ultramsg  WHATSAPP_INSTANCE_ID=instance123  WHATSAPP_TOKEN=...
//   Any other HTTP API (most Arabic WhatsApp gateways):
//     WHATSAPP_PROVIDER=custom
//     WHATSAPP_API_URL=https://provider.example/api/send     (may contain {token} and {instance})
//     WHATSAPP_TOKEN=...                WHATSAPP_INSTANCE_ID=... (optional)
//     WHATSAPP_AUTH=bearer | header:X-Api-Key | body:token | query:token | none   (default bearer)
//     WHATSAPP_TO_FIELD=phone           WHATSAPP_TEXT_FIELD=message
//     WHATSAPP_TO_FORMAT=plain | plus | jid   (966..., +966..., 966...@c.us; default plain)
//     WHATSAPP_EXTRA={"instance_id":"..."}   (extra JSON fields merged into the body)
//     WHATSAPP_FORMAT=json | form            (default json)
import { MIN } from './config.js';
import { localDate, localTime, at } from './time.js';
import { getSettings } from './settings.js';
import { loadAttendance } from './attendance.js';
import { opsRows } from './reports.js';
import { waConnected, waSend, waStatus } from './wa.js';
import * as msg from './messages.js';

const env = process.env;

export function providerStatus() {
  const p = (env.WHATSAPP_PROVIDER || (env.WHATSAPP_API_URL ? 'custom' : env.WHATSAPP_INSTANCE_ID ? 'ultramsg' : 'qr')).toLowerCase();
  if (p === 'custom' || p === 'webhook') return { provider: 'custom', configured: !!((env.WHATSAPP_API_URL || env.WHATSAPP_WEBHOOK_URL) && (env.WHATSAPP_TOKEN || env.WHATSAPP_AUTH === 'none')) };
  if (p === 'ultramsg') return { provider: 'ultramsg', configured: !!(env.WHATSAPP_INSTANCE_ID && env.WHATSAPP_TOKEN) };
  return { provider: 'qr', configured: waConnected(), link: waStatus() };
}

/** Builds the HTTP request for a generic gateway from the WHATSAPP_* variables. */
export function customRequest(to, body, e = env) {
  const token = e.WHATSAPP_TOKEN || '';
  let url = (e.WHATSAPP_API_URL || e.WHATSAPP_WEBHOOK_URL || '').replace('{token}', encodeURIComponent(token)).replace('{instance}', encodeURIComponent(e.WHATSAPP_INSTANCE_ID || ''));
  const fmt = (e.WHATSAPP_TO_FORMAT || 'plain').toLowerCase();
  const recipient = fmt === 'plus' ? `+${to}` : fmt === 'jid' ? `${to}@c.us` : to;
  let extra = {};
  try { extra = e.WHATSAPP_EXTRA ? JSON.parse(e.WHATSAPP_EXTRA) : {}; } catch { throw new Error('WHATSAPP_EXTRA ليس JSON صحيحاً'); }
  const payload = { ...extra, [e.WHATSAPP_TO_FIELD || 'phone']: recipient, [e.WHATSAPP_TEXT_FIELD || 'message']: body };
  const headers = {};
  const auth = (e.WHATSAPP_AUTH || 'bearer').trim();
  if (auth === 'bearer') headers.Authorization = `Bearer ${token}`;
  else if (auth.startsWith('header:')) headers[auth.slice(7)] = token;
  else if (auth.startsWith('body:')) payload[auth.slice(5)] = token;
  else if (auth.startsWith('query:')) url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(auth.slice(6))}=${encodeURIComponent(token)}`;
  const form = (e.WHATSAPP_FORMAT || 'json').toLowerCase() === 'form';
  headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
  return { url, init: { method: 'POST', headers, body: form ? new URLSearchParams(payload) : JSON.stringify(payload) } };
}

/** Saudi-friendly normalisation: 05xxxxxxxx → 9665xxxxxxxx. Returns '' if it can't be a phone. */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = `966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) d = `966${d}`;
  return /^\d{10,15}$/.test(d) ? d : '';
}

async function deliver(to, body) {
  const { provider, configured } = providerStatus();
  if (provider === 'qr') return waSend(to, body);
  if (!configured) throw Object.assign(new Error('مزوّد واتساب غير مضبوط'), { skip: true });
  const ctrl = AbortSignal.timeout(15_000);
  let res;
  if (provider === 'custom') {
    const { url, init } = customRequest(to, body);
    res = await fetch(url, { ...init, signal: ctrl });
  } else {
    res = await fetch(`https://api.ultramsg.com/${encodeURIComponent(env.WHATSAPP_INSTANCE_ID)}/messages/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: env.WHATSAPP_TOKEN, to: `+${to}`, body }),
      signal: ctrl,
    });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (/"(error|errors)"\s*:\s*(?!null|false|\[\]|"")/.test(text) || /"(success|status)"\s*:\s*(false|"error"|"failed")/i.test(text)) throw new Error(text.slice(0, 200));
}

/**
 * Queue a message. `key` makes it idempotent: the same key is only ever queued once,
 * so reminders don't repeat every minute.
 */
export function queue(db, { to, body, kind, key = null, userId = null }) {
  const phone = normalizePhone(to);
  if (!phone || !body) return false;
  const r = db.prepare(`INSERT OR IGNORE INTO notifications (to_phone, body, kind, dedupe_key, user_id, status, attempts, created_at)
                        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`).run(phone, body, kind, key, userId, Date.now());
  return r.changes > 0;
}

const phoneOf = (db, userId) => db.prepare('SELECT phone FROM users WHERE id = ? AND active = 1').get(userId)?.phone || '';
const managerPhone = (db) => getSettings(db).notify.manager_phone;
/** The system address shown at the bottom of employee messages. */
export const appLink = (db) => getSettings(db).notify.app_url || env.PUBLIC_URL || '';

/** To the employee about their own account (deduction, loan, replies...). */
export function notifyEmployee(db, userId, kind, body, key = null) {
  if (!getSettings(db).notify.staff_account) return false;
  return queue(db, { to: phoneOf(db, userId), body, kind, key, userId });
}

/** To the manager (alerts). */
export function notifyManager(db, kind, body, key = null) {
  if (!getSettings(db).notify.alert_manager) return false;
  return queue(db, { to: managerPhone(db), body, kind, key });
}

/** Send whatever is pending. Called every few seconds; one message at a time to stay gentle with the provider. */
let sending = false;
export async function flush(db, send = deliver) {
  if (sending) return 0;
  sending = true;
  let sent = 0;
  try {
    // Reminders lose their point after a while; don't flood people when the link comes back.
    db.prepare("UPDATE notifications SET status = 'skipped', error = 'انتهت صلاحية الرسالة قبل إرسالها' WHERE status = 'pending' AND created_at < ?")
      .run(Date.now() - 6 * 60 * MIN);
    const rows = db.prepare("SELECT * FROM notifications WHERE status = 'pending' AND attempts < 3 ORDER BY id LIMIT 20").all();
    for (const n of rows) {
      try {
        await send(n.to_phone, n.body);
        db.prepare("UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?").run(Date.now(), n.id);
        sent++;
      } catch (e) {
        if (e.defer) break; // link temporarily down: leave the queue untouched and try again later
        const status = e.skip ? 'skipped' : n.attempts + 1 >= 3 ? 'failed' : 'pending';
        db.prepare('UPDATE notifications SET status = ?, attempts = attempts + 1, error = ? WHERE id = ?').run(status, String(e.message).slice(0, 300), n.id);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  } finally {
    sending = false;
  }
  return sent;
}

/** Runs once a minute: punch reminders, lateness/absence alerts, daily summary. */
export function tick(db, now = Date.now()) {
  const s = getSettings(db);
  const n = s.notify;
  const date = localDate(now);
  const rows = loadAttendance(db, { from: date, to: date, now });
  const after = (n.remind_after_minutes || 10) * MIN;
  const before = (n.alert_before_minutes || 10) * MIN;
  const within = (t) => now >= t && now < t + 5 * MIN; // fire once, only close to the moment
  const link = appLink(db);
  const nowHHMM = localTime(now);
  for (const r of rows) {
    if (r.status === 'excused' || r.status === 'holiday' || r.status === 'off') continue;
    if (n.shift_alerts) {
      const to = phoneOf(db, r.userId);
      r.periods.forEach((p, i) => {
        const start = at(date, p.start);
        const end = at(date, p.end);
        const next = r.periods[i + 1];
        if (within(start - before) && !p.firstIn) {
          queue(db, { to, userId: r.userId, kind: 'alarm_start', key: `alarm_start:${r.userId}:${date}:${p.id}`,
            body: msg.alarmStart({ name: r.name, period: p.name, start: p.start, now: nowHHMM, grace: s.grace_minutes, link }) });
        }
        if (within(end)) {
          queue(db, { to, userId: r.userId, kind: next ? 'alarm_break' : 'alarm_end', key: `alarm_end:${r.userId}:${date}:${p.id}`,
            body: next
              ? msg.alarmBreak({ name: r.name, period: p.name, nextStart: next.start, link })
              : msg.alarmEnd({ name: r.name, end: p.end, link }) });
        }
      });
    }
    for (const p of r.periods) {
      const start = at(date, p.start);
      const end = at(date, p.end);
      const notArrived = p.state === 'not_arrived' || (p.state === 'running' && !p.firstIn);
      if (notArrived && now >= start + after && now < end) {
        if (n.remind_staff) {
          queue(db, { to: phoneOf(db, r.userId), userId: r.userId, kind: 'remind_in', key: `remind_in:${r.userId}:${date}:${p.id}`,
            body: msg.remindIn({ name: r.name, period: p.name, start: p.start, link }) });
        }
        notifyManager(db, 'late', msg.mgrLate({ name: r.name, period: p.name, start: p.start, now: nowHHMM }), `late:${r.userId}:${date}:${p.id}`);
      }
      if (p.absent && now < end + 30 * MIN) {
        notifyManager(db, 'absent', msg.mgrAbsent({ name: r.name, period: p.name, start: p.start, end: p.end }), `absent:${r.userId}:${date}:${p.id}`);
      }
    }
    const last = r.periods[r.periods.length - 1];
    if (n.remind_staff && last && r.liveState === 'in' && now >= at(date, last.end) + 20 * MIN) {
      queue(db, { to: phoneOf(db, r.userId), userId: r.userId, kind: 'remind_out', key: `remind_out:${r.userId}:${date}`,
        body: msg.remindOut({ name: r.name, end: last.end, link }) });
    }
  }
  if (n.daily_summary && n.manager_phone && localTime(now) >= n.summary_time) {
    queue(db, { to: n.manager_phone, kind: 'summary', key: `summary:${date}`, body: dailySummary(db, date, rows, s) });
  }
}

export function dailySummary(db, date, rows, s = getSettings(db)) {
  const ops = opsRows(db, date, date)[0];
  const scheduled = rows.filter((r) => r.scheduledMinutes > 0);
  const came = rows.filter((r) => ['present', 'late', 'partial', 'off_worked'].includes(r.status));
  const late = rows.filter((r) => r.lateMinutes > 0);
  const absent = rows.filter((r) => r.status === 'absent' || r.status === 'partial');
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const out = ['*وريف · فريق العمل*', '━━━━━━━━━━━━━━━', `📊 *ملخص ${day}*`, ''];
  out.push('👥 *الحضور*');
  out.push(`▫️ حضروا: *${came.length} من ${scheduled.length}*`);
  out.push(`▫️ متأخرون: *${late.length}*${late.length ? `  (${late.map((r) => `${r.name} ${r.lateMinutes}د`).join('، ')})` : ''}`);
  out.push(`▫️ غياب: *${absent.length}*${absent.length ? `  (${absent.map((r) => r.name + (r.status === 'partial' ? ' جزئي' : '')).join('، ')})` : ''}`);
  const exits = rows.filter((r) => r.exitMinutes > 0);
  if (exits.length) out.push(`▫️ خروج أثناء الدوام: ${exits.map((r) => `${r.name} ${r.exitMinutes}د`).join('، ')}`);

  out.push('', '🛒 *الطلبات*');
  if (ops?.totalOrders) {
    out.push(`▫️ الإجمالي: *${num(ops.totalOrders)} طلب*  ·  *${num(Math.round(ops.totalAmount))} ر.س*`);
    for (const c of s.channels) {
      const v = ops.channels[c.key];
      if (v?.count) out.push(`   ${c.name}: ${num(v.count)}${v.amount ? `  (${num(Math.round(v.amount))} ر.س)` : ''}`);
    }
  } else {
    out.push('▫️ _لم تُسجَّل بعد_');
  }

  const missing = [];
  const recorded = [];
  for (const m of s.metrics) {
    const v = ops?.metrics?.[m.key];
    if (v) recorded.push(`▫️ ${m.name}: *${num(v.value)}*${v.note ? `\n> ${v.note.replace(/\n/g, '\n> ')}` : ''}`);
    else missing.push(m.name);
  }
  if (recorded.length) out.push('', '📦 *العمليات*', ...recorded);
  if (missing.length) out.push('', `⚠️ *لم يُسجَّل:* ${missing.join('، ')}`);

  const pending = db.prepare("SELECT COUNT(*) n FROM requests WHERE status = 'pending'").get().n;
  const tickets = db.prepare("SELECT COUNT(*) n FROM tickets WHERE status != 'closed'").get().n;
  if (pending || tickets) out.push('', `📌 *بانتظارك:* ${pending} طلب فسح أو نواقص · ${tickets} تذكرة مفتوحة`);
  const link = appLink(db);
  if (link) out.push('', `🔗 ${link}`);
  out.push('━━━━━━━━━━━━━━━', '_وريف · لوحة المدير_');
  return out.join('\n');
}

export function startNotifier(db) {
  const safe = (fn) => () => { try { const r = fn(); if (r?.catch) r.catch((e) => console.error('notify', e)); } catch (e) { console.error('notify', e); } };
  setInterval(safe(() => tick(db)), 60_000).unref();
  setInterval(safe(() => flush(db)), 15_000).unref();
}
