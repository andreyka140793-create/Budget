/**
 * Чат-бот «Дзен-бюджет» — весь учёт через Telegram-чат
 */
import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard, webhookCallback } from 'grammy';
import crypto from 'node:crypto';
import { config } from '../server/config.js';
import { getOrCreateUser, parseMoneyRubles, coerceReceiptAmount } from '../server/db.js';
import * as svc from '../server/service.js';
import * as ai from '../server/ai.js';
import { parseBankSms } from '../server/smsParse.js';
import { suggestCategory } from '../server/categorize.js';
import { pdfToImageDataUrls, extractPdfText } from '../server/pdfImages.js';

const fmt = (n) =>
  `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(n) || 0)} ₽`;
const esc = (s) =>
  String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** @type {import('grammy').Bot | null} */
let botInstance = null;
export const getBot = () => botInstance;

const sessions = new Map();
function getSession(uid) {
  const id = String(uid);
  if (!sessions.has(id)) sessions.set(id, { step: null, data: {} });
  return sessions.get(id);
}
function clearSession(uid) {
  sessions.set(String(uid), { step: null, data: {} });
}

function mainKeyboard() {
  return new Keyboard()
    .text('📊 Сегодня').text('📅 Месяц').row()
    .text('➖ Расход').text('➕ Доход').row()
    .text('💳 Счета').text('🏛 Копилки').row()
    .text('🎯 Бюджет').text('⚙️ Ещё')
    .resized()
    .persistent();
}

function cancelKeyboard() {
  return new Keyboard().text('❌ Отмена').resized();
}

function clampDate(dateStr, today) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return today;
  if (dateStr > today) return today;
  const t = Date.parse(`${today}T12:00:00Z`);
  const d = Date.parse(`${dateStr}T12:00:00Z`);
  if (Number.isFinite(t) && Number.isFinite(d) && t - d > 400 * 86400000) return today;
  return dateStr;
}

async function fileBuffer(bot, fileId, maxBytes = 7_000_000) {
  const file = await bot.api.getFile(fileId);
  if (file.file_size && file.file_size > maxBytes) throw new Error('Файл слишком большой');
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error('Не удалось скачать файл');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Файл слишком большой');
  return { buf, path: file.file_path || '' };
}

