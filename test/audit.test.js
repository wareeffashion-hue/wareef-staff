// Regression tests for the findings of the full system review: permissions, money visibility, dates, payroll, exports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings, getSettings } = await import('../src/settings.js');
const { localDate, addDays, at, isDate, monthBounds } = await import('../src/time.js');
const { closeMonth } = await import('../src/monthly.js');
const { debtBalances, payroll, toCsv } = await import('../src/reports.js');
const { saveSubscription } = await import('../src/push.js');
const { addScan, removeScan } = await import('../src/scans.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;

before(async () => {
  bootstrap(db);
  saveSettings(db, { notify: { manager_phone: '0500000009', alert_manager: true, staff_account: true } });
  db.prepare("UPDATE users SET phone = '966500000001' WHERE username = 'ali'").run();
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
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
}
const admin = client();
const sup = client();   // monther, made a supervisor
const ali = client();
const safwan = client();

test('setup', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  await admin('PUT', `/api/users/${id('monther')}`, { password: 'monther-pass1', perms: ['supervisor'], salary: 4000 });
  await admin('PUT', `/api/users/${id('ali')}`, { password: 'ali-pass1', salary: 3000 });
  await admin('PUT', `/api/users/${id('safwan')}`, { password: 'safwan-pass1', perms: ['m:daily_edits'] });
  for (const [u, c] of [['monther', sup], ['ali', ali], ['safwan', safwan]]) {
    assert.equal((await c('POST', '/api/login', { username: u, password: `${u}-pass1` })).status, 200);
  }
});

test('a supervisor manages the team but never their own record', async () => {
  const own = (await sup('POST', '/api/leaves', { kind: 'leave', from_date: addDays(localDate(), 3), reason: 'سفر' })).body.id;
  assert.equal((await sup('PUT', `/api/leaves/${own}`, { status: 'approved' })).status, 403);
  const other = (await ali('POST', '/api/leaves', { kind: 'leave', from_date: addDays(localDate(), 3), reason: 'سفر' })).body.id;
  assert.equal((await sup('PUT', `/api/leaves/${other}`, { status: 'approved' })).status, 200);
  const today = localDate();
  assert.equal((await sup('POST', '/api/punches', { user_id: id('monther'), date: today, time: '00:01', type: 'in', note: 'نسيت' })).status, 403);
  assert.equal((await sup('POST', '/api/punches', { user_id: id('ali'), date: today, time: '00:01', type: 'in', note: 'نسي' })).status, 200);
  assert.equal((await sup('POST', '/api/excuses', { kind: 'excused', user_id: id('monther'), from: today, to: today })).status, 403);
  assert.equal((await sup('POST', '/api/excuses', { kind: 'holiday', from: today, to: today })).status, 403, 'public holidays are for the owner');
  assert.equal((await admin('PUT', `/api/leaves/${own}`, { status: 'approved' })).status, 200, 'the owner decides it');
});

test('supervisors see no deductions, loans or salary history', async () => {
  const date = localDate();
  assert.equal((await admin('POST', '/api/deductions', { user_id: id('ali'), amount: 75, date, category: 'late', reason: 'تأخير' })).status, 200);
  assert.match((await admin('GET', `/report/daily?date=${date}`)).body, /الخصومات والسلف/);
  assert.doesNotMatch((await sup('GET', `/report/daily?date=${date}`)).body, /الخصومات والسلف/);
  const audit = (await sup('GET', '/api/flags')).body.audit;
  assert.ok(audit.length > 0);
  assert.ok(!audit.some((a) => /^(deduction|debt|payroll)\./.test(a.action)));
  assert.ok(!audit.some((a) => a.action === 'user.update' && /salary/.test(a.details)));
  assert.ok((await admin('GET', '/api/flags')).body.audit.some((a) => a.action === 'deduction.add'));
});

test('sales amounts are for the people who record them', async () => {
  const date = localDate();
  await admin('PUT', `/api/ops/${date}`, { channels: { salla: { count: 4, amount: 900 } } });
  const mine = (await safwan('GET', `/api/ops?from=${date}&to=${date}`)).body;
  assert.equal(mine.ops[0].channels.salla.count, 4);
  assert.equal(mine.ops[0].channels.salla.amount, undefined);
  assert.equal(mine.ops[0].totalAmount, null);
  assert.deepEqual(mine.stock, []);
  assert.equal((await admin('GET', `/api/ops?from=${date}&to=${date}`)).body.ops[0].channels.salla.amount, 900);
});

test('changing the password signs out the other devices', async () => {
  const other = client();
  assert.equal((await other('POST', '/api/login', { username: 'ali', password: 'ali-pass1' })).status, 200);
  assert.equal((await ali('POST', '/api/me/password', { current: 'ali-pass1', password: 'ali-pass2' })).status, 200);
  assert.equal((await other('GET', '/api/me')).status, 401);
  assert.equal((await ali('GET', '/api/me')).status, 200, 'this device stays in');
});

test('password codes: one a minute per account, masked once sent', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'otp'").get().n;
  const anon = client();
  await anon('POST', '/api/reset/request', { username: 'ali' });
  await anon('POST', '/api/reset/request', { username: 'ali' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'otp'").get().n, before + 1);
});

test('dates that do not exist are refused; months only 01-12', async () => {
  assert.equal(isDate('2026-02-31'), false);
  assert.equal(isDate('2026-02-28'), true);
  assert.equal((await admin('POST', '/api/deductions', { user_id: id('ali'), amount: 10, date: '2026-02-31', category: 'late' })).status, 400);
  assert.equal((await admin('GET', '/api/payroll?month=2026-13')).status, 400);
});

test('a month closes only after its last day; loans after the month are not on its payslip', () => {
  const month = '2026-07';
  db.prepare("INSERT INTO debts (user_id, kind, amount, date, note, from_salary, created_by, created_at) VALUES (?, 'loan', 1000, '2026-07-10', '', 0, ?, ?)").run(id('ali'), id('admin'), Date.now());
  db.prepare("INSERT INTO debts (user_id, kind, amount, date, note, from_salary, created_by, created_at) VALUES (?, 'loan', 5000, '2026-08-02', '', 0, ?, ?)").run(id('ali'), id('admin'), Date.now());
  assert.equal(debtBalances(db, monthBounds(month).to).find((b) => b.user_id === id('ali')).balance, 1000);
  assert.equal(payroll(db, month).find((r) => r.userId === id('ali')).debtBalance, 1000);
  const adminUser = { id: id('admin') };
  assert.throws(() => closeMonth(db, adminUser, month, { send: false, now: at('2026-07-31', '20:00') }), /قبل نهايته/);
  assert.equal(closeMonth(db, adminUser, month, { send: false, now: at('2026-08-01', '09:00') }).ok, true);
});

test('a deactivated employee still appears in the payroll of a month they worked', () => {
  const month = '2026-06';
  db.prepare("INSERT INTO punches (user_id, date, ts, type, created_at) VALUES (?, '2026-06-03', ?, 'in', ?)").run(id('basem'), at('2026-06-03', '07:00'), Date.now());
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id('basem'));
  assert.ok(payroll(db, month).some((r) => r.userId === id('basem')));
  assert.ok(!payroll(db, '2026-05').some((r) => r.userId === id('basem')), 'not in months with nothing for them');
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(id('basem'));
});

test('exports: a cell starting with = + - @ stays text in Excel', () => {
  const csv = toCsv([{ title: 't', head: ['a'], rows: [['=HYPERLINK("x")'], ['+1'], ['@cmd'], ['normal'], [-5]] }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /'\+1/);
  assert.match(csv, /'@cmd/);
  assert.match(csv, /\n-5/, 'real negative numbers are left alone');
});

test('phone notifications only to real push services, a handful of devices each', () => {
  assert.throws(() => saveSubscription(db, id('ali'), { endpoint: 'https://169.254.169.254/latest', keys: { p256dh: 'B', auth: 'a' } }), /غير صالح/);
  for (let i = 0; i < 12; i++) saveSubscription(db, id('ali'), { endpoint: `https://fcm.googleapis.com/fcm/send/dev-${i}`, keys: { p256dh: 'B', auth: 'a' } });
  assert.ok(db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?').get(id('ali')).n <= 8);
});

test('undoing the last scan keeps a number that was typed by hand', () => {
  const date = localDate();
  const ab = { id: id('abdullah') };
  db.prepare("INSERT INTO daily_metrics (date, key, value, note, updated_by, updated_at) VALUES (?, 'returns_warehouse', 1, '', ?, ?) ON CONFLICT(date, key) DO UPDATE SET value = 1").run(date, ab.id, Date.now());
  // a scan replaces the hand count with the scan count (1), and undoing it removes the scans' number
  const s = addScan(db, ab, { kind: 'return', code: 'UNDO-1' });
  removeScan(db, ab, s.id, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_metrics WHERE date = ? AND key = 'returns_warehouse'").get(date).n, 0);
  // a hand-typed 40 is never wiped by undoing a scan on another day's flow
  db.prepare("INSERT INTO daily_metrics (date, key, value, note, updated_by, updated_at) VALUES (?, 'shipments', 40, '', ?, ?)").run(date, ab.id, Date.now());
  const s2 = addScan(db, ab, { kind: 'shipment', code: 'UNDO-2' });
  db.prepare("UPDATE daily_metrics SET value = 40 WHERE date = ? AND key = 'shipments'").run(date); // typed again after the scan
  removeScan(db, ab, s2.id, true);
  assert.equal(db.prepare("SELECT value FROM daily_metrics WHERE date = ? AND key = 'shipments'").get(date).value, 40);
});

test('a malformed cookie or path is a clean answer, not a crash', async () => {
  const res = await fetch(`${base}/api/me`, { headers: { Cookie: 'ws_session=%E0%A4%A' } });
  assert.equal(res.status, 401);
  const r2 = await fetch(`${base}/api/exchanges/%E0%A4%A`, { method: 'DELETE', headers: { 'X-Requested-With': 'fetch' } });
  assert.ok(r2.status < 500);
});

test('saving part of the notification settings keeps the rest', () => {
  saveSettings(db, { notify: { ...getSettings(db).notify, remind_staff: true, manager_phone: '0500000009' } });
  saveSettings(db, { notify: { summary_time: '22:00' } });
  const n = getSettings(db).notify;
  assert.equal(n.remind_staff, true);
  assert.equal(n.manager_phone, '0500000009');
  assert.equal(n.summary_time, '22:00');
});
