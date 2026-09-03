import crypto from 'node:crypto';
import db, { fromCents, withTransaction } from './db.js';
import { config } from './config.js';
import { badRequest, notFound } from './errors.js';
import {
  requireAccountType, requireAmountCents, requireColor, requireDate, requireIcon,
  requireInt, requireName, requireNote, requireType, optionalInt, optionalIdempotencyKey,
} from './validation.js';

/* ---------- даты и таймзоны ---------- */
export function tzOf(user) {
  return user?.timezone || config.timezoneDefault;
}

export function todayIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts; // en-CA даёт YYYY-MM-DD
}

export function localHourIn(timeZone) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(new Date())
  );
}

export function monthBounds(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
    label: `${String(m).padStart(2, '0')}.${y}`,
  };
}

function shiftMonth(dateStr, delta) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/* ---------- владение ---------- */
export function getAccountOwned(userId, accountId) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').get(accountId, userId);
  if (!acc) throw notFound('Счёт не найден');
  return acc;
}

export function getCategoryOwned(userId, categoryId, type = null) {
  const cat = db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(categoryId, userId);
  if (!cat) throw notFound('Категория не найдена');
  if (type && cat.type !== type) throw badRequest('Категория не подходит по типу операции');
  return cat;
}

/* ---------- счета ---------- */
const ACCOUNT_SQL = `
  SELECT a.id, a.user_id, a.name, a.type, a.icon, a.archived,
         a.initial_balance + COALESCE((
           SELECT SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END)
           FROM transactions t WHERE t.account_id = a.id
         ), 0) AS balance_cents
  FROM accounts a
  WHERE a.user_id = ?`;

export function accountList(userId, { includeArchived = false } = {}) {
  const sql = ACCOUNT_SQL + (includeArchived ? '' : ' AND a.archived = 0') + ' ORDER BY a.id';
  return db.prepare(sql).all(userId).map((a) => ({
    id: a.id, name: a.name, type: a.type, icon: a.icon,
    archived: Boolean(a.archived), balance: fromCents(a.balance_cents),
  }));
}

function accountBalanceCents(userId, accountId) {
  const row = db.prepare(ACCOUNT_SQL + ' AND a.id = ?').get(userId, accountId);
  if (!row) throw notFound('Счёт не найден');
  return row.balance_cents;
}

export function createAccount(userId, input) {
  const name = requireName(input.name, 'Название счёта');
  const type = requireAccountType(input.type);
  const icon = requireIcon(input.icon, type === 'cash' ? '💵' : '💳');
  const initial = input.initial_balance ? requireAmountCents(input.initial_balance, 'Начальный баланс') : 0;
  const count = db.prepare('SELECT COUNT(*) c FROM accounts WHERE user_id=?').get(userId).c;
  if (count >= 30) throw badRequest('Слишком много счетов');
  const info = db
    .prepare('INSERT INTO accounts(user_id,name,type,initial_balance,icon) VALUES(?,?,?,?,?)')
    .run(userId, name, type, initial, icon);
  return accountList(userId).find((a) => a.id === Number(info.lastInsertRowid));
}

export function deleteAccount(userId, accountId) {
  const acc = getAccountOwned(userId, requireInt(accountId, 'account_id'));
  const active = db.prepare('SELECT COUNT(*) c FROM accounts WHERE user_id=? AND archived=0').get(userId).c;
  if (active <= 1) throw badRequest('Нужен хотя бы один активный счёт');
  const used = db.prepare('SELECT COUNT(*) c FROM transactions WHERE account_id=?').get(acc.id).c;
  if (used > 0) {
    db.prepare('UPDATE accounts SET archived=1 WHERE id=? AND user_id=?').run(acc.id, userId);
    return { ok: true, archived: true };
  }
  db.prepare('DELETE FROM accounts WHERE id=? AND user_id=?').run(acc.id, userId);
  return { ok: true, archived: false };
}

/* ---------- категории ---------- */
export function categoryList(userId, type = null) {
  if (type === 'income' || type === 'expense') {
    return db.prepare('SELECT * FROM categories WHERE user_id=? AND type=? ORDER BY name').all(userId, type);
  }
  return db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY type, name').all(userId);
}

