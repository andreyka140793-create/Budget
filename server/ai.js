import { parseMoneyRubles, coerceReceiptAmount } from './db.js';
/**
 * AI-провайдеры для чеков и текста:
 * - yandex  (Vision OCR + YandexGPT) — лучше с Amvera/РФ
 * - openai / gemini / grok
 *
 * AI_PROVIDER=auto|yandex|openai|gemini|grok
 */
import { config } from './config.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const OPENAI_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
const YANDEX_OCR_URL = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText';
const YANDEX_LLM_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

function mode() {
  return String(process.env.AI_PROVIDER || 'auto').toLowerCase();
}

function yandexKey() {
  return process.env.YANDEX_API_KEY || process.env.YC_API_KEY || '';
}
function yandexFolder() {
  return process.env.YANDEX_FOLDER_ID || process.env.YC_FOLDER_ID || '';
}

export function isYandexEnabled() {
  return Boolean(yandexKey() && yandexFolder());
}
export function isOpenAiEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}
export function isGeminiEnabled() {
  return Boolean(config.geminiApiKey);
}
export function isGrokEnabled() {
  return Boolean(process.env.XAI_API_KEY || process.env.GROK_API_KEY);
}
export function isAiEnabled() {
  return isYandexEnabled() || isOpenAiEnabled() || isGeminiEnabled() || isGrokEnabled();
}

function pickOrder() {
  const m = mode();
  const available = [
    ['yandex', isYandexEnabled()],
    ['openai', isOpenAiEnabled()],
    ['gemini', isGeminiEnabled()],
    ['grok', isGrokEnabled()],
  ]
    .filter(([, on]) => on)
    .map(([n]) => n);

  if (['yandex', 'openai', 'gemini', 'grok'].includes(m)) {
    return available.includes(m) ? [m, ...available.filter((x) => x !== m)] : available;
  }
  // auto: Yandex первым (доступен из РФ)
  const preferred = ['yandex', 'openai', 'gemini', 'grok'];
  return preferred.filter((p) => available.includes(p));
}

function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function catsList(categoryNames) {
  return categoryNames.length
    ? categoryNames.join(', ')
    : 'Продукты, Кафе, Транспорт, Жильё, Связь, Здоровье, Одежда, Развлечения, Прочее, Зарплата, Подработка, Подарок';
}

function normalizeDraft(parsed, today = null, rawText = '') {
  if (!parsed || parsed.error || !parsed.amount) return null;
  const amount = coerceReceiptAmount(parsed.amount, rawText || parsed.note || '');
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let date = null;
  if (parsed.date && /^\d{4}-\d{2}-\d{2}/.test(String(parsed.date))) {
    date = String(parsed.date).slice(0, 10);
    if (today && date > today) date = today;
    // OCR часто врёт год (2019) — не старше 400 дней
    if (today) {
      const t = Date.parse(today + 'T12:00:00Z');
      const d = Date.parse(date + 'T12:00:00Z');
      if (Number.isFinite(t) && Number.isFinite(d) && t - d > 400 * 86400000) date = today;
    }
  }
  return {
    amount: Math.round(amount * 100) / 100,
    type: parsed.type === 'income' ? 'income' : 'expense',
    category_name: String(parsed.category_name || 'Прочее').slice(0, 40),
    note: String(parsed.note || '').slice(0, 120),
    date,
  };
}

function dataUrlParts(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(m[1])) return null;
  return { mimeType: m[1], data: m[2], dataUrl: `data:${m[1]};base64,${m[2]}` };
}

function mimeToYandex(mime) {
  const m = String(mime).toLowerCase();
  if (m.includes('png')) return 'PNG';
  if (m.includes('pdf')) return 'PDF';
  return 'JPEG';
}

