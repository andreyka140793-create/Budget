import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import db, { getOrCreateUser } from '../server/db.js';
import { getUsersForReminder, getUserDaySummary } from '../server/routes.js';
import { parseBankSms } from '../server/smsParse.js';
import { suggestCategory } from '../server/categorize.js';
import { isGrokEnabled, parseTransactionWithGrok, askBudgetGrok } from '../server/grok.js';

const token = process.env.BOT_TOKEN;
const webappUrl = process.env.WEBAPP_URL || 'https://example.com';
const pending = new Map();

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
}

function getCategories(userId) {
  return db.prepare('SELECT * FROM categories WHERE user_id=?').all(userId);
}

function getDefaultAccount(userId) {
  return db.prepare('SELECT * FROM accounts WHERE user_id=? ORDER BY id LIMIT 1').get(userId);
}

function monthSummary(userId) {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-31`;
  const income = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND type='income' AND date>=? AND date<=?`
  ).get(userId, from, to).t;
  const expense = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND type='expense' AND date>=? AND date<=?`
  ).get(userId, from, to).t;
  const byCat = db.prepare(
    `SELECT c.name, SUM(t.amount) as total FROM transactions t
     LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=? AND t.type='expense' AND t.date>=? AND t.date<=?
     GROUP BY t.category_id ORDER BY total DESC LIMIT 8`
  ).all(userId, from, to);
  const accounts = db.prepare('SELECT name, balance FROM accounts WHERE user_id=?').all(userId);
  return { from, to, income, expense, balance: income - expense, byCategory: byCat, accounts };
}

async function buildDraftFromText(user, text) {
  // 1) быстрый парсер SMS
  const sms = parseBankSms(text);
  if (sms) {
    const cats = getCategories(user.id);
    const sug = suggestCategory(`${sms.merchant} ${sms.raw}`, sms.type, cats);
    return {
      amount: sms.amount,
      type: sms.type,
      category_id: sug.category_id,
      category_name: sug.category_name,
      note: sms.merchant || sms.raw.slice(0, 80),
      source: 'sms',
    };
  }

  // 2) правила + простая эвристика суммы в тексте
  const amountMatch = text.match(/(\d+[\s.,]?\d*)\s*(?:₽|р|руб|rub)?/i);
  if (amountMatch && !isGrokEnabled()) {
    const amount = parseFloat(amountMatch[1].replace(/\s/g, '').replace(',', '.'));
    if (amount > 0) {
      const type = /зарплат|получил|зачисл|доход|аванс/i.test(text) ? 'income' : 'expense';
      const cats = getCategories(user.id);
      const sug = suggestCategory(text, type, cats);
      return {
        amount,
        type,
        category_id: sug.category_id,
        category_name: sug.category_name,
        note: text.slice(0, 80),
        source: 'rules',
      };
    }
  }

  // 3) Grok
  if (isGrokEnabled()) {
    const cats = getCategories(user.id);
    const names = cats.map((c) => c.name);
    const g = await parseTransactionWithGrok(text, names);
    if (g) {
      const found = cats.find(
        (c) => c.type === g.type && c.name.toLowerCase() === g.category_name.toLowerCase()
      ) || cats.find((c) => c.type === g.type && c.name === 'Прочее')
        || cats.find((c) => c.type === g.type);

      return {
        amount: g.amount,
        type: g.type,
        category_id: found?.id ?? null,
        category_name: found?.name || g.category_name,
        note: g.note || text.slice(0, 80),
        source: 'grok',
      };
    }
  }

  return null;
}

export function startBot() {
  if (!token) {
    console.error('Укажи BOT_TOKEN в .env');
    return null;
  }

  const bot = new Bot(token);
  const grokOn = isGrokEnabled();
  console.log('Grok:', grokOn ? 'включён' : 'выкл (нет XAI_API_KEY)');

  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name || 'друг';
    if (ctx.from?.id) getOrCreateUser(ctx.from.id, name);
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply(
      `Привет, ${name}!\n\n` +
        `*Мой бюджет*\n\n` +
        `📱 Перешлите *SMS банка*\n` +
        `✍️ Или напишите: «кофе 350» / «зарплата 80000»\n` +
        (grokOn ? `🤖 Grok поможет разобрать текст\n` : '') +
        `\n/app — приложение\n/today — сегодня\n/ask … — вопрос про бюджет\n/remind on|off|21`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  });

  bot.command('app', async (ctx) => {
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply('Открывай Mini App:', { reply_markup: kb });
  });

  bot.command('today', async (ctx) => {
    if (!ctx.from?.id) return;
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const s = getUserDaySummary(user.id);
    await ctx.reply(
      `📅 Сегодня (${s.date})\nОпераций: ${s.count}\nДоходы: +${fmt(s.income)}\nРасходы: −${fmt(s.expense)}\nИтого: ${fmt(s.income - s.expense)}`
    );
  });

  bot.command('ask', async (ctx) => {
    if (!ctx.from?.id) return;
    if (!isGrokEnabled()) {
      await ctx.reply('Grok не подключён. Добавьте XAI_API_KEY на сервере.');
      return;
    }
    const q = (ctx.match || '').toString().trim() || 'Кратко оцени мой бюджет за этот месяц';
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const summary = monthSummary(user.id);
      const answer = await askBudgetGrok(q, summary);
      await ctx.reply(answer.slice(0, 3500));
    } catch (e) {
      await ctx.reply('Не удалось спросить Grok: ' + e.message);
    }
  });

  bot.command('remind', async (ctx) => {
    if (!ctx.from?.id) return;
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const arg = (ctx.match || '').toString().trim().toLowerCase();
    if (arg === 'on' || arg === 'вкл') {
      db.prepare('UPDATE users SET remind_enabled=1 WHERE id=?').run(user.id);
      await ctx.reply(`Напоминания вкл (${user.remind_hour ?? 21}:00).`);
      return;
    }
    if (arg === 'off' || arg === 'выкл') {
      db.prepare('UPDATE users SET remind_enabled=0 WHERE id=?').run(user.id);
      await ctx.reply('Напоминания выкл.');
      return;
    }
    if (/^\d{1,2}$/.test(arg)) {
      const h = Math.max(0, Math.min(23, parseInt(arg, 10)));
      db.prepare('UPDATE users SET remind_hour=?, remind_enabled=1 WHERE id=?').run(h, user.id);
      await ctx.reply(`Напоминание каждый день в ${h}:00.`);
      return;
    }
    await ctx.reply(`Сейчас: ${user.remind_enabled ? 'вкл' : 'выкл'}, час ${user.remind_hour ?? 21}`);
  });

  bot.callbackQuery(/^sms:(ok|no):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const key = ctx.match[2];
    const draft = pending.get(key);
    await ctx.answerCallbackQuery();

    if (!draft || String(draft.tgId) !== String(ctx.from.id)) {
      await ctx.editMessageText('Черновик устарел. Напишите ещё раз.');
      return;
    }
    if (action === 'no') {
      pending.delete(key);
      await ctx.editMessageText('Отменено.');
      return;
    }

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const acc = getDefaultAccount(user.id);
    const today = new Date().toISOString().slice(0, 10);
    const delta = draft.type === 'income' ? draft.amount : -draft.amount;

    db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (user_id, category_id, account_id, amount, type, note, date)
         VALUES (?,?,?,?,?,?,?)`
      ).run(user.id, draft.category_id, acc?.id ?? null, draft.amount, draft.type, draft.note || '', today);
      if (acc) {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id=?').run(delta, acc.id);
      }
    })();

    pending.delete(key);
    const sign = draft.type === 'income' ? '+' : '−';
    await ctx.editMessageText(
      `✅ Записано: ${sign}${fmt(draft.amount)}\n${draft.category_name || ''}${draft.note ? '\n' + draft.note : ''}`
    );
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return;

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');

    let draft;
    try {
      draft = await buildDraftFromText(user, text);
    } catch (e) {
      await ctx.reply('Ошибка разбора: ' + e.message);
      return;
    }

    if (!draft) {
      const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
      await ctx.reply(
        'Не распознал операцию.\n\nПримеры:\n• кофе 350\n• зарплата 80000\n• перешлите SMS банка\n\nИли /ask как дела с бюджетом?',
        { reply_markup: kb }
      );
      return;
    }

    const key = `${ctx.from.id}:${ctx.message.message_id}`;
    pending.set(key, { ...draft, tgId: ctx.from.id });
    setTimeout(() => pending.delete(key), 30 * 60 * 1000);

    const sign = draft.type === 'income' ? '+' : '−';
    const src = draft.source === 'grok' ? '🤖 Grok' : draft.source === 'sms' ? '📱 SMS' : '⚡';
    const kb = new InlineKeyboard()
      .text('✅ Записать', `sms:ok:${key}`)
      .text('❌ Отмена', `sms:no:${key}`);

    await ctx.reply(
      `${src} распознал:\n\n` +
        `${sign}*${fmt(draft.amount)}* · ${draft.type === 'income' ? 'доход' : 'расход'}\n` +
        `📂 ${draft.category_name || '—'}\n` +
        (draft.note ? `📝 ${draft.note}\n` : '') +
        `\nЗаписать?`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  });

  bot.on('message', async (ctx) => {
    if (ctx.message.text) return;
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply('Текст, SMS или /app', { reply_markup: kb });
  });

  bot.catch((err) => console.error('Bot error:', err));
  bot.start();
  console.log('Бот запущен');

  let lastHourSent = -1;
  setInterval(async () => {
    const now = new Date();
    if (now.getMinutes() !== 0 || now.getHours() === lastHourSent) return;
    lastHourSent = now.getHours();
    for (const u of getUsersForReminder(now.getHours())) {
      try {
        const s = getUserDaySummary(u.id);
        const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
        await bot.api.sendMessage(
          u.telegram_id,
          `🔔 Сегодня: ${s.count} оп.\n−${fmt(s.expense)} / +${fmt(s.income)}`,
          { reply_markup: kb }
        );
      } catch (e) {
        console.warn('Remind fail', e.message);
      }
    }
  }, 30_000);

  return bot;
}

const isMain =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    process.argv[1].endsWith('bot/index.js'));
if (isMain) startBot();
