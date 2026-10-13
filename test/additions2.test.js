import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/settings.js');
const { localDate, addDays, at, weekday } = await import('../src/time.js');
const { loadAttendance } = await import('../src/attendance.js');
const { reviewTick } = await import('../src/additions/cases.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
const notes = (where = '1=1', ...a) => db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id`).all(...a);
// a past working day (Saturday to Thursday) in the current month when possible
const D = (() => { let d = addDays(localDate(), -1); while (weekday(d) === 5) d = addDays(d, -1); return d; })();
const punch = (u, time, type, note = '') => db.prepare("INSERT INTO punches (user_id, date, ts, type, note, source, created_by, flags, created_at) VALUES (?, ?, ?, ?, ?, 'self', ?, '[]', ?)")
  .run(id(u), D, at(D, time), type, note, id(u), Date.now());
const cases = (u, kind) => db.prepare('SELECT * FROM review_cases WHERE user_id = ? AND kind = ? ORDER BY id').all(id(u), kind);

before(async () => {
  bootstrap(db);
  saveSettings(db, { notify: { manager_phone: '0500000009', staff_account: true, app_url: 'https://staff.example.com' } });
  db.prepare('UPDATE users SET created_at = 0').run();
  const phones = { ali: '0500000001', basem: '0500000002', monther: '0500000003', safwan: '0500000004', abdulmalik: '0500000006' };
  for (const [u, p] of Object.entries(phones)) db.prepare('UPDATE users SET phone = ? WHERE username = ?').run(`966${p.slice(1)}`, u);
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
const basem = client(); // supervisor
const ali = client();
const safwan = client();
const malik = client(); // accountant

test('setup', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  const perms = { basem: ['supervisor'], ali: [], safwan: [], abdulmalik: ['accountant'] };
  for (const [u, c] of [['basem', basem], ['ali', ali], ['safwan', safwan], ['abdulmalik', malik]]) {
    assert.equal((await admin('PUT', `/api/users/${id(u)}`, { password: `${u}-pass1`, salary: 3000, perms: perms[u] })).status, 200);
    assert.equal((await c('POST', '/api/login', { username: u, password: `${u}-pass1` })).status, 200);
  }
});

test('missing checkout: a case half an hour after the period, the day under review, approval makes it absence', async () => {
  punch('ali', '07:00', 'in');
  assert.equal(reviewTick(db, at(D, '12:49')), 0);
  assert.equal(reviewTick(db, at(D, '12:51')), 1);
  assert.equal(reviewTick(db, at(D, '12:55')), 0, 'once');
  const [c] = cases('ali', 'missing_out');
  assert.equal(c.ref, 'am');
  assert.ok(notes("kind = 'review_case'").length >= 1, 'supervisors told');
  assert.equal(notes("kind = 'review_case_employee' AND user_id = ?", id('ali')).length, 1, 'the employee told');
  let day = loadAttendance(db, { from: D, to: D, userId: id('ali') })[0];
  assert.equal(day.status, 'review');
  // the employee cannot decide; a dismissal needs a reason
  assert.equal((await ali('PUT', `/api/cases/${c.id}`, { status: 'approved' })).status, 403);
  assert.equal((await basem('PUT', `/api/cases/${c.id}`, { status: 'dismissed' })).status, 400);
  assert.equal((await basem('PUT', `/api/cases/${c.id}`, { status: 'approved' })).status, 200);
  day = loadAttendance(db, { from: D, to: D, userId: id('ali') })[0];
  assert.equal(day.periods.find((p) => p.id === 'am').absent, true);
  assert.notEqual(day.status, 'review');
  assert.ok((await admin('GET', '/api/changes?area=attendance')).body.changes.some((x) => x.action === 'اعتماد غياب لعدم تسجيل الانصراف'));
  assert.equal((await basem('PUT', `/api/cases/${c.id}`, { status: 'approved' })).status, 400, 'decided once');
});

test('a checkout correction closes the open case', async () => {
  punch('monther', '13:00', 'in');
  reviewTick(db, at(D, '21:31'));
  const [c] = cases('monther', 'missing_out');
  assert.ok(c && c.ref === 'pm');
  const monther = client();
  await admin('PUT', `/api/users/${id('monther')}`, { password: 'monther-pass1' });
  await monther('POST', '/api/login', { username: 'monther', password: 'monther-pass1' });
  const r = await monther('POST', '/api/corrections', { date: D, type: 'out', time: '21:00', reason: 'نسيت البصمة' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await basem('PUT', `/api/corrections/${r.body.id}`, { status: 'approved' })).status, 200);
  assert.equal(cases('monther', 'missing_out')[0].status, 'dismissed');
});

test('exit without permission: priced like lateness, only inside working hours, minus approved permission', async () => {
  punch('safwan', '07:00', 'in');
  punch('safwan', '09:00', 'leave', 'مشوار');
  punch('safwan', '09:30', 'back');
  punch('safwan', '12:10', 'leave', 'غداء');
  punch('safwan', '13:10', 'back');
  // an approved permission 09:00–09:15
  db.prepare("INSERT INTO leave_requests (user_id, kind, from_date, to_date, from_time, to_time, reason, minutes, status, created_at, updated_at) VALUES (?, 'permission', ?, ?, '09:00', '09:15', 'إذن', 15, 'approved', 0, 0)").run(id('safwan'), D, D);
  reviewTick(db, at(D, '13:15'));
  const ex = cases('safwan', 'unauthorized_exit');
  assert.equal(ex.length, 2);
  assert.equal(ex[0].minutes, 15);
  assert.equal(ex[0].amount, 5);
  assert.equal(ex[1].minutes, 20, '10 minutes before the break and 10 after it');
  // the supervisor approves with the proposed amount; the deduction is recorded
  assert.equal((await basem('PUT', `/api/cases/${ex[0].id}`, { status: 'approved' })).status, 200);
  const ded = db.prepare("SELECT * FROM deductions WHERE user_id = ? AND category = 'exit'").all(id('safwan'));
  assert.equal(ded.length, 1);
  assert.equal(ded[0].amount, 5);
  assert.equal(notes("kind = 'deduction' AND user_id = ?", id('safwan')).length, 1);
  // a different amount, or dismiss with a reason
  assert.equal((await basem('PUT', `/api/cases/${ex[1].id}`, { status: 'dismissed', response: 'مشوار للمحل بطلب المشرف' })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM deductions WHERE user_id = ? AND category = 'exit'").get(id('safwan')).n, 1);
});

test('a supervisor never decides a case about themselves', async () => {
  punch('basem', '07:00', 'in');
  punch('basem', '08:00', 'leave', 'x');
  punch('basem', '08:20', 'back');
  reviewTick(db, at(D, '08:30'));
  const [c] = cases('basem', 'unauthorized_exit');
  assert.equal((await basem('PUT', `/api/cases/${c.id}`, { status: 'dismissed', response: 'لي' })).status, 403);
  assert.equal((await admin('PUT', `/api/cases/${c.id}`, { status: 'approved', amount: 3 })).status, 200);
  assert.equal(db.prepare("SELECT amount FROM deductions WHERE user_id = ? AND category = 'exit'").get(id('basem')).amount, 3);
  assert.equal((await ali('GET', '/api/cases?status=all')).body.cases.every((x) => x.user_id === id('ali')), true, 'an employee sees only their own');
});

test('shift exceptions: for everyone, for one employee, and who may set them', async () => {
  const day = addDays(localDate(), 3);
  assert.equal((await ali('POST', '/api/shift-exceptions', { date: day, periods: [{ start: '09:00', end: '12:00' }], note: 'x' })).status, 403);
  assert.equal((await basem('POST', '/api/shift-exceptions', { date: day, periods: [{ id: 'am', name: 'الصباحية', start: '09:00', end: '12:00' }], note: 'جرد' })).status, 200);
  assert.equal((await basem('POST', '/api/shift-exceptions', { date: day, user_id: id('safwan'), off: true, note: 'يوم بديل' })).status, 200);
  assert.equal((await basem('POST', '/api/shift-exceptions', { date: day, user_id: id('basem'), off: true, note: 'لي' })).status, 403);
  assert.equal((await basem('POST', '/api/shift-exceptions', { date: day, periods: [{ start: '10:00', end: '09:00' }], note: 'خطأ' })).status, 400);
  const { periodsFor, loadExceptions, exceptionOf } = await import('../src/attendance.js');
  const { getSettings } = await import('../src/settings.js');
  const ex = loadExceptions(db, day, day);
  const s = getSettings(db).schedule;
  const u = (n) => db.prepare('SELECT * FROM users WHERE username = ?').get(n);
  assert.deepEqual(periodsFor(u('ali'), day, s, false, exceptionOf(ex, id('ali'), day)).map((p) => `${p.start}-${p.end}`), ['09:00-12:00']);
  assert.deepEqual(periodsFor(u('safwan'), day, s, false, exceptionOf(ex, id('safwan'), day)), []);
  assert.ok(notes("kind = 'shift_exception'").length >= 2);
  const list = (await basem('GET', '/api/shift-exceptions')).body.exceptions;
  assert.equal(list.length, 2);
  assert.equal((await basem('DELETE', `/api/shift-exceptions/${list[1].id}`, { reason: 'أُلغي' })).status, 200);
});

test('hide deductions: the employee sees the net only, the accounts still see everything', async () => {
  assert.equal((await basem('PUT', '/api/addition-settings', { hide_deductions: true })).status, 403);
  assert.equal((await admin('PUT', '/api/addition-settings', { hide_deductions: true })).status, 200);
  const before = notes("kind = 'deduction'").length;
  assert.equal((await admin('POST', '/api/deductions', { user_id: id('safwan'), amount: 40, category: 'violation', reason: 'مخالفة', date: D })).status, 200);
  const notice = notes("kind = 'deduction'").slice(before)[0];
  assert.ok(notice && !notice.body.includes('40'), 'no amount in the WhatsApp notice');
  const mine = (await safwan('GET', `/api/my/month?month=${D.slice(0, 7)}`)).body;
  assert.equal(mine.hidden, true);
  assert.deepEqual(mine.deductions, []);
  const prof = (await safwan('GET', `/api/profile?month=${D.slice(0, 7)}`)).body;
  assert.equal(prof.salary.deductions, null);
  assert.ok((await malik('GET', `/api/profile?user_id=${id('safwan')}&month=${D.slice(0, 7)}`)).body.salary.deductions > 0);
  await admin('PUT', '/api/addition-settings', { hide_deductions: false });
  assert.equal((await safwan('GET', `/api/my/month?month=${D.slice(0, 7)}`)).body.deductions.length > 0, true);
});

test('closed payroll: the accounts reopen only with the permission and a reason', async () => {
  const month = localDate().slice(0, 7) === '2026-01' ? '2025-12' : `${localDate().slice(0, 4)}-${String(Number(localDate().slice(5, 7)) - 1).padStart(2, '0')}`;
  assert.equal((await admin('POST', '/api/payroll/close', { month, send: false })).status, 200);
  assert.equal((await malik('DELETE', `/api/payroll/close/${month}`, { reason: 'تصحيح' })).status, 403);
  await admin('PUT', `/api/users/${id('abdulmalik')}`, { perms: ['accountant', 'payroll_reopen'] });
  assert.equal((await malik('DELETE', `/api/payroll/close/${month}`, {})).status, 400);
  assert.equal((await malik('DELETE', `/api/payroll/close/${month}`, { reason: 'تصحيح خصم خاطئ' })).status, 200);
  assert.ok((await malik('GET', '/api/changes?area=salary')).body.changes.some((c) => c.action === 'فتح مسير مقفل' && c.reason === 'تصحيح خصم خاطئ'));
  assert.equal((await malik('POST', '/api/payroll/close', { month, send: false })).status, 200);
  assert.equal((await malik('GET', `/api/finance?month=${month}`)).body.canLock, true);
});
