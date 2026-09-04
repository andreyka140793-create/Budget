/**
 * SQLite через sql.js — без native-модулей (Amvera-friendly)
 * API совместим: prepare().get/all/run, transaction, exec, pragma
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { config } from './config.js';

const require = createRequire(import.meta.url);

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

let wasmPath = null;
try {
  wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
} catch {
  wasmPath = null;
}

const SQL = await initSqlJs(
  wasmPath ? { locateFile: (f) => (f.endsWith('.wasm') ? wasmPath : f) } : undefined
);

let raw;
try {
  if (fs.existsSync(config.dbPath)) {
    raw = new SQL.Database(fs.readFileSync(config.dbPath));
  } else {
    raw = new SQL.Database();
  }
} catch (e) {
  console.warn('DB open failed, new DB:', e.message);
  raw = new SQL.Database();
}

let dirty = false;
let persistTimer = null;
function persist() {
  try {
    const data = raw.export();
    fs.writeFileSync(config.dbPath, Buffer.from(data));
  } catch (e) {
    console.warn('DB persist failed:', e.message);
  }
}
function markDirty() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (dirty) {
      dirty = false;
      persist();
    }
  }, 800);
}

function normalizeParams(params) {
  if (!params || params.length === 0) return [];
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function stmtAll(sql, params) {
  const p = normalizeParams(params);
  const stmt = raw.prepare(sql);
  try {
    if (p.length) stmt.bind(p);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function stmtGet(sql, params) {
  return stmtAll(sql, params)[0];
}

function stmtRun(sql, params) {
  const p = normalizeParams(params);
  const stmt = raw.prepare(sql);
  try {
    if (p.length) stmt.bind(p);
    stmt.step();
  } finally {
    stmt.free();
  }
  const changes = raw.getRowsModified();
  let lastInsertRowid = 0;
  try {
    const r = raw.exec('SELECT last_insert_rowid() as id');
    if (r[0]?.values?.[0]) lastInsertRowid = r[0].values[0][0];
  } catch {}
  markDirty();
  return { changes, lastInsertRowid };
}

const db = {
  prepare(sql) {
    return {
      all(...params) {
        return stmtAll(sql, params);
      },
      get(...params) {
        return stmtGet(sql, params);
      },
      run(...params) {
        return stmtRun(sql, params);
      },
    };
  },
  exec(sql) {
    raw.exec(sql);
    markDirty();
  },
  pragma() {},
  transaction(fn) {
    return (...args) => {
      raw.run('BEGIN');
      try {
        const result = fn(...args);
        raw.run('COMMIT');
        markDirty();
        return result;
      } catch (e) {
        try {
          raw.run('ROLLBACK');
        } catch {}
        throw e;
      }
    };
  },
  close() {
    persist();
  },
};

export function withTransaction(fn) {
  return db.transaction(fn)();
}

export function toCents(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
export const fromCents = (cents) => Math.round(Number(cents) || 0) / 100;

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
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'card',
      initial_balance INTEGER NOT NULL DEFAULT 0,
      icon TEXT DEFAULT '💳',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      icon TEXT DEFAULT '💰',
      color TEXT DEFAULT '#5c6bc0'
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      UNIQUE(user_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category_id INTEGER,
      account_id INTEGER,
      amount INTEGER NOT NULL,
      type TEXT,
      kind TEXT DEFAULT 'regular',
      note TEXT DEFAULT '',
      date TEXT NOT NULL,
      transfer_id TEXT,
      idempotency_key TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS piggy_banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      goal INTEGER NOT NULL DEFAULT 0,
      balance INTEGER NOT NULL DEFAULT 0,
      icon TEXT DEFAULT '🏦',
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS piggy_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piggy_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT
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
  `);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','2')").run();
}

createSchema();
console.log('DB ready (sql.js):', config.dbPath);

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
    for (const [n, typ, i, c] of DEFAULT_CATEGORIES) insCat.run(userId, n, typ, i, c);

    return db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  });
}

export function closeDb() {
  try {
    persist();
    raw.close();
  } catch (e) {
    console.warn('closeDb', e.message);
  }
}

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

export default db;
