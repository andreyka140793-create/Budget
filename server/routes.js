import { Router } from 'express';
import db, { getOrCreateUser } from './db.js';
import { validateInitData, devUser } from './auth.js';
import { createBackup, listBackups } from './backup.js';
import { suggestCategory } from './categorize.js';
import { parseBankSms } from './smsParse.js';
import { isGrokEnabled, parseReceiptImage, parseReceiptText, parseTransactionWithGrok } from './grok.js';
import { pdfToImageDataUrls, extractPdfText } from './pdfImages.js';

const router = Router();

function auth(req, res, next) {
  try {
    const initData = req.headers['x-telegram-init-data'] || '';
    const botToken = process.env.BOT_TOKEN || '';
    let tgUser = null;
    try {
      tgUser = validateInitData(initData, botToken);
    } catch (e) {
      console.warn('validateInitData', e.message);
    }
    if (!tgUser) tgUser = devUser(initData);
    if (!tgUser?.id) {
      return res.status(401).json({
        error: 'Unauthorized: нет данных Telegram. Откройте через кнопку бота.',
      });
    }
    req.user = getOrCreateUser(tgUser.id, tgUser.first_name || tgUser.username || '');
    req.tgUser = tgUser;
    next();
  } catch (e) {
    console.error('auth error', e);
    res.status(500).json({ error: 'Auth: ' + e.message });
  }
}

router.use(auth);

function monthBounds(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to, label: `${String(m).padStart(2, '0')}.${y}` };
}

// ===== Dashboard =====
router.get('/dashboard', (req, res) => {
  try {
  const uid = req.user.id;
  const { from, to } = monthBounds(0);

  const income = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions
     WHERE user_id=? AND type='income' AND date>=? AND date<=?`
  ).get(uid, from, to)?.t ?? 0;

  const expense = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions
     WHERE user_id=? AND type='expense' AND date>=? AND date<=?`
  ).get(uid, from, to)?.t ?? 0;

  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id=? ORDER BY id').all(uid);
  const balance = accounts.reduce((s, a) => s + a.balance, 0);

  const byCategory = db.prepare(
    `SELECT c.id as category_id, c.name, c.icon, c.color, SUM(t.amount) as total
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id=? AND t.type='expense' AND t.date>=? AND t.date<=?
     GROUP BY t.category_id ORDER BY total DESC LIMIT 10`
  ).all(uid, from, to);

  // бюджеты + факт
  const budgets = db.prepare(
    `SELECT b.*, c.name, c.icon, c.color,
       COALESCE((
         SELECT SUM(t.amount) FROM transactions t
         WHERE t.user_id=b.user_id AND t.category_id=b.category_id
           AND t.type='expense' AND t.date>=? AND t.date<=?
       ), 0) as spent
     FROM budgets b
     JOIN categories c ON c.id = b.category_id
     WHERE b.user_id=?`
  ).all(from, to, uid);

  const recent = db.prepare(
    `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
            a.name as account_name, a.icon as account_icon
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id=?
     ORDER BY t.date DESC, t.id DESC LIMIT 15`
  ).all(uid);

  const piggies = db.prepare('SELECT * FROM piggy_banks WHERE user_id=? ORDER BY id').all(uid);

  res.json({
    balance: balance || 0,
    accounts: accounts || [],
    month: { income: income || 0, expense: expense || 0, balance: (income || 0) - (expense || 0), from, to },
    byCategory: byCategory || [],
    budgets: budgets || [],
    recent: recent || [],
    piggies: piggies || [],
    currency: req.user.currency || 'RUB',
    name: req.user.name,
    remind_enabled: !!req.user.remind_enabled,
    remind_hour: req.user.remind_hour ?? 21,
  });
  } catch (e) {
    console.error('/dashboard', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ===== Charts (несколько месяцев) =====
router.get('/stats/months', (req, res) => {
  const uid = req.user.id;
  const months = Math.min(parseInt(req.query.months || '6', 10), 12);
  const result = [];
  for (let i = -(months - 1); i <= 0; i++) {
    const { from, to, label } = monthBounds(i);
    const income = db.prepare(
      `SELECT COALESCE(SUM(amount),0) as t FROM transactions
       WHERE user_id=? AND type='income' AND date>=? AND date<=?`
    ).get(uid, from, to)?.t ?? 0;
    const expense = db.prepare(
      `SELECT COALESCE(SUM(amount),0) as t FROM transactions
       WHERE user_id=? AND type='expense' AND date>=? AND date<=?`
    ).get(uid, from, to)?.t ?? 0;
    result.push({ label, from, to, income, expense });
  }
  res.json(result);
});

// ===== Categories =====
router.get('/categories', (req, res) => {
  const type = req.query.type;
  let rows;
  if (type === 'expense' || type === 'income') {
    rows = db.prepare('SELECT * FROM categories WHERE user_id=? AND type=? ORDER BY name').all(req.user.id, type);
  } else {
    rows = db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY type, name').all(req.user.id);
  }
  res.json(rows);
});

router.post('/categories', (req, res) => {
  const { name, type, icon, color } = req.body;
  if (!name || !['expense', 'income'].includes(type)) {
    return res.status(400).json({ error: 'name and type required' });
  }
  const info = db.prepare(
    'INSERT INTO categories (user_id, name, type, icon, color) VALUES (?,?,?,?,?)'
  ).run(req.user.id, name, type, icon || '💰', color || '#5c6bc0');
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(info.lastInsertRowid));
});

// ===== Budgets (лимиты по категориям) =====
router.get('/budgets', (req, res) => {
  const { from, to } = monthBounds(0);
  const rows = db.prepare(
    `SELECT b.*, c.name, c.icon, c.color,
       COALESCE((
         SELECT SUM(t.amount) FROM transactions t
         WHERE t.user_id=b.user_id AND t.category_id=b.category_id
           AND t.type='expense' AND t.date>=? AND t.date<=?
       ), 0) as spent
     FROM budgets b
     JOIN categories c ON c.id = b.category_id
     WHERE b.user_id=?`
  ).all(from, to, req.user.id);
  res.json(rows);
});

router.post('/budgets', (req, res) => {
  const { category_id, amount } = req.body;
  if (!category_id || amount == null || amount < 0) {
    return res.status(400).json({ error: 'category_id and amount required' });
  }
  db.prepare(
    `INSERT INTO budgets (user_id, category_id, amount) VALUES (?,?,?)
     ON CONFLICT(user_id, category_id) DO UPDATE SET amount=excluded.amount`
  ).run(req.user.id, category_id, Number(amount));
  const { from, to } = monthBounds(0);
  const row = db.prepare(
    `SELECT b.*, c.name, c.icon, c.color,
       COALESCE((SELECT SUM(t.amount) FROM transactions t
         WHERE t.user_id=b.user_id AND t.category_id=b.category_id
           AND t.type='expense' AND t.date>=? AND t.date<=?),0) as spent
     FROM budgets b JOIN categories c ON c.id=b.category_id
     WHERE b.user_id=? AND b.category_id=?`
  ).get(from, to, req.user.id, category_id);
  res.json(row);
});

router.delete('/budgets/:categoryId', (req, res) => {
  db.prepare('DELETE FROM budgets WHERE user_id=? AND category_id=?')
    .run(req.user.id, req.params.categoryId);
  res.json({ ok: true });
});

// ===== Accounts =====
router.get('/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts WHERE user_id=? ORDER BY id').all(req.user.id));
});

