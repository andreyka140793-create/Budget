/**
 * Парсер SMS российских банков (Сбер, Т-Банк, Альфа и т.п.)
 * Возвращает { amount, type: 'expense'|'income', merchant, raw } или null
 */

function normalizeAmount(str) {
  if (!str) return null;
  let s = String(str).replace(/\s/g, '').replace(',', '.');
  s = s.replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {string} text
 */
export function parseBankSms(text) {
  if (!text || text.length < 5) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  const low = t.toLowerCase();

  // Явный доход
  const isIncome =
    /зачислен|пополнен|приход|incoming|зачисление|перевод (вам|вам)|поступило|получен/.test(low) &&
    !/не прошел|отклонен|отмен/.test(low);

  // Явный расход
  const isExpense =
    /покупка|списан|оплата|payment|снятие|перевод|расход|оплачен|hold|автоплатеж|подписк/.test(low);

  let type = null;
  if (isIncome && !isExpense) type = 'income';
  else if (isExpense) type = 'expense';
  else if (isIncome) type = 'income';

  // Суммы: 1 234.56 р / 1234,56 RUB / 500р / 1.234,56
  const amountPatterns = [
    /(\d[\d\s]*[.,]\d{2})\s*(?:₽|р|руб|rub|rur)/i,
    /(?:сумма|sum|на сумму|amount)[:\s]*(\d[\d\s.,]*)/i,
    /(\d[\d\s]*[.,]\d{2})/,
    /(\d{2,7})\s*(?:₽|р|руб)/i,
  ];

  let amount = null;
  for (const re of amountPatterns) {
    const m = t.match(re);
    if (m) {
      amount = normalizeAmount(m[1]);
      if (amount) break;
    }
  }
  if (!amount) return null;

  if (!type) {
    // по знаку в тексте
    if (/^\+|плюс/.test(low) || /\+\s*\d/.test(t)) type = 'income';
    else type = 'expense';
  }

  // Merchant / место
  let merchant = '';
  const merchantPatterns = [
    /покупка\s+(?:в\s+)?(.+?)(?:\s+сумма|\s+\d|\s+балн|\s+доступ|\.|$)/i,
    /(?:в|у)\s+([A-Za-zА-Яа-я0-9*.\-\s]{3,40}?)(?:\s+\d|\s+сумма|\s+балн|\.|$)/i,
    /(?:MCC\s*\d+\s*)?([A-Z][A-Z0-9*\s.\-]{2,30})/,
  ];
  for (const re of merchantPatterns) {
    const m = t.match(re);
    if (m && m[1]) {
      merchant = m[1].trim().replace(/\s+/g, ' ').slice(0, 60);
      if (merchant.length >= 2) break;
    }
  }

  // Баланс из SMS (опционально)
  let balance = null;
  const bal = t.match(/(?:баланс|доступно|остаток)[:\s]*(\d[\d\s.,]*)/i);
  if (bal) balance = normalizeAmount(bal[1]);

  return {
    amount,
    type,
    merchant: merchant || '',
    balance,
    raw: t,
  };
}
