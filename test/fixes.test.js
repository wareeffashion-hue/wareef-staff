// Owner requests of 2026-11-28: a manual "present" must not stay absent, deductions are 3 times
// their value, the approver may change a recorded deduction's amount, payroll month 27 → 26.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { localDate, addDays, at, weekday } = await import('../src/time.js');
const { computeDay, loadAttendance } = await import('../src/attendance.js');
const { reviewTick } = await import('../src/additions/cases.js');
const { payMonthOf, payPeriod } = await import('../src/payperiod.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
// a past working day (not Friday), at least two days back so it is never "today"
const D = (() => { let d = addDays(localDate(), -2); while (weekday(d) === 5) d = addDays(d, -1); return d; })();
const selfPunch = (u, time, type) => db.prepare("INSERT INTO punches (user_id, date, ts, type, note, source, created_by, flags, created_at) VALUES (?, ?, ?, ?, '', 'self', ?, '[]', ?)")
  .run(id(u), D, at(D, time), type, id(u), Date.now());
const cases = (u) => db.prepare("SELECT * FROM review_cases WHERE user_id = ? AND kind = 'missing_out' ORDER BY id").all(id(u));
const day = (u) => loadAttendance(db, { from: D, to: D, userId: id(u) })[0];

before(async () => {
  bootstrap(db);
  db.prepare('UPDATE users SET created_at = 0').run();
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
const basem = client(); // supervisor who records deductions

test('setup', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  for (const u of ['ali', 'safwan', 'monther']) assert.equal((await admin('PUT', `/api/users/${id(u)}`, { salary: 3000 })).status, 200);
  assert.equal((await admin('PUT', `/api/users/${id('basem')}`, { password: 'basem-pass1', salary: 3000, perms: ['supervisor'] })).status, 200);
  assert.equal((await basem('POST', '/api/login', { username: 'basem', password: 'basem-pass1' })).status, 200);
});

test('manual present: a presence the manager enters never turns into «غياب بانتظار المراجعة»', async () => {
  const r = await admin('POST', '/api/punches', { user_id: id('safwan'), date: D, time: '07:00', type: 'in', note: 'حضر وجواله خربان' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  reviewTick(db, at(D, '12:51'));
  reviewTick(db, at(D, '21:31'));
  assert.equal(cases('safwan').length, 0, 'no missing-checkout case on a manual presence');
  const d = day('safwan');
  assert.equal(d.status, 'present');
  assert.equal(d.absentPeriods, 0);
});

test('manual checkout closes the open case, pending or already approved as absence', async () => {
  selfPunch('ali', '07:00', 'in');
  reviewTick(db, at(D, '12:51'));
  reviewTick(db, at(D, '21:31'));
  const [am, pm] = cases('ali');
  assert.ok(am && pm, 'two cases: no checkout at the break nor at the end');
  assert.equal(day('ali').status, 'review');
  // the supervisor had already confirmed the evening as absence
  assert.equal((await admin('PUT', `/api/cases/${pm.id}`, { status: 'approved' })).status, 200);
  for (const [time, type] of [['12:20', 'out'], ['13:00', 'in'], ['21:00', 'out']]) {
    assert.equal((await admin('POST', '/api/punches', { user_id: id('ali'), date: D, time, type, note: 'نسي البصمة' })).status, 200);
  }
  assert.deepEqual(cases('ali').map((c) => c.status), ['dismissed', 'dismissed']);
  const d = day('ali');
  assert.equal(d.status, 'present');
  assert.equal(d.absentPeriods, 0);
  assert.ok((await admin('GET', '/api/changes?area=attendance')).body.changes.some((x) => x.action === 'إغلاق حالة عدم تسجيل الانصراف ببصمة يدوية'));
});

test('a manual punch that does not fix the checkout leaves the case open', async () => {
  selfPunch('monther', '13:00', 'in');
  reviewTick(db, at(D, '21:31'));
  assert.equal(cases('monther').length, 1);
  // fixing only the arrival time does not add the missing checkout
  assert.equal((await admin('POST', '/api/punches', { user_id: id('monther'), date: D, time: '12:58', type: 'in', note: 'وصل قبل البصمة' })).status, 200);
  assert.equal(cases('monther')[0].status, 'pending');
});

test('deductions are 3 times their value by default, and the setting can change it', async () => {
  const SAT = '2026-10-03';
  const periods = [{ id: 'am', name: 'ص', start: '07:00', end: '12:20' }, { id: 'pm', name: 'م', start: '13:00', end: '21:00' }];
  const p = (t, type) => ({ ts: at(SAT, t), type });
  const base = { date: SAT, periods, now: at(SAT, '23:30'), salary: 3000, lateRate: 3, punches: [p('07:30', 'in'), p('12:20', 'out'), p('13:00', 'in'), p('21:00', 'out')] };
  assert.equal(computeDay(base).suggested, 10, '30 minutes late = 10 riyals');
  assert.equal(computeDay({ ...base, multiplier: 3 }).suggested, 30);
  // a day of absence = a day's basic wage (3000 / 30 = 100) × 3
  assert.equal(computeDay({ ...base, punches: [], multiplier: 3 }).suggested, 300);
  const s = await admin('GET', '/api/settings');
  assert.equal(s.body.deduction_multiplier, 3);
  const att = await admin('GET', `/api/attendance?from=${D}&to=${D}`);
  assert.equal(att.body.multiplier, 3);
});

test('the approver changes a recorded deduction amount before approving it', async () => {
  const r = await basem('POST', '/api/deduction-requests', { user_id: id('ali'), amount: 50, category: 'violation', date: localDate(), reason: 'تأخير تسليم الطلبات' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin('PUT', `/api/deduction-requests/${r.body.id}`, { status: 'approved', amount: 'abc' })).status, 400, 'a bad amount is refused');
  assert.equal((await admin('PUT', `/api/deduction-requests/${r.body.id}`, { status: 'approved', amount: 150 })).status, 200);
  const ded = db.prepare("SELECT * FROM deductions WHERE user_id = ? AND category = 'violation'").get(id('ali'));
  assert.equal(ded.amount, 150);
  assert.equal(db.prepare('SELECT amount FROM deduction_requests WHERE id = ?').get(r.body.id).amount, 150);
  const log = (await admin('GET', '/api/changes?area=salary')).body.changes.find((x) => x.action === 'تعديل مبلغ خصم مسجّل قبل اعتماده');
  assert.ok(log && /50/.test(log.before) && /150/.test(log.after));
  // approving without an amount keeps what was recorded
  const r2 = await basem('POST', '/api/deduction-requests', { user_id: id('safwan'), amount: 20, category: 'other', date: localDate(), reason: 'سبب آخر' });
  assert.equal((await admin('PUT', `/api/deduction-requests/${r2.body.id}`, { status: 'approved' })).status, 200);
  assert.equal(db.prepare('SELECT amount FROM deductions WHERE id = (SELECT deduction_id FROM deduction_requests WHERE id = ?)').get(r2.body.id).amount, 20);
});

test('payroll month 27 → 26 by default, and the employee page follows it', async () => {
  assert.deepEqual(payPeriod(db, '2026-12'), { from: '2026-11-27', to: '2026-12-26' });
  const month = payMonthOf(db, localDate());
  const pf = await admin('GET', `/api/profile?user_id=${id('ali')}`);
  assert.equal(pf.status, 200, JSON.stringify(pf.body));
  assert.equal(pf.body.month, month);
  assert.deepEqual(pf.body.salary.period, payPeriod(db, month));
  assert.ok(pf.body.attendance.days.every((d) => d.date >= payPeriod(db, month).from));
});
