/**
 * Локальный разбор текста чека (без облака) + опциональный Tesseract OCR.
 */

/** Достаём сумму/магазин из текста чека эвристиками */
export function parseReceiptHeuristics(text, categoryNames = []) {
  const raw = String(text || '').replace(/\u00a0/g, ' ');
  if (raw.trim().length < 5) return null;

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Кандидаты на сумму: ИТОГО, Всего, Total, К оплате, Сумма
  const sumPatterns = [
    /(?:итого|итог|всего\s*к\s*оплате|к\s*оплате|сумма|total|amount|итого\s*к\s*оплате)\s*[:\-]?\s*(\d+[\s.,]\d{2}|\d+)/i,
    /(?:итого|всего|total)\s*(\d+[\s.,]\d{2})/i,
    /(\d+[\s.,]\d{2})\s*(?:руб|₽|р\b)/i,
  ];

  let amount = null;
  for (const re of sumPatterns) {
    const m = raw.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
      if (n > 0 && n < 5_000_000) {
        amount = n;
        break;
      }
    }
  }

  // Если не нашли — самое большое число вида 1234.56 в нижней половине чека
  if (amount == null) {
    const money = [...raw.matchAll(/(\d{1,7}[\s.,]\d{2})/g)].map((m) =>
      parseFloat(m[1].replace(/\s/g, '').replace(',', '.'))
    ).filter((n) => n >= 10 && n < 5_000_000);
    if (money.length) amount = Math.max(...money);
  }

  if (amount == null || !(amount > 0)) return null;

  // Магазин: первые осмысленные строки
  let note = 'Чек';
  for (const line of lines.slice(0, 8)) {
    if (/^\d+$/.test(line)) continue;
    if (/чек|касс|инн|ооо|ип|фискал|рн\b|фд\b|фн\b/i.test(line) && line.length < 12) continue;
    if (line.length >= 3 && line.length <= 60) {
      note = line.slice(0, 80);
      break;
    }
  }

  // Дата
  let date = null;
  const dm = raw.match(/(\d{2})[./](\d{2})[./](\d{2,4})/);
  if (dm) {
    let y = dm[3];
    if (y.length === 2) y = '20' + y;
    const yi = Number(y);
    const nowY = new Date().getFullYear();
    if (yi >= nowY - 1 && yi <= nowY) {
      date = `${y}-${dm[2]}-${dm[1]}`;
    }
  }

  // Категория
  const blob = raw.toLowerCase();
  let category_name = 'Прочее';
  const rules = [
    [/магнит|пят[её]роч|перекр|лента|ашан|вкусвилл|продукты|молоко|хлеб/i, 'Продукты'],
    [/кофе|кафе|ресторан|бар|столов|mcdonald|kfc|бургер/i, 'Кафе'],
    [/такси|яндекс|uber|метро|автобус|бензин|азс|транспорт/i, 'Транспорт'],
    [/аптека|вита|фарма|сберздоров|клиник|стомат/i, 'Здоровье'],
    [/мтс|билайн|мегафон|теле2|ростелеком|связь/i, 'Связь'],
    [/жкх|квартплат|электро|газ|водоканал|жиль/i, 'Жильё'],
    [/кино|театр|steam|spotify|подписк|развлеч/i, 'Развлечения'],
    [/zara|hm|одежд|обувь|спортмастер/i, 'Одежда'],
  ];
  for (const [re, name] of rules) {
    if (re.test(blob)) {
      category_name = name;
      break;
    }
  }
  // если категории из списка пользователя
  const lower = categoryNames.map((c) => String(c).toLowerCase());
  if (lower.length && !lower.includes(category_name.toLowerCase())) {
    const found = categoryNames.find((c) => c.toLowerCase() === category_name.toLowerCase());
    if (!found) {
      const proch = categoryNames.find((c) => /прочее/i.test(c));
      category_name = proch || categoryNames[0] || category_name;
    }
  }

  return {
    amount: Math.round(amount * 100) / 100,
    type: 'expense',
    category_name,
    note,
    date,
    source: 'local',
  };
}

/** OCR через tesseract.js (без облака) */
export async function localOcrFromDataUrl(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Некорректное изображение');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 1000) throw new Error('Слишком маленький файл');
  if (buf.length > 6_000_000) throw new Error('Файл слишком большой для локального OCR');

  // динамический импорт — если пакет не установлен, понятная ошибка
  let Tesseract;
  try {
    Tesseract = (await import('tesseract.js')).default;
  } catch {
    throw new Error('Локальный OCR не установлен (tesseract.js)');
  }

  const result = await Tesseract.recognize(buf, 'rus+eng', {
    logger: () => {},
  });
  const text = (result?.data?.text || '').trim();
  if (!text || text.length < 5) throw new Error('Локальный OCR не нашёл текст на изображении');
  return text;
}

export async function parseImageLocal(dataUrl, categoryNames = []) {
  const text = await localOcrFromDataUrl(dataUrl);
  const draft = parseReceiptHeuristics(text, categoryNames);
  if (!draft) throw new Error('Не удалось понять сумму на чеке. Введите вручную.');
  return { ...draft, ocrPreview: text.slice(0, 200) };
}
