import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/settings.js');
const { localDate, addDays, at } = await import('../src/time.js');
const { parseCommand, handleIncoming } = await import('../src/commands.js');
const { monthlyTick, monthlySummary } = await import('../src/monthly.js');
const { backupTick } = await import('../src/notify.js');
const { performance } = await import('../src/performance.js');

let server;
let base;
const db = openDb(':memory:');
const MGR = '966500000009';
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
const notes = (where = '1=1', ...a) => db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id`).all(...a);

before(async () => {
  bootstrap(db);
  saveSettings(db, { notify: { manager_phone: '0500000009', remind_staff: true, shift_alerts: true, alert_manager: true, staff_account: true, daily_summary: true, summary_time: '21:30', alert_all: true } });
  const phones = { ali: '0500000001', basem: '0500000002', abdulmalik: '0500000006', monther: '0500000003' };
  for (const [u, p] of Object.entries(phones)) db.prepare("UPDATE users SET phone = ? WHERE username = ?").run(`966${p.slice(1)}`, u);
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  const jar = {};
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Requested-With': 'fetch', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
}
const admin = client();
const ali = client();
const basem = client();
const monther = client();
const malik = client();

test('setup: logins', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  for (const [u, c] of [['ali', ali], ['basem', basem], ['monther', monther], ['abdulmalik', malik]]) {
    assert.equal((await admin('PUT', `/api/users/${id(u)}`, { password: `${u}-pass1`, salary: 3000 })).status, 200);
    assert.equal((await c('POST', '/api/login', { username: u, password: `${u}-pass1` })).status, 200);
  }
});

test('Basem records late orders and whether they are available', async () => {
  const me = (await basem('GET', '/api/me')).body;
  assert.ok(['m:late_orders', 'm:late_available', 'm:late_unavailable', 'requests'].every((p) => me.user.perms.includes(p)));
  assert.ok(me.metrics.some((m) => m.key === 'late_unavailable' && m.note));
  const r = await basem('PUT', `/api/ops/${localDate()}`, { metrics: { late_orders: { value: 7 }, late_available: { value: 5 }, late_unavailable: { value: 2, note: 'مقاس 56 نافد' } } });
  assert.equal(r.status, 200);
  const n = notes("kind = 'entry'");
  assert.equal(n.length, 1, 'the manager hears about it');
  assert.equal(n[0].to_phone, MGR);
  assert.match(n[0].body, /الطلبات المتأخرة: \*7\*/);
  assert.match(n[0].body, /> مقاس 56 نافد/);
});

test('every punch reaches the manager', async () => {
  assert.equal((await ali('POST', '/api/punch', { type: 'in' })).status, 200);
  const p = notes("kind = 'punch'");
  assert.equal(p.length, 1);
  assert.match(p[0].body, /تسجيل حضور: علي/);
});

test('leave requests: employee asks, manager decides, days become excuses', async () => {
  const from = addDays(localDate(), 2);
  const r = await ali('POST', '/api/leaves', { kind: 'leave', from_date: from, to_date: addDays(from, 1), reason: 'سفر' });
  assert.equal(r.status, 200);
  assert.match(notes("kind = 'leave_request'")[0].body, new RegExp(`موافق ج${r.body.id}`));
  assert.equal((await ali('PUT', `/api/leaves/${r.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await admin('PUT', `/api/leaves/${r.body.id}`, { status: 'approved', response: 'بالتوفيق' })).status, 200);
  const ex = db.prepare('SELECT * FROM excuses WHERE user_id = ? ORDER BY date').all(id('ali'));
  assert.deepEqual(ex.map((e) => e.date), [from, addDays(from, 1)]);
  assert.match(notes("kind = 'leave_status'")[0].body, /تمت الموافقة/);
  // Rejecting later removes the excuses again.
  await admin('PUT', `/api/leaves/${r.body.id}`, { status: 'rejected' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM excuses WHERE user_id = ?').get(id('ali')).n, 0);
  const mine = (await ali('GET', '/api/leaves')).body.leaves;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'rejected');
  // bad input
  assert.equal((await ali('POST', '/api/leaves', { kind: 'permission', from_date: localDate(), from_time: '10:00', to_time: '09:00', reason: 'x' })).status, 400);
});

