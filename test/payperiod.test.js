// Payroll month from the 27th of the month before to the 26th: periods, closing, and the switch over.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/settings.js');
const { at } = await import('../src/time.js');
const { assertOpen, closeMonth, payrollFor, reopenMonth } = await import('../src/monthly.js');
const { nominalPeriod, payMonthOf, payPeriod } = await import('../src/payperiod.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
const boss = () => ({ id: id('admin') });
const deduct = (date, amount) => db.prepare("INSERT INTO deductions (user_id, date, amount, category, reason, created_by, created_at) VALUES (?, ?, ?, 'other', '', ?, ?)")
  .run(id('ali'), date, amount, id('admin'), Date.now());
const aliRow = (month) => payrollFor(db, month).rows.find((r) => r.userId === id('ali'));

before(async () => {
  bootstrap(db);
  db.prepare("UPDATE users SET salary = 4000 WHERE username = 'ali'").run();
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('the default stays the calendar month', () => {
  assert.deepEqual(payPeriod(db, '2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(payMonthOf(db, '2026-02-27'), '2026-02');
});

test('start day 27: each month runs from the 27th of the month before to the 26th', () => {
  assert.deepEqual(nominalPeriod('2026-12', 27), { from: '2026-11-27', to: '2026-12-26' });
  assert.deepEqual(nominalPeriod('2027-01', 27), { from: '2026-12-27', to: '2027-01-26' });
  assert.deepEqual(nominalPeriod('2027-03', 27), { from: '2027-02-27', to: '2027-03-26' });
});

test('switching over after a closed calendar month: no day counted twice, none dropped', () => {
  // September closed the old way (1 → 30), then the owner sets the 27th
  deduct('2026-09-28', 100);
  assert.equal(closeMonth(db, boss(), '2026-09', { send: false, now: at('2026-10-01', '09:00') }).ok, true);
  saveSettings(db, { payroll_start_day: 27 });
  assert.deepEqual(payPeriod(db, '2026-09'), { from: '2026-09-01', to: '2026-09-30' }, 'a closed month keeps its dates');
  assert.deepEqual(payPeriod(db, '2026-10'), { from: '2026-10-01', to: '2026-10-26' }, 'the first month starts after the closed one');
  assert.deepEqual(payPeriod(db, '2026-11'), { from: '2026-10-27', to: '2026-11-26' });
  assert.equal(payMonthOf(db, '2026-09-28'), '2026-09');
  assert.equal(payMonthOf(db, '2026-10-26'), '2026-10');
  assert.equal(payMonthOf(db, '2026-10-27'), '2026-11');
  assert.equal(payMonthOf(db, '2026-11-27'), '2026-12');
  assert.equal(aliRow('2026-10').deductions, 0, "September's deduction is not taken again in October");
});

test('deductions from the 27th go to the next month, and a month closes from the 27th', () => {
  deduct('2026-10-26', 50);  // October (1 → 26)
  deduct('2026-10-27', 70);  // November (27/10 → 26/11)
  deduct('2026-11-26', 30);  // November
  deduct('2026-11-27', 200); // December
  assert.equal(aliRow('2026-10').deductions, 50);
  assert.equal(aliRow('2026-11').deductions, 100);
  assert.equal(aliRow('2026-11').net, 3900);
  assert.throws(() => closeMonth(db, boss(), '2026-11', { send: false, now: at('2026-11-26', '22:00') }), /قبل نهايته.*26\/11/);
  assert.equal(closeMonth(db, boss(), '2026-11', { send: false, now: at('2026-11-27', '08:00') }).ok, true);
  assert.deepEqual(payrollFor(db, '2026-11').period, { from: '2026-10-27', to: '2026-11-26' });
  assert.throws(() => assertOpen(db, '2026-11-26'), /مقفل/);
  assert.throws(() => assertOpen(db, '2026-10-27'), /مقفل/);
  assert.doesNotThrow(() => assertOpen(db, '2026-11-27'), "the 27th already belongs to December's open payroll");
  assert.doesNotThrow(() => assertOpen(db, '2026-10-26'), 'October is still open');
});

test('changing the start day later keeps closed months as they were', () => {
  saveSettings(db, { payroll_start_day: 25 });
  assert.deepEqual(payPeriod(db, '2026-11'), { from: '2026-10-27', to: '2026-11-26' });
  assert.deepEqual(payPeriod(db, '2026-12'), { from: '2026-11-27', to: '2026-12-24' }, 'the next month starts right after the closed one');
  assert.deepEqual(payPeriod(db, '2027-01'), { from: '2026-12-25', to: '2027-01-24' });
  assert.deepEqual(payPeriod(db, '2026-10'), { from: '2026-10-01', to: '2026-10-26' }, 'an open month before a closed one ends the day before it');
  saveSettings(db, { payroll_start_day: 27 });
  reopenMonth(db, boss(), '2026-11');
  assert.deepEqual(payPeriod(db, '2026-11'), { from: '2026-10-27', to: '2026-11-26' });
});

test('API: the owner sets the start day; pages default to the payroll month today falls in', async () => {
  const jar = {};
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'X-Requested-With': 'fetch', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  };
  await call('POST', '/api/login', { username: 'admin', password: 'manager123' });
  const s = await call('PUT', '/api/addition-settings', { payroll_start_day: 40 });
  assert.equal(s.body.payroll_start_day, 28, 'kept within 1..28 so every month has the day');
  assert.equal((await call('PUT', '/api/addition-settings', { payroll_start_day: 27 })).body.payroll_start_day, 27);
  const pay = (await call('GET', '/api/payroll?month=2026-11')).body;
  assert.deepEqual(pay.period, { from: '2026-10-27', to: '2026-11-26' });
  const ded = (await call('GET', '/api/deductions?month=2026-11')).body;
  assert.equal(ded.from, '2026-10-27');
  assert.equal(ded.deductions.length, 2);
  const cur = (await call('GET', '/api/payroll')).body;
  assert.match(cur.month, /^\d{4}-\d{2}$/);
  assert.ok(cur.period.from <= cur.period.to);
  const slip = await call('GET', `/payslip?month=2026-11&user_id=${id('ali')}`);
  assert.match(slip.body, /من 2026-10-27 إلى 2026-11-26/);
  const log = db.prepare("SELECT * FROM change_log WHERE action = 'فترة شهر الرواتب' ORDER BY id").all();
  assert.ok(log.length >= 1);
});
