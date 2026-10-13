import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ADMIN_PASSWORD = 'manager123';
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/settings.js');
const { localDate, addDays, at } = await import('../src/time.js');
const { shortageDailyTick } = await import('../src/additions/shortages.js');
const { chatRetentionTick } = await import('../src/additions/chat.js');
const { hijri, renderDecision } = await import('../src/additions/decisions.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
const notes = (where = '1=1', ...a) => db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id`).all(...a);

before(async () => {
  bootstrap(db);
  saveSettings(db, { notify: { manager_phone: '0500000009', remind_staff: true, shift_alerts: true, alert_manager: true, staff_account: false, daily_summary: true, summary_time: '21:30', alert_all: true, app_url: 'https://staff.example.com' } });
  const phones = { ali: '0500000001', basem: '0500000002', monther: '0500000003', safwan: '0500000004', abdulmalik: '0500000006' };
  for (const [u, p] of Object.entries(phones)) db.prepare('UPDATE users SET phone = ? WHERE username = ?').run(`966${p.slice(1)}`, u);
  server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client({ csrf = true } = {}) {
  const jar = {};
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(csrf ? { 'X-Requested-With': 'fetch' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
}
const admin = client();
const ali = client(); // supervisor
const basem = client(); // shortages
const monther = client(); // delegated recorder
const malik = client(); // accountant
const safwan = client(); // plain employee
const guest = client({ csrf: false });

test('setup: roles', async () => {
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'manager123' })).status, 200);
  const perms = { ali: ['supervisor'], basem: ['requests', 'shortages'], monther: ['exchanges'], abdulmalik: ['orders', 'stock', 'accountant'], safwan: [] };
  for (const [u, c] of [['ali', ali], ['basem', basem], ['monther', monther], ['abdulmalik', malik], ['safwan', safwan]]) {
    assert.equal((await admin('PUT', `/api/users/${id(u)}`, { password: `${u}-pass1`, salary: 3000, perms: perms[u], salary_reason: 'الراتب الأساسي' })).status, 200);
    assert.equal((await c('POST', '/api/login', { username: u, password: `${u}-pass1` })).status, 200);
  }
});

test('change log: salary edits keep before, after and reason; visible by area', async () => {
  assert.equal((await admin('PUT', `/api/users/${id('safwan')}`, { salary: 3500, salary_reason: 'زيادة سنوية' })).status, 200);
  const { body } = await admin('GET', `/api/changes?area=salary&user_id=${id('safwan')}`);
  const row = body.changes.find((c) => c.action === 'تعديل الراتب' && c.after.includes('3500'));
  assert.ok(row, 'salary change logged');
  assert.match(row.before, /3000/);
  assert.equal(row.reason, 'زيادة سنوية');
  // a supervisor sees attendance and returns, never salary
  assert.equal((await ali('GET', '/api/changes?area=salary')).status, 403);
  assert.equal((await ali('GET', '/api/changes?area=attendance')).status, 200);
  // the accountant sees salary only
  assert.equal((await malik('GET', '/api/changes?area=salary')).status, 200);
  assert.equal((await malik('GET', '/api/changes?area=attendance')).status, 403);
  assert.equal((await safwan('GET', '/api/changes')).status, 403);
  // a deleted punch is logged with its reason
  const p = await ali('POST', '/api/punches', { user_id: id('safwan'), date: addDays(localDate(), -2), time: '09:00', type: 'in', note: 'نسي' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const punchId = db.prepare('SELECT id FROM punches WHERE user_id = ? ORDER BY id DESC').get(id('safwan')).id;
  assert.equal((await ali('DELETE', `/api/punches/${punchId}`, { reason: 'بصمة خاطئة' })).status, 200);
  const att = (await ali('GET', '/api/changes?area=attendance')).body.changes;
  assert.ok(att.some((c) => c.action === 'إلغاء بصمة' && c.reason === 'بصمة خاطئة'));
  assert.ok(att.some((c) => c.action === 'إضافة بصمة يدوية'));
});

test('custom WhatsApp message from a supervisor', async () => {
  assert.equal((await safwan('POST', '/api/broadcasts', { body: 'x', user_ids: 'all' })).status, 403);
  const r = await ali('POST', '/api/broadcasts', { body: 'اجتماع الساعة 4 العصر', user_ids: [id('basem'), id('safwan')] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sent = notes("kind = 'custom'");
  assert.equal(sent.length, 2);
  assert.ok(sent.every((n) => n.body.includes('اجتماع الساعة 4 العصر')));
  const list = (await ali('GET', '/api/broadcasts')).body.broadcasts;
  assert.equal(list[0].recipients.length, 2);
});

test('decisions: draft, issue with numbering, WhatsApp link, acknowledge without login', async () => {
  assert.equal((await safwan('POST', '/api/decisions', { title: 'x' })).status, 403);
  const c = await ali('POST', '/api/decisions', {
    title: 'تنظيم أوقات الدوام', subtitle: 'الفترة الصباحية', preamble: 'بناءً على مصلحة العمل',
    articles: [{ title: 'أوقات الدوام', body: 'يبدأ الدوام **الساعة 9**' }, { title: 'الالتزام', body: '- لا خروج بدون إذن\n- الالتزام بالبصمة', warn: true }], issued_date: localDate(), effective_date: localDate(),
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const did = c.body.id;
  const up = await ali('PUT', `/api/decisions/${did}`, { title: 'تنظيم أوقات الدوام والانصراف' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const html = renderDecision((await ali('GET', `/api/decisions/${did}`)).body.decision);
  assert.ok(html.includes('تنظيم أوقات الدوام والانصراف'));
  assert.ok(html.includes('<b>الساعة 9</b>'));
  assert.equal((await ali('GET', `/decision/${did}`)).status, 200);
  const iss = await ali('POST', `/api/decisions/${did}/issue`, { user_ids: [id('safwan'), id('basem')] });
  assert.equal(iss.status, 200, JSON.stringify(iss.body));
  const d = (await ali('GET', `/api/decisions/${did}`)).body;
  assert.equal(d.decision.status, 'issued');
  assert.match(d.decision.number, /^ق\.إ \/ \d{4} \/ \d{3}$/);
  // an issued decision is frozen
  assert.equal((await ali('PUT', `/api/decisions/${did}`, { title: 'x' })).status, 400);
  assert.equal((await ali('DELETE', `/api/decisions/${did}`)).status, 400);
  const msg = notes("kind = 'decision' AND user_id = ?", id('safwan'));
  assert.equal(msg.length, 1);
  const token = db.prepare('SELECT token FROM decision_recipients WHERE decision_id = ? AND user_id = ?').get(did, id('safwan')).token;
  assert.ok(msg[0].body.includes(`/ack/${token}`));
  // the page opens without login, marks seen; posting acknowledges
  const page = await guest('GET', `/ack/${token}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('تنظيم أوقات الدوام والانصراف'));
  assert.equal((await guest('GET', '/ack/not-a-token')).status, 404);
  const ack = await guest('POST', `/ack/${token}`);
  assert.equal(ack.status, 303);
  const rec = db.prepare('SELECT seen_at, ack_at FROM decision_recipients WHERE decision_id = ? AND user_id = ?').get(did, id('safwan'));
  assert.ok(rec.seen_at && rec.ack_at);
  // in the app too, and only for recipients
  assert.equal((await basem('POST', `/api/my/decisions/${did}/ack`)).status, 200);
  assert.equal((await monther('POST', `/api/my/decisions/${did}/ack`)).status, 404);
  const list = (await ali('GET', '/api/decisions')).body.decisions.find((x) => x.id === did);
  assert.equal(list.acked, 2);
  // the next decision takes the next number
  const c2 = await ali('POST', '/api/decisions', { title: 'قرار ثانٍ', articles: [{ body: 'نص المادة' }], issued_date: localDate() });
  await ali('POST', `/api/decisions/${c2.body.id}/issue`, { user_ids: [id('safwan')] });
  const n2 = (await ali('GET', `/api/decisions/${c2.body.id}`)).body.decision.number;
  assert.equal(Number(n2.slice(-3)), Number(d.decision.number.slice(-3)) + 1);
  assert.match(hijri(localDate()), /\d{4}/);
});

