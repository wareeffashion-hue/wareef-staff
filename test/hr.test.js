import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ADMIN_PASSWORD = 'manager123';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wareef-hr-')), 'staff.db');
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/settings.js');
const { localDate, addDays } = await import('../src/time.js');
const { payMonthOf } = await import('../src/payperiod.js');
const { endOfService, overtimeRate, gosiRow, documentsTick, HR_DEFAULTS } = await import('../src/hr/index.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;

before(async () => {
  bootstrap(db);
  saveSettings(db, { notify: { manager_phone: '0500000009', remind_staff: true, shift_alerts: true, alert_manager: true, staff_account: false, daily_summary: true, summary_time: '21:30', alert_all: true, app_url: 'https://staff.example.com' } });
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
const ali = client(); // supervisor
const safwan = client(); // plain employee

test('setup: logins', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  for (const [u, c, perms] of [['ali', ali, ['supervisor']], ['safwan', safwan, []]]) {
    assert.equal((await admin('PUT', `/api/users/${id(u)}`, { password: `${u}-pass1`, salary: 3000, perms, salary_reason: 'الراتب الأساسي' })).status, 200);
    assert.equal((await c('POST', '/api/login', { username: u, password: `${u}-pass1` })).status, 200);
  }
});

test('end of service follows articles 84 and 85', () => {
  const s = 6000;
  const three = endOfService({ salary: s, start: '2023-01-01', end: '2025-12-31', reason: 'end' });
  assert.ok(Math.abs(three.full - s / 2 * (three.days / 365)) < 0.01);
  assert.equal(three.share, 1);
  assert.equal(endOfService({ salary: s, start: '2023-01-01', end: '2025-12-31', reason: 'resign' }).share, 0.33);
  assert.equal(endOfService({ salary: s, start: '2024-06-01', end: '2025-12-31', reason: 'resign' }).amount, 0);
  assert.equal(endOfService({ salary: s, start: '2015-01-01', end: '2025-12-31', reason: 'art80' }).amount, 0);
  const seven = endOfService({ salary: s, start: '2019-01-01', end: '2025-12-31', reason: 'end' });
  assert.ok(Math.abs(seven.full - (s / 2 * 5 + s * (seven.days / 365 - 5))) < 0.01);
  assert.equal(endOfService({ salary: s, start: '2019-01-01', end: '2025-12-31', reason: 'resign' }).share, 0.67);
  assert.throws(() => endOfService({ salary: s, start: '2025-01-01', end: '2024-01-01', reason: 'end' }));
});

test('overtime rate: an hour of pay plus half the basic hour', () => {
  assert.equal(overtimeRate({ salary: 3000, basic: 2000, housing: 750, transport: 250 }), 16.67);
  assert.equal(overtimeRate({ salary: 2400 }), 15); // no parts: all of it is basic
});

test('GOSI: Saudi share on basic + housing, employer only for non-Saudis, nothing when not registered', () => {
  const g = HR_DEFAULTS.gosi;
  assert.deepEqual(gosiRow({ salary: 3000, basic: 2000, housing: 750, saudi: 1, gosi: 1 }, g), { base: 2750, employee: 268.13, employer: 323.13 });
  assert.deepEqual(gosiRow({ salary: 3000, basic: 2000, housing: 750, saudi: 0, gosi: 1 }, g), { base: 2750, employee: 0, employer: 55 });
  assert.equal(gosiRow({ salary: 3000, saudi: 1, gosi: 0 }, g).employer, 0);
});

test('employee file: admin only, IBAN and salary parts checked', async () => {
  assert.equal((await safwan('GET', '/api/hr/files')).status, 403);
  assert.equal((await ali('GET', '/api/hr/files')).status, 403);
  const u = id('safwan');
  assert.equal((await admin('PUT', `/api/hr/files/${u}`, { iban: 'SA12' })).status, 400);
  assert.equal((await admin('PUT', `/api/hr/files/${u}`, { basic: 2500, housing: 750 })).status, 400);
  assert.equal((await admin('PUT', `/api/hr/files/${u}`, { iban: 'sa03 8000 0000 6080 1016 7519', basic: 2000, housing: 750, transport: 250, hire_date: '2024-01-15', job_title: 'مسؤول مبيعات' })).status, 200);
  const f = (await admin('GET', '/api/hr/files')).body.employees.find((e) => e.id === u);
  assert.equal(f.iban, 'SA0380000000608010167519');
  assert.deepEqual(f.parts, { basic: 2000, housing: 750, transport: 250, other: 0 });
});

test('documents: upload, expiry alert once per mark, file served to the owner only', async () => {
  const u = id('safwan');
  const soon = addDays(localDate(), 5);
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  const r = await admin('POST', '/api/hr/documents', { user_id: u, kind: 'iqama', number: '2345678901', expires_on: soon, file: png });
  assert.equal(r.status, 200);
  assert.equal((await admin('POST', '/api/hr/documents', { user_id: u, kind: 'iqama', file: 'data:text/html;base64,PGI+' })).status, 400);
  const file = await admin('GET', `/hr/documents/${r.body.id}/file`);
  assert.equal(file.status, 200);
  assert.equal((await safwan('GET', `/hr/documents/${r.body.id}/file`)).status, 403);
  documentsTick(db);
  documentsTick(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'hr_expiry'").get().n, 1);
  const sum = (await ali('GET', '/api/hr/summary')).body;
  assert.deepEqual(sum.expiring, []); // supervisors don't see document numbers or expiries
  assert.equal((await admin('GET', '/api/hr/summary')).body.expiring[0].days, 5);
});

test('payroll: approved overtime is added and unpaid leave takes a day each', async () => {
  const u = id('safwan');
  const today = localDate();
  const month = payMonthOf(db, today);
  const before = (await admin('GET', `/api/payroll?month=${month}`)).body.rows.find((r) => r.userId === u);
  const ot = await admin('POST', '/api/hr/overtime', { user_id: u, date: today, minutes: 120 });
  assert.equal(ot.status, 200);
  assert.equal(ot.body.amount, 33.34);
  assert.equal((await admin('POST', '/api/excuses', { kind: 'leave', user_id: u, from: today, to: today, unpaid: true })).status, 200);
  const after = (await admin('GET', `/api/payroll?month=${month}`)).body.rows.find((r) => r.userId === u);
  assert.equal(after.overtimePay, 33.34);
  assert.equal(after.unpaidLeave, 100);
  assert.equal(after.unpaidDays, 1);
  assert.equal(Math.round((after.net - before.net) * 100) / 100, Math.round((33.34 - 100 - (after.deductions - before.deductions)) * 100) / 100);
  // a supervisor's leave is never unpaid: only the owner decides that
  assert.equal((await ali('POST', '/api/excuses', { kind: 'leave', user_id: u, from: addDays(today, 1), to: addDays(today, 1), unpaid: true })).status, 200);
  assert.equal(db.prepare('SELECT unpaid FROM excuses WHERE user_id = ? AND date = ?').get(u, addDays(today, 1)).unpaid, 0);
});

test('discipline ladder: a warning first, then a deduction that reaches payroll', async () => {
  const u = id('safwan');
  const v = HR_DEFAULTS.violations[0].name;
  const first = await admin('POST', '/api/hr/discipline', { user_id: u, violation: v });
  assert.equal(first.body.step, 1);
  assert.equal(first.body.amount, 0);
  const preview = await admin('POST', '/api/hr/discipline', { user_id: u, violation: v, preview: true });
  assert.equal(preview.body.step, 2);
  const second = await admin('POST', '/api/hr/discipline', { user_id: u, violation: v });
  assert.equal(second.body.amount, 10); // 10% of a day's pay (3000 / 30)
  const ded = db.prepare("SELECT * FROM deductions WHERE user_id = ? AND category = 'violation'").all(u);
  assert.equal(ded.length, 1);
  assert.equal((await admin('DELETE', `/api/hr/discipline/${second.body.id}`, { reason: 'خطأ' })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deductions WHERE user_id = ? AND category = 'violation'").get(u).n, 0);
  assert.equal((await admin('POST', '/api/hr/discipline', { user_id: u, violation: 'غير موجودة' })).status, 400);
});

test('custody, calendar and end-of-service settlement', async () => {
  const u = id('safwan');
  const c = await admin('POST', '/api/hr/custody', { user_id: u, item: 'جهاز نقاط البيع', value: 900 });
  assert.equal(c.status, 200);
  const e = await admin('GET', `/api/hr/eos?user_id=${u}&reason=resign&end=${localDate()}`);
  assert.equal(e.status, 200);
  assert.equal(e.body.start, '2024-01-15');
  assert.equal(e.body.settlement.custody.length, 1);
  assert.equal((await admin('POST', `/api/hr/custody/${c.body.id}/return`, {})).status, 200);
  assert.equal((await admin('GET', `/api/hr/eos?user_id=${u}&end=${localDate()}`)).body.settlement.custody.length, 0);
  const cal = (await ali('GET', `/api/hr/calendar?month=${localDate().slice(0, 7)}`)).body;
  assert.ok(cal.items.some((i) => i.kind === 'pay'));
  assert.ok(cal.items.some((i) => i.kind === 'lv'));
  assert.equal((await safwan('GET', '/api/hr/calendar')).status, 403);
});
