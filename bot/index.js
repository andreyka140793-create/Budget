import 'dotenv/config';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import crypto from 'node:crypto';
import { config } from '../server/config.js';
import { getOrCreateUser } from '../server/db.js';
import * as svc from '../server/service.js';
import * as ai from '../server/ai.js';
import { parseBankSms } from '../server/smsParse.js';
import { suggestCategory } from '../server/categorize.js';
import { pdfToImageDataUrls, extractPdfText } from '../server/pdfImages.js';

const fmt = (n) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n || 0)} ₽`;
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

let botInstance = null;
export const getBot = () => botInstance;

/* ---------- вспомогательное ---------- */
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
      amount: sms.amount, type: sms.type, category_id: sug.category_id,
      category_name: sug.category_name, note: sms.merchant || sms.raw.slice(0, 80),
      date: today, source: 'sms',
    };
  }

  if (ai.isAiEnabled()) {
    const g = await ai.parseTransactionText(text, categories.map((c) => c.name), today);
    if (g) {
      const cat = svc.resolveCategoryByName(user.id, g.type, g.category_name);
      return { ...g, ...cat, date: g.date || today, source: 'ai' };
    }
  }

  const m = text.match(/(\d[\d\s]*(?:[.,]\d{1,2})?)/);
  if (m) {
    const amount = Number.parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(amount) && amount > 0) {
      const type = /зарплат|получил|зачисл|доход|аванс|премия|подарил/i.test(text) ? 'income' : 'expense';
      const sug = suggestCategory(text, type, categories);
      return {
        amount, type, category_id: sug.category_id, category_name: sug.category_name,
        note: text.slice(0, 80), date: today, source: 'rules',
      };
    }
  }
  return null;
}

/* ---------- бот ---------- */
function createBot() {
  const bot = new Bot(config.botToken);

  const openKeyboard = () =>
    config.webappUrl ? new InlineKeyboard().webApp('💰 Открыть бюджет', config.webappUrl) : undefined;

  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name || 'друг';
    getOrCreateUser(ctx.from.id, name);
    await ctx.reply(
      `Привет, ${esc(name)}!\n\n` +
        'Дзен-бюджет на связи. Что умею:\n' +
        '• перешлите SMS банка — распознаю операцию\n' +
        '• напишите «кофе 350»\n' +
        '• отправьте фото или PDF чека\n\n' +
        'Команды: /app /today /month /ask /remind',
      { reply_markup: openKeyboard() }
    );
  });

  bot.command('app', async (ctx) => {
    const kb = openKeyboard();
    if (!kb) return ctx.reply('Адрес Mini App не настроен на сервере');
    await ctx.reply('Mini App:', { reply_markup: kb });
  });

  bot.command('today', async (ctx) => {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const s = svc.daySummary(user);
    await ctx.reply(`📅 Сегодня (${s.date})\nОпераций: ${s.count}\n+${fmt(s.income)} / −${fmt(s.expense)}`);
  });

  bot.command('month', async (ctx) => {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const d = svc.dashboard(user);
    const top = d.byCategory.slice(0, 5).map((c) => `${c.icon || '•'} ${esc(c.name)} — ${fmt(c.total)}`).join('\n');
    await ctx.reply(
      `📊 Месяц ${d.month.from.slice(0, 7)}\n` +
        `Доходы: +${fmt(d.month.income)}\nРасходы: −${fmt(d.month.expense)}\n` +
        `Итог: ${fmt(d.month.balance)}\nБаланс счетов: ${fmt(d.balance)}` +
        (top ? `\n\nТоп категорий:\n${top}` : '')
    );
  });

  bot.command('ask', async (ctx) => {
    if (!ai.isAiEnabled()) return ctx.reply('AI-помощник не настроен на сервере');
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const q = (ctx.match || '').toString().trim() || 'Кратко оцени бюджет за месяц';
    await ctx.replyWithChatAction('typing');
    try {
      const answer = await ai.askBudget(q, svc.summaryForAi(user));
      await ctx.reply(answer.slice(0, 3500));
    } catch (e) {
      await ctx.reply(e.message);
    }
  });

  bot.command('remind', async (ctx) => {
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const arg = (ctx.match || '').toString().trim().toLowerCase();
    if (['on', 'вкл'].includes(arg)) {
      svc.updateSettings(user, { remind_enabled: true });
      return ctx.reply(`Напоминания включены, в ${String(user.remind_hour ?? 21).padStart(2, '0')}:00`);
    }
    if (['off', 'выкл'].includes(arg)) {
      svc.updateSettings(user, { remind_enabled: false });
      return ctx.reply('Напоминания выключены');
    }
    if (/^\d{1,2}$/.test(arg)) {
      const h = Math.max(0, Math.min(23, Number.parseInt(arg, 10)));
      svc.updateSettings(user, { remind_hour: h, remind_enabled: true });
      return ctx.reply(`Буду напоминать в ${String(h).padStart(2, '0')}:00 (${svc.tzOf(user)})`);
    }
    await ctx.reply('Использование: /remind on | off | 21');
  });

  /* ---------- черновики ---------- */
  async function offerDraft(ctx, draft) {
    const key = crypto.randomBytes(9).toString('base64url');
    svc.saveDraft(key, ctx.from.id, draft);
    const sign = draft.type === 'income' ? '+' : '−';
    const kb = new InlineKeyboard()
      .text('✅ Записать', `d:ok:${key}`)
      .text('❌ Отмена', `d:no:${key}`);
    await ctx.reply(
      `Распознано:\n${sign}<b>${fmt(draft.amount)}</b> · ${draft.type === 'income' ? 'доход' : 'расход'}\n` +
        `📂 ${esc(draft.category_name || '—')}\n` +
        (draft.note ? `📝 ${esc(draft.note)}\n` : '') +
        (draft.date ? `📅 ${draft.date}\n` : '') +
        '\nЗаписать?',
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }

  bot.callbackQuery(/^d:(ok|no):(.+)$/, async (ctx) => {
    const [, action, key] = ctx.match;
    await ctx.answerCallbackQuery();
    const draft = svc.takeDraft(key, ctx.from.id);
    if (!draft) return ctx.editMessageText('Черновик устарел или уже обработан.');
    if (action === 'no') return ctx.editMessageText('Отменено.');

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    try {
      const tx = svc.createTransaction(user, {
        amount: draft.amount,
        type: draft.type,
        category_id: draft.category_id,
        note: draft.note,
        date: draft.date || svc.todayIn(svc.tzOf(user)),
        idempotency_key: `bot:${key}`,
      });
      const sign = tx.type === 'income' ? '+' : '−';
      await ctx.editMessageText(`✅ ${sign}${fmt(tx.amount)} · ${esc(tx.category_name || 'без категории')}`);
    } catch (e) {
      await ctx.editMessageText(`Не удалось записать: ${esc(e.message)}`);
    }
  });

  /* ---------- медиа ---------- */
  bot.on('message:photo', async (ctx) => {
    if (!ai.isAiEnabled()) return ctx.reply('Распознавание чеков не настроено на сервере');
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const best = ctx.message.photo[ctx.message.photo.length - 1];
      const dataUrl = await fileDataUrl(bot, best.file_id);
      const g = await ai.parseReceiptImage(
        dataUrl,
        svc.categoryList(user.id).map((c) => c.name),
        svc.todayIn(svc.tzOf(user))
      );
      if (!g) return ctx.reply('Не удалось прочитать чек на фото');
      const cat = svc.resolveCategoryByName(user.id, g.type, g.category_name);
      await offerDraft(ctx, { ...g, ...cat });
    } catch (e) {
      await ctx.reply(e.message);
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const name = (doc.file_name || '').toLowerCase();
    const isImage = mime.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/.test(name);
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');

    if (!isImage && !isPdf) return ctx.reply('Пришлите фото или PDF чека');
    if (!ai.isAiEnabled()) return ctx.reply('Распознавание чеков не настроено на сервере');

    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    const names = svc.categoryList(user.id).map((c) => c.name);
    const today = svc.todayIn(svc.tzOf(user));
    await ctx.replyWithChatAction('typing');

    try {
      if (isImage) {
        const g = await ai.parseReceiptImage(await fileDataUrl(bot, doc.file_id), names, today);
        if (!g) return ctx.reply('Не удалось прочитать изображение');
        const cat = svc.resolveCategoryByName(user.id, g.type, g.category_name);
        return offerDraft(ctx, { ...g, ...cat });
      }

      await ctx.reply('Читаю PDF…');
      const { buf } = await fileBuffer(bot, doc.file_id);
      let g = null;
      for (const img of pdfToImageDataUrls(buf)) {
        try {
          g = await ai.parseReceiptImage(img, names, today);
          if (g) break;
        } catch (e) { console.warn('pdf image', e.message); }
      }
      if (!g) {
        const text = extractPdfText(buf);
        if (text.length > 10) g = await ai.parseReceiptText(text, names, today);
      }
      if (!g) return ctx.reply('Не удалось распознать PDF. Попробуйте фото страницы чека.');
      const cat = svc.resolveCategoryByName(user.id, g.type, g.category_name);
      await offerDraft(ctx, { ...g, ...cat });
    } catch (e) {
      await ctx.reply(e.message);
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return;
    const user = getOrCreateUser(ctx.from.id, ctx.from.first_name || '');
    await ctx.replyWithChatAction('typing');
    try {
      const draft = await buildDraftFromText(user, text.slice(0, 1000));
      if (!draft) return ctx.reply('Не распознал. Примеры: «кофе 350», текст SMS банка, фото или PDF чека.');
      await offerDraft(ctx, draft);
    } catch (e) {
      await ctx.reply(e.message);
    }
  });

  bot.catch((err) => console.error('Bot error:', err.error ?? err));
  return bot;
}

/**
 * Возвращает express-middleware для вебхука (или null в режиме polling).
 */
export async function startBot(mode = config.botMode) {
  if (!config.botToken) {
    console.error('BOT_TOKEN не задан — бот не запущен');
    return null;
  }
  botInstance = createBot();
  await botInstance.init();

  try {
    await botInstance.api.setMyCommands([
      { command: 'start', description: 'Начать' },
      { command: 'app', description: 'Открыть бюджет' },
      { command: 'today', description: 'Итоги дня' },
      { command: 'month', description: 'Итоги месяца' },
      { command: 'ask', description: 'Спросить помощника' },
      { command: 'remind', description: 'Напоминания' },
    ]);
  } catch (e) {
    console.warn('setMyCommands', e.message);
  }

  const startPolling = async () => {
    await botInstance.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    botInstance.start({ onStart: (i) => console.log('Бот в режиме polling: @' + i.username) });
    return null;
  };

  if (mode === 'polling' || !config.webappUrl) {
    if (mode !== 'polling') console.warn('WEBAPP_URL пуст — переключаюсь на polling');
    return startPolling();
  }

  const hookUrl = `${config.webappUrl}${config.webhookPath}`;
  try {
    await botInstance.api.setWebhook(hookUrl, {
      secret_token: config.webhookSecret || undefined,
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log('Вебхук установлен:', hookUrl);
    return webhookCallback(botInstance, 'express', {
      secretToken: config.webhookSecret || undefined,
      timeoutMilliseconds: 20_000,
    });
  } catch (e) {
    console.error('setWebhook не удался, перехожу на polling:', e.message);
    return startPolling();
  }
}

export async function stopBot() {
  try { await botInstance?.stop(); } catch {}
  botInstance = null;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bot/index.js');
if (isMain) {
  startBot('polling').catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
