/**
 * xAI Grok API — операции, чеки, ответы про бюджет
 * https://docs.x.ai/docs/api
 */

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.XAI_MODEL || 'grok-2-latest';
const VISION_MODEL = process.env.XAI_VISION_MODEL || process.env.XAI_MODEL || 'grok-2-vision-latest';

function getApiKey() {
  return process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
}

export function isGrokEnabled() {
  return Boolean(getApiKey());
}

async function chat(messages, { json = false, maxTokens = 400, model = MODEL } = {}) {
  const key = getApiKey();
  if (!key) throw new Error('XAI_API_KEY не задан');

  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(XAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Grok API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
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

/**
 * @returns {{ amount: number, type: 'expense'|'income', category_name: string, note: string } | null}
 */
export async function parseTransactionWithGrok(text, categoryNames = []) {
  const cats = categoryNames.length
    ? categoryNames.join(', ')
    : 'Продукты, Кафе, Транспорт, Жильё, Связь, Здоровье, Одежда, Развлечения, Прочее, Зарплата, Подработка, Подарок';

  const content = await chat(
    [
      {
        role: 'system',
        content:
          'Ты парсер финансовых операций. Отвечай ТОЛЬКО JSON.\n' +
          'Поля: amount (число > 0), type ("expense"|"income"), category_name (из списка), note (кратко).\n' +
          `Категории: ${cats}\n` +
          'Если не операция — {"error":"not_transaction"}.',
      },
      { role: 'user', content: String(text).slice(0, 1500) },
    ],
    { json: true, maxTokens: 250 }
  );

  const parsed = parseJsonContent(content);
  if (!parsed || parsed.error || !parsed.amount || parsed.amount <= 0) return null;
  return {
    amount: Number(parsed.amount),
    type: parsed.type === 'income' ? 'income' : 'expense',
    category_name: String(parsed.category_name || 'Прочее'),
    note: String(parsed.note || '').slice(0, 120),
  };
}

/**
 * Распознавание чека с фото (base64 data URL или https URL)
 */
export async function parseReceiptImage(imageUrlOrDataUrl, categoryNames = []) {
  const cats = categoryNames.length
    ? categoryNames.join(', ')
    : 'Продукты, Кафе, Транспорт, Жильё, Связь, Здоровье, Одежда, Развлечения, Прочее';

  const content = await chat(
    [
      {
        role: 'system',
        content:
          'Ты читаешь кассовые чеки и квитанции. Отвечай ТОЛЬКО JSON.\n' +
          'Поля: amount (итого к оплате, число), type (обычно "expense"), ' +
          'category_name (из списка), note (магазин/организация), date (YYYY-MM-DD или null).\n' +
          `Категории: ${cats}\n` +
          'Если чек не читается — {"error":"unreadable"}.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Распознай чек: сумма итого, магазин, категория.' },
          { type: 'image_url', image_url: { url: imageUrlOrDataUrl } },
        ],
      },
    ],
    { json: true, maxTokens: 300, model: VISION_MODEL }
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

/**
 * Распознавание текста, извлечённого из PDF
 */
export async function parseReceiptText(text, categoryNames = []) {
  return parseTransactionWithGrok(
    'Это текст с чека/квитанции PDF:\n' + String(text).slice(0, 3000),
    categoryNames
  );
}

export async function askBudgetGrok(question, summary) {
  const content = await chat(
    [
      {
        role: 'system',
        content:
          'Ты помощник по личному бюджету. Кратко по-русски (2–5 предложений). Только по переданным цифрам.',
      },
      {
        role: 'user',
        content: `Данные:\n${JSON.stringify(summary)}\n\nВопрос: ${question}`,
      },
    ],
    { maxTokens: 400 }
  );
  return content.trim();
}