export function createCategory(userId, input) {
  const name = requireName(input.name, 'Название категории');
  const type = requireType(input.type);
  const icon = requireIcon(input.icon, '💰');
  const color = requireColor(input.color);
  const dup = db
    .prepare('SELECT 1 FROM categories WHERE user_id=? AND type=? AND lower(name)=lower(?)')
    .get(userId, type, name);
  if (dup) throw badRequest('Такая категория уже есть');
  const count = db.prepare('SELECT COUNT(*) c FROM categories WHERE user_id=?').get(userId).c;
  if (count >= 100) throw badRequest('Слишком много категорий');
  const info = db
    .prepare('INSERT INTO categories(user_id,name,type,icon,color) VALUES(?,?,?,?,?)')
    .run(userId, name, type, icon, color);
  return db.prepare('SELECT * FROM categories WHERE id=?').get(Number(info.lastInsertRowid));
}

export function deleteCategory(userId, categoryId) {
  const cat = getCategoryOwned(userId, requireInt(categoryId, 'category_id'));
  withTransaction(() => {
    db.prepare('DELETE FROM budgets WHERE user_id=? AND category_id=?').run(userId, cat.id);
    db.prepare('UPDATE transactions SET category_id=NULL WHERE user_id=? AND category_id=?').run(userId, cat.id);
    db.prepare('DELETE FROM categories WHERE id=? AND user_id=?').run(cat.id, userId);
  });
  return { ok: true };
}

export function resolveCategoryByName(userId, type, categoryName) {
  const cats = categoryList(userId, type);
  const wanted = String(categoryName || '').trim().toLowerCase();
  const found =
    cats.find((c) => c.name.toLowerCase() === wanted) ||
    cats.find((c) => c.name === 'Прочее') ||
    cats[0];
  return { category_id: found?.id ?? null, category_name: found?.name ?? null };
}

/* ---------- операции ---------- */
const TX_SELECT = `
  SELECT t.id, t.amount, t.type, t.kind, t.note, t.date, t.transfer_id,
         c.id AS category_id, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
         a.id AS account_id, a.name AS account_name, a.icon AS account_icon
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
  LEFT JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id
  WHERE t.user_id = ?`;

const mapTx = (r) => ({ ...r, amount: fromCents(r.amount) });

