import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { bootstrap } from '../src/auth.js';
import { saveSettings } from '../src/settings.js';
import { at } from '../src/time.js';
import { flush, normalizePhone, notifyEmployee, queue, tick, dailySummary, customRequest } from '../src/notify.js';
import { loadAttendance } from '../src/attendance.js';

const SAT = '2026-10-03';

function setup() {
  const db = openDb(':memory:');
  bootstrap(db);
  db.prepare("UPDATE users SET phone = '966500000001', created_at = ? WHERE username = 'ali'").run(at('2026-09-01', '08:00'));
  db.prepare("UPDATE users SET created_at = ? WHERE role = 'employee' AND username != 'ali'").run(at('2026-09-01', '08:00'));
  saveSettings(db, { notify: { manager_phone: '0500000009', remind_staff: true, remind_after_minutes: 10, alert_manager: true, staff_account: true, daily_summary: true, summary_time: '21:30' } });
  return db;
}
const all = (db) => db.prepare('SELECT * FROM notifications ORDER BY id').all();

test('phone numbers are normalised to international format', () => {
  assert.equal(normalizePhone('0501234567'), '966501234567');
  assert.equal(normalizePhone('+966 50 123 4567'), '966501234567');
  assert.equal(normalizePhone('00966501234567'), '966501234567');
  assert.equal(normalizePhone('501234567'), '966501234567');
  assert.equal(normalizePhone('abc'), '');
});

test('punch-in reminder goes once to the employee and an alert to the manager', () => {
  const db = setup();
  tick(db, at(SAT, '07:05'));
  assert.equal(all(db).length, 0, 'nothing before the reminder delay');
  tick(db, at(SAT, '07:11'));
  tick(db, at(SAT, '07:12'));
  const n = all(db);
  const toAli = n.filter((x) => x.to_phone === '966500000001');
  assert.equal(toAli.length, 1);
  assert.match(toAli[0].body, /ما سجّلت حضورك/);
  // the manager hears about every employee not in yet, once each
  const late = n.filter((x) => x.kind === 'late');
  assert.equal(late.length, 6);
  assert.ok(late.every((x) => x.to_phone === '966500000009'));
});

test('employees who punched in get no reminder; forgotten checkout does', () => {
  const db = setup();
  const ali = db.prepare("SELECT id FROM users WHERE username = 'ali'").get().id;
  const ins = db.prepare("INSERT INTO punches (user_id, date, ts, type, created_at) VALUES (?, ?, ?, ?, ?)");
  ins.run(ali, SAT, at(SAT, '06:58'), 'in', 0);
  tick(db, at(SAT, '07:15'));
  assert.equal(all(db).filter((x) => x.kind === 'remind_in').length, 0);
  ins.run(ali, SAT, at(SAT, '12:20'), 'out', 0);
  ins.run(ali, SAT, at(SAT, '13:00'), 'in', 0);
  tick(db, at(SAT, '21:25'));
  const out = all(db).filter((x) => x.kind === 'remind_out');
  assert.equal(out.length, 1);
  assert.match(out[0].body, /ما سجّلت انصراف/);
});

test('daily summary at the configured time, once', () => {
  const db = setup();
  tick(db, at(SAT, '21:29'));
  assert.equal(all(db).filter((x) => x.kind === 'summary').length, 0);
  tick(db, at(SAT, '21:31'));
  tick(db, at(SAT, '21:40'));
  const s = all(db).filter((x) => x.kind === 'summary');
  assert.equal(s.length, 1);
  assert.match(s[0].body, /ملخص يوم 2026-10-03/);
  assert.match(s[0].body, /لم يُسجَّل:/);
  const text = dailySummary(db, SAT, loadAttendance(db, { from: SAT, to: SAT, now: at(SAT, '22:00') }));
  assert.match(text, /الغياب: /);
});

test('switches turn notification groups off', () => {
  const db = setup();
  saveSettings(db, { notify: { manager_phone: '0500000009', remind_staff: false, alert_manager: false, staff_account: false, daily_summary: false, summary_time: '21:30' } });
  tick(db, at(SAT, '07:30'));
  tick(db, at(SAT, '22:00'));
  const ali = db.prepare("SELECT id FROM users WHERE username = 'ali'").get().id;
  notifyEmployee(db, ali, 'deduction', 'x');
  assert.equal(all(db).length, 0);
});

test('sender: sent, retried, and skipped when no provider is configured', async () => {
  const db = setup();
  queue(db, { to: '0500000001', body: 'a', kind: 't' });
  queue(db, { to: '0500000002', body: 'b', kind: 't' });
  assert.equal(queue(db, { to: '0500000003', body: 'c', kind: 't', key: 'k1' }), true);
  assert.equal(queue(db, { to: '0500000003', body: 'c', kind: 't', key: 'k1' }), false, 'dedupe key');
  let calls = 0;
  const sent = await flush(db, async (to) => { calls++; if (to.endsWith('2')) throw new Error('boom'); });
  assert.equal(sent, 2);
  const rows = all(db);
  assert.equal(rows.find((r) => r.to_phone.endsWith('2')).status, 'pending');
  assert.equal(rows.find((r) => r.to_phone.endsWith('2')).attempts, 1);
  await flush(db, async () => { throw Object.assign(new Error('no provider'), { skip: true }); });
  assert.equal(all(db).find((r) => r.to_phone.endsWith('2')).status, 'skipped');
  assert.equal(calls, 3);
});

test('custom gateway request is built from environment variables', () => {
  const a = customRequest('966500000001', 'hi', { WHATSAPP_API_URL: 'https://gw.example/send', WHATSAPP_TOKEN: 'T' });
  assert.equal(a.url, 'https://gw.example/send');
  assert.equal(a.init.headers.Authorization, 'Bearer T');
  assert.deepEqual(JSON.parse(a.init.body), { phone: '966500000001', message: 'hi' });
  const b = customRequest('966500000001', 'hi', { WHATSAPP_API_URL: 'https://gw.example/{instance}/send', WHATSAPP_INSTANCE_ID: 'i9', WHATSAPP_TOKEN: 'T',
    WHATSAPP_AUTH: 'body:api_key', WHATSAPP_TO_FIELD: 'to', WHATSAPP_TEXT_FIELD: 'text', WHATSAPP_TO_FORMAT: 'jid', WHATSAPP_EXTRA: '{"type":"text"}' });
  assert.equal(b.url, 'https://gw.example/i9/send');
  assert.deepEqual(JSON.parse(b.init.body), { type: 'text', to: '966500000001@c.us', text: 'hi', api_key: 'T' });
  const c = customRequest('966500000001', 'hi', { WHATSAPP_API_URL: 'https://gw.example/send', WHATSAPP_TOKEN: 'T', WHATSAPP_AUTH: 'header:X-Api-Key', WHATSAPP_FORMAT: 'form' });
  assert.equal(c.init.headers['X-Api-Key'], 'T');
  assert.equal(c.init.body.get('phone'), '966500000001');
});
