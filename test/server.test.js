import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { localDate, addDays } = await import('../src/time.js');

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
  assert.equal((await admin('PUT', `/api/users/${id('ali')}`, { password: 'ali12345', salary: 3000, perms: ['orders', 'stock', 'm:shipments', 'not-a-perm'] })).status, 200);
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

test('operations: each part needs its own permission', async () => {
  const date = localDate();
  assert.equal((await ali('PUT', `/api/ops/${date}`, { channels: { salla: { count: 12, amount: 3400 }, tabby: { count: 3, amount: 900 } }, notes: 'تأخر مندوب الشحن' })).status, 200);
  assert.equal((await ali('PUT', `/api/ops/${date}`, { metrics: { shipments: { value: 14 } } })).status, 200);
  assert.equal((await ali('PUT', `/api/ops/${date}`, { metrics: { pending_chats: { value: 3 } } })).status, 403);
  assert.equal((await basem('PUT', `/api/ops/${date}`, { metrics: { shipments: { value: 1 } } })).status, 403);
  assert.equal((await ali('PUT', `/api/ops/${addDays(date, -10)}`, { metrics: { shipments: { value: 1 } } })).status, 403);
  // a second save of one part keeps the other parts
  assert.equal((await ali('PUT', `/api/ops/${date}`, { channels: { tamara: { count: 2, amount: 500 } } })).status, 200);
  const ops = (await admin('GET', '/api/ops')).body.ops.find((o) => o.date === date);
  assert.equal(ops.totalOrders, 17);
  assert.equal(ops.metrics.shipments.value, 14);
  assert.equal(ops.notes, 'تأخر مندوب الشحن');
  const users = (await admin('GET', '/api/users')).body.users;
  assert.deepEqual(users.find((u) => u.username === 'ali').perms, ['orders', 'stock', 'm:shipments']);
  assert.deepEqual(users.find((u) => u.username === 'monther').perms, ['m:pending_issues', 'm:pending_chats']);
});

test('invoices and merchant returns are recorded per product code', async () => {
  const r = await ali('POST', '/api/stock', { kind: 'new_goods', party: 'مصنع الرياض', invoice_no: 'INV-88', lines: [{ sku: 'AB-100', quantity: 40, value: 6000 }, { sku: 'AB-101', quantity: 10 }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ids.length, 2);
  assert.equal((await ali('POST', '/api/stock', { kind: 'merchant_return', party: 'تاجر جدة', lines: [{ sku: 'AB-100', quantity: 0 }] })).status, 400);
  assert.equal((await ali('POST', '/api/stock', { kind: 'merchant_return', party: 'تاجر جدة', lines: [{ sku: 'AB-100', quantity: 5 }] })).status, 200);
  assert.equal((await basem('POST', '/api/stock', { kind: 'new_goods', party: 'x', lines: [{ sku: 'A', quantity: 1 }] })).status, 403);
  const stock = (await admin('GET', '/api/ops')).body.stock;
  assert.ok(stock.some((s) => s.invoice_no === 'INV-88' && s.sku === 'AB-101' && s.quantity === 10));
});

test('release and shortage requests', async () => {
  const users = (await admin('GET', '/api/users')).body.users;
  const basemId = users.find((u) => u.username === 'basem').id;
  assert.equal((await admin('PUT', `/api/users/${basemId}`, { perms: ['requests'] })).status, 200);
  const r = await basem('POST', '/api/requests', { kind: 'release', sku: 'AB-100', quantity: 3, reason: 'عيب في الخياطة' });
  assert.equal(r.status, 200);
  assert.equal((await basem('POST', '/api/requests', { kind: 'shortage', sku: 'AB-200', quantity: 5 })).status, 400);
  assert.equal((await ali('POST', '/api/requests', { kind: 'shortage', sku: 'AB-200', quantity: 5, reason: 'نفد' })).status, 403);
  assert.equal((await basem('PUT', `/api/requests/${r.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await admin('PUT', `/api/requests/${r.body.id}`, { status: 'approved', response: 'تمت الموافقة، رجّعها الخميس' })).status, 200);
  const mine = (await basem('GET', '/api/requests')).body.requests;
  assert.equal(mine[0].status, 'approved');
  assert.equal((await admin('GET', '/api/dashboard')).body.pendingRequests, 0);
});

test('tickets', async () => {
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
  assert.equal(d.body.ops.totalOrders, 17);
  assert.equal(d.body.ops.metrics.shipments.value, 14);
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
  assert.ok(csv.body.includes('INV-88'));
  assert.ok(csv.body.includes('عيب في الخياطة'));
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