export function listTransactions(userId, limit = 50, offset = 0) {
  return db
    .prepare(`${TX_SELECT} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(userId, limit, offset)
    .map(mapTx);
}

export function getTransaction(userId, id) {
  const row = db.prepare(`${TX_SELECT} AND t.id = ?`).get(userId, id);
  return row ? mapTx(row) : null;
}

export function createTransaction(user, input) {
  const userId = user.id;
  const type = requireType(input.type);
  const amount = requireAmountCents(input.amount);
  const date = requireDate(input.date, todayIn(tzOf(user)));
  const note = requireNote(input.note);
  const idempotencyKey = optionalIdempotencyKey(input.idempotency_key);

  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT id FROM transactions WHERE user_id=? AND idempotency_key=?')
      .get(userId, idempotencyKey);
    if (existing) return getTransaction(userId, existing.id);
  }

  let accountId = optionalInt(input.account_id, 'account_id');
  const categoryId = optionalInt(input.category_id, 'category_id');

  if (!accountId) {
    accountId =
      db.prepare('SELECT id FROM accounts WHERE user_id=? AND archived=0 ORDER BY id LIMIT 1').get(userId)?.id ??
      null;
  }
  if (accountId) getAccountOwned(userId, accountId);
  if (categoryId) getCategoryOwned(userId, categoryId, type);

  const dayCount = db
    .prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND date=? AND kind='normal'")
    .get(userId, date).c;
  if (dayCount >= config.maxTransactionsPerDay) throw badRequest('Слишком много операций за один день');

  const id = withTransaction(() => {
    const info = db
      .prepare(`INSERT INTO transactions(user_id,category_id,account_id,idempotency_key,amount,type,kind,note,date)
                VALUES(?,?,?,?,?,?,'normal',?,?)`)
      .run(userId, categoryId, accountId, idempotencyKey, amount, type, note, date);
    return Number(info.lastInsertRowid);
  });
  return getTransaction(userId, id);
}

export function deleteTransaction(userId, id) {
  const txId = requireInt(id, 'transaction_id');
  const row = db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(txId, userId);
  if (!row) throw notFound('Операция не найдена');
  if (row.transfer_id) throw badRequest('Перевод удаляется целиком: удалите его в разделе переводов');
  const res = db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(row.id, userId);
  if (res.changes !== 1) throw badRequest('Не удалось удалить операцию');
  return { ok: true };
}

/* ---------- переводы ---------- */
export function createTransfer(user, input) {
  const userId = user.id;
  const fromId = requireInt(input.from_id, 'from_id');
  const toId = requireInt(input.to_id, 'to_id');
  const amount = requireAmountCents(input.amount);
  const note = requireNote(input.note);
  const date = requireDate(input.date, todayIn(tzOf(user)));
  if (fromId === toId) throw badRequest('Счета должны отличаться');

  return withTransaction(() => {
    const from = getAccountOwned(userId, fromId);
    const to = getAccountOwned(userId, toId);
    if (accountBalanceCents(userId, from.id) < amount) throw badRequest('Недостаточно средств');

    const transferId = crypto.randomUUID();
    db.prepare(`INSERT INTO transfers(id,user_id,from_account_id,to_account_id,amount,note,date)
                VALUES(?,?,?,?,?,?,?)`)
      .run(transferId, userId, from.id, to.id, amount, note, date);

    const ins = db.prepare(`INSERT INTO transactions(user_id,account_id,transfer_id,amount,type,kind,note,date)
                            VALUES(?,?,?,?,?, 'transfer',?,?)`);
    ins.run(userId, from.id, transferId, amount, 'expense', note || `Перевод → ${to.name}`, date);
    ins.run(userId, to.id, transferId, amount, 'income', note || `Перевод ← ${from.name}`, date);

    return { id: transferId, accounts: accountList(userId) };
  });
}

export function listTransfers(userId, limit = 50) {
  return db
    .prepare(`SELECT tr.*, af.name from_name, at.name to_name
              FROM transfers tr
              JOIN accounts af ON af.id = tr.from_account_id
              JOIN accounts at ON at.id = tr.to_account_id
              WHERE tr.user_id=? ORDER BY tr.date DESC, tr.created_at DESC LIMIT ?`)
    .all(userId, limit)
    .map((t) => ({ ...t, amount: fromCents(t.amount) }));
}

export function deleteTransfer(userId, transferId) {
  const transfer = db.prepare('SELECT * FROM transfers WHERE id=? AND user_id=?').get(String(transferId), userId);
  if (!transfer) throw notFound('Перевод не найден');
  withTransaction(() => {
    db.prepare('DELETE FROM transactions WHERE transfer_id=? AND user_id=?').run(transfer.id, userId);
    db.prepare('DELETE FROM transfers WHERE id=? AND user_id=?').run(transfer.id, userId);
  });
  return { ok: true };
}

/* ---------- лимиты ---------- */
export function budgetList(user) {
  const { from, to } = monthBounds(todayIn(tzOf(user)));
  return db
    .prepare(`SELECT b.id, b.category_id, b.amount, c.name, c.icon, c.color,
                     COALESCE((SELECT SUM(t.amount) FROM transactions t
                       WHERE t.user_id=b.user_id AND t.category_id=b.category_id
                         AND t.type='expense' AND t.kind='normal' AND t.date BETWEEN ? AND ?),0) spent
              FROM budgets b
              JOIN categories c ON c.id=b.category_id AND c.user_id=b.user_id
              WHERE b.user_id=? ORDER BY c.name`)
    .all(from, to, user.id)
    .map((b) => ({ ...b, amount: fromCents(b.amount), spent: fromCents(b.spent) }));
}

export function setBudget(user, input) {
  const categoryId = requireInt(input.category_id, 'category_id');
  getCategoryOwned(user.id, categoryId, 'expense');
  const amount = requireAmountCents(input.amount, 'Лимит');
  db.prepare(`INSERT INTO budgets(user_id,category_id,amount) VALUES(?,?,?)
              ON CONFLICT(user_id,category_id) DO UPDATE SET amount=excluded.amount`)
    .run(user.id, categoryId, amount);
  return budgetList(user).find((b) => b.category_id === categoryId);
}

export function deleteBudget(userId, categoryId) {
  const id = requireInt(categoryId, 'category_id');
  db.prepare('DELETE FROM budgets WHERE user_id=? AND category_id=?').run(userId, id);
  return { ok: true };
}

/* ---------- копилки ---------- */
const PIGGY_SQL = `
  SELECT p.id, p.name, p.goal, p.icon,
         COALESCE((SELECT SUM(o.amount) FROM piggy_ops o WHERE o.piggy_id=p.id),0) balance
  FROM piggy_banks p WHERE p.user_id = ?`;

export function piggyList(userId) {
  return db.prepare(PIGGY_SQL + ' ORDER BY p.id').all(userId)
    .map((p) => ({ ...p, goal: fromCents(p.goal), balance: fromCents(p.balance) }));
}

export function createPiggy(userId, input) {
  const name = requireName(input.name, 'Название копилки');
  const goal = input.goal ? requireAmountCents(input.goal, 'Цель') : 0;
  const icon = requireIcon(input.icon, '🏦');
  const count = db.prepare('SELECT COUNT(*) c FROM piggy_banks WHERE user_id=?').get(userId).c;
  if (count >= 30) throw badRequest('Слишком много копилок');
  const info = db.prepare('INSERT INTO piggy_banks(user_id,name,goal,icon) VALUES(?,?,?,?)')
    .run(userId, name, goal, icon);
  return piggyList(userId).find((p) => p.id === Number(info.lastInsertRowid));
}

function getPiggyOwned(userId, id) {
  const p = db.prepare(PIGGY_SQL + ' AND p.id = ?').get(userId, requireInt(id, 'piggy_id'));
  if (!p) throw notFound('Копилка не найдена');
  return p;
}

export function piggyOp(userId, id, direction, input) {
  const piggy = getPiggyOwned(userId, id);
  const amount = requireAmountCents(input.amount);
  const note = requireNote(input.note);
  if (direction === 'withdraw' && amount > piggy.balance) throw badRequest('В копилке меньше средств');
  db.prepare('INSERT INTO piggy_ops(piggy_id,amount,note) VALUES(?,?,?)')
    .run(piggy.id, direction === 'withdraw' ? -amount : amount, note || (direction === 'withdraw' ? 'Снятие' : 'Пополнение'));
  return piggyList(userId).find((p) => p.id === piggy.id);
}

export function deletePiggy(userId, id) {
  const piggy = getPiggyOwned(userId, id);
  db.prepare('DELETE FROM piggy_banks WHERE id=? AND user_id=?').run(piggy.id, userId);
  return { ok: true };
}

/* ---------- сводки ---------- */
export function dashboard(user) {
  const today = todayIn(tzOf(user));
  const { from, to } = monthBounds(today);

  const totals = db
    .prepare(`SELECT type, COALESCE(SUM(amount),0) t FROM transactions
              WHERE user_id=? AND kind='normal' AND date BETWEEN ? AND ? GROUP BY type`)
    .all(user.id, from, to);
  const income = totals.find((x) => x.type === 'income')?.t ?? 0;
  const expense = totals.find((x) => x.type === 'expense')?.t ?? 0;

  const accounts = accountList(user.id);
  const byCategory = db
    .prepare(`SELECT c.id category_id, c.name, c.icon, c.color, SUM(t.amount) total
              FROM transactions t
              JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id
              WHERE t.user_id=? AND t.type='expense' AND t.kind='normal' AND t.date BETWEEN ? AND ?
              GROUP BY c.id ORDER BY total DESC LIMIT 10`)
    .all(user.id, from, to)
    .map((r) => ({ ...r, total: fromCents(r.total) }));

  return {
    balance: accounts.reduce((s, a) => s + a.balance, 0),
    accounts,
    month: { income: fromCents(income), expense: fromCents(expense), balance: fromCents(income - expense), from, to },
    byCategory,
    budgets: budgetList(user),
    recent: listTransactions(user.id, 15, 0),
    piggies: piggyList(user.id),
    currency: user.currency || 'RUB',
    name: user.name,
    today,
    timezone: tzOf(user),
    remind_enabled: Boolean(user.remind_enabled),
    remind_hour: user.remind_hour ?? 21,
  };
}

export function statsMonths(user, months = 6) {
  const today = todayIn(tzOf(user));
  const first = shiftMonth(today, -(months - 1));
  const rows = db
    .prepare(`SELECT substr(date,1,7) ym, type, SUM(amount) t FROM transactions
              WHERE user_id=? AND kind='normal' AND date >= ? GROUP BY ym, type`)
    .all(user.id, first);

  const out = [];
  for (let i = -(months - 1); i <= 0; i++) {
    const monthStart = shiftMonth(today, i);
    const { from, to, label } = monthBounds(monthStart);
    const ym = from.slice(0, 7);
    out.push({
      label, from, to,
      income: fromCents(rows.find((r) => r.ym === ym && r.type === 'income')?.t ?? 0),
      expense: fromCents(rows.find((r) => r.ym === ym && r.type === 'expense')?.t ?? 0),
    });
  }
  return out;
}

export function daySummary(user, date = null) {
  const day = date || todayIn(tzOf(user));
  const rows = db
    .prepare(`SELECT type, COALESCE(SUM(amount),0) t, COUNT(*) c FROM transactions
              WHERE user_id=? AND kind='normal' AND date=? GROUP BY type`)
    .all(user.id, day);
  const income = rows.find((r) => r.type === 'income')?.t ?? 0;
  const expense = rows.find((r) => r.type === 'expense')?.t ?? 0;
  const count = rows.reduce((s, r) => s + r.c, 0);
  return { date: day, income: fromCents(income), expense: fromCents(expense), count };
}

export function summaryForAi(user) {
  const d = dashboard(user);
  return {
    month: d.month,
    byCategory: d.byCategory.map((x) => ({ name: x.name, total: x.total })),
    accounts: d.accounts.map((x) => ({ name: x.name, balance: x.balance })),
    piggies: d.piggies.map((p) => ({ name: p.name, balance: p.balance, goal: p.goal })),
  };
}

/* ---------- настройки ---------- */
export function getSettings(user, isAdmin = false) {
  return {
    name: user.name,
    currency: user.currency || 'RUB',
    timezone: tzOf(user),
    remind_enabled: Boolean(user.remind_enabled),
    remind_hour: user.remind_hour ?? 21,
    ai_enabled: Boolean(config.geminiApiKey),
    is_admin: isAdmin,
  };
}

export function updateSettings(user, input) {
  if (input.remind_enabled !== undefined) {
    db.prepare('UPDATE users SET remind_enabled=? WHERE id=?').run(input.remind_enabled ? 1 : 0, user.id);
  }
  if (input.remind_hour !== undefined) {
    const h = Number.parseInt(input.remind_hour, 10);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw badRequest('Час: 0–23');
    db.prepare('UPDATE users SET remind_hour=? WHERE id=?').run(h, user.id);
  }
  if (input.timezone !== undefined) {
    const tz = requireTimezoneSafe(input.timezone);
    if (tz) db.prepare('UPDATE users SET timezone=? WHERE id=?').run(tz, user.id);
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  return getSettings(fresh);
}

function requireTimezoneSafe(tz) {
  try {
    const s = String(tz).trim();
    if (!s || s.length > 64) return null;
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return null;
  }
}

/* ---------- черновики бота (в БД, а не в памяти) ---------- */
export function saveDraft(key, telegramId, payload) {
  db.prepare('INSERT OR REPLACE INTO bot_drafts(key,telegram_id,payload,created_at) VALUES(?,?,?,?)')
    .run(String(key), String(telegramId), JSON.stringify(payload), Date.now());
}

export function takeDraft(key, telegramId) {
  const row = db.prepare('SELECT * FROM bot_drafts WHERE key=? AND telegram_id=?')
    .get(String(key), String(telegramId));
  if (!row) return null;
  const res = db.prepare('DELETE FROM bot_drafts WHERE key=?').run(row.key);
  if (res.changes !== 1) return null; // защита от двойного нажатия
  if (Date.now() - row.created_at > 60 * 60 * 1000) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function cleanupDrafts() {
  db.prepare('DELETE FROM bot_drafts WHERE created_at < ?').run(Date.now() - 6 * 3600 * 1000);
}

/* ---------- напоминания ---------- */
export function usersToRemind() {
  return db.prepare('SELECT * FROM users WHERE remind_enabled=1').all();
}

export function markReminded(userId, date) {
  db.prepare('UPDATE users SET last_remind_date=? WHERE id=?').run(date, userId);
}
