import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import db, { getOrCreateUser } from '../server/db.js';
import { getUsersForReminder, getUserDaySummary } from '../server/routes.js';
import { parseBankSms } from '../server/smsParse.js';
import { suggestCategory } from '../server/categorize.js';

const token = process.env.BOT_TOKEN;
const webappUrl = process.env.WEBAPP_URL || 'https://example.com';

// Временные черновики SMS: key = `${tgId}:${msgId}` 
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

export function startBot() {
  if (!token) {
    console.error('Укажи BOT_TOKEN в .env');
    return null;
  }

  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name || 'друг';
    if (ctx.from?.id) getOrCreateUser(ctx.from.id, name);
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply(
      `Привет, ${name}!\n\n` +
        `*Дзен-бюджет*\n\n` +
        `📱 *SMS банка* — перешлите сюда смс о покупке/зачислении, бот предложит записать операцию.\n` +
        `📂 Категории подставятся автоматически.\n\n` +
        `Команды:\n` +
        `/app — приложение\n` +
        `/today — сегодня\n` +
        `/remind on|off|21 — напоминания`,
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
    await ctx.reply(`Сейчас: ${user.remind_enabled ? 'вкл' : 'выкл'}, час ${user.remind_hour ?? 21}\n/remind on|off|21`);
  });

  // Подтверждение SMS
  bot.callbackQuery(/^sms:(ok|no):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const key = ctx.match[2];
    const draft = pending.get(key);
    await ctx.answerCallbackQuery();

    if (!draft || String(draft.tgId) !== String(ctx.from.id)) {
      await ctx.editMessageText('Черновик устарел. Перешлите SMS ещё раз.');
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
      ).run(
        user.id,
        draft.category_id,
        acc?.id ?? null,
        draft.amount,
        draft.type,
        draft.note || '',
        today
      );
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

  // Любой текст / пересланное SMS
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || '';
    // команды уже обработаны
    if (text.startsWith('/')) return;

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const parsed = parseBankSms(text);

    if (!parsed) {
      const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
      await ctx.reply(
        'Не похоже на SMS банка.\n\nПерешлите SMS о покупке/зачислении целиком, или откройте приложение.',
        { reply_markup: kb }
      );
      return;
    }

    const cats = getCategories(user.id);
    const sug = suggestCategory(
      `${parsed.merchant} ${parsed.raw}`,
      parsed.type,
      cats
    );

    const key = `${ctx.from.id}:${ctx.message.message_id}`;
    pending.set(key, {
      tgId: ctx.from.id,
      amount: parsed.amount,
      type: parsed.type,
      category_id: sug.category_id,
      category_name: sug.category_name,
      note: parsed.merchant || parsed.raw.slice(0, 80),
    });
    // TTL 30 мин
    setTimeout(() => pending.delete(key), 30 * 60 * 1000);

    const sign = parsed.type === 'income' ? '+' : '−';
    const conf = sug.confidence === 'high' ? '🎯' : '❓';
    const kb = new InlineKeyboard()
      .text('✅ Записать', `sms:ok:${key}`)
      .text('❌ Отмена', `sms:no:${key}`);

    await ctx.reply(
      `Распознано из SMS:\n\n` +
        `${sign}*${fmt(parsed.amount)}* · ${parsed.type === 'income' ? 'доход' : 'расход'}\n` +
        `${conf} Категория: *${sug.category_name || '—'}*\n` +
        (parsed.merchant ? `📌 ${parsed.merchant}\n` : '') +
        (parsed.balance != null ? `Баланс в SMS: ${fmt(parsed.balance)}\n` : '') +
        `\nЗаписать?`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  });

  bot.on('message', async (ctx) => {
    if (ctx.message.text) return;
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply('Перешлите текстовое SMS банка или /app', { reply_markup: kb });
  });

  bot.catch((err) => console.error('Bot error:', err));
  bot.start();
  console.log('Бот запущен (SMS + напоминания)');

  let lastHourSent = -1;
  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    if (minute !== 0 || hour === lastHourSent) return;
    lastHourSent = hour;
    const users = getUsersForReminder(hour);
    for (const u of users) {
      try {
        const s = getUserDaySummary(u.id);
        const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
        await bot.api.sendMessage(
          u.telegram_id,
          `🔔 Напоминание\nСегодня: ${s.count} оп.\nРасходы: −${fmt(s.expense)}\nДоходы: +${fmt(s.income)}`,
          { reply_markup: kb }
        );
      } catch (e) {
        console.warn('Remind fail', u.telegram_id, e.message);
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
