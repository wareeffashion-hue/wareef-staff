import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ADMIN_PASSWORD = 'manager123';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wareef-selfie-')), 'staff.db'); // photos land next to it
const { openDb } = await import('../src/db.js');
const { bootstrap } = await import('../src/auth.js');
const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/settings.js');
const { localDate, at } = await import('../src/time.js');
const { selfieRetentionTick } = await import('../src/additions/selfie.js');

let server;
let base;
const db = openDb(':memory:');
const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
const notes = (where = '1=1', ...a) => db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id`).all(...a);
const SELFIE = `data:image/jpeg;base64,${Buffer.alloc(4000, 7).toString('base64')}`;

before(async () => {
  bootstrap(db);
  saveSettings(db, { notify: { manager_phone: '0500000009', app_url: 'https://staff.example.com' } });
  db.prepare("UPDATE users SET phone = '966500000002' WHERE username = 'basem'").run();
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
const phone1 = client(); // ali's usual phone
const phone2 = client(); // ali on a new phone
const backdate = () => db.prepare('UPDATE punches SET ts = ts - 120000 WHERE user_id = ?').run(id('ali'));

test('setup', async () => {
  await admin('POST', '/api/login', { username: 'admin', password: 'manager123' });
  await admin('PUT', `/api/users/${id('basem')}`, { password: 'basem-pass1', perms: ['supervisor'] });
  await admin('PUT', `/api/users/${id('ali')}`, { password: 'ali-pass1' });
  for (const [c, u] of [[basem, 'basem'], [phone1, 'ali'], [phone2, 'ali']]) assert.equal((await c('POST', '/api/login', { username: u, password: `${u}-pass1` })).status, 200);
});

test('a punch from a new phone needs a selfie; it reaches supervisors and stays 30 days', async () => {
  assert.equal((await phone1('POST', '/api/punch', { type: 'in' })).status, 200);
  backdate();
  const r = await phone2('POST', '/api/punch', { type: 'leave', note: 'مشوار' });
  assert.equal(r.status, 428);
  assert.equal(r.body.error, 'selfie_required');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM punches WHERE user_id = ?').get(id('ali')).n, 1, 'refused punch not saved');
  assert.equal((await phone2('POST', '/api/punch', { type: 'leave', note: 'مشوار', selfie: 'data:image/gif;base64,AAAA' })).status, 400);
  const ok = await phone2('POST', '/api/punch', { type: 'leave', note: 'مشوار', selfie: SELFIE });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const s = db.prepare('SELECT * FROM punch_selfies').get();
  assert.ok(s && JSON.parse(s.flags).includes('new_device'));
  // supervisors told at once: stepped out without permission
  assert.equal(notes("kind = 'suspect_away' AND user_id = ?", id('basem')).length, 1);
  // only supervisors and the owner can see the photo
  assert.equal((await basem('GET', `/selfie/${s.punch_id}`)).status, 200);
  assert.equal((await phone1('GET', `/selfie/${s.punch_id}`)).status, 403);
  assert.equal((await basem('GET', '/api/selfies')).body.selfies.length, 1);
  assert.equal((await phone1('GET', '/api/selfies')).status, 403);
  // deleted after 30 days
  db.prepare('UPDATE punch_selfies SET created_at = ?').run(Date.now() - 31 * 86_400_000);
  assert.equal(selfieRetentionTick(db, at(localDate(), '04:30')), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM punch_selfies').get().n, 0);
  assert.equal((await basem('GET', `/selfie/${s.punch_id}`)).status, 404);
  assert.ok(!existsSync(join(process.env.DB_PATH, '..', 'uploads', 'selfies', s.file)));
});

test('the owner can switch the selfie off', async () => {
  assert.equal((await basem('PUT', '/api/addition-settings', { selfie_on_suspicion: false })).status, 403);
  assert.equal((await admin('PUT', '/api/addition-settings', { selfie_on_suspicion: false })).status, 200);
  backdate();
  const phone3 = client();
  await phone3('POST', '/api/login', { username: 'ali', password: 'ali-pass1' });
  assert.equal((await phone3('POST', '/api/punch', { type: 'back' })).status, 200);
  assert.equal((await admin('GET', '/api/addition-settings')).body.selfie_on_suspicion, false);
});
