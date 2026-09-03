import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

export function withTransaction(fn) {
  return db.transaction(fn)();
}

/* ---------- деньги ---------- */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
export const fromCents = (cents) => Math.round(Number(cents) || 0) / 100;

/* ---------- схема ---------- */
function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'RUB',
      timezone TEXT,
      remind_enabled INTEGER NOT NULL DEFAULT 0,
      remind_hour INTEGER NOT NULL DEFAULT 21,
      last_remind_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'card' CHECK (type IN ('card','cash','other')),
      initial_balance INTEGER NOT NULL DEFAULT 0,
      icon TEXT DEFAULT '💳',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      icon TEXT DEFAULT '💰',
      color TEXT DEFAULT '#5c6bc0'
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK (amount >= 0),
      UNIQUE(user_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      to_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      amount INTEGER NOT NULL CHECK (amount > 0),
      note TEXT DEFAULT '',
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      transfer_id TEXT REFERENCES transfers(id) ON DELETE CASCADE,
      idempotency_key TEXT,
      amount INTEGER NOT NULL CHECK (amount > 0),
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','transfer')),
      note TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS piggy_banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      goal INTEGER NOT NULL DEFAULT 0,
      icon TEXT DEFAULT '🏦',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS piggy_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piggy_id INTEGER NOT NULL REFERENCES piggy_banks(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_drafts (
      key TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_tx_user_kind_type ON transactions(user_id, kind, type, date);
    CREATE INDEX IF NOT EXISTS idx_tx_user_cat ON transactions(user_id, category_id, date);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_transfer ON transactions(transfer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_idem
      ON transactions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_piggy_user ON piggy_banks(user_id);
    CREATE INDEX IF NOT EXISTS idx_piggy_ops ON piggy_ops(piggy_id);
    CREATE INDEX IF NOT EXISTS idx_users_remind ON users(remind_enabled, remind_hour);
  `);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','2')").run();
}

/* ---------- миграция старой базы (sql.js, суммы в рублях) ---------- */
function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function migrateLegacy() {
  if (!tableExists('transactions')) return false;
  if (hasColumn('transactions', 'kind')) return false;

  console.log('Обнаружена база старого формата — миграция…');
  try {
    fs.copyFileSync(config.dbPath, `${config.dbPath}.legacy-${Date.now()}`);
  } catch (e) {
    console.warn('Не удалось сделать копию перед миграцией:', e.message);
  }

  const legacyTables = ['users', 'accounts', 'categories', 'budgets', 'transactions', 'piggy_banks'];
  db.pragma('foreign_keys = OFF');
  withTransaction(() => {
    for (const t of legacyTables) {
      if (tableExists(t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_legacy`);
    }
    createSchema();

    db.exec(`
      INSERT INTO users(id,telegram_id,name,currency,remind_enabled,remind_hour,created_at)
      SELECT id, CAST(telegram_id AS TEXT), COALESCE(name,''), COALESCE(currency,'RUB'),
             COALESCE(remind_enabled,0), COALESCE(remind_hour,21), COALESCE(created_at, datetime('now'))
      FROM users_legacy;

      INSERT INTO accounts(id,user_id,name,type,initial_balance,icon)
      SELECT id, user_id, COALESCE(name,'Счёт'),
             CASE WHEN type IN ('card','cash','other') THEN type ELSE 'card' END,
             CAST(ROUND(COALESCE(balance,0)*100) AS INTEGER), COALESCE(icon,'💳')
      FROM accounts_legacy;

      INSERT INTO categories(id,user_id,name,type,icon,color)
      SELECT id, user_id, COALESCE(name,'Прочее'),
             CASE WHEN type='income' THEN 'income' ELSE 'expense' END,
             COALESCE(icon,'💰'), COALESCE(color,'#5c6bc0')
      FROM categories_legacy;

      INSERT INTO transactions(id,user_id,category_id,account_id,amount,type,kind,note,date,created_at)
      SELECT id, user_id, category_id, account_id,
             CAST(ROUND(amount*100) AS INTEGER),
             CASE WHEN type='income' THEN 'income' ELSE 'expense' END,
             CASE WHEN category_id IS NULL AND COALESCE(note,'') LIKE 'Перевод%' THEN 'transfer' ELSE 'normal' END,
             COALESCE(note,''), date, COALESCE(created_at, datetime('now'))
      FROM transactions_legacy
      WHERE amount IS NOT NULL AND amount > 0;
    `);

    if (tableExists('budgets_legacy')) {
      db.exec(`
        INSERT INTO budgets(user_id,category_id,amount)
        SELECT user_id, category_id, CAST(ROUND(COALESCE(amount,0)*100) AS INTEGER)
        FROM budgets_legacy
        WHERE category_id IN (SELECT id FROM categories);
      `);
    }
    if (tableExists('piggy_banks_legacy')) {
      db.exec(`
        INSERT INTO piggy_banks(id,user_id,name,goal,icon)
        SELECT id, user_id, COALESCE(name,'Копилка'),
               CAST(ROUND(COALESCE(goal,0)*100) AS INTEGER), COALESCE(icon,'🏦')
        FROM piggy_banks_legacy;

        INSERT INTO piggy_ops(piggy_id, amount, note)
        SELECT id, CAST(ROUND(COALESCE(balance,0)*100) AS INTEGER), 'Перенос при миграции'
        FROM piggy_banks_legacy WHERE COALESCE(balance,0) <> 0;
      `);
    }

    // чистим «висячие» ссылки
    db.exec(`
      UPDATE transactions SET category_id=NULL
        WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM categories);
      UPDATE transactions SET account_id=NULL
        WHERE account_id IS NOT NULL AND account_id NOT IN (SELECT id FROM accounts);
      DELETE FROM transactions WHERE user_id NOT IN (SELECT id FROM users);
      DELETE FROM accounts WHERE user_id NOT IN (SELECT id FROM users);
      DELETE FROM categories WHERE user_id NOT IN (SELECT id FROM users);
    `);

    // сохраняем ранее показанные балансы: initial = old_balance - net(tx)
    db.exec(`
      UPDATE accounts SET initial_balance = initial_balance - COALESCE((
        SELECT SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END)
        FROM transactions t WHERE t.account_id = accounts.id
      ), 0);
    `);

    for (const t of legacyTables) {
      if (tableExists(`${t}_legacy`)) db.exec(`DROP TABLE ${t}_legacy`);
    }
  });
  db.pragma('foreign_keys = ON');

  const bad = db.pragma('foreign_key_check');
  if (bad.length) console.warn('foreign_key_check после миграции:', bad.slice(0, 5));
  console.log('Миграция завершена.');
  return true;
}

