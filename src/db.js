import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Each entry upgrades the schema by one version (PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
    password_hash TEXT,                 -- NULL until the manager sets one
    active INTEGER NOT NULL DEFAULT 1,
    salary REAL NOT NULL DEFAULT 0,     -- monthly, SAR
    periods TEXT,                       -- JSON array of schedule period ids; NULL = all
    day_off INTEGER,                    -- weekly day off 0..6 (0 = Sunday), NULL = none
    can_log_ops INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- type: in | out | leave (temporary exit) | back (return from exit)
  -- ts is always the server clock; client_ts is only kept to detect tampered device clocks.
  CREATE TABLE punches (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('in', 'out', 'leave', 'back')),
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'manager')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip TEXT, device TEXT, user_agent TEXT,
    lat REAL, lng REAL, accuracy REAL,
    client_ts INTEGER,
    flags TEXT NOT NULL DEFAULT '[]',
    voided INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX punches_user_date ON punches(user_id, date, ts);
  CREATE INDEX punches_date ON punches(date);
  CREATE INDEX punches_device ON punches(device, ts);

  -- Approved leave, sick days, holidays. user_id NULL = whole company.
  CREATE TABLE excuses (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('leave', 'sick', 'holiday', 'excused')),
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX excuses_date ON excuses(date);

  CREATE TABLE deductions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL CHECK (category IN ('late', 'absence', 'early', 'exit', 'violation', 'damage', 'other')),
    reason TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX deductions_user_date ON deductions(user_id, date);

  -- Debt ledger: kind 'loan' adds to what the employee owes, 'repayment' reduces it.
  CREATE TABLE debts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('loan', 'repayment')),
    amount REAL NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '',
    from_salary INTEGER NOT NULL DEFAULT 1, -- repayment taken out of the salary (vs paid in cash)
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX debts_user_date ON debts(user_id, date);

  -- One row per day: order counts per sales channel, shipments, returns.
  CREATE TABLE daily_ops (
    date TEXT PRIMARY KEY,
    channels TEXT NOT NULL DEFAULT '{}',   -- {"salla": {"count": 12, "amount": 3400}, ...}
    shipments INTEGER NOT NULL DEFAULT 0,
    returns INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );

  -- kind: merchant_return (returned to/from merchants) | new_goods (received stock)
  CREATE TABLE stock_moves (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('merchant_return', 'new_goods')),
    party TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 0,
    value REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX stock_moves_date ON stock_moves(date);

  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('achievement', 'note', 'issue', 'request')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tickets_user ON tickets(user_id, created_at);
  CREATE INDEX tickets_date ON tickets(date);
  CREATE TABLE ticket_replies (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ticket_replies_ticket ON ticket_replies(ticket_id, created_at);

  -- Every change a manager makes to records, so edits can't hide.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    details TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_log_ts ON audit_log(ts);
  `,
  // v2: per-employee permissions, daily metrics, release/shortage requests, invoice lines.
  `
  ALTER TABLE users ADD COLUMN perms TEXT NOT NULL DEFAULT '[]';
  UPDATE users SET perms = '["orders","stock"]' WHERE can_log_ops = 1;
  UPDATE users SET perms = '["orders","stock","m:returns_system"]' WHERE username = 'abdulmalik';
  UPDATE users SET perms = '["m:shipments","m:returns_warehouse","m:orders_prepared"]' WHERE username = 'abdullah';
  UPDATE users SET perms = '["requests"]' WHERE username = 'basem';
  UPDATE users SET perms = '["m:daily_edits"]' WHERE username = 'safwan';
  UPDATE users SET perms = '["m:pending_issues","m:pending_chats"]' WHERE username = 'monther';

  -- One number (and optional note) per metric per day, e.g. orders prepared, pending chats.
  CREATE TABLE daily_metrics (
    date TEXT NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (date, key)
  );
  INSERT INTO daily_metrics (date, key, value, updated_by, updated_at)
    SELECT date, 'shipments', shipments, updated_by, updated_at FROM daily_ops WHERE shipments > 0;
  INSERT INTO daily_metrics (date, key, value, updated_by, updated_at)
    SELECT date, 'returns_system', returns, updated_by, updated_at FROM daily_ops WHERE returns > 0;

  ALTER TABLE stock_moves ADD COLUMN invoice_no TEXT NOT NULL DEFAULT '';
  ALTER TABLE stock_moves ADD COLUMN sku TEXT NOT NULL DEFAULT '';

  -- kind: release (فسح لإرجاع منتجات) | shortage (طلب نواقص)
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('release', 'shortage')),
    sku TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'done')),
    response TEXT NOT NULL DEFAULT '',
    handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX requests_status ON requests(status, created_at);
  CREATE INDEX requests_user ON requests(user_id, created_at);
  `,
  // v3: WhatsApp notifications.
  `
  ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    to_phone TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,          -- the same reminder is only ever queued once
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX notifications_status ON notifications(status, id);
  `,
  // v4: leave requests, month close, employee of the month, OTP resets, merchant return tracking,
  // Basem's late-orders numbers.
  `
  -- kind: leave (إجازة) | sick (مرضية) | permission (استئذان بالساعات، same day)
  CREATE TABLE leave_requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('leave', 'sick', 'permission')),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    from_time TEXT NOT NULL DEFAULT '',
    to_time TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    response TEXT NOT NULL DEFAULT '',
    handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX leave_requests_user ON leave_requests(user_id, from_date);
  CREATE INDEX leave_requests_status ON leave_requests(status, created_at);

  -- A closed month is frozen: its payroll is read from the snapshot and money entries are locked.
  CREATE TABLE payroll_closes (
    month TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_at INTEGER NOT NULL
  );

  CREATE TABLE awards (
    month TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    score REAL NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    announced_at INTEGER
  );

  CREATE TABLE otp_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  -- Merchant returns move ready → sent → settled.
  ALTER TABLE stock_moves ADD COLUMN status TEXT NOT NULL DEFAULT '';
  ALTER TABLE stock_moves ADD COLUMN status_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE stock_moves ADD COLUMN status_at INTEGER;
  UPDATE stock_moves SET status = 'ready' WHERE kind = 'merchant_return';

  UPDATE users SET perms = json_insert(json_insert(json_insert(perms, '$[#]', 'm:late_orders'), '$[#]', 'm:late_available'), '$[#]', 'm:late_unavailable')
    WHERE username = 'basem' AND perms NOT LIKE '%late_orders%';
  UPDATE settings SET value = json_insert(json_insert(json_insert(value,
      '$[#]', json('{"key":"late_orders","name":"الطلبات المتأخرة","note":false}')),
      '$[#]', json('{"key":"late_available","name":"منها متوفرة","note":false}')),
      '$[#]', json('{"key":"late_unavailable","name":"منها غير متوفرة","note":true}'))
    WHERE key = 'metrics' AND value NOT LIKE '%late_orders%';
  `,
  // v5: exit permission requested on the spot for a number of minutes (kind 'permission', minutes > 0).
  // The approved window starts when the employee actually steps out (left_at) and closes at their return (back_at).
  `
  ALTER TABLE leave_requests ADD COLUMN minutes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE leave_requests ADD COLUMN left_at INTEGER;
  ALTER TABLE leave_requests ADD COLUMN back_at INTEGER;
  `,
  // v6: barcode scans: outgoing shipments and customer returns, one row per scanned code.
  `
  CREATE TABLE scans (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('shipment', 'return')),
    code TEXT NOT NULL,
    date TEXT NOT NULL,
    ts INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (kind, code)
  );
  CREATE INDEX scans_day ON scans(date, kind);
  UPDATE users SET perms = json_insert(perms, '$[#]', 'scan') WHERE username = 'abdullah' AND perms NOT LIKE '%"scan"%';
  `,
  // v7: phone notifications (Web Push): one row per device that allowed notifications.
  `
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    fails INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
  -- reminders that must reach the phone once only (same keys as the WhatsApp queue)
  CREATE TABLE push_sent (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
  `,
  // v8: exchanges shipped ahead of the customer's return: the return tracking number, matched when the warehouse scans it.
  `
  CREATE TABLE exchanges (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'exchange' CHECK (kind IN ('exchange', 'refund')),
    tracking TEXT NOT NULL UNIQUE,
    order_no TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    date TEXT NOT NULL,
    received_at INTEGER,
    received_scan_id INTEGER,
    received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_notified_at INTEGER
  );
  CREATE INDEX exchanges_open ON exchanges(received_at, date);
  UPDATE users SET perms = json_insert(perms, '$[#]', 'exchanges') WHERE username = 'monther' AND perms NOT LIKE '%"exchanges"%';
  `,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function audit(db, actorId, action, targetUserId = null, details = '') {
  db.prepare('INSERT INTO audit_log (ts, actor_id, action, target_user_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), actorId, action, targetUserId, typeof details === 'string' ? details : JSON.stringify(details));
}
