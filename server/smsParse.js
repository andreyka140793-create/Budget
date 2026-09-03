/**
 * Парсер SMS российских банков.
 * @returns {{amount:number, type:'expense'|'income', merchant:string, balance:number|null, raw:string}|null}
 */
const INCOME_RE = /зачислен|зачисление|пополнен|поступил|приход|возврат|перевод от|перевод вам|получен перевод|salary|зарплата/i;
const EXPENSE_RE = /покупк|списан|оплат|снятие|перевод на|перевод в |перевод по|расход|payment|hold|автоплат|подписк|withdraw/i;
const FAILED_RE = /не прошел|не прошёл|отклонен|отклонён|отмена|отменен|недостаточно|отказ/i;

function normalizeAmount(str) {
  if (!str) return null;
  let s = String(str).replace(/\s|\u00a0/g, '');
  // 1.234,56 → 1234.56 ; 1,234.56 → 1234.56
  if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  s = s.replace(/[^\d.]/g, '');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}

export function parseBankSms(text) {
  if (!text || text.length < 6) return null;
  const raw = String(text).replace(/\s+/g, ' ').trim();
  if (FAILED_RE.test(raw)) return null;

  // Сначала вырезаем баланс/остаток, чтобы не принять его за сумму операции
  let balance = null;
  const balMatch = raw.match(/(?:баланс|доступно|остаток|дост\.?)\s*[:\-]?\s*([\d\s.,]+)/i);
  let work = raw;
  if (balMatch) {
    balance = normalizeAmount(balMatch[1]);
    work = raw.replace(balMatch[0], ' ');
  }

  const amountPatterns = [
    /(?:сумма|на сумму|amount|списание|зачисление)\s*[:\-]?\s*([\d\s.,]+)\s*(?:₽|р\b|руб|rub|rur)?/i,
    /([\d][\d\s]*[.,]\d{2})\s*(?:₽|р\b|руб|rub|rur)/i,
    /([\d][\d\s]*)\s*(?:₽|р\b|руб|rub|rur)/i,
    /([\d][\d\s]*[.,]\d{2})/,
  ];
  let amount = null;
  for (const re of amountPatterns) {
    const m = work.match(re);
    if (m) {
      amount = normalizeAmount(m[1]);
      if (amount) break;
    }
  }
  if (!amount) return null;

  // Тип: по тому, какое ключевое слово встретилось раньше
  const low = work.toLowerCase();
  const inc = low.search(INCOME_RE);
  const exp = low.search(EXPENSE_RE);
  let type;
  if (inc >= 0 && exp >= 0) type = inc < exp ? 'income' : 'expense';
  else if (inc >= 0) type = 'income';
  else if (exp >= 0) type = 'expense';
  else type = /(^|\s)\+\s*\d/.test(work) ? 'income' : 'expense';

  // Merchant
  let merchant = '';
  const merchantPatterns = [
    /покупка\s+(?:в\s+)?([^.,;]{2,40}?)(?=\s+(?:сумма|на сумму|\d)|[.,;]|$)/i,
    /(?:оплата|списание)\s+(?:в|у|на)?\s*([^.,;]{2,40}?)(?=\s+(?:сумма|на сумму|\d)|[.,;]|$)/i,
    /\b([A-Z][A-Z0-9][A-Z0-9 .*_-]{2,28})\b/,
  ];
  for (const re of merchantPatterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      const cand = m[1].trim().replace(/\s+/g, ' ').slice(0, 60);
      if (cand.length >= 2 && !/^(?:карта|карты|счет|счёт|мир|visa|mastercard)$/i.test(cand)) {
        merchant = cand;
        break;
      }
    }
  }

  return { amount, type, merchant, balance, raw };
}
