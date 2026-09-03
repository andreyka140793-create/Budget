import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import db, { getOrCreateUser } from '../server/db.js';
import { getUsersForReminder, getUserDaySummary } from '../server/routes.js';
import { parseBankSms } from '../server/smsParse.js';
import { suggestCategory } from '../server/categorize.js';
import {
  isGrokEnabled,
  parseTransactionWithGrok,
  parseReceiptImage,
  parseReceiptText,
  askBudgetGrok,
} from '../server/grok.js';

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

function resolveCategory(userId, type, categoryName) {
  const cats = getCategories(userId);
  const found =
    cats.find((c) => c.type === type && c.name.toLowerCase() === String(categoryName || '').toLowerCase()) ||
    cats.find((c) => c.type === type && c.name === 'Прочее') ||
    cats.find((c) => c.type === type);
  return {
    category_id: found?.id ?? null,
    category_name: found?.name || categoryName || 'Прочее',
  };
}

async function buildDraftFromText(user, text) {
  const sms = parseBankSms(text);
  if (sms) {
    const sug = suggestCategory(`${sms.merchant} ${sms.raw}`, sms.type, getCategories(user.id));
    return {
      amount: sms.amount,
      type: sms.type,
      category_id: sug.category_id,
      category_name: sug.category_name,
      note: sms.merchant || sms.raw.slice(0, 80),
      date: null,
      source: 'sms',
    };
  }

  const amountMatch = text.match(/(\d+[\s.,]?\d*)\s*(?:₽|р|руб|rub)?/i);
  if (amountMatch && !isGrokEnabled()) {
    const amount = parseFloat(amountMatch[1].replace(/\s/g, '').replace(',', '.'));
    if (amount > 0) {
      const type = /зарплат|получил|зачисл|доход|аванс/i.test(text) ? 'income' : 'expense';
      const sug = suggestCategory(text, type, getCategories(user.id));
      return {
        amount,
        type,
        category_id: sug.category_id,
        category_name: sug.category_name,
        note: text.slice(0, 80),
        date: null,
        source: 'rules',
      };
    }
  }

  if (isGrokEnabled()) {
    const names = getCategories(user.id).map((c) => c.name);
    const g = await parseTransactionWithGrok(text, names);
    if (g) {
      const cat = resolveCategory(user.id, g.type, g.category_name);
      return { ...g, ...cat, date: null, source: 'grok' };
    }
  }
  return null;
}

