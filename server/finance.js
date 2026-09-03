import crypto from 'node:crypto';
import db, { fromCents, toCents, withTransaction } from './db.js';
import { requireDate, requireInt, requireName, requireNote, requirePositiveCents, requireType } from './validation.js';
import { config } from './config.js';

export function getAccountOwned(userId, accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').get(accountId, userId);
}
export function getCategoryOwned(userId, categoryId, type = null) {
  if (type) return db.prepare('SELECT * FROM categories WHERE id=? AND user_id=? AND type=?').get(categoryId, userId, type);
  return db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(categoryId, userId);
}

export function listTransactions(userId, limit=50, offset=0) {
  return db.prepare(`
    SELECT t.*, c.name category_name, c.icon category_icon, c.color category_color,
           a.name account_name, a.icon account_icon
    FROM transactions t
    LEFT JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id
    LEFT JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
    WHERE t.user_id=?
    ORDER BY t.date DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset).map((r) => ({ ...r, amount: fromCents(r.amount) }));
}

export function createTransaction(userId, input) {
  const type = requireType(input.type);
  const amount = requirePositiveCents(toCents(input.amount));
  const date = requireDate(input.date);
  const note = requireNote(input.note);
  const idempotencyKey = input.idempotency_key == null ? null : String(input.idempotency_key);
  if (idempotencyKey && !/^[A-Za-z0-9:_-]{8,100}$/.test(idempotencyKey)) throw new Error('idempotency_key: invalid');
  if (idempotencyKey) {
    const existing = db.prepare('SELECT id FROM transactions WHERE user_id=? AND idempotency_key=?').get(userId,idempotencyKey);
    if (existing) return existing.id;
  }

  let accountId = input.account_id == null || input.account_id === '' ? null : requireInt(input.account_id, 'account_id');
  let categoryId = input.category_id == null || input.category_id === '' ? null : requireInt(input.category_id, 'category_id');

  if (!accountId) accountId = db.prepare('SELECT id FROM accounts WHERE user_id=? ORDER BY id LIMIT 1').get(userId)?.id ?? null;
  if (accountId && !getAccountOwned(userId, accountId)) throw new Error('Счёт не найден');
  if (categoryId && !getCategoryOwned(userId, categoryId, type)) throw new Error('Категория не найдена');

  const dayCount = db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND date=? AND kind='normal'").get(userId, date).c;
  if (dayCount >= config.maxTransactionsPerDay) throw new Error('Слишком много операций за один день');

  return withTransaction(() => {
    const info = db.prepare(`
      INSERT INTO transactions(user_id,category_id,account_id,idempotency_key,amount,type,kind,note,date)
      VALUES(?,?,?,?,?,?,'normal',?,?)
    `).run(userId, categoryId, accountId, idempotencyKey, amount, type, note, date);
    const delta = type === 'income' ? amount : -amount;
    if (accountId) {
      const changed = db.prepare('UPDATE accounts SET balance=balance+? WHERE id=? AND user_id=?').run(delta, accountId, userId);
      if (changed.changes !== 1) throw new Error('Счёт не найден');
    }
    return Number(info.lastInsertRowid);
  });
}

export function deleteTransaction(userId, id) {
  const txId = requireInt(id, 'transaction_id');
  const row = db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(txId, userId);
  if (!row) throw new Error('Операция не найдена');
  if (row.kind === 'transfer' || row.transfer_id) throw new Error('Перевод удаляется целиком через /transfers');

  withTransaction(() => {
    if (row.account_id) {
      const delta = row.type === 'income' ? -row.amount : row.amount;
      const changed = db.prepare('UPDATE accounts SET balance=balance+? WHERE id=? AND user_id=?').run(delta, row.account_id, userId);
      if (changed.changes !== 1) throw new Error('Счёт операции не найден');
    }
    const deleted = db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(row.id, userId);
    if (deleted.changes !== 1) throw new Error('Операция не удалена');
  });
}

export function createTransfer(userId, input) {
  const fromId = requireInt(input.from_id, 'from_id');
  const toId = requireInt(input.to_id, 'to_id');
  const amount = requirePositiveCents(toCents(input.amount));
  const note = requireNote(input.note);
  const date = requireDate(input.date);
  if (fromId === toId) throw new Error('Счета должны отличаться');

  return withTransaction(() => {
    const from = getAccountOwned(userId, fromId);
    const to = getAccountOwned(userId, toId);
    if (!from || !to) throw new Error('Счёт не найден');
    if (from.balance < amount) throw new Error('Недостаточно средств');

    const transferId = crypto.randomUUID();
    db.prepare(`INSERT INTO transfers(id,user_id,from_account_id,to_account_id,amount,note,date) VALUES(?,?,?,?,?,?,?)`)
      .run(transferId,userId,fromId,toId,amount,note,date);
    db.prepare('UPDATE accounts SET balance=balance-? WHERE id=? AND user_id=?').run(amount,fromId,userId);
    db.prepare('UPDATE accounts SET balance=balance+? WHERE id=? AND user_id=?').run(amount,toId,userId);
    db.prepare(`INSERT INTO transactions(user_id,account_id,transfer_id,amount,type,kind,note,date) VALUES(?,?,?,?,'expense','transfer',?,?)`)
      .run(userId,fromId,transferId,amount,note || `Перевод → ${from.name}`,date);
    db.prepare(`INSERT INTO transactions(user_id,account_id,transfer_id,amount,type,kind,note,date) VALUES(?,?,?,?,'income','transfer',?,?)`)
      .run(userId,toId,transferId,amount,note || `Перевод ← ${from.name}`,date);
    return transferId;
  });
}

export function deleteTransfer(userId, transferId) {
  const transfer = db.prepare('SELECT * FROM transfers WHERE id=? AND user_id=?').get(String(transferId), userId);
  if (!transfer) throw new Error('Перевод не найден');
  return withTransaction(() => {
    const from = getAccountOwned(userId, transfer.from_account_id);
    const to = getAccountOwned(userId, transfer.to_account_id);
    if (!from || !to) throw new Error('Счёт перевода не найден');
    if (to.balance < transfer.amount) throw new Error('Нельзя отменить перевод: на счёте-получателе недостаточно средств');
    db.prepare('UPDATE accounts SET balance=balance+? WHERE id=? AND user_id=?').run(transfer.amount,from.id,userId);
    db.prepare('UPDATE accounts SET balance=balance-? WHERE id=? AND user_id=?').run(transfer.amount,to.id,userId);
    db.prepare('DELETE FROM transfers WHERE id=? AND user_id=?').run(transfer.id,userId);
  });
}

export function accountList(userId) {
  return db.prepare('SELECT * FROM accounts WHERE user_id=? ORDER BY id').all(userId).map((a)=>({ ...a, balance: fromCents(a.balance) }));
}

export function categoryList(userId, type=null) {
  const rows = type ? db.prepare('SELECT * FROM categories WHERE user_id=? AND type=? ORDER BY name').all(userId,type) : db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY type,name').all(userId);
  return rows;
}

export function monthBounds(date = new Date(), timeZone = undefined) {
  let y, m;
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'numeric' }).formatToParts(date);
    y = Number(parts.find(p=>p.type==='year')?.value); m = Number(parts.find(p=>p.type==='month')?.value)-1;
  } else { y = date.getFullYear(); m = date.getMonth(); }
  const from = `${y}-${String(m+1).padStart(2,'0')}-01`;
  const last = new Date(Date.UTC(y,m+1,0)).getUTCDate();
  const to = `${y}-${String(m+1).padStart(2,'0')}-${String(last).padStart(2,'0')}`;
  return { from, to, label: `${String(m+1).padStart(2,'0')}.${y}` };
}

export function dashboard(userId, user) {
  const {from,to}=monthBounds(new Date(), user?.timezone);
  const income = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE user_id=? AND type='income' AND kind='normal' AND date BETWEEN ? AND ?").get(userId,from,to).t;
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE user_id=? AND type='expense' AND kind='normal' AND date BETWEEN ? AND ?").get(userId,from,to).t;
  const accounts = accountList(userId);
  const byCategory = db.prepare(`SELECT c.id category_id,c.name,c.icon,c.color,SUM(t.amount) total FROM transactions t JOIN categories c ON c.id=t.category_id AND c.user_id=t.user_id WHERE t.user_id=? AND t.type='expense' AND t.kind='normal' AND t.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC LIMIT 10`).all(userId,from,to).map(r=>({...r,total:fromCents(r.total)}));
  const budgets = db.prepare(`SELECT b.*,c.name,c.icon,c.color,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id=b.user_id AND t.category_id=b.category_id AND t.type='expense' AND t.kind='normal' AND t.date BETWEEN ? AND ?),0) spent FROM budgets b JOIN categories c ON c.id=b.category_id AND c.user_id=b.user_id WHERE b.user_id=? ORDER BY c.name`).all(from,to,userId).map(r=>({...r,amount:fromCents(r.amount),spent:fromCents(r.spent)}));
  const recent = listTransactions(userId,15,0);
  const piggies = db.prepare('SELECT * FROM piggy_banks WHERE user_id=? ORDER BY id').all(userId).map(p=>({...p,goal:fromCents(p.goal),balance:fromCents(p.balance)}));
  return {balance:accounts.reduce((s,a)=>s+a.balance,0),accounts,month:{income:fromCents(income),expense:fromCents(expense),balance:fromCents(income-expense),from,to},byCategory,budgets,recent,piggies,currency:user.currency||'RUB',name:user.name,remind_enabled:Boolean(user.remind_enabled),remind_hour:user.remind_hour??21,timezone:user.timezone};
}

export function statsMonths(userId, months=6, timeZone=undefined) {
  const result=[]; const now=new Date();
  for(let i=-(months-1);i<=0;i++){
    const d=new Date(now.getFullYear(),now.getMonth()+i,1); const {from,to,label}=monthBounds(d,timeZone);
    const income=db.prepare("SELECT COALESCE(SUM(amount),0)t FROM transactions WHERE user_id=? AND type='income' AND kind='normal' AND date BETWEEN ? AND ?").get(userId,from,to).t;
    const expense=db.prepare("SELECT COALESCE(SUM(amount),0)t FROM transactions WHERE user_id=? AND type='expense' AND kind='normal' AND date BETWEEN ? AND ?").get(userId,from,to).t;
    result.push({label,from,to,income:fromCents(income),expense:fromCents(expense)});
  }
  return result;
}

export function monthSummaryForAi(userId) {
  const d=dashboard(userId, {currency:'RUB',name:''});
  return { month:d.month, byCategory:d.byCategory.map(x=>({name:x.name,total:x.total})), accounts:d.accounts.map(x=>({name:x.name,balance:x.balance})) };
}