router.post('/accounts', (req, res) => {
  const { name, type, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const t = ['cash', 'card', 'other'].includes(type) ? type : 'card';
  const info = db.prepare(
    'INSERT INTO accounts (user_id, name, type, balance, icon) VALUES (?,?,?,0,?)'
  ).run(req.user.id, name, t, icon || (t === 'cash' ? '💵' : '💳'));
  res.json(db.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/accounts/:id', (req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!acc) return res.status(404).json({ error: 'Not found' });
  const count = db.prepare('SELECT COUNT(*) as c FROM accounts WHERE user_id=?').get(req.user.id).c;
  if (count <= 1) return res.status(400).json({ error: 'Нужен хотя бы один счёт' });
  db.prepare('UPDATE transactions SET account_id=NULL WHERE account_id=?').run(acc.id);
  db.prepare('DELETE FROM accounts WHERE id=?').run(acc.id);
  res.json({ ok: true });
});

// Перевод между счетами
router.post('/accounts/transfer', (req, res) => {
  const { from_id, to_id, amount, note } = req.body;
  const sum = Number(amount);
  if (!from_id || !to_id || from_id === to_id || !sum || sum <= 0) {
    return res.status(400).json({ error: 'Некорректный перевод' });
  }
  const from = db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').get(from_id, req.user.id);
  const to = db.prepare('SELECT * FROM accounts WHERE id=? AND user_id=?').get(to_id, req.user.id);
  if (!from || !to) return res.status(404).json({ error: 'Счёт не найден' });
  if (from.balance < sum) return res.status(400).json({ error: 'Недостаточно средств' });

  const today = new Date().toISOString().slice(0, 10);
  db.transaction(() => {
    db.prepare('UPDATE accounts SET balance = balance - ? WHERE id=?').run(sum, from.id);
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id=?').run(sum, to.id);
    // Две служебные операции для истории (без категории)
    db.prepare(
      `INSERT INTO transactions (user_id, category_id, account_id, amount, type, note, date)
       VALUES (?,?,?,?, 'expense', ?, ?)`
    ).run(req.user.id, null, from.id, sum, note || `Перевод → ${to.name}`, today);
    db.prepare(
      `INSERT INTO transactions (user_id, category_id, account_id, amount, type, note, date)
       VALUES (?,?,?,?, 'income', ?, ?)`
    ).run(req.user.id, null, to.id, sum, note || `Перевод ← ${from.name}`, today);
  })();

  res.json({
    from: db.prepare('SELECT * FROM accounts WHERE id=?').get(from.id),
    to: db.prepare('SELECT * FROM accounts WHERE id=?').get(to.id),
  });
});

// ===== Transactions =====
router.get('/transactions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(
    `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
            a.name as account_name, a.icon as account_icon
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id=?
     ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`
  ).all(req.user.id, limit, offset);
  res.json(rows);
});