test('request decisions reach the requester, Basem and Abdulmalik', async () => {
  const q = (await basem('POST', '/api/requests', { kind: 'release', sku: 'AB-1', quantity: 3, reason: 'عيب' })).body;
  assert.equal((await admin('PUT', `/api/requests/${q.id}`, { status: 'approved', response: 'تمام' })).status, 200);
  const sent = notes("kind = 'request_status'");
  const to = sent.map((n) => n.to_phone).sort();
  assert.deepEqual(to, ['966500000002', '966500000006'], 'Basem once (requester), Abdulmalik (stock)');
  assert.match(sent.find((n) => n.to_phone === '966500000006').body, /رفعه: \*باسم\*/);
});

test('WhatsApp replies from the manager approve requests and leaves', async () => {
  assert.deepEqual(parseCommand('موافق ف12'), { status: 'approved', target: 'request', id: 12, reason: '' });
  assert.deepEqual(parseCommand('*رفض ج٣* ما يمدي هالأسبوع'), { status: 'rejected', target: 'leave', id: 3, reason: 'ما يمدي هالأسبوع' });
  assert.equal(parseCommand('تم ف 7').status, 'done');
  assert.equal(parseCommand('تم ج7'), null);
  assert.equal(parseCommand('السلام عليكم'), null);
  assert.deepEqual(parseCommand('طلبات'), { help: true });

  const q = (await basem('POST', '/api/requests', { kind: 'shortage', sku: 'ZZ-9', quantity: 10, reason: 'نفد' })).body;
  assert.equal(handleIncoming(db, '966500000002', `موافق ف${q.id}`), null, 'only the manager is listened to');
  assert.match(handleIncoming(db, MGR, 'طلبات'), new RegExp(`ف${q.id}`));
  assert.match(handleIncoming(db, MGR, `رفض ف${q.id} السعر عالي`), /تم الرفض/);
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(q.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.response, 'السعر عالي');
  assert.match(handleIncoming(db, MGR, 'موافق ف99999'), /ما تم التنفيذ/);

  const l = (await monther('POST', '/api/leaves', { kind: 'permission', from_date: localDate(), from_time: '10:00', to_time: '11:00', reason: 'مراجعة' })).body;
  assert.match(handleIncoming(db, MGR, `موافق ج${l.id}`), /تمت الموافقة/);
  assert.equal(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(l.id).status, 'approved');
});

test('merchant returns move ready → sent → settled', async () => {
  const r = await malik('POST', '/api/stock', { kind: 'merchant_return', party: 'مصنع النخبة', invoice_no: 'R-1', lines: [{ sku: 'A1', quantity: 2 }, { sku: 'A2', quantity: 1 }] });
  assert.equal(r.status, 200);
  assert.match(notes("kind = 'stock'")[0].body, /A1 × 2/);
  const rows = db.prepare("SELECT status FROM stock_moves WHERE kind = 'merchant_return'").all();
  assert.ok(rows.every((x) => x.status === 'ready'));
  assert.equal((await ali('PUT', `/api/stock/${r.body.ids[0]}/status`, { status: 'sent' })).status, 403);
  assert.equal((await malik('PUT', `/api/stock/${r.body.ids[0]}/status`, { status: 'sent', all: true, note: 'مع سمسا' })).status, 200);
  assert.deepEqual(db.prepare("SELECT status FROM stock_moves WHERE kind = 'merchant_return' ORDER BY id").all().map((x) => x.status), ['sent', 'sent']);
  assert.match(notes("kind = 'stock_status'")[0].body, /أُرسل للتاجر/);
});

