import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { localDate } = await import('../src/time.js');

let server;
let base;
const db = openDb(':memory:');

before(async () => {
  bootstrap(db);
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** Tiny cookie-keeping client. */
function client() {
  const jar = {};
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Requested-With': 'fetch',
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

const admin = client();
const ali = client();
const basem = client();

test('first boot creates the manager and the six employees', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  const { body } = await admin('GET', '/api/users');
  const names = body.users.filter((u) => u.role === 'employee').map((u) => u.name);
  assert.deepEqual(names, ['عبدالله', 'باسم', 'منذر', 'صفوان', 'علي', 'عبدالملك']);
  assert.ok(body.users.every((u) => u.role === 'admin' || !u.has_password));
});

test('employees cannot log in until the manager sets a password', async () => {
  assert.equal((await ali('POST', '/api/login', { username: 'ali', password: 'anything' })).status, 401);
  const { body } = await admin('GET', '/api/users');
  const id = (u) => body.users.find((x) => x.username === u).id;
  assert.equal((await admin('PUT', `/api/users/${id('ali')}`, { password: 'ali12345', salary: 3000, can_log_ops: true })).status, 200);
  assert.equal((await admin('PUT', `/api/users/${id('basem')}`, { password: 'basem123', salary: 4500 })).status, 200);
  assert.equal((await ali('POST', '/api/login', { username: 'ali', password: 'ali12345' })).status, 200);
  assert.equal((await basem('POST', '/api/login', { username: 'basem', password: 'basem123' })).status, 200);
});

test('employees cannot reach manager pages', async () => {
  assert.equal((await ali('GET', '/api/dashboard')).status, 403);
  assert.equal((await ali('GET', '/api/export/daily')).status, 403);
  assert.equal((await ali('POST', '/api/deductions', { user_id: 1, amount: 10 })).status, 403);
});

test('punch flow enforces order, needs a reason to step out, and uses server time', async () => {
  const r1 = await ali('POST', '/api/punch', { type: 'in', client_ts: Date.now() - 3 * 3600_000 });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body.allowed, ['leave', 'out']);
  assert.ok(Math.abs(r1.body.punches[0].ts - Date.now()) < 5000);
  assert.ok(r1.body.punches[0].flags.includes('clock_skew'));
  assert.equal((await ali('POST', '/api/punch', { type: 'in' })).status, 409);
  db.prepare('UPDATE punches SET ts = ts - 120000').run(); // skip the one-minute cooldown
  assert.equal((await ali('POST', '/api/punch', { type: 'leave' })).status, 400);
});

test('one phone punching for two people is flagged', async () => {
  // basem uses ali's device cookie
  const res = await fetch(`${base}/api/punch`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401);
  const aliDevice = db.prepare('SELECT device FROM punches LIMIT 1').get().device;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'basem', password: 'basem123' }) });
  const session = login.headers.getSetCookie()[0].split(';')[0];
  const p = await fetch(`${base}/api/punch`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', Cookie: `${session}; ws_device=${aliDevice}` },
    body: JSON.stringify({ type: 'in' }),
  });
  const body = await p.json();
  assert.ok(body.punches[0].flags.includes('shared_device'));
});

test('operations, stock moves and tickets', async () => {
  const date = localDate();
  assert.equal((await ali('PUT', `/api/ops/${date}`, { channels: { salla: { count: 12, amount: 3400 }, tabby: { count: 3, amount: 900 } }, shipments: 14, returns: 1, notes: 'تأخر مندوب الشحن' })).status, 200);
  assert.equal((await basem('PUT', `/api/ops/${date}`, { shipments: 1 })).status, 403);
  assert.equal((await ali('POST', '/api/stock', { kind: 'new_goods', party: 'مصنع الرياض', description: 'عبايات سوداء', quantity: 40, value: 6000 })).status, 200);
  assert.equal((await ali('POST', '/api/stock', { kind: 'merchant_return', party: 'تاجر جدة', description: 'مقاسات خاطئة', quantity: 5 })).status, 200);
  const t = await basem('POST', '/api/tickets', { kind: 'achievement', title: 'إنجازات اليوم', body: 'جهزت 20 طلب' });
  assert.equal(t.status, 200);
  assert.equal((await ali('GET', `/api/tickets/${t.body.id}`)).status, 404);
  assert.equal((await admin('POST', `/api/tickets/${t.body.id}/replies`, { body: 'ممتاز' })).status, 200);
  assert.equal((await admin('PUT', `/api/tickets/${t.body.id}`, { status: 'closed' })).status, 200);
  const mine = await basem('GET', '/api/tickets');
  assert.equal(mine.body.tickets[0].status, 'closed');
  assert.equal(mine.body.tickets[0].replies, 1);
});