router.post('/transactions', (req, res) => {
  const { amount, type, category_id, account_id, note, date } = req.body;
  if (!amount || amount <= 0 || !['expense', 'income'].includes(type)) {
    return res.status(400).json({ error: 'Invalid amount or type' });
  }
  const d = date || new Date().toISOString().slice(0, 10);
  let accId = account_id || null;
  if (!accId) {
    const first = db.prepare('SELECT id FROM accounts WHERE user_id=? ORDER BY id LIMIT 1').get(req.user.id);
    accId = first?.id || null;
  }

  const delta = type === 'income' ? Number(amount) : -Number(amount);
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO transactions (user_id, category_id, account_id, amount, type, note, date)
       VALUES (?,?,?,?,?,?,?)`
    ).run(req.user.id, category_id || null, accId, Number(amount), type, note || '', d);
    if (accId) {
      db.prepare('UPDATE accounts SET balance = balance + ? WHERE id=? AND user_id=?')
        .run(delta, accId, req.user.id);
    }
    return info.lastInsertRowid;
  });
  const id = tx();

  res.json(db.prepare(
    `SELECT t.*, c.name as category_name, c.icon as category_icon,
            a.name as account_name
     FROM transactions t
     LEFT JOIN categories c ON c.id=t.category_id
     LEFT JOIN accounts a ON a.id=t.account_id
     WHERE t.id=?`
  ).get(id));
});

router.delete('/transactions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.transaction(() => {
    if (row.account_id) {
      const delta = row.type === 'income' ? -row.amount : row.amount;
      db.prepare('UPDATE accounts SET balance = balance + ? WHERE id=?')
        .run(delta, row.account_id);
    }
    db.prepare('DELETE FROM transactions WHERE id=?').run(row.id);
  })();

  res.json({ ok: true });
});


// ===== Settings / reminders =====


// Разбор текста SMS из Mini App
router.post('/parse-sms', async (req, res) => {
  const text = req.body?.text || '';
  const categories = db.prepare('SELECT * FROM categories WHERE user_id=?').all(req.user.id);

  let parsed = parseBankSms(text);
  if (parsed) {
    const sug = suggestCategory(`${parsed.merchant} ${parsed.raw}`, parsed.type, categories);
    return res.json({ ...parsed, ...sug, source: 'sms' });
  }

  if (isGrokEnabled()) {
    try {
      const g = await parseTransactionWithGrok(text, categories.map((c) => c.name));
      if (g) {
        const found = categories.find((c) => c.type === g.type && c.name.toLowerCase() === g.category_name.toLowerCase())
          || categories.find((c) => c.type === g.type && c.name === 'Прочее')
          || categories.find((c) => c.type === g.type);
        return res.json({
          amount: g.amount,
          type: g.type,
          merchant: g.note,
          category_id: found?.id ?? null,
          category_name: found?.name || g.category_name,
          source: 'grok',
        });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Не удалось распознать SMS' });
});

// Чек: фото (base64 data URL) или текст/PDF
router.post('/parse-receipt', async (req, res) => {
  if (!isGrokEnabled()) {
    return res.status(400).json({ error: 'Нужен GEMINI_API_KEY на сервере' });
  }
  const categories = db.prepare('SELECT * FROM categories WHERE user_id=?').all(req.user.id);
  const names = categories.map((c) => c.name);
  const { image, text, pdfBase64 } = req.body || {};

  try {
    let g = null;
    if (image && typeof image === 'string' && image.startsWith('data:image')) {
      g = await parseReceiptImage(image, names);
    } else if (text && String(text).trim().length > 10) {
      g = await parseReceiptText(String(text), names);
    } else if (pdfBase64) {
      const b64 = String(pdfBase64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      // Сначала картинки из PDF (сканы) → Vision
      const imgs = pdfToImageDataUrls(buf);
      for (const img of imgs) {
        try {
          g = await parseReceiptImage(img, names);
          if (g) break;
        } catch (e) {
          console.warn('pdf vision', e.message);
        }
      }
      // Затем текстовый слой
      if (!g) {
        const extracted = extractPdfText(buf);
        console.log('PDF text len', extracted.length, 'images', imgs.length);
        if (extracted.length > 10) g = await parseReceiptText(extracted, names);
      }
      if (!g) {
        return res.status(400).json({
          error: 'Не удалось распознать PDF. Попробуйте другой файл или фото.',
        });
      }
    } else {
      return res.status(400).json({ error: 'Нужны image (data URL), text или pdfBase64' });
    }

    if (!g) return res.status(400).json({ error: 'Не удалось распознать чек' });

    const found = categories.find((c) => c.type === g.type && c.name.toLowerCase() === g.category_name.toLowerCase())
      || categories.find((c) => c.type === g.type && c.name === 'Прочее')
      || categories.find((c) => c.type === g.type);

    res.json({
      amount: g.amount,
      type: g.type,
      note: g.note,
      date: g.date || null,
      category_id: found?.id ?? null,
      category_name: found?.name || g.category_name,
      source: 'receipt',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/settings', (req, res) => {
  res.json({
    remind_enabled: !!req.user.remind_enabled,
    remind_hour: req.user.remind_hour ?? 21,
    name: req.user.name,
    currency: req.user.currency || 'RUB',
  });
});

router.post('/settings', (req, res) => {
  const { remind_enabled, remind_hour } = req.body;
  if (remind_enabled !== undefined) {
    db.prepare('UPDATE users SET remind_enabled=? WHERE id=?')
      .run(remind_enabled ? 1 : 0, req.user.id);
  }
  if (remind_hour !== undefined) {
    const h = Math.max(0, Math.min(23, parseInt(remind_hour, 10)));
    db.prepare('UPDATE users SET remind_hour=? WHERE id=?').run(h, req.user.id);
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({
    remind_enabled: !!u.remind_enabled,
    remind_hour: u.remind_hour ?? 21,
  });
});

// ===== Piggy banks =====
router.get('/piggies', (req, res) => {
  res.json(db.prepare('SELECT * FROM piggy_banks WHERE user_id=? ORDER BY id').all(req.user.id));
});

router.post('/piggies', (req, res) => {
  const { name, goal, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare(
    'INSERT INTO piggy_banks (user_id, name, goal, balance, icon) VALUES (?,?,?,0,?)'
  ).run(req.user.id, name, Number(goal) || 0, icon || '🏦');
  res.json(db.prepare('SELECT * FROM piggy_banks WHERE id=?').get(info.lastInsertRowid));
});

router.post('/piggies/:id/deposit', (req, res) => {
  const piggy = db.prepare('SELECT * FROM piggy_banks WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!piggy) return res.status(404).json({ error: 'Not found' });
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  db.prepare('UPDATE piggy_banks SET balance = balance + ? WHERE id=?').run(amount, piggy.id);
  db.prepare('INSERT INTO piggy_ops (piggy_id, amount, note) VALUES (?,?,?)')
    .run(piggy.id, amount, req.body.note || 'Пополнение');
  res.json(db.prepare('SELECT * FROM piggy_banks WHERE id=?').get(piggy.id));
});

router.post('/piggies/:id/withdraw', (req, res) => {
  const piggy = db.prepare('SELECT * FROM piggy_banks WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!piggy) return res.status(404).json({ error: 'Not found' });
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0 || amount > piggy.balance) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  db.prepare('UPDATE piggy_banks SET balance = balance - ? WHERE id=?').run(amount, piggy.id);
  db.prepare('INSERT INTO piggy_ops (piggy_id, amount, note) VALUES (?,?,?)')
    .run(piggy.id, -amount, req.body.note || 'Снятие');
  res.json(db.prepare('SELECT * FROM piggy_banks WHERE id=?').get(piggy.id));
});

router.delete('/piggies/:id', (req, res) => {
  const piggy = db.prepare('SELECT * FROM piggy_banks WHERE id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!piggy) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM piggy_banks WHERE id=?').run(piggy.id);
  res.json({ ok: true });
});

// Для бота: пользователи с включёнными напоминаниями
export function getUsersForReminder(hour) {
  return db.prepare(
    `SELECT id, telegram_id, name, remind_hour FROM users
     WHERE remind_enabled=1 AND remind_hour=?`
  ).all(hour);
}

export function getUserDaySummary(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const expense = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions
     WHERE user_id=? AND type='expense' AND date=?`
  ).get(userId, today)?.t ?? 0;
  const income = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions
     WHERE user_id=? AND type='income' AND date=?`
  ).get(userId, today)?.t ?? 0;
  const count = db.prepare(
    `SELECT COUNT(*) as c FROM transactions WHERE user_id=? AND date=?`
  ).get(userId, today).c;
  return { expense, income, count, date: today };
}

export default router;
