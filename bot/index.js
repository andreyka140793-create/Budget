import 'dotenv/config';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import db, { getOrCreateUser } from '../server/db.js';
import { getUsersForReminder, getUserDaySummary } from '../server/routes.js';
import { parseBankSms } from '../server/smsParse.js';
import { suggestCategory } from '../server/categorize.js';
import { pdfToImageDataUrls, extractPdfText } from '../server/pdfImages.js';
import {
  isGrokEnabled,
  parseTransactionWithGrok,
  parseReceiptImage,
  parseReceiptText,
  askBudgetGrok,
} from '../server/grok.js';

const token = process.env.BOT_TOKEN;
const webappUrl = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const pending = new Map();

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(n || 0) + ' ₽';
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
  const income =
    db.prepare(
      `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND type='income' AND date>=? AND date<=?`
    ).get(userId, from, to)?.t ?? 0;
  const expense =
    db.prepare(
      `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE user_id=? AND type='expense' AND date>=? AND date<=?`
    ).get(userId, from, to)?.t ?? 0;
  const byCat = db
    .prepare(
      `SELECT c.name, SUM(t.amount) as total FROM transactions t
     LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=? AND t.type='expense' AND t.date>=? AND t.date<=?
     GROUP BY t.category_id ORDER BY total DESC LIMIT 8`
    )
    .all(userId, from, to);
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

  if (isGrokEnabled()) {
    const names = getCategories(user.id).map((c) => c.name);
    const g = await parseTransactionWithGrok(text, names);
    if (g) {
      const cat = resolveCategory(user.id, g.type, g.category_name);
      return { ...g, ...cat, date: null, source: 'grok' };
    }
  }

  const amountMatch = text.match(/(\d+[\s.,]?\d*)\s*(?:₽|р|руб|rub)?/i);
  if (amountMatch) {
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
  return null;
}

async function telegramFileBuffer(bot, fileId) {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Не удалось скачать файл');
  return Buffer.from(await res.arrayBuffer());
}