test('chat: one-to-one reuse, groups, members write, supervisors read all', async () => {
  const people = (await safwan('GET', '/api/chat/people')).body.people;
  assert.ok(people.some((p) => p.id === id('basem')));
  const a = await safwan('POST', '/api/chat', { user_ids: [id('basem')] });
  assert.equal(a.status, 200);
  const again = await basem('POST', '/api/chat', { user_ids: [id('safwan')] });
  assert.equal(again.body.id, a.body.id);
  assert.equal((await safwan('POST', `/api/chat/${a.body.id}`, { body: 'السلام عليكم' })).status, 200);
  assert.equal((await basem('GET', '/api/chat/unread')).body.unread, 1);
  const read = await basem('GET', `/api/chat/${a.body.id}`);
  assert.equal(read.body.messages[0].body, 'السلام عليكم');
  assert.equal((await basem('GET', '/api/chat/unread')).body.unread, 0);
  // outsiders cannot read or write; supervisors read but do not write
  assert.equal((await monther('GET', `/api/chat/${a.body.id}`)).status, 403);
  assert.equal((await ali('GET', `/api/chat/${a.body.id}`)).status, 200);
  assert.equal((await ali('POST', `/api/chat/${a.body.id}`, { body: 'x' })).status, 403);
  assert.ok((await ali('GET', '/api/chat?all=1')).body.chats.some((c) => c.id === a.body.id));
  assert.ok(!(await monther('GET', '/api/chat?all=1')).body.chats.some((c) => c.id === a.body.id));
  const g = await monther('POST', '/api/chat', { user_ids: [id('basem'), id('safwan')], title: 'فريق المستودع' });
  assert.notEqual(g.body.id, a.body.id);
  // old messages go after 180 days
  db.prepare('UPDATE chat_messages SET ts = ? WHERE chat_id = ?').run(Date.now() - 200 * 86_400_000, a.body.id);
  const fourTwenty = at(localDate(), '04:20');
  assert.equal(chatRetentionTick(db, fourTwenty), 1);
});

