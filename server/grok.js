/**
 * xAI Grok API — разбор операций и короткие ответы про бюджет
 * Docs: https://docs.x.ai/docs/api
 */

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const MODEL = process.env.XAI_MODEL || 'grok-2-latest';

function getApiKey() {
  return process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
}

export function isGrokEnabled() {
  return Boolean(getApiKey());
}

async function chat(messages, { json = false, maxTokens = 400 } = {}) {
  const key = getApiKey();
  if (!key) throw new Error('XAI_API_KEY не задан');

  const body = {
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }

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
    throw new Error(`Grok API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Разбор свободного текста или SMS в операцию
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
          'Ты парсер финансовых операций для приложения бюджета. Отвечай ТОЛЬКО JSON без markdown.\n' +
          'Поля: amount (число > 0), type ("expense" или "income"), category_name (строго из списка или ближайшая), note (кратко).\n' +
          `Категории: ${cats}\n` +
          'Если это не финансовая операция — {"error":"not_transaction"}.',
      },
      { role: 'user', content: String(text).slice(0, 1500) },
    ],
    { json: true, maxTokens: 250 }
  );

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }

  if (parsed.error || !parsed.amount || parsed.amount <= 0) return null;
  const type = parsed.type === 'income' ? 'income' : 'expense';
  return {
    amount: Number(parsed.amount),
    type,
    category_name: String(parsed.category_name || 'Прочее'),
    note: String(parsed.note || '').slice(0, 120),
  };
}

/**
 * Короткий ответ по сводке бюджета
 */
export async function askBudgetGrok(question, summary) {
  const content = await chat(
    [
      {
        role: 'system',
        content:
          'Ты помощник по личному бюджету. Отвечай кратко по-русски (2–5 предложений), без воды. ' +
          'Опирайся только на переданные цифры. Не выдумывай транзакции.',
      },
      {
        role: 'user',
        content: `Данные:\n${JSON.stringify(summary, null, 0)}\n\nВопрос: ${question}`,
      },
    ],
    { json: false, maxTokens: 400 }
  );
  return content.trim();
}