async function telegramFileToDataUrl(bot, fileId) {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Не удалось скачать файл');
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (file.file_path || '').split('.').pop()?.toLowerCase() || 'jpg';
  const mime =
    ext === 'png' ? 'image/png' :
    ext === 'webp' ? 'image/webp' :
    ext === 'gif' ? 'image/gif' :
    'image/jpeg';
  // лимит ~4MB data url практичный
  if (buf.length > 5_000_000) throw new Error('Файл слишком большой (макс ~5 МБ)');
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function offerDraft(ctx, draft) {
  const key = `${ctx.from.id}:${ctx.message.message_id}`;
  pending.set(key, { ...draft, tgId: ctx.from.id });
  setTimeout(() => pending.delete(key), 30 * 60 * 1000);

  const sign = draft.type === 'income' ? '+' : '−';
  const src =
    draft.source === 'receipt' ? '🧾 Чек' :
    draft.source === 'grok' ? '🤖 Grok' :
    draft.source === 'sms' ? '📱 SMS' : '⚡';
  const kb = new InlineKeyboard()
    .text('✅ Записать', `sms:ok:${key}`)
    .text('❌ Отмена', `sms:no:${key}`);

  await ctx.reply(
    `${src}:\n\n` +
      `${sign}*${fmt(draft.amount)}* · ${draft.type === 'income' ? 'доход' : 'расход'}\n` +
      `📂 ${draft.category_name || '—'}\n` +
      (draft.note ? `📝 ${draft.note}\n` : '') +
      (draft.date ? `📅 ${draft.date}\n` : '') +
      `\nЗаписать?`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
}

export function startBot() {
  if (!token) {
    console.error('Укажи BOT_TOKEN в .env');
    return null;
  }

  const bot = new Bot(token);
  const grokOn = isGrokEnabled();
  console.log('Grok:', grokOn ? 'включён' : 'выкл');

  bot.command('start', async (ctx) => {
    try {
    const name = ctx.from?.first_name || 'друг';
    if (ctx.from?.id) getOrCreateUser(ctx.from.id, name);
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply(
      `Привет, ${name}!\n\n` +
        `*Мой бюджет*\n\n` +
        `📱 SMS банка — перешлите сюда\n` +
        `✍️ «кофе 350» / «зарплата 80000»\n` +
        `🧾 *Фото чека* — пришлите снимок\n` +
        (grokOn ? `🤖 Grok распознаёт текст и чеки\n` : '') +
        `\n/app /today /ask /remind`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    } catch (e) {
      console.error('/start error', e);
      try { await ctx.reply('Бот запущен, но ошибка: ' + e.message); } catch {}
    }
  });

  bot.command('app', async (ctx) => {
    const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
    await ctx.reply('Mini App:', { reply_markup: kb });
  });

  bot.command('today', async (ctx) => {
    if (!ctx.from?.id) return;
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const s = getUserDaySummary(user.id);
    await ctx.reply(
      `📅 Сегодня (${s.date})\nОпераций: ${s.count}\n+${fmt(s.income)} / −${fmt(s.expense)}`
    );
  });

  bot.command('ask', async (ctx) => {
    if (!ctx.from?.id) return;
    if (!isGrokEnabled()) {
      await ctx.reply('Нужен XAI_API_KEY на сервере.');
      return;
    }
    const q = (ctx.match || '').toString().trim() || 'Кратко оцени бюджет за месяц';
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const answer = await askBudgetGrok(q, monthSummary(user.id));
      await ctx.reply(answer.slice(0, 3500));
    } catch (e) {
      await ctx.reply('Grok: ' + e.message);
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
      await ctx.reply(`Напоминание в ${h}:00.`);
      return;
    }
    await ctx.reply(`/remind on|off|21 — сейчас ${user.remind_enabled ? 'вкл' : 'выкл'} ${user.remind_hour ?? 21}:00`);
  });

  bot.callbackQuery(/^sms:(ok|no):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const key = ctx.match[2];
    const draft = pending.get(key);
    await ctx.answerCallbackQuery();
    if (!draft || String(draft.tgId) !== String(ctx.from.id)) {
      await ctx.editMessageText('Черновик устарел.');
      return;
    }
    if (action === 'no') {
      pending.delete(key);
      await ctx.editMessageText('Отменено.');
      return;
    }

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const acc = getDefaultAccount(user.id);
    const date = draft.date || new Date().toISOString().slice(0, 10);
    const delta = draft.type === 'income' ? draft.amount : -draft.amount;

    db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (user_id, category_id, account_id, amount, type, note, date)
         VALUES (?,?,?,?,?,?,?)`
      ).run(user.id, draft.category_id, acc?.id ?? null, draft.amount, draft.type, draft.note || '', date);
      if (acc) db.prepare('UPDATE accounts SET balance = balance + ? WHERE id=?').run(delta, acc.id);
    })();

    pending.delete(key);
    const sign = draft.type === 'income' ? '+' : '−';
    await ctx.editMessageText(`✅ ${sign}${fmt(draft.amount)} · ${draft.category_name || ''}`);
  });

  // Фото чека
  bot.on('message:photo', async (ctx) => {
    if (!ctx.from?.id) return;
    if (!isGrokEnabled()) {
      await ctx.reply('Для распознавания чеков нужен XAI_API_KEY (Grok Vision) на сервере.');
      return;
    }
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const dataUrl = await telegramFileToDataUrl(bot, best.file_id);
      const names = getCategories(user.id).map((c) => c.name);
      const g = await parseReceiptImage(dataUrl, names);
      if (!g) {
        await ctx.reply('Не удалось прочитать чек. Попробуйте фото ровнее/ближе или введите сумму текстом.');
        return;
      }
      const cat = resolveCategory(user.id, g.type, g.category_name);
      await offerDraft(ctx, { ...g, ...cat, source: 'receipt' });
    } catch (e) {
      await ctx.reply('Ошибка распознавания: ' + e.message);
    }
  });

  // Документ: PDF или картинка файлом
  bot.on('message:document', async (ctx) => {
    if (!ctx.from?.id) return;
    const doc = ctx.message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const name = (doc.file_name || '').toLowerCase();
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');

    const isImage = mime.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/.test(name);
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');

    if (!isImage && !isPdf) {
      await ctx.reply('Пришлите фото чека или PDF. Также можно CSV в Mini App (вкладка «Ещё»).');
      return;
    }

    if (!isGrokEnabled()) {
      await ctx.reply('Нужен XAI_API_KEY на сервере для распознавания.');
      return;
    }

    await ctx.replyWithChatAction('typing');
    try {
      if (isImage) {
        const dataUrl = await telegramFileToDataUrl(bot, doc.file_id);
        const names = getCategories(user.id).map((c) => c.name);
        const g = await parseReceiptImage(dataUrl, names);
        if (!g) {
          await ctx.reply('Не удалось прочитать изображение чека.');
          return;
        }
        const cat = resolveCategory(user.id, g.type, g.category_name);
        await offerDraft(ctx, { ...g, ...cat, source: 'receipt' });
        return;
      }

      // PDF: скачиваем, пробуем извлечь текст (простые PDF) или просим фото
      const file = await bot.api.getFile(doc.file_id);
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 6_000_000) {
        await ctx.reply('PDF слишком большой. Пришлите фото чека.');
        return;
      }

      // Грубое извлечение текстовых строк из PDF (без библиотек)
      const asLatin = buf.toString('latin1');
      const texts = [];
      const re = /\(([^)]{2,80})\)\s*Tj/g;
      let m;
      while ((m = re.exec(asLatin)) && texts.length < 80) {
        texts.push(m[1].replace(/\\([nrt\\()])/g, ' '));
      }
      // Также потоки между BT/ET
      const streamBits = asLatin.match(/BT[\s\S]{5,400}?ET/g) || [];
      for (const bit of streamBits.slice(0, 20)) {
        const parts = bit.match(/\(([^)]+)\)/g) || [];
        for (const p of parts) texts.push(p.slice(1, -1));
      }

      const extracted = texts.join(' ').replace(/\s+/g, ' ').trim();
      if (extracted.length > 20) {
        const names = getCategories(user.id).map((c) => c.name);
        const g = await parseReceiptText(extracted, names);
        if (g) {
          const cat = resolveCategory(user.id, g.type, g.category_name);
          await offerDraft(ctx, { ...g, ...cat, date: null, source: 'receipt' });
          return;
        }
      }

      await ctx.reply(
        'Этот PDF не удалось прочитать как текст.\n\n' +
          'Сделайте *фото* или скрин чека и отправьте картинкой — так распознаётся надёжнее.',
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      await ctx.reply('Ошибка: ' + e.message);
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return;
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const draft = await buildDraftFromText(user, text);
      if (!draft) {
        const kb = new InlineKeyboard().webApp('💰 Открыть бюджет', webappUrl);
        await ctx.reply(
          'Не распознал.\nПримеры: «кофе 350», SMS банка, *фото чека*.\n/ask — вопрос про бюджет.',
          { parse_mode: 'Markdown', reply_markup: kb }
        );
        return;
      }
      await offerDraft(ctx, draft);
    } catch (e) {
      await ctx.reply('Ошибка: ' + e.message);
    }
  });

  bot.on('message', async (ctx) => {
    if (ctx.message.text || ctx.message.photo || ctx.message.document) return;
    await ctx.reply('Текст, SMS, фото чека или /app');
  });

  bot.catch((err) => console.error('Bot error:', err));
  bot.start();
  console.log('Бот запущен (SMS + чеки + Grok)');

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
          `🔔 Сегодня: ${s.count} оп. −${fmt(s.expense)} / +${fmt(s.income)}`,
          { reply_markup: kb }
        );
      } catch (e) {
        console.warn('Remind', e.message);
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