test('shortages: add, partial, done, daily reminder until supplied', async () => {
  assert.equal((await safwan('POST', '/api/shortages', { sku: 'A1', name: 'عباية' })).status, 403);
  const a = await basem('POST', '/api/shortages', { sku: 'WR-101', name: 'عباية سوداء مقاس 54', qty: 5, priority: 'high', assignee_id: id('abdulmalik') });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.ok(notes("kind LIKE 'shortage%'").length > 0, 'followers notified');
  // the reminder goes once a day at 10:00
  const ten = at(localDate(), '10:00');
  const n = shortageDailyTick(db, ten);
  assert.ok(n > 0);
  assert.equal(shortageDailyTick(db, ten + 60_000), 0);
  const rem = notes("kind = 'shortage_daily'");
  assert.ok(rem.some((x) => x.body.includes('WR-101')));
  // partial supply, then «تم توفير الطلب»
  const sp = await basem('POST', `/api/shortages/${a.body.id}/supply`, { qty: 2 });
  assert.equal(sp.status, 200, JSON.stringify(sp.body) + JSON.stringify(a.body));
  let s = db.prepare('SELECT * FROM shortages WHERE id = ?').get(a.body.id);
  assert.equal(s.status, 'partial');
  assert.equal(s.qty_done, 2);
  assert.equal((await basem('POST', `/api/shortages/${a.body.id}/supply`, { all: true })).status, 200);
  s = db.prepare('SELECT * FROM shortages WHERE id = ?').get(a.body.id);
  assert.equal(s.status, 'done');
  // nothing open → no reminder the next day
  assert.equal(shortageDailyTick(db, at(addDays(localDate(), 1), '10:00')), 0);
  // the assignee sees it on their profile while open; cancelling needs a reason
  const b = await ali('POST', '/api/shortages', { sku: 'WR-7', name: 'شيلة', assignee_id: id('safwan') });
  assert.ok((await safwan('GET', '/api/profile')).body.tasks.shortages.some((x) => x.id === b.body.id));
  assert.equal((await ali('POST', `/api/shortages/${b.body.id}/cancel`, {})).status, 400);
  assert.equal((await ali('POST', `/api/shortages/${b.body.id}/cancel`, { reason: 'أُلغي المنتج' })).status, 200);
  assert.equal((await safwan('GET', '/api/shortages')).status, 403);
  assert.equal((await malik('GET', '/api/shortages')).status, 200); // stock permission views
});