async function fileDataUrl(bot, fileId) {
  const { buf, path } = await fileBuffer(bot, fileId);
  const ext = path.split('.').pop()?.toLowerCase() || 'jpg';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function buildDraftFromText(user, text) {
  const today = svc.todayIn(svc.tzOf(user));
  const categories = svc.categoryList(user.id);

  const sms = parseBankSms(text);
  if (sms) {
    const sug = suggestCategory(`${sms.merchant} ${sms.raw}`, sms.type, categories);
    return {
      amount: sms.amount,
      type: sms.type,
      category_id: sug.category_id,
      category_name: sug.category_name,
      note: sms.merchant || sms.raw.slice(0, 80),
      date: today,
      source: 'sms',
    };
  }

  if (ai.isAiEnabled()) {
    try {
      const g = await ai.parseTransactionText(text, categories.map((c) => c.name), today);
      if (g) {
        const cat = svc.resolveCategoryByName(user.id, g.type, g.category_name);
        return { ...g, ...cat, date: clampDate(g.date, today), source: 'ai' };
      }
    } catch (e) {
      console.warn('ai text', e.message);
    }
  }

  const m = text.match(/(\d+[.,]?\d*)/);
  if (m) {
    const amount = parseMoneyRubles(m[1]);
    if (Number.isFinite(amount) && amount > 0) {
      const note = text.replace(m[0], '').replace(/руб|₽/gi, '').trim().slice(0, 80) || 'Операция';
      const type = /зарплат|аванс|доход|перевод\s*от/i.test(text) ? 'income' : 'expense';
      const sug = suggestCategory(note, type, categories);
      return {
        amount,
        type,
        category_id: sug.category_id,
        category_name: sug.category_name,
        note,
        date: today,
        source: 'quick',
      };
    }
  }
  return null;
}

async function buildDraftFromImage(user, dataUrl) {
  const today = svc.todayIn(svc.tzOf(user));
  const names = svc.categoryList(user.id).map((c) => c.name);
  const draft = await ai.parseReceiptImage(dataUrl, names, today);
  if (!draft) return null;
  const cat = svc.resolveCategoryByName(user.id, draft.type || 'expense', draft.category_name);
  return { ...draft, ...cat, date: clampDate(draft.date, today), source: draft.source || 'receipt' };
}

function draftKeyboard(draftId) {
  return new InlineKeyboard()
    .text('✅ Сохранить', `d:ok:${draftId}`)
    .text('❌ Отмена', `d:no:${draftId}`)
    .row()
    .text('🏷 Категория', `d:cat:${draftId}`)
    .text('📝 Доход/Расход', `d:type:${draftId}`);
}

function formatDraft(d) {
  const sign = d.type === 'income' ? '+' : '−';
  return (
    `🧾 <b>${d.type === 'income' ? 'Доход' : 'Расход'}</b>\n` +
    `${sign}${fmt(d.amount)}\n` +
    `Категория: <b>${esc(d.category_name || '—')}</b>\n` +
    (d.note ? `Комментарий: ${esc(d.note)}\n` : '') +
    `Дата: ${esc(d.date)}\n` +
    (d.source ? `<i>${esc(d.source)}</i>` : '')
  );
}

function saveDraftBoth(key, telegramId, draft) {
  svc.saveDraft(key, telegramId, draft);
}

async function readDraftAsync(key, telegramId) {
  try {
    const mod = await import('../server/db.js');
    const db = mod.default;
    const row = db
      .prepare('SELECT * FROM bot_drafts WHERE key=? AND telegram_id=?')
      .get(String(key), String(telegramId));
    if (!row) return null;
    if (Date.now() - Number(row.created_at) > 60 * 60 * 1000) return null;
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

async function offerDraft(ctx, user, draft) {
  if (draft && draft.amount != null) {
    draft.amount = coerceReceiptAmount(draft.amount, draft.note || draft.ocrPreview || '');
  }
  const key = crypto.randomBytes(6).toString('hex');
  saveDraftBoth(key, user.telegram_id || ctx.from.id, draft);
  await ctx.reply(formatDraft(draft), {
    parse_mode: 'HTML',
    reply_markup: draftKeyboard(key),
  });
}

function todayText(user) {
  const d = svc.daySummary(user);
  return (
    `📊 <b>Сегодня</b> (${esc(d.date)})\n` +
    `➕ Доходы: ${fmt(d.income)}\n` +
    `➖ Расходы: ${fmt(d.expense)}\n` +
    `Итого: ${fmt((d.income || 0) - (d.expense || 0))}`
  );
}

function monthText(user) {
  const dash = svc.dashboard(user);
  const lines = (dash.byCategory || [])
    .slice(0, 12)
    .map((c) => `• ${esc(c.name)}: ${fmt(c.total)}`)
    .join('\n');
  return (
    `📅 <b>Месяц</b>\n` +
    `➕ ${fmt(dash.month?.income)}   ➖ ${fmt(dash.month?.expense)}\n` +
    `Баланс счетов: ${fmt(dash.balance)}\n` +
    (lines ? `\n<b>Расходы:</b>\n${lines}` : '\nПока нет расходов в этом месяце')
  );
}

function accountsText(user) {
  const list = svc.accountList(user.id);
  if (!list.length) return 'Счетов пока нет.';
  return `💳 <b>Счета</b>\n` + list.map((a) => `${a.icon || '💳'} <b>${esc(a.name)}</b>: ${fmt(a.balance)}`).join('\n');
}

export function createBot() {
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    if (ctx.from?.id) {
      ctx.dbUser = getOrCreateUser(ctx.from.id, ctx.from.first_name || ctx.from.username || '');
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    clearSession(ctx.from.id);
    const name = ctx.from?.first_name || 'друг';
    await ctx.reply(
      `Привет, ${esc(name)}! 👋\n\n` +
        `<b>Дзен-бюджет</b> — учёт прямо в чате.\n\n` +
        `• напишите <code>кофе 350</code>\n` +
        `• перешлите SMS банка\n` +
        `• пришлите фото или PDF чека\n` +
        `• кнопки меню внизу\n\n` +
        `/today · /month · /balance · /help`,
      { parse_mode: 'HTML', reply_markup: mainKeyboard() }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `<b>Справка</b>\n` +
        `➖ Расход / ➕ Доход — пошаговый ввод\n` +
        `<code>такси 500</code> — быстрый расход\n` +
        `<code>лимит Транспорт 5000</code> — лимит\n` +
        `Фото или PDF чека → подтверждение\n` +
        `/remind on|off — напоминания`,
      { parse_mode: 'HTML', reply_markup: mainKeyboard() }
    );
  });

  bot.command('today', (ctx) => ctx.reply(todayText(ctx.dbUser), { parse_mode: 'HTML', reply_markup: mainKeyboard() }));
  bot.command('month', (ctx) => ctx.reply(monthText(ctx.dbUser), { parse_mode: 'HTML', reply_markup: mainKeyboard() }));
  bot.command('balance', (ctx) => ctx.reply(accountsText(ctx.dbUser), { parse_mode: 'HTML', reply_markup: mainKeyboard() }));

  bot.command('remind', async (ctx) => {
    const arg = String(ctx.match || '').trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      svc.updateSettings(ctx.dbUser, { remind_enabled: arg === 'on' });
      return ctx.reply(arg === 'on' ? 'Напоминания включены ✅' : 'Напоминания выключены');
    }
    await ctx.reply('Использование: /remind on или /remind off');
  });

  const MENU = new Set(['📊 Сегодня', '📅 Месяц', '➖ Расход', '➕ Доход', '💳 Счета', '🏛 Копилки', '🎯 Бюджет', '⚙️ Ещё', '❌ Отмена']);

  bot.hears('❌ Отмена', async (ctx) => {
    clearSession(ctx.from.id);
    await ctx.reply('Отменено.', { reply_markup: mainKeyboard() });
  });
  bot.hears('📊 Сегодня', (ctx) => ctx.reply(todayText(ctx.dbUser), { parse_mode: 'HTML' }));
  bot.hears('📅 Месяц', (ctx) => ctx.reply(monthText(ctx.dbUser), { parse_mode: 'HTML' }));
  bot.hears('💳 Счета', (ctx) => ctx.reply(accountsText(ctx.dbUser), { parse_mode: 'HTML' }));

  bot.hears('➖ Расход', async (ctx) => {
    const s = getSession(ctx.from.id);
    s.step = 'tx_amount';
    s.data = { type: 'expense' };
    await ctx.reply('Сумма расхода? Например <code>350</code>', {
      parse_mode: 'HTML',
      reply_markup: cancelKeyboard(),
    });
  });
  bot.hears('➕ Доход', async (ctx) => {
    const s = getSession(ctx.from.id);
    s.step = 'tx_amount';
    s.data = { type: 'income' };
    await ctx.reply('Сумма дохода?', { reply_markup: cancelKeyboard() });
  });

  bot.hears('🏛 Копилки', async (ctx) => {
    const list = svc.piggyList(ctx.dbUser.id);
    if (!list.length) {
      return ctx.reply('Копилок нет. Создайте в будущем через «копилка Имя 10000» (скоро) или пока учитывайте расходы.');
    }
    const lines = list.map((p) => `${p.icon || '🏦'} <b>${esc(p.name)}</b>: ${fmt(p.balance)}${p.goal ? ` / ${fmt(p.goal)}` : ''}`);
    await ctx.reply(`🏛 <b>Копилки</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.hears('🎯 Бюджет', async (ctx) => {
    const list = svc.budgetList(ctx.dbUser);
    if (!list.length) return ctx.reply('Лимитов нет.\nПример: <code>лимит Транспорт 5000</code>', { parse_mode: 'HTML' });
    const lines = list.map((b) => `• ${esc(b.name)}: ${fmt(b.spent)} / ${fmt(b.amount)}`);
    await ctx.reply(`🎯 <b>Лимиты месяца</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.hears('⚙️ Ещё', async (ctx) => {
    const u = ctx.dbUser;
    const kb = new InlineKeyboard()
      .text('Москва', 'tz:Europe/Moscow')
      .text('Самара', 'tz:Europe/Samara')
      .row()
      .text('Екатеринбург', 'tz:Asia/Yekaterinburg')
      .text('Новосибирск', 'tz:Asia/Novosibirsk')
      .row()
      .text(u.remind_enabled ? '🔔 Выкл. напоминания' : '🔕 Вкл. напоминания', 'toggle_remind');
    await ctx.reply(`⚙️ Пояс: <b>${esc(u.timezone || config.timezoneDefault)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  });

  /* callbacks */
  bot.callbackQuery(/^d:ok:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const draft = svc.takeDraft(key, ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!draft) return ctx.reply('Черновик устарел. Пришлите снова.');
    try {
      svc.createTransaction(ctx.dbUser, {
        amount: draft.amount,
        type: draft.type || 'expense',
        category_id: draft.category_id,
        note: draft.note || '',
        date: clampDate(draft.date, svc.todayIn(svc.tzOf(ctx.dbUser))),
        idempotency_key: `tg-${key}`,
      });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
      } catch {}
      await ctx.reply(
        `✅ Сохранено: ${draft.type === 'income' ? '+' : '−'}${fmt(draft.amount)} · ${esc(draft.category_name || '')}`,
        { reply_markup: mainKeyboard() }
      );
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  bot.callbackQuery(/^d:no:(.+)$/, async (ctx) => {
    svc.takeDraft(ctx.match[1], ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    } catch {}
    await ctx.reply('Не сохранял.', { reply_markup: mainKeyboard() });
  });

  bot.callbackQuery(/^d:cat:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const draft = await readDraftAsync(key, ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!draft) return ctx.reply('Черновик устарел');
    const cats = svc.categoryList(ctx.dbUser.id, draft.type || 'expense').slice(0, 24);
    const kb = new InlineKeyboard();
    cats.forEach((c, i) => {
      kb.text(c.name, `d:setcat:${key}:${c.id}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply('Выберите категорию:', { reply_markup: kb });
  });

  bot.callbackQuery(/^d:setcat:([^:]+):(\d+)$/, async (ctx) => {
    const key = ctx.match[1];
    const catId = Number(ctx.match[2]);
    const draft = await readDraftAsync(key, ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'Ок' });
    if (!draft) return ctx.reply('Черновик устарел');
    const cat = svc.categoryList(ctx.dbUser.id).find((c) => Number(c.id) === catId);
    draft.category_id = catId;
    draft.category_name = cat?.name || draft.category_name;
    saveDraftBoth(key, ctx.from.id, draft);
    await ctx.reply(formatDraft(draft), { parse_mode: 'HTML', reply_markup: draftKeyboard(key) });
  });

  bot.callbackQuery(/^d:type:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const draft = await readDraftAsync(key, ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!draft) return ctx.reply('Черновик устарел');
    draft.type = draft.type === 'income' ? 'expense' : 'income';
    saveDraftBoth(key, ctx.from.id, draft);
    await ctx.reply(formatDraft(draft), { parse_mode: 'HTML', reply_markup: draftKeyboard(key) });
  });

  bot.callbackQuery(/^tz:(.+)$/, async (ctx) => {
    const tz = ctx.match[1];
    svc.updateSettings(ctx.dbUser, { timezone: tz });
    await ctx.answerCallbackQuery({ text: 'Сохранено' });
    await ctx.reply(`Часовой пояс: ${tz}`, { reply_markup: mainKeyboard() });
  });

  bot.callbackQuery('toggle_remind', async (ctx) => {
    const on = !ctx.dbUser.remind_enabled;
    svc.updateSettings(ctx.dbUser, { remind_enabled: on });
    ctx.dbUser.remind_enabled = on ? 1 : 0;
    await ctx.answerCallbackQuery({ text: on ? 'Вкл' : 'Выкл' });
    await ctx.reply(on ? 'Напоминания включены' : 'Напоминания выключены', { reply_markup: mainKeyboard() });
  });

  bot.callbackQuery(/^wiz:cat:(\d+)$/, async (ctx) => {
    const catId = Number(ctx.match[1]);
    const s = getSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (s.step !== 'tx_category') return ctx.reply('Начните снова: ➖ Расход');
    const cat = svc.categoryList(ctx.dbUser.id).find((c) => Number(c.id) === catId);
    s.data.category_id = catId;
    s.data.category_name = cat?.name || 'Прочее';
    s.step = 'tx_note';
    await ctx.reply('Комментарий? Отправьте «-» чтобы пропустить', { reply_markup: cancelKeyboard() });
  });

  bot.on('message:photo', async (ctx) => {
    await ctx.reply('Распознаю чек…');
    try {
      const photos = ctx.message.photo;
      const dataUrl = await fileDataUrl(bot, photos[photos.length - 1].file_id);
      const draft = await buildDraftFromImage(ctx.dbUser, dataUrl);
      if (!draft) return ctx.reply('Не удалось распознать. Введите: сумма категория');
      await offerDraft(ctx, ctx.dbUser, draft);
    } catch (e) {
      console.error(e);
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name || '';
    const isPdf = doc.mime_type === 'application/pdf' || /\.pdf$/i.test(name);
    const isImage = String(doc.mime_type || '').startsWith('image/');
    if (!isPdf && !isImage) return;
    await ctx.reply(isPdf ? 'Читаю PDF…' : 'Распознаю…');
    try {
      const { buf, path } = await fileBuffer(bot, doc.file_id);
      if (isImage) {
        const ext = path.split('.').pop()?.toLowerCase() || 'jpg';
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
        const draft = await buildDraftFromImage(ctx.dbUser, `data:${mime};base64,${buf.toString('base64')}`);
        if (!draft) return ctx.reply('Не распознано');
        return offerDraft(ctx, ctx.dbUser, draft);
      }
      const images = pdfToImageDataUrls(buf);
      let any = false;
      for (let i = 0; i < images.length; i++) {
        try {
          const draft = await buildDraftFromImage(ctx.dbUser, images[i]);
          if (draft) {
            any = true;
            await offerDraft(ctx, ctx.dbUser, { ...draft, note: draft.note || `PDF ${i + 1}` });
          }
        } catch (e) {
          console.warn('pdf', e.message);
        }
      }
      if (!any) {
        const text = extractPdfText(buf);
        if (text.length > 10) {
          const draft = await buildDraftFromText(ctx.dbUser, text);
          if (draft) return offerDraft(ctx, ctx.dbUser, draft);
        }
        await ctx.reply('В PDF чек не найден. Пришлите фото.');
      }
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = (ctx.message.text || '').trim();
    if (!text || text.startsWith('/') || MENU.has(text)) return;

    const s = getSession(ctx.from.id);

    if (s.step === 'tx_amount') {
      const amount = parseMoneyRubles(text);
      if (!(amount > 0)) return ctx.reply('Введите число, например 350');
      s.data.amount = amount;
      s.step = 'tx_category';
      const cats = svc.categoryList(ctx.dbUser.id, s.data.type).slice(0, 20);
      const kb = new InlineKeyboard();
      cats.forEach((c, i) => {
        kb.text(c.name, `wiz:cat:${c.id}`);
        if (i % 2 === 1) kb.row();
      });
      await ctx.reply('Категория:', { reply_markup: kb });
      return;
    }

    if (s.step === 'tx_note') {
      s.data.note = text === '-' ? '' : text.slice(0, 120);
      const d = {
        amount: s.data.amount,
        type: s.data.type,
        category_id: s.data.category_id,
        category_name: s.data.category_name,
        note: s.data.note,
        date: svc.todayIn(svc.tzOf(ctx.dbUser)),
        source: 'wizard',
      };
      clearSession(ctx.from.id);
      await offerDraft(ctx, ctx.dbUser, d);
      return;
    }

    const lim = text.match(/^лимит\s+(.+?)\s+(\d+[.,]?\d*)$/i);
    if (lim) {
      try {
        const cat = svc.resolveCategoryByName(ctx.dbUser.id, 'expense', lim[1].trim());
        const amount = parseMoneyRubles(lim[2]);
        svc.setBudget(ctx.dbUser, { category_id: cat.category_id, amount });
        await ctx.reply(`Лимит «${esc(cat.category_name)}»: ${fmt(amount)}`, { reply_markup: mainKeyboard() });
      } catch (e) {
        await ctx.reply(e.message);
      }
      return;
    }

    try {
      const draft = await buildDraftFromText(ctx.dbUser, text);
      if (!draft) {
        return ctx.reply(
          'Не понял. Примеры:\n• <code>кофе 350</code>\n• <code>лимит Транспорт 5000</code>\n• фото чека\n• кнопки меню',
          { parse_mode: 'HTML', reply_markup: mainKeyboard() }
        );
      }
      await offerDraft(ctx, ctx.dbUser, draft);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  bot.catch((err) => console.error('bot error', err.error || err));
  return bot;
}

/**
 * Совместимость с server/index.js:
 * const middleware = await startBot(mode)
 */
export async function startBot(mode = config.botMode) {
  if (!config.botToken) {
    console.warn('BOT_TOKEN пуст');
    return null;
  }
  botInstance = createBot();

  await botInstance.api.setMyCommands([
    { command: 'start', description: 'Меню' },
    { command: 'today', description: 'Итоги дня' },
    { command: 'month', description: 'Итоги месяца' },
    { command: 'balance', description: 'Счета' },
    { command: 'help', description: 'Справка' },
    { command: 'remind', description: 'Напоминания on/off' },
  ]);

  const useWebhook = mode === 'webhook' && config.webappUrl;

  if (useWebhook) {
    await botInstance.api.setWebhook(`${config.webappUrl.replace(/\/$/, '')}${config.webhookPath}`, {
      secret_token: config.webhookSecret || undefined,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log('Bot webhook mode');
    return webhookCallback(botInstance, 'express');
  }

  await botInstance.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  botInstance.start({ onStart: () => console.log('Bot polling') });
  return null;
}

export async function stopBot() {
  try {
    await botInstance?.stop();
  } catch {}
}
