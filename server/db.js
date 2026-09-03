/**
 * SQLite через sql.js (без native-модулей — стабильно на Amvera)
 * API совместим с better-sqlite3: prepare().get/all/run, transaction, exec
 */
import initSqlJs from 'sql.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dataDir =
  process.env.DATA_DIR ||
  (process.env.AMVERA === '1' ? '/data' : path.join(__dirname, '..', 'data'));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'budget.db');

let wasmPath;
try {
  wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
} catch {
  wasmPath = null;
}
const SQL = await initSqlJs(
  wasmPath
    ? { locateFile: (f) => (f.endsWith('.wasm') ? wasmPath : f) }
    : undefined
);
let raw;
if (fs.existsSync(dbPath)) {
  raw = new SQL.Database(fs.readFileSync(dbPath));
} else {
  raw = new SQL.Database();
}

function persist() {
  try {
    const data = raw.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.warn('DB persist failed:', e.message);
  }
}

// автосохранение раз в 2 сек после изменений
let dirty = false;
let persistTimer = null;
function markDirty() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (dirty) {
      dirty = false;
      persist();
    }
  }, 1500);
}

function bindStmt(stmt, params) {
  if (!params || params.length === 0) return;
  // sql.js: bind array is 1-based values as array
  const bound = {};
  params.forEach((v, i) => {
    bound[i + 1] = v === undefined ? null : v;
  });
  stmt.bind(bound);
}

function stmtAll(sql, params) {
  const stmt = raw.prepare(sql);
  bindStmt(stmt, params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function stmtGet(sql, params) {
  const rows = stmtAll(sql, params);
  return rows[0];
}

function stmtRun(sql, params) {
  const stmt = raw.prepare(sql);
  bindStmt(stmt, params);
  stmt.step();
  stmt.free();
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
  pragma() {
    /* no-op for sql.js */
  },
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
};

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
    type TEXT NOT NULL DEFAULT 'card',
    balance REAL NOT NULL DEFAULT 0,
    icon TEXT DEFAULT '💳',
    created_at TEXT DEFAULT (datetime('now'))
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
    amount REAL NOT NULL,
    UNIQUE(user_id, category_id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category_id INTEGER,
    account_id INTEGER,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    note TEXT DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS piggy_banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    goal REAL NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0,
    icon TEXT DEFAULT '🏦',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const DEFAULT_CATEGORIES = [
  { name: 'Продукты', type: 'expense', icon: '🛒', color: '#66bb6a' },
  { name: 'Кафе', type: 'expense', icon: '☕', color: '#ffa726' },
  { name: 'Транспорт', type: 'expense', icon: '🚗', color: '#42a5f5' },
  { name: 'Жильё', type: 'expense', icon: '🏠', color: '#ab47bc' },
  { name: 'Связь', type: 'expense', icon: '📱', color: '#26c6da' },
  { name: 'Здоровье', type: 'expense', icon: '💊', color: '#ef5350' },
  { name: 'Одежда', type: 'expense', icon: '👕', color: '#ec407a' },
  { name: 'Развлечения', type: 'expense', icon: '🎬', color: '#7e57c2' },
  { name: 'Прочее', type: 'expense', icon: '📦', color: '#78909c' },
  { name: 'Зарплата', type: 'income', icon: '💰', color: '#66bb6a' },
  { name: 'Подработка', type: 'income', icon: '🛠️', color: '#9ccc65' },
  { name: 'Подарок', type: 'income', icon: '🎁', color: '#ffca28' },
];

export function getOrCreateUser(telegramId, name = '') {
  const tid = String(telegramId);
  let user = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
  if (user) {
    if (name && name !== user.name) {
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, user.id);
      user.name = name;
    }
    return user;
  }

  // sql.js: INTEGER PRIMARY KEY auto
  db.prepare(
    `INSERT INTO users (telegram_id, name, remind_enabled, remind_hour) VALUES (?,?,0,21)`
  ).run(tid, name || '');
  user = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);

  db.prepare(
    `INSERT INTO accounts (user_id, name, type, balance, icon) VALUES (?,?,?,?,?)`
  ).run(user.id, 'Карта', 'card', 0, '💳');
  db.prepare(
    `INSERT INTO accounts (user_id, name, type, balance, icon) VALUES (?,?,?,?,?)`
  ).run(user.id, 'Наличные', 'cash', 0, '💵');

  const ins = db.prepare(
    `INSERT INTO categories (user_id, name, type, icon, color) VALUES (?,?,?,?,?)`
  );
  for (const c of DEFAULT_CATEGORIES) {
    ins.run(user.id, c.name, c.type, c.icon, c.color);
  }
  persist();
  return user;
}

// сохранение при выходе
process.on('SIGINT', () => {
  persist();
  process.exit(0);
});
process.on('SIGTERM', () => {
  persist();
  process.exit(0);
});

console.log('DB ready at', dbPath);
export default db;