test('profile and correction requests', async () => {
  const me = await safwan('GET', '/api/profile');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.name, 'صفوان');
  assert.ok(me.body.salary, 'the employee sees their own salary');
  assert.equal(me.body.shift.week.length, 7);
  assert.equal((await safwan('GET', `/api/profile?user_id=${id('basem')}`)).status, 403);
  const sup = await ali('GET', `/api/profile?user_id=${id('safwan')}`);
  assert.equal(sup.status, 200);
  assert.equal(sup.body.salary, null, 'supervisors see no money');
  assert.ok((await malik('GET', `/api/profile?user_id=${id('safwan')}`)).body.salary);
  const day = addDays(localDate(), -1);
  const c = await safwan('POST', '/api/corrections', { date: day, type: 'in', time: '09:05', reason: 'نسيت البصمة' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await safwan('POST', '/api/corrections', { date: day, type: 'in', time: '09:10', reason: 'مرة ثانية' })).status, 409);
  assert.equal((await safwan('POST', '/api/corrections', { date: addDays(localDate(), -40), type: 'in', time: '09:10', reason: 'قديم' })).status, 400);
  assert.ok(notes("kind = 'correction_request'").length > 0);
  assert.equal((await safwan('PUT', `/api/corrections/${c.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await ali('PUT', `/api/corrections/${c.body.id}`, { status: 'rejected' })).status, 400); // a rejection needs a reason
  assert.equal((await ali('PUT', `/api/corrections/${c.body.id}`, { status: 'approved' })).status, 200);
  const punch = db.prepare('SELECT * FROM punches WHERE user_id = ? AND type = ? ORDER BY id DESC').get(id('safwan'), 'in');
  assert.ok(punch && punch.note.includes('تصحيح معتمد'));
  assert.ok(notes("kind = 'correction_status' AND user_id = ?", id('safwan')).length === 1);
  // a supervisor's own correction goes to the owner
  const own = await ali('POST', '/api/corrections', { date: day, type: 'out', time: '17:00', reason: 'نسيت' });
  assert.equal((await ali('PUT', `/api/corrections/${own.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await admin('PUT', `/api/corrections/${own.body.id}`, { status: 'approved' })).status, 200);
});

test('accountant: payroll and loans, no approvals, nothing for themselves', async () => {
  const f = await malik('GET', '/api/finance');
  assert.equal(f.status, 200);
  assert.ok(f.body.payroll.length > 0);
  assert.equal((await ali('GET', '/api/finance')).status, 403);
  assert.equal((await malik('POST', '/api/finance/debts', { user_id: id('safwan'), kind: 'loan', amount: 500, note: 'سلفة' })).status, 200);
  assert.equal((await malik('POST', '/api/finance/debts', { user_id: id('abdulmalik'), kind: 'loan', amount: 500 })).status, 403);
  assert.ok((await malik('GET', '/api/changes?area=salary')).body.changes.some((c) => c.action === 'سلفة'));
  const slip = await malik('GET', `/finance/payslip?user_id=${id('safwan')}`);
  assert.equal(slip.status, 200);
  assert.ok(slip.body.includes('صفوان'));
  // the accountant cannot touch attendance or staff
  assert.equal((await malik('POST', '/api/punches', { user_id: id('safwan'), date: localDate(), time: '10:00', type: 'in' })).status, 403);
  assert.equal((await malik('PUT', `/api/users/${id('safwan')}`, { salary: 9000 })).status, 403);
});

test('delegated deductions: recorded, approved by another supervisor, never self', async () => {
  assert.equal((await monther('POST', '/api/deduction-requests', { user_id: id('safwan'), amount: 50, reason: 'تأخير' })).status, 403);
  assert.equal((await ali('PUT', '/api/delegates', { user_id: id('monther'), on: true })).status, 200);
  assert.ok((await ali('GET', '/api/delegates')).body.delegates.some((d) => d.id === id('monther')));
  // the session reloads perms on every request
  assert.equal((await monther('POST', '/api/deduction-requests', { user_id: id('monther'), amount: 50, reason: 'على نفسي' })).status, 403);
  assert.equal((await monther('POST', '/api/deduction-requests', { user_id: id('safwan'), amount: 50, reason: '' })).status, 400);
  const r = await monther('POST', '/api/deduction-requests', { user_id: id('safwan'), amount: 50, category: 'other', reason: 'تأخير تسليم الطلبات' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deductions WHERE user_id = ?').get(id('safwan')).n, 0, 'not in payroll before approval');
  assert.equal((await monther('PUT', `/api/deduction-requests/${r.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await malik('PUT', `/api/deduction-requests/${r.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await ali('PUT', `/api/deduction-requests/${r.body.id}`, { status: 'approved' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deductions WHERE user_id = ?').get(id('safwan')).n, 1);
  assert.equal((await ali('PUT', `/api/deduction-requests/${r.body.id}`, { status: 'approved' })).status, 400);
  // a supervisor never approves what they recorded, nor a deduction on themselves
  const own = await ali('POST', '/api/deduction-requests', { user_id: id('safwan'), amount: 10, reason: 'سجّلته أنا' });
  assert.equal((await ali('PUT', `/api/deduction-requests/${own.body.id}`, { status: 'approved' })).status, 403);
  const onAli = await monther('POST', '/api/deduction-requests', { user_id: id('ali'), amount: 10, reason: 'على المشرف' });
  assert.equal((await ali('PUT', `/api/deduction-requests/${onAli.body.id}`, { status: 'approved' })).status, 403);
  assert.equal((await admin('PUT', `/api/deduction-requests/${onAli.body.id}`, { status: 'rejected', response: 'غير مبرر' })).status, 200);
  // notes
  assert.equal((await monther('POST', '/api/notes', { user_id: id('safwan'), body: 'تأخر في الرد على العملاء' })).status, 200);
  assert.equal((await ali('GET', '/api/notes')).body.notes.length, 1);
  assert.equal((await safwan('POST', '/api/notes', { user_id: id('basem'), body: 'xxx' })).status, 403);
  // revoking the permission stops recording
  assert.equal((await ali('PUT', '/api/delegates', { user_id: id('monther'), on: false })).status, 200);
  assert.equal((await monther('POST', '/api/notes', { user_id: id('safwan'), body: 'ملاحظة' })).status, 403);
});