async function telegramFileToDataUrl(bot, fileId) {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Не удалось скачать файл');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 7_000_000) throw new Error('Файл слишком большой');
  const ext = (file.file_path || '').split('.').pop()?.toLowerCase() || 'jpg';
  const mime =
    ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function parsePdfBuffer(buf, userId) {
  const names = getCategories(userId).map((c) => c.name);

  // 1) картинки внутри PDF → Vision
  const images = pdfToImageDataUrls(buf);
  for (const img of images) {
    try {
      const g = await parseReceiptImage(img, names);
      if (g) return { ...g, source: 'receipt-pdf-image' };
    } catch (e) {
      console.warn('pdf image vision', e.message);
    }
  }

  // 2) текстовый слой
  const text = extractPdfText(buf);
  if (text.length > 10) {
    const g = await parseReceiptText(text, names);
    if (g) return { ...g, source: 'receipt-pdf-text' };
  }
  return null;
}

function createBot() {
  if (!token) {
    console.error('BOT_TOKEN не задан');
    return null;
  }
  const bot = new Bot(token);
  const grokOn = isGrokEnabled();

  const replyStart = async (ctx) => {
    try {
      const name = ctx.from?.first_name || 'друг';
      if (ctx.from?.id) getOrCreateUser(ctx.from.id, name);
      const kb = new InlineKeyboard();
      if (webappUrl) kb.webApp('💰 Открыть бюджет', webappUrl);
      await ctx.reply(
        `Привет, ${name}!\n\n` +
          `Мой бюджет готов.\n\n` +
          `• SMS банка — перешлите сюда\n` +
          `• «кофе 350»\n` +
          `• фото или PDF чека\n` +
          (grokOn ? `• Grok подключён\n` : '') +
          `\n/app /today /ask /remind`,
        { reply_markup: kb.inline_keyboard.length ? kb : undefined }
      );
    } catch (e) {
      console.error('/start', e);
      try {
        await ctx.reply('Ошибка /start: ' + e.message);
      } catch {}
    }
  };

  bot.command('start', replyStart);
  bot.hears(/^\/start(?:@\w+)?(?:\s|$)/, replyStart);

  bot.command('app', async (ctx) => {
    if (!webappUrl) return ctx.reply('WEBAPP_URL не задан на сервере');
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
    if (!isGrokEnabled()) return ctx.reply('Нужен XAI_API_KEY');
    const q = (ctx.match || '').toString().trim() || 'Кратко оцени бюджет за месяц';
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      await ctx.reply((await askBudgetGrok(q, monthSummary(user.id))).slice(0, 3500));
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
      return ctx.reply('Напоминания вкл');
    }
    if (arg === 'off' || arg === 'выкл') {
      db.prepare('UPDATE users SET remind_enabled=0 WHERE id=?').run(user.id);
      return ctx.reply('Напоминания выкл');
    }
    if (/^\d{1,2}$/.test(arg)) {
      const h = Math.max(0, Math.min(23, parseInt(arg, 10)));
      db.prepare('UPDATE users SET remind_hour=?, remind_enabled=1 WHERE id=?').run(h, user.id);
      return ctx.reply(`Напоминание в ${h}:00`);
    }
    await ctx.reply(`/remind on|off|21`);
  });

  bot.callbackQuery(/^sms:(ok|no):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const key = ctx.match[2];
    const draft = pending.get(key);
    await ctx.answerCallbackQuery();
    if (!draft || String(draft.tgId) !== String(ctx.from.id)) {
      return ctx.editMessageText('Черновик устарел.');
    }
    if (action === 'no') {
      pending.delete(key);
      return ctx.editMessageText('Отменено.');
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

  async function offerDraft(ctx, draft) {
    const key = `${ctx.from.id}:${ctx.message.message_id}`;
    pending.set(key, { ...draft, tgId: ctx.from.id });
    setTimeout(() => pending.delete(key), 30 * 60 * 1000);
    const sign = draft.type === 'income' ? '+' : '−';
    const kb = new InlineKeyboard()
      .text('✅ Записать', `sms:ok:${key}`)
      .text('❌ Отмена', `sms:no:${key}`);
    await ctx.reply(
      `Распознано:\n${sign}*${fmt(draft.amount)}* · ${draft.type === 'income' ? 'доход' : 'расход'}\n` +
        `📂 ${draft.category_name || '—'}\n` +
        (draft.note ? `📝 ${draft.note}\n` : '') +
        `\nЗаписать?`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  }

  bot.on('message:photo', async (ctx) => {
    if (!isGrokEnabled()) return ctx.reply('Нужен XAI_API_KEY');
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const best = ctx.message.photo[ctx.message.photo.length - 1];
      const dataUrl = await telegramFileToDataUrl(bot, best.file_id);
      const g = await parseReceiptImage(
        dataUrl,
        getCategories(user.id).map((c) => c.name)
      );
      if (!g) return ctx.reply('Не удалось прочитать фото чека');
      const cat = resolveCategory(user.id, g.type, g.category_name);
      await offerDraft(ctx, { ...g, ...cat, source: 'receipt' });
    } catch (e) {
      await ctx.reply('Ошибка: ' + e.message);
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const name = (doc.file_name || '').toLowerCase();
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const isImage = mime.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/.test(name);
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');

    if (!isImage && !isPdf) return ctx.reply('Пришлите фото или PDF чека');
    if (!isGrokEnabled()) return ctx.reply('Нужен XAI_API_KEY');

    await ctx.replyWithChatAction('typing');
    try {
      if (isImage) {
        const dataUrl = await telegramFileToDataUrl(bot, doc.file_id);
        const g = await parseReceiptImage(
          dataUrl,
          getCategories(user.id).map((c) => c.name)
        );
        if (!g) return ctx.reply('Не удалось прочитать изображение');
        const cat = resolveCategory(user.id, g.type, g.category_name);
        return offerDraft(ctx, { ...g, ...cat, source: 'receipt' });
      }

      await ctx.reply('Читаю PDF…');
      const buf = await telegramFileBuffer(bot, doc.file_id);
      const g = await parsePdfBuffer(buf, user.id);
      if (!g) {
        return ctx.reply(
          'Не удалось распознать PDF. Попробуйте другой файл или фото страницы чека.'
        );
      }
      const cat = resolveCategory(user.id, g.type, g.category_name);
      await offerDraft(ctx, { ...g, ...cat });
    } catch (e) {
      await ctx.reply('Ошибка PDF: ' + e.message);
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
        return ctx.reply('Не распознал. Примеры: «кофе 350», SMS, фото/PDF чека.');
      }
      await offerDraft(ctx, draft);
    } catch (e) {
      await ctx.reply('Ошибка: ' + e.message);
    }
  });

  bot.catch((err) => console.error('Bot error:', err));
  return bot;
}

let botInstance = null;

export function getBot() {
  return botInstance;
}

export function getWebhookMiddleware() {
  if (!botInstance) return null;
  return webhookCallback(botInstance, 'express');
}

/**
 * mode: 'webhook' | 'polling'
 */
export async function startBot(mode = process.env.BOT_MODE || 'webhook') {
  if (!token) {
    console.error('BOT_TOKEN не задан — бот не запущен');
    return null;
  }
  botInstance = createBot();
  if (!botInstance) return null;

  try {
    await botInstance.api.setMyCommands([
      { command: 'start', description: 'Начать' },
      { command: 'app', description: 'Открыть бюджет' },
      { command: 'today', description: 'Сегодня' },
      { command: 'ask', description: 'Спросить Grok' },
      { command: 'remind', description: 'Напоминания' },
    ]);
  } catch (e) {
    console.warn('setMyCommands', e.message);
  }

  if (mode === 'polling') {
    try {
      await botInstance.api.deleteWebhook({ drop_pending_updates: false });
    } catch {}
    botInstance.start({
      onStart: (i) => console.log('Bot polling @' + i.username),
    });
    return botInstance;
  }

  // webhook
  if (!webappUrl) {
    console.warn('WEBAPP_URL пуст — fallback на polling');
    try {
      await botInstance.api.deleteWebhook({ drop_pending_updates: false });
    } catch {}
    botInstance.start({ onStart: (i) => console.log('Bot polling @' + i.username) });
    return botInstance;
  }

  const hookUrl = `${webappUrl}/telegram-webhook`;
  try {
    await botInstance.api.setWebhook(hookUrl, {
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log('Webhook set:', hookUrl);
  } catch (e) {
    console.error('setWebhook failed, polling:', e.message);
    try {
      await botInstance.api.deleteWebhook({ drop_pending_updates: false });
    } catch {}
    botInstance.start({ onStart: (i) => console.log('Bot polling @' + i.username) });
  }
  return botInstance;
}

const isMain =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    process.argv[1].endsWith('bot/index.js'));
if (isMain) startBot(process.env.BOT_MODE || 'polling');
