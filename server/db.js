import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || (process.env.AMVERA === '1' ? '/data' : path.join(__dirname, '..', 'data'));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'budget.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    name TEXT,
    currency TEXT DEFAULT 'RUB',
    remind_enabled INTEGER DEFAULT 0,
    remind_hour INTEGER DEFAULT 21,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'card' CHECK(type IN ('cash', 'card', 'other')),
    balance REAL NOT NULL DEFAULT 0,
    icon TEXT DEFAULT '💳',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
    icon TEXT DEFAULT '💰',
    color TEXT DEFAULT '#5c6bc0',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    UNIQUE(user_id, category_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category_id INTEGER,
    account_id INTEGER,
    amount REAL NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
    note TEXT DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS piggy_banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    goal REAL NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0,
    icon TEXT DEFAULT '🏦',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS piggy_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piggy_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (piggy_id) REFERENCES piggy_banks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_cat_user ON categories(user_id);
  CREATE INDEX IF NOT EXISTS idx_acc_user ON accounts(user_id);
`);

// Миграции для уже существующих БД
try { db.exec(`ALTER TABLE users ADD COLUMN remind_enabled INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN remind_hour INTEGER DEFAULT 21`); } catch {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN account_id INTEGER`); } catch {}

const DEFAULT_CATEGORIES = [
  { name: 'Продукты', type: 'expense', icon: '🛒', color: '#66bb6a' },
  { name: 'Кафе', type: 'expense', icon: '☕', color: '#ffa726' },
  { name: 'Транспорт', type: 'expense', icon: '🚇', color: '#42a5f5' },
  { name: 'Жильё', type: 'expense', icon: '🏠', color: '#8d6e63' },
  { name: 'Связь', type: 'expense', icon: '📱', color: '#26c6da' },
  { name: 'Здоровье', type: 'expense', icon: '💊', color: '#ef5350' },
  { name: 'Одежда', type: 'expense', icon: '👕', color: '#ab47bc' },
  { name: 'Развлечения', type: 'expense', icon: '🎬', color: '#ec407a' },
  { name: 'Прочее', type: 'expense', icon: '📦', color: '#78909c' },
  { name: 'Зарплата', type: 'income', icon: '💼', color: '#43a047' },
  { name: 'Подработка', type: 'income', icon: '🛠️', color: '#7cb342' },
  { name: 'Подарок', type: 'income', icon: '🎁', color: '#9ccc65' },
];

const DEFAULT_ACCOUNTS = [
  { name: 'Наличные', type: 'cash', icon: '💵' },
  { name: 'Карта', type: 'card', icon: '💳' },
];

export function getOrCreateUser(telegramId, name = '') {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  if (user) {
    // счета могли появиться позже
    const accCount = db.prepare('SELECT COUNT(*) as c FROM accounts WHERE user_id = ?').get(user.id).c;
    if (accCount === 0) {
      const insA = db.prepare(
        'INSERT INTO accounts (user_id, name, type, balance, icon) VALUES (?, ?, ?, 0, ?)'
      );
      for (const a of DEFAULT_ACCOUNTS) insA.run(user.id, a.name, a.type, a.icon);
    }
    return user;
  }

  const info = db.prepare('INSERT INTO users (telegram_id, name) VALUES (?, ?)').run(String(telegramId), name || '');
  const userId = info.lastInsertRowid;

  const ins = db.prepare(
    'INSERT INTO categories (user_id, name, type, icon, color) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of DEFAULT_CATEGORIES) {
    ins.run(userId, c.name, c.type, c.icon, c.color);
  }

  const insA = db.prepare(
    'INSERT INTO accounts (user_id, name, type, balance, icon) VALUES (?, ?, ?, 0, ?)'
  );
  for (const a of DEFAULT_ACCOUNTS) {
    insA.run(userId, a.name, a.type, a.icon);
  }

  db.prepare(
    'INSERT INTO piggy_banks (user_id, name, goal, balance, icon) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'Подушка безопасности', 100000, 0, '🏦');

  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export default db;