test('supervisor sees attendance but no money', async () => {
  await admin('PUT', `/api/users/${id('monther')}`, { perms: ['supervisor', 'm:pending_issues'] });
  const me = (await monther('GET', '/api/me')).body;
  assert.equal(me.user.manager, true);
  const dash = await monther('GET', '/api/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.attendance.every((r) => !('suggested' in r)));
  assert.equal((await monther('GET', '/api/payroll')).status, 403);
  assert.equal((await monther('GET', '/api/users')).status, 403);
  assert.equal((await monther('GET', '/api/export/payroll')).status, 403);
  assert.equal((await monther('GET', '/api/performance')).status, 200);
  assert.equal((await monther('GET', '/report/monthly')).status, 200);
});

test('month close freezes payroll, locks money, sends payslips', async () => {
  const month = addDays(`${localDate().slice(0, 7)}-01`, -1).slice(0, 7);
  assert.equal((await admin('POST', '/api/deductions', { user_id: id('ali'), amount: 100, date: `${month}-10`, category: 'late' })).status, 200);
  assert.equal((await admin('POST', '/api/payroll/close', { month: localDate().slice(0, 7) })).status, 400, 'not before the month ends');
  assert.equal((await ali('GET', `/payslip?month=${month}`)).status, 404, 'no payslip before closing');
  const c = await admin('POST', '/api/payroll/close', { month });
  assert.equal(c.status, 200);
  assert.ok(c.body.sent >= 1);
  assert.match(notes("kind = 'payslip' AND to_phone = '966500000001'")[0].body, /صافي الراتب: \*2,900 ر\.س\*/);
  const p = await admin('GET', `/api/payroll?month=${month}`);
  assert.ok(p.body.closed);
  assert.equal((await admin('POST', '/api/deductions', { user_id: id('ali'), amount: 5, date: `${month}-11` })).status, 400);
  const slip = await ali('GET', `/payslip?month=${month}`);
  assert.equal(slip.status, 200);
  assert.match(slip.body, /قسيمة راتب/);
  assert.match(slip.body, /2,900/);
  assert.equal((await admin('DELETE', `/api/payroll/close/${month}`)).status, 200);
  assert.equal((await admin('POST', '/api/deductions', { user_id: id('ali'), amount: 5, date: `${month}-11` })).status, 200);
});

test('performance board and employee of the month', async () => {
  const month = localDate().slice(0, 7);
  const rows = performance(db, month);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r, i) => i === 0 || (rows[i - 1].score ?? -1) >= (r.score ?? -1)));
  const basemRow = rows.find((r) => r.name === 'باسم');
  assert.ok(basemRow.metrics.some((m) => m.key === 'late_orders' && m.total === 7));
  const a = await admin('POST', '/api/awards', { month, user_id: id('ali') });
  assert.equal(a.status, 200);
  assert.equal(a.body.award.name, 'علي');
  const aw = notes("kind = 'award'");
  assert.ok(aw.some((n) => n.to_phone === '966500000001' && /مبروك علي/.test(n.body)));
  assert.ok(aw.some((n) => n.to_phone === '966500000002' && /نبارك لزميلنا \*علي\*/.test(n.body)));
});