migrateLegacy();
createSchema();
db.exec('ANALYZE');

/* ---------- пользователи ---------- */
const DEFAULT_CATEGORIES = [
  ['Продукты', 'expense', '🛒', '#66bb6a'],
  ['Кафе', 'expense', '☕', '#ffa726'],
  ['Транспорт', 'expense', '🚗', '#42a5f5'],
  ['Жильё', 'expense', '🏠', '#ab47bc'],
  ['Связь', 'expense', '📱', '#26c6da'],
  ['Здоровье', 'expense', '💊', '#ef5350'],
  ['Одежда', 'expense', '👕', '#ec407a'],
  ['Развлечения', 'expense', '🎬', '#7e57c2'],
  ['Прочее', 'expense', '📦', '#78909c'],
  ['Зарплата', 'income', '💰', '#66bb6a'],
  ['Подработка', 'income', '🛠️', '#9ccc65'],
  ['Подарок', 'income', '🎁', '#ffca28'],
];

export function getOrCreateUser(telegramId, name = '') {
  const tid = String(telegramId);
  const safeName = String(name || '').slice(0, 64);
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
  if (existing) {
    if (safeName && safeName !== existing.name) {
      db.prepare('UPDATE users SET name=? WHERE id=?').run(safeName, existing.id);
      existing.name = safeName;
    }
    return existing;
  }

  return withTransaction(() => {
    const info = db
      .prepare('INSERT INTO users(telegram_id,name,timezone) VALUES(?,?,?)')
      .run(tid, safeName, config.timezoneDefault);
    const userId = Number(info.lastInsertRowid);

    const insAcc = db.prepare(
      'INSERT INTO accounts(user_id,name,type,initial_balance,icon) VALUES(?,?,?,0,?)'
    );
    insAcc.run(userId, 'Карта', 'card', '💳');
    insAcc.run(userId, 'Наличные', 'cash', '💵');

    const insCat = db.prepare(
      'INSERT INTO categories(user_id,name,type,icon,color) VALUES(?,?,?,?,?)'
    );
    for (const [n, t, i, c] of DEFAULT_CATEGORIES) insCat.run(userId, n, t, i, c);

    return db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  });
}

export function closeDb() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (e) {
    console.warn('closeDb', e.message);
  }
}

export default db;
