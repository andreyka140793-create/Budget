import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function hasTable(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function hasColumn(table, column) {
  return db.pragma(`table_info(${table})`).some((c) => c.name === column);
}

function migrateLegacyMoneyToCents() {
  const version = Number(db.pragma('user_version', { simple: true }) || 0);
  if (version >= 2) return;

  const legacyTables = ['accounts', 'transactions', 'budgets', 'piggy_banks'];
  const existing = legacyTables.filter(hasTable);
  if (version === 0 && existing.length) {
    // The original application stored monetary values as RUB/REAL.
    // Version 2 stores integer kopecks/cents in the same columns.
    const marker = db.prepare("SELECT value FROM app_meta WHERE key='money_migrated'").get();
    if (!marker) {
      db.transaction(() => {
        if (hasTable('accounts')) db.prepare('UPDATE accounts SET balance = ROUND(balance * 100)').run();
        if (hasTable('transactions')) db.prepare('UPDATE transactions SET amount = ROUND(amount * 100)').run();
        if (hasTable('budgets')) db.prepare('UPDATE budgets SET amount = ROUND(amount * 100)').run();
        if (hasTable('piggy_banks')) {
          db.prepare('UPDATE piggy_banks SET goal = ROUND(goal * 100), balance = ROUND(balance * 100)').run();
        }
        db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('money_migrated','1')").run();
      })();
    }
  }
  db.pragma('user_version = 2');
}

// Metadata table is created first so migrations are idempotent.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

migrateLegacyMoneyToCents();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'RUB',
    timezone TEXT NOT NULL DEFAULT '${config.timezoneDefault.replace(/'/g, "''")}',
    remind_enabled INTEGER NOT NULL DEFAULT 0 CHECK(remind_enabled IN (0,1)),
    remind_hour INTEGER NOT NULL DEFAULT 21 CHECK(remind_hour BETWEEN 0 AND 23),
    last_reminder_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
    type TEXT NOT NULL DEFAULT 'card' CHECK(type IN ('card','cash','other')),
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= -900000000000000),
    icon TEXT NOT NULL DEFAULT '💳',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 50),
    type TEXT NOT NULL CHECK(type IN ('expense','income')),
    icon TEXT NOT NULL DEFAULT '💰',
    color TEXT NOT NULL DEFAULT '#5c6bc0',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount >= 0),
    UNIQUE(user_id, category_id)
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    to_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount INTEGER NOT NULL CHECK(amount > 0),
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    transfer_id TEXT REFERENCES transfers(id) ON DELETE CASCADE,
    idempotency_key TEXT,
    amount INTEGER NOT NULL CHECK(amount > 0),
    type TEXT NOT NULL CHECK(type IN ('expense','income')),
    kind TEXT NOT NULL DEFAULT 'normal' CHECK(kind IN ('normal','transfer')),
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS piggy_banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
    goal INTEGER NOT NULL DEFAULT 0 CHECK(goal >= 0),
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    icon TEXT NOT NULL DEFAULT '🏦',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS piggy_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    piggy_id INTEGER NOT NULL REFERENCES piggy_banks(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK(amount != 0),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe additive migration for databases created by the previous version.
if (hasTable('users')) {
  if (!hasColumn('users', 'timezone')) db.exec(`ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT '${config.timezoneDefault.replace(/'/g, "''")}'`);
  if (!hasColumn('users', 'last_reminder_date')) db.exec('ALTER TABLE users ADD COLUMN last_reminder_date TEXT');
  if (!hasColumn('users', 'updated_at')) db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
}
if (hasTable('transactions')) {
  if (!hasColumn('transactions', 'transfer_id')) db.exec('ALTER TABLE transactions ADD COLUMN transfer_id TEXT');
  if (!hasColumn('transactions', 'kind')) db.exec("ALTER TABLE transactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
  if (!hasColumn('transactions', 'idempotency_key')) db.exec('ALTER TABLE transactions ADD COLUMN idempotency_key TEXT');
  // Legacy transfers were represented by two ordinary transactions. Mark them so they
  // do not distort income/expense analytics after migration. They remain visible in history.
  db.prepare("UPDATE transactions SET kind='transfer' WHERE kind='normal' AND (note LIKE 'Перевод →%' OR note LIKE 'Перевод ←%')").run();
}
if (hasTable('piggy_ops') && !hasColumn('piggy_ops', 'user_id')) {
  db.exec('ALTER TABLE piggy_ops ADD COLUMN user_id INTEGER');
  db.exec('UPDATE piggy_ops SET user_id=(SELECT user_id FROM piggy_banks WHERE piggy_banks.id=piggy_ops.piggy_id)');
}

// Ownership indexes. The service layer still checks ownership explicitly.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_categories_user_type ON categories(user_id,type);
  CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id,date,id);
  CREATE INDEX IF NOT EXISTS idx_transactions_transfer ON transactions(transfer_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_piggies_user ON piggy_banks(user_id);
  CREATE INDEX IF NOT EXISTS idx_piggy_ops_user ON piggy_ops(user_id,created_at);
`);

const DEFAULT_CATEGORIES = [
  ['Продукты','expense','🛒','#66bb6a'], ['Кафе','expense','☕','#ffa726'],
  ['Транспорт','expense','🚗','#42a5f5'], ['Жильё','expense','🏠','#ab47bc'],
  ['Связь','expense','📱','#26c6da'], ['Здоровье','expense','💊','#ef5350'],
  ['Одежда','expense','👕','#ec407a'], ['Развлечения','expense','🎬','#7e57c2'],
  ['Прочее','expense','📦','#78909c'], ['Зарплата','income','💰','#66bb6a'],
  ['Подработка','income','🛠️','#9ccc65'], ['Подарок','income','🎁','#ffca28'],
];

export function ensureUser(telegramId, name = '') {
  const tid = String(telegramId);
  let user = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
  if (user) {
    if (name && name !== user.name) db.prepare('UPDATE users SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name.slice(0,80), user.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  }

  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO users(telegram_id,name) VALUES(?,?)').run(tid, String(name || '').slice(0,80));
    const userId = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO accounts(user_id,name,type,balance,icon) VALUES(?,?,?,?,?)').run(userId,'Карта','card',0,'💳');
    db.prepare('INSERT INTO accounts(user_id,name,type,balance,icon) VALUES(?,?,?,?,?)').run(userId,'Наличные','cash',0,'💵');
    const insert = db.prepare('INSERT INTO categories(user_id,name,type,icon,color) VALUES(?,?,?,?,?)');
    for (const c of DEFAULT_CATEGORIES) insert.run(userId, ...c);
    return userId;
  });
  const id = tx();
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

export function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
export function getUserByTelegramId(id) { return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(id)); }

export function withTransaction(fn) { return db.transaction(fn)(); }
export function nowDateInTimeZone(timeZone = config.timezoneDefault) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezoneDefault }).format(new Date());
  }
}
export function todayForUser(user) { return nowDateInTimeZone(user?.timezone || config.timezoneDefault); }
export function toCents(value) {
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
export function fromCents(value) { return Number(value || 0) / 100; }
export function mapMoneyRow(row, fields = []) {
  if (!row) return row;
  const copy = { ...row };
  for (const f of fields) if (f in copy) copy[f] = fromCents(copy[f]);
  return copy;
}

export function getDaySummary(userId, date) {
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE user_id=? AND type='expense' AND kind='normal' AND date=?").get(userId,date).t;
  const income = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE user_id=? AND type='income' AND kind='normal' AND date=?").get(userId,date).t;
  const count = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND date=?').get(userId,date).c;
  return { date, expense: fromCents(expense), income: fromCents(income), count };
}

export function getUsersForReminder(hour) {
  return db.prepare("SELECT * FROM users WHERE remind_enabled=1 AND remind_hour=?").all(hour);
}

export function closeDb() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}

process.once('SIGINT', () => { closeDb(); process.exit(0); });
process.once('SIGTERM', () => { closeDb(); process.exit(0); });

console.log(`DB ready: ${config.dbPath}`);
export default db;