test('analytics and the monthly report', async () => {
  const a = await admin('GET', `/api/analytics?from=${addDays(localDate(), -6)}&to=${localDate()}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.days.length, 7);
  assert.equal(a.body.days.at(-1).metrics.late_orders, 7);
  const page = await admin('GET', `/report/monthly?month=${localDate().slice(0, 7)}`);
  assert.match(page.body, /التقرير الشهري/);
  assert.match(page.body, /تقييم الأداء/);
  assert.match(monthlySummary(db, localDate().slice(0, 7)), /تقرير شهر/);
});

test('on the 1st: monthly report to the manager, award announced once', () => {
  const first = at('2026-11-01', '09:05');
  monthlyTick(db, at('2026-11-01', '08:59'));
  assert.equal(notes("kind = 'monthly'").length, 0);
  monthlyTick(db, first);
  monthlyTick(db, first + 60_000);
  assert.equal(notes("kind = 'monthly' AND dedupe_key = 'monthly:2026-10'").length, 1);
});

test('nightly backup is queued once', () => {
  const t = at(localDate(), '23:31');
  backupTick(db, t);
  backupTick(db, t + 60_000);
  assert.equal(notes("kind = 'backup'").length, 1);
});

test('password reset with a WhatsApp code', async () => {
  const anon = client();
  assert.equal((await anon('POST', '/api/reset/request', { username: 'nobody' })).status, 200, 'same answer for unknown users');
  assert.equal((await anon('POST', '/api/reset/request', { username: 'basem' })).status, 200);
  const otp = notes("kind = 'otp'").at(-1);
  assert.equal(otp.to_phone, '966500000002');
  const code = otp.body.match(/\*(\d{6})\*/)[1];
  assert.equal((await anon('POST', '/api/reset/confirm', { username: 'basem', code: '000000' === code ? '111111' : '000000', password: 'newpass1' })).status, 400);
  assert.equal((await anon('POST', '/api/reset/confirm', { username: 'basem', code, password: 'newpass1' })).status, 200);
  assert.equal((await anon('POST', '/api/reset/confirm', { username: 'basem', code, password: 'newpass2' })).status, 400, 'one use');
  assert.equal((await basem('GET', '/api/me')).status, 401, 'old sessions are signed out');
  assert.equal((await anon('POST', '/api/login', { username: 'basem', password: 'newpass1' })).status, 200);
});

test('exit permission: ask for minutes, manager approves, out now, back to the office', async () => {
  const { exitTick } = await import('../src/exits.js');
  const mon = client();
  await admin('PUT', `/api/users/${id('safwan')}`, { password: 'safwan-pass1', phone: '0500000004' });
  assert.equal((await mon('POST', '/api/login', { username: 'safwan', password: 'safwan-pass1' })).status, 200);
  assert.equal((await mon('POST', '/api/exit-requests', { minutes: 20, reason: 'بنك' })).status, 400, 'must be clocked in');
  await mon('POST', '/api/punch', { type: 'in' });
  const back5 = () => db.prepare('UPDATE punches SET ts = ts - 300000 WHERE user_id = ?').run(id('safwan'));
  back5();
  assert.equal((await mon('POST', '/api/exit-requests', { minutes: 2, reason: 'x' })).status, 400, 'at least 5 minutes');
  const r = await mon('POST', '/api/exit-requests', { minutes: 20, reason: 'مراجعة بنك' });
  assert.equal(r.status, 200);
  const x = r.body.exit;
  assert.equal(x.status, 'pending');
  assert.equal((await mon('POST', '/api/exit-requests', { minutes: 20, reason: 'مرة ثانية' })).status, 400, 'one open request at a time');
  const ask = notes("kind = 'exit_request'").at(-1);
  assert.equal(ask.to_phone, MGR);
  assert.match(ask.body, new RegExp(`موافق ج${x.id}`));
  assert.match(ask.body, /20 دقيقة/);
  // not usable before approval
  assert.equal((await mon('POST', '/api/punch', { type: 'leave', exit_id: x.id })).status, 400);
  assert.equal((await mon('GET', '/api/dashboard')).status, 403);
  assert.equal((await admin('GET', '/api/dashboard')).body.exits.length, 1);
  assert.match(handleIncoming(db, MGR, `موافق ج${x.id}`), /تمت الموافقة/);
  assert.match(notes("kind = 'leave_status' AND to_phone = '966500000004'").at(-1).body, /اخرج الآن/);
  back5();
  const out = await mon('POST', '/api/punch', { type: 'leave', exit_id: x.id });
  assert.equal(out.status, 200);
  assert.ok(out.body.exit.left_at);
  assert.match(notes("kind = 'leave'").at(-1).body, /بإذن 20 دقيقة/);
  assert.equal((await mon('POST', '/api/punch', { type: 'leave', exit_id: x.id })).status, 400);
  // overrun reminder fires once, 2 minutes after the window
  const left = out.body.exit.left_at;
  exitTick(db, left + 21 * 60_000);
  assert.equal(notes("kind = 'exit_over'").length, 0);
  exitTick(db, left + 23 * 60_000);
  exitTick(db, left + 24 * 60_000);
  assert.equal(notes("kind = 'exit_over'").length, 2, 'employee and manager, once each');
  // step out 5 minutes ago (the punch and the permission window move together)
  const { localTime } = await import('../src/time.js');
  const lp = db.prepare("SELECT * FROM punches WHERE user_id = ? AND type = 'leave' ORDER BY id DESC LIMIT 1").get(id('safwan'));
  const t0 = lp.ts - 300000;
  db.prepare('UPDATE punches SET ts = ? WHERE id = ?').run(t0, lp.id);
  db.prepare('UPDATE leave_requests SET left_at = ?, from_time = ?, to_time = ? WHERE id = ?').run(t0, localTime(t0), localTime(t0 + 20 * 60_000), x.id);
  const back = await mon('POST', '/api/punch', { type: 'back' });
  assert.equal(back.status, 200);
  assert.ok(back.body.exit.back_at);
  assert.match(notes("kind = 'back'").at(-1).body, /رجع للمكتب: صفوان[\s\S]*الإذن: \*20 دقيقة\*/);
  // the approved window is covered time, not an exit
  const { loadAttendance } = await import('../src/attendance.js');
  const row = loadAttendance(db, { from: localDate(), to: localDate(), userId: id('safwan') })[0];
  assert.equal(row.exitMinutes, 0);
});

test('daily report as PDF, and its WhatsApp caption', async () => {
  const { summaryCaption } = await import('../src/notify.js');
  const { chromiumPath } = await import('../src/pdf.js');
  const cap = summaryCaption(db, localDate());
  assert.match(cap, /التقرير اليومي الشامل/);
  assert.match(cap, /حضروا: \*/);
  assert.match(cap, /الملف المرفق/);
  assert.equal((await ali('GET', `/report/daily.pdf?date=${localDate()}`)).status, 403);
  if (!chromiumPath()) return; // no Chromium on this machine
  assert.equal((await fetch(`${base}/report/daily.pdf?date=${localDate()}`, { redirect: 'manual' })).status, 302, 'needs a session');
  const pdf = await admin('GET', `/report/daily.pdf?date=${localDate()}`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.body.startsWith('%PDF'));
});

test('barcode: shipments and returns are counted from scans, once per code', async () => {
  const ab = client();
  await admin('PUT', `/api/users/${id('abdullah')}`, { password: 'abdullah-pass1' });
  assert.equal((await ab('POST', '/api/login', { username: 'abdullah', password: 'abdullah-pass1' })).status, 200);
  assert.ok((await ab('GET', '/api/me')).body.user.perms.includes('scan'), 'Abdullah can scan by default');
  assert.equal((await ali('POST', '/api/scans', { kind: 'shipment', code: 'X1' })).status, 403);
  const a = await ab('POST', '/api/scans', { kind: 'shipment', code: ' SMSA-1001 ' });
  assert.equal(a.status, 200);
  assert.equal(a.body.count, 1);
  assert.equal((await ab('POST', '/api/scans', { kind: 'shipment', code: 'SMSA-1002' })).body.count, 2);
  const dup = await ab('POST', '/api/scans', { kind: 'shipment', code: 'SMSA-1001' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /مسجّل مسبقاً/);
  assert.match(notes("kind = 'scan_dup'").at(-1).body, /مسح مكرر/);
  const metric = () => db.prepare("SELECT value FROM daily_metrics WHERE date = ? AND key = ?").get(localDate(), 'shipments')?.value;
  assert.equal(metric(), 2, 'the daily number follows the scans');
  // the manual number is locked on days with scans
  const manual = await ab('PUT', `/api/ops/${localDate()}`, { metrics: { shipments: { value: 99 } } });
  assert.equal(manual.status, 400);
  assert.equal(metric(), 2);
  // a customer return of something we shipped says so
  const ret = await ab('POST', '/api/scans', { kind: 'return', code: 'SMSA-1001' });
  assert.equal(ret.status, 200);
  assert.match(ret.body.note, /شُحن يوم/);
  assert.equal(db.prepare("SELECT value FROM daily_metrics WHERE date = ? AND key = 'returns_warehouse'").get(localDate()).value, 1);
  // undo
  assert.equal((await ab('DELETE', `/api/scans/${a.body.id}`)).body.count, 1);
  assert.equal(metric(), 1);
  const list = await ab('GET', '/api/scans?kind=shipment');
  assert.deepEqual(list.body.scans.map((s) => s.code), ['SMSA-1002']);
  // reports carry the scans
  const daily = await admin('GET', `/report/daily?date=${localDate()}`);
  assert.match(daily.body, /المسح بالباركود/);
  assert.match(daily.body, /SMSA-1002/);
});

test('phone notifications: alarms and decisions reach subscribed devices, once', async () => {
  const { setPushSender, cardToPush } = await import('../src/push.js');
  const { tick } = await import('../src/notify.js');
  const sent = [];
  setPushSender(async (sub, payload, opts) => { sent.push({ to: sub.endpoint, ...JSON.parse(payload), urgency: opts.urgency }); });
  const key = (await ali('GET', '/api/push/key')).body.key;
  assert.ok(key.length > 60);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/ali-phone', keys: { p256dh: 'BOr', auth: 'xyz' } };
  assert.equal((await ali('POST', '/api/push/subscribe', { subscription: sub })).body.devices, 1);
  assert.equal((await ali('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://x' } })).status, 400);
  await admin('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/boss', keys: { p256dh: 'B', auth: 'a' } } });
  // the WhatsApp card becomes a short notification
  const c = cardToPush('*وريف · فريق العمل*\n━━━━━━━━━━━━━━━\n⏰ *منبّه الفترة الصباحية*\n\nصباح الخير علي 🌤️\nفترتك تبدأ الساعة *07:00*\n━━━━━━━━━━━━━━━\n✨ _فريق واحد، هدف واحد_');
  assert.equal(c.title, '⏰ منبّه الفترة الصباحية');
  assert.match(c.body, /فترتك تبدأ الساعة 07:00/);
  assert.doesNotMatch(c.body, /فريق واحد/);
  // the morning alarm goes to the phone too, urgent, and only once
  const day = '2026-10-17';
  tick(db, at(day, '06:50')); tick(db, at(day, '06:51'));
  await new Promise((r) => setTimeout(r, 30));
  const alarms = sent.filter((s) => s.to.endsWith('ali-phone') && /منبّه/.test(s.title));
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].urgent, true);
  assert.equal(alarms[0].urgency, 'high');
  // manager alerts reach the manager's device
  const before = sent.length;
  const q = (await ali('POST', '/api/leaves', { kind: 'leave', from_date: addDays(localDate(), 5), reason: 'سفر' })).body;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sent.slice(before).some((s) => s.to.endsWith('boss') && /طلب إجازة/.test(s.title)));
  await admin('PUT', `/api/leaves/${q.id}`, { status: 'approved' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sent.some((s) => s.to.endsWith('ali-phone') && /تمت الموافقة/.test(s.title) && s.url === '/#/leaves'));
  // test button, and a dead device is removed
  setPushSender(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); });
  assert.equal((await ali('POST', '/api/push/test')).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%ali-phone'").get().n, 0);
  assert.equal((await ali('POST', '/api/push/test')).status, 400);
});
