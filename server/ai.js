import { config } from './config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function isAiEnabled() {
  return Boolean(config.geminiApiKey);
}

async function generate(parts, { json = false, maxTokens = 512 } = {}) {
  if (!isAiEnabled()) throw new Error('AI не настроен: нет GEMINI_API_KEY');

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
  };
  if (json) body.generationConfig.responseMimeType = 'application/json';

  const url = `${BASE}/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Распознавание заняло слишком долго' : 'Сервис распознавания недоступен');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('AI error', res.status, text.slice(0, 500));
    throw new Error(res.status === 429 ? 'Лимит распознавания исчерпан, попробуйте позже' : 'Сервис распознавания вернул ошибку');
  }

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').trim();
}

function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

const catsList = (names) =>
  names?.length ? names.join(', ')
    : 'Продукты, Кафе, Транспорт, Жильё, Связь, Здоровье, Одежда, Развлечения, Прочее, Зарплата, Подработка, Подарок';

function normalizeDraft(parsed, today) {
  if (!parsed || parsed.error) return null;
  const amount = Number(parsed.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return null;
  let date = null;
  if (typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    date = parsed.date;
    if (today && date > today) date = today;
  }
  return {
    amount: Math.round(amount * 100) / 100,
    type: parsed.type === 'income' ? 'income' : 'expense',
    category_name: String(parsed.category_name || 'Прочее').slice(0, 40),
    note: String(parsed.note || '').slice(0, 120),
    date,
  };
}

export async function parseTransactionText(text, categoryNames = [], today = null) {
  const prompt =
    'Ты парсер финансовых операций. Ответь ТОЛЬКО JSON.\n' +
    'Поля: amount (число > 0, в рублях), type ("expense"|"income"), category_name (строго из списка), ' +
    'note (кратко), date (YYYY-MM-DD или null).\n' +
    `Категории: ${catsList(categoryNames)}\n` +
    (today ? `Сегодня: ${today}. «вчера», «в пятницу» и т.п. переводи в дату.\n` : '') +
    'Если это не финансовая операция — {"error":"not_transaction"}.\n\nТекст:\n' +
    String(text).slice(0, 2000);

  return normalizeDraft(parseJsonContent(await generate([{ text: prompt }], { json: true, maxTokens: 300 })), today);
}

function dataUrlToInline(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(m[1])) return null;
  return { mimeType: m[1], data: m[2] };
}

export async function parseReceiptImage(dataUrl, categoryNames = [], today = null) {
  const inline = dataUrlToInline(dataUrl);
  if (!inline) throw new Error('Нужно изображение JPG, PNG или WEBP');

  const prompt =
    'На картинке кассовый чек или квитанция. Ответь ТОЛЬКО JSON.\n' +
    'Поля: amount (ИТОГО к оплате, рубли), type ("expense"), category_name (строго из списка), ' +
    'note (название магазина), date (YYYY-MM-DD или null).\n' +
    `Категории: ${catsList(categoryNames)}\n` +
    (today ? `Сегодня: ${today}.\n` : '') +
    'Если не читается — {"error":"unreadable"}.';

  const content = await generate(
    [{ text: prompt }, { inlineData: inline }],
    { json: true, maxTokens: 350 }
  );
  const draft = normalizeDraft(parseJsonContent(content), today);
  if (draft && !draft.note) draft.note = 'Чек';
  return draft;
}

export function parseReceiptText(text, categoryNames = [], today = null) {
  return parseTransactionText('Текст с чека или квитанции:\n' + String(text).slice(0, 3500), categoryNames, today);
}

export async function askBudget(question, summary) {
  const prompt =
    'Ты помощник по личному бюджету. Отвечай кратко по-русски (2–5 предложений), ' +
    'опирайся только на переданные цифры, ничего не выдумывай. Суммы в рублях.\n\n' +
    `Данные: ${JSON.stringify(summary)}\n\nВопрос: ${String(question).slice(0, 500)}`;
  return generate([{ text: prompt }], { maxTokens: 400 });
}
