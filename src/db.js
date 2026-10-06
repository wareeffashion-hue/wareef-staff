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
