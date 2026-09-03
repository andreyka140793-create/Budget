/**
 * Google Gemini API — текст, чеки, PDF (картинки)
 * https://ai.google.dev/api
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function getApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function isGeminiEnabled() {
  return Boolean(getApiKey());
}

/** Обратная совместимость с вызовами isGrokEnabled */
export function isGrokEnabled() {
  return isGeminiEnabled();
}

async function generate(parts, { json = false, maxTokens = 512 } = {}) {
  const key = getApiKey();
  if (!key) throw new Error('GEMINI_API_KEY не задан');

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
    },
  };
  if (json) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `${BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 280)}`);
  }

  const data = await res.json();
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text.trim();
}

function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
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

/**
 * @returns {{ amount: number, type: 'expense'|'income', category_name: string, note: string } | null}
 */
export async function parseTransactionWithGrok(text, categoryNames = []) {
  const cats = catsList(categoryNames);
  const prompt =
    'Ты парсер финансовых операций. Ответь ТОЛЬКО JSON.\n' +
    'Поля: amount (число > 0), type ("expense" или "income"), category_name (из списка), note (кратко).\n' +
    `Категории: ${cats}\n` +
    'Если это не операция — {"error":"not_transaction"}.\n\n' +
    String(text).slice(0, 2000);

  const content = await generate([{ text: prompt }], { json: true, maxTokens: 300 });
  const parsed = parseJsonContent(content);
  if (!parsed || parsed.error || !parsed.amount || parsed.amount <= 0) return null;
  return {
    amount: Number(parsed.amount),
    type: parsed.type === 'income' ? 'income' : 'expense',
    category_name: String(parsed.category_name || 'Прочее'),
    note: String(parsed.note || '').slice(0, 120),
  };
}

function dataUrlToInline(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/**
 * Чек с фото (data URL)
 */
export async function parseReceiptImage(imageUrlOrDataUrl, categoryNames = []) {
  const cats = catsList(categoryNames);
  const inline = dataUrlToInline(imageUrlOrDataUrl);
  if (!inline) throw new Error('Нужен data URL изображения');

  const prompt =
    'Это кассовый чек или квитанция. Ответь ТОЛЬКО JSON.\n' +
    'Поля: amount (итого к оплате), type ("expense"), category_name (из списка), ' +
    'note (магазин), date (YYYY-MM-DD или null).\n' +
    `Категории: ${cats}\n` +
    'Если не читается — {"error":"unreadable"}.';

  const content = await generate(
    [{ text: prompt }, { inlineData: { mimeType: inline.mimeType, data: inline.data } }],
    { json: true, maxTokens: 350 }
  );

  const parsed = parseJsonContent(content);
  if (!parsed || parsed.error || !parsed.amount || parsed.amount <= 0) return null;
  return {
    amount: Number(parsed.amount),
    type: parsed.type === 'income' ? 'income' : 'expense',
    category_name: String(parsed.category_name || 'Прочее'),
    note: String(parsed.note || 'Чек').slice(0, 120),
    date: parsed.date && /^\d{4}-\d{2}-\d{2}/.test(parsed.date) ? parsed.date.slice(0, 10) : null,
  };
}

export async function parseReceiptText(text, categoryNames = []) {
  return parseTransactionWithGrok(
    'Текст с чека/квитанции:\n' + String(text).slice(0, 3500),
    categoryNames
  );
}

export async function askBudgetGrok(question, summary) {
  const prompt =
    'Ты помощник по личному бюджету. Кратко по-русски (2–5 предложений). ' +
    'Только по переданным цифрам, не выдумывай.\n\n' +
    `Данные: ${JSON.stringify(summary)}\n\nВопрос: ${question}`;
  return generate([{ text: prompt }], { maxTokens: 400 });
}