test('deductions, debts and payroll', async () => {
  const users = (await admin('GET', '/api/users')).body.users;
  const aliId = users.find((u) => u.username === 'ali').id;
  assert.equal((await admin('POST', '/api/deductions', { user_id: aliId, amount: 50, category: 'late', reason: 'تأخير' })).status, 200);
  assert.equal((await admin('POST', '/api/debts', { user_id: aliId, kind: 'loan', amount: 1000, note: 'سلفة' })).status, 200);
  assert.equal((await admin('POST', '/api/debts', { user_id: aliId, kind: 'repayment', amount: 250 })).status, 200);
  const pay = await admin('GET', '/api/payroll');
  const row = pay.body.rows.find((r) => r.userId === aliId);
  assert.equal(row.deductions, 50);
  assert.equal(row.repayments, 250);
  assert.equal(row.net, 2700);
  assert.equal(row.debtBalance, 750);
  const mine = await ali('GET', '/api/my/month');
  assert.equal(mine.body.balance, 750);
  assert.equal(mine.body.deductions.length, 1);
});

test('dashboard, manual punch with audit, flags', async () => {
  const d = await admin('GET', '/api/dashboard');
  assert.equal(d.status, 200);
  assert.equal(d.body.attendance.length, 6);
  assert.equal(d.body.ops.totalOrders, 15);
  const users = (await admin('GET', '/api/users')).body.users;
  const monther = users.find((u) => u.username === 'monther').id;
  assert.equal((await admin('POST', '/api/punches', { user_id: monther, date: localDate(), time: '00:00', type: 'in' })).status, 400);
  assert.equal((await admin('POST', '/api/punches', { user_id: monther, date: localDate(), time: '00:00', type: 'in', note: 'نسي البصمة' })).status, 200);
  const f = await admin('GET', '/api/flags');
  assert.ok(f.body.punches.some((p) => p.flags.includes('manager_entry')));
  assert.ok(f.body.punches.some((p) => p.flags.includes('shared_device')));
  assert.ok(f.body.audit.some((a) => a.action === 'punch.add'));
});

test('exports and printable report', async () => {
  const csv = await admin('GET', `/api/export/daily?date=${localDate()}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.body.includes('الحضور والانصراف'));
  assert.ok(csv.body.includes('مصنع الرياض'));
  assert.ok(csv.body.includes('إنجازات اليوم'));
  for (const p of ['/api/export/attendance', '/api/export/payroll', '/api/export/ops', '/api/export/tickets', '/api/export/debts']) {
    assert.equal((await admin('GET', p)).status, 200, p);
  }
  const page = await admin('GET', '/report/daily');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('التقرير اليومي'));
  assert.equal((await ali('GET', '/report/daily')).status, 403);
  assert.equal((await client()('GET', '/report/daily')).status, 302);
});

test('settings validate the schedule', async () => {
  const s = (await admin('GET', '/api/settings')).body;
  assert.equal(s.schedule.days[5][0].start, '14:00');
  const bad = structuredClone(s.schedule);
  bad.days[1] = [{ id: 'am', name: 'x', start: '10:00', end: '09:00' }];
  assert.equal((await admin('PUT', '/api/settings', { schedule: bad })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { grace_minutes: 15, security: { allowed_ips: '10.0.0.1', geo: { lat: 24.7, lng: 46.7, radius: 100 } } })).status, 200);
  const after = (await admin('GET', '/api/settings')).body;
  assert.equal(after.grace_minutes, 15);
  assert.deepEqual(after.security.allowed_ips, ['10.0.0.1']);
});

test('static app and CSRF guard', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('app.js'));
  const noHeader = await fetch(`${base}/api/login`, { method: 'POST', body: '{}' });
  assert.equal(noHeader.status, 403);
});