/* ---------- Yandex ---------- */
async function yandexOcrImage(base64, mimeType = 'image/jpeg') {
  const key = yandexKey();
  if (!key) throw new Error('YANDEX_API_KEY не задан');

  let res;
  try {
    res = await fetch(YANDEX_OCR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${key}`,
        'x-data-logging-enabled': 'false',
      },
      body: JSON.stringify({
        mimeType: mimeToYandex(mimeType),
        languageCodes: ['ru', 'en'],
        model: 'page',
        content: base64,
      }),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Yandex OCR: таймаут' : 'Yandex OCR недоступен');
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Yandex OCR', res.status, t.slice(0, 400));
    throw new Error(res.status === 403
      ? 'Yandex OCR 403: включите биллинг и роль ai.vision.user у сервисного аккаунта'
      : `Yandex OCR: ошибка ${res.status}`);
  }

  const data = await res.json();
  // Собираем текст со всех блоков
  const texts = [];
  const ann = data.result?.textAnnotation;
  if (ann?.fullText) texts.push(ann.fullText);
  const blocks = ann?.blocks || [];
  for (const b of blocks) {
    for (const line of b.lines || []) {
      if (line.text) texts.push(line.text);
      else {
        const words = (line.words || []).map((w) => w.text).filter(Boolean);
        if (words.length) texts.push(words.join(' '));
      }
    }
  }
  // alternative structure
  if (!texts.length && data.result?.page) {
    for (const block of data.result.page.blocks || []) {
      for (const line of block.lines || []) {
        const words = (line.words || []).map((w) => w.text).filter(Boolean);
        if (words.length) texts.push(words.join(' '));
      }
    }
  }
  return [...new Set(texts)].join('\n').trim();
}

async function yandexGpt(prompt, { json = false, maxTokens = 400 } = {}) {
  const key = yandexKey();
  const folder = yandexFolder();
  if (!key || !folder) throw new Error('YANDEX_API_KEY / YANDEX_FOLDER_ID не заданы');

  const model =
    process.env.YANDEX_GPT_MODEL ||
    `gpt://${folder}/yandexgpt-lite`;

  const body = {
    modelUri: model.startsWith('gpt://') ? model : `gpt://${folder}/${model}`,
    completionOptions: {
      stream: false,
      temperature: 0.1,
      maxTokens: String(maxTokens),
    },
    messages: [
      {
        role: 'system',
        text: json
          ? 'Отвечай только валидным JSON без markdown и пояснений.'
          : 'Отвечай кратко по-русски.',
      },
      { role: 'user', text: prompt },
    ],
  };

  let res;
  try {
    res = await fetch(YANDEX_LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${key}`,
        'x-folder-id': folder,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'YandexGPT: таймаут' : 'YandexGPT недоступен');
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('YandexGPT', res.status, t.slice(0, 400));
    throw new Error(`YandexGPT: ошибка ${res.status}`);
  }

  const data = await res.json();
  const text =
    data.result?.alternatives?.[0]?.message?.text ||
    data.result?.alternatives?.[0]?.text ||
    '';
  return String(text).trim();
}

/* ---------- OpenAI / Gemini / Grok (как раньше) ---------- */
async function callOpenAI(messages, { json = false, maxTokens = 400 } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const body = { model, messages, temperature: 0.1, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'OpenAI: таймаут' : 'OpenAI недоступен с сервера');
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('OpenAI', res.status, t.slice(0, 300));
    throw new Error(`OpenAI: ошибка ${res.status}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(parts, { json = false, maxTokens = 400 } = {}) {
  if (!isGeminiEnabled()) throw new Error('GEMINI_API_KEY не задан');
  const model = config.geminiModel || 'gemini-2.0-flash';
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
  };
  if (json) body.generationConfig.responseMimeType = 'application/json';

  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Gemini: таймаут' : 'Gemini недоступен с сервера');
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Gemini', res.status, t.slice(0, 300));
    throw new Error(`Gemini: ошибка ${res.status}`);
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').trim();
}

async function callGrok(messages, { json = false, maxTokens = 400 } = {}) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) throw new Error('XAI_API_KEY не задан');
  const model = process.env.XAI_MODEL || 'grok-4.3';
  const body = { model, messages, temperature: 0.1, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(XAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Grok: таймаут' : 'Grok недоступен с сервера');
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('Grok', res.status, t.slice(0, 300));
    if (res.status === 403) throw new Error('Grok: нет кредитов');
    throw new Error(`Grok: ошибка ${res.status}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function generateText(prompt, { json = true, maxTokens = 350 } = {}) {
  const order = pickOrder();
  if (!order.length) {
    throw new Error('Нет AI-ключей. Для РФ: YANDEX_API_KEY + YANDEX_FOLDER_ID');
  }
  const errors = [];
  for (const p of order) {
    try {
      if (p === 'yandex') return await yandexGpt(prompt, { json, maxTokens });
      if (p === 'openai') {
        return await callOpenAI(
          [
            { role: 'system', content: json ? 'Только JSON.' : 'Кратко по-русски.' },
            { role: 'user', content: prompt },
          ],
          { json, maxTokens }
        );
      }
      if (p === 'gemini') return await callGemini([{ text: prompt }], { json, maxTokens });
      return await callGrok(
        [
          { role: 'system', content: json ? 'Только JSON.' : 'Кратко.' },
          { role: 'user', content: prompt },
        ],
        { json, maxTokens }
      );
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
      console.warn('AI text fail', p, e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

/**
 * Vision: Yandex = OCR → GPT; остальные = multimodal
 */
async function generateVision(prompt, dataUrl, { json = true, maxTokens = 350 } = {}) {
  const order = pickOrder();
  if (!order.length) throw new Error('Нет AI для распознавания фото');

  const img = dataUrlParts(dataUrl);
  if (!img) throw new Error('Нужен JPG/PNG/WEBP');

  const errors = [];
  for (const p of order) {
    try {
      if (p === 'yandex') {
        const ocrText = await yandexOcrImage(img.data, img.mimeType);
        if (!ocrText || ocrText.length < 5) throw new Error('OCR: текст не найден');
        const fullPrompt =
          prompt +
          '\n\nРаспознанный текст с изображения:\n' +
          ocrText.slice(0, 4000);
        return await yandexGpt(fullPrompt, { json, maxTokens });
      }
      if (p === 'openai') {
        return await callOpenAI(
          [
            { role: 'system', content: json ? 'Только JSON.' : 'Кратко.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: img.dataUrl } },
              ],
            },
          ],
          { json, maxTokens }
        );
      }
      if (p === 'gemini') {
        return await callGemini(
          [{ text: prompt }, { inlineData: { mimeType: img.mimeType, data: img.data } }],
          { json, maxTokens }
        );
      }
      return await callGrok(
        [
          { role: 'system', content: json ? 'Только JSON.' : 'Кратко.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: img.dataUrl } },
            ],
          },
        ],
        { json, maxTokens }
      );
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
      console.warn('AI vision fail', p, e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

export async function parseTransactionText(text, categoryNames = [], today = null) {
  const prompt =
    'Ты парсер финансовых операций. Ответь ТОЛЬКО JSON.\n' +
    'Поля: amount (число > 0), type ("expense"|"income"), category_name (из списка), note, date (YYYY-MM-DD|null).\n' +
    `Категории: ${catsList(categoryNames)}\n` +
    (today ? `Сегодня: ${today}\n` : '') +
    'Не операция — {"error":"not_transaction"}.\n\n' +
    String(text).slice(0, 2000);
  const out = await generateText(prompt);
  return normalizeDraft(parseJsonContent(out), today, String(text));
}

export async function parseReceiptImage(dataUrl, categoryNames = [], today = null) {
  const prompt =
    'Это кассовый чек. Ответь ТОЛЬКО JSON.\n' +
    'Поля: amount (итого к оплате), type ("expense"), category_name (из списка), note (магазин), date (YYYY-MM-DD|null).\n' +
    `Категории: ${catsList(categoryNames)}\n` +
    (today ? `Сегодня: ${today}\n` : '') +
    'Не читается — {"error":"unreadable"}.';

  // 1) облачные провайдеры
  if (isAiEnabled()) {
    try {
      const visionOut = await generateVision(prompt, dataUrl);
      const draft = normalizeDraft(parseJsonContent(visionOut), today, visionOut);
      if (draft) {
        if (!draft.note) draft.note = 'Чек';
        return draft;
      }
    } catch (e) {
      console.warn('cloud vision failed, try local OCR:', e.message);
    }
  }

  // 2) локальный Tesseract + эвристики (работает без ключей)
  const { parseImageLocal } = await import('./receiptParse.js');
  const local = await parseImageLocal(dataUrl, categoryNames);
  if (today && local.date && local.date > today) local.date = today;
  return local;
}

export function parseReceiptText(text, categoryNames = [], today = null) {
  return parseTransactionText('Текст чека:\n' + String(text).slice(0, 3500), categoryNames, today);
}

export async function askBudget(question, summary) {
  const prompt =
    'Помощник по бюджету. 2–5 предложений по-русски, только по цифрам.\n' +
    `Данные: ${JSON.stringify(summary)}\nВопрос: ${question}`;
  return generateText(prompt, { json: false, maxTokens: 400 });
}
