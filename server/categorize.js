/**
 * Автокатегории по тексту (SMS / комментарий / merchant)
 * Правила: подстрока (нижний регистр) → имя категории расхода
 */
export const MERCHANT_RULES = [
  // Продукты
  { keys: ['пятер', 'пятёр', 'pyater', 'magnit', 'магнит', 'перекр', 'перекресток', 'лента', 'lenta', 'ашан', 'auchan', 'дикси', 'верны', 'вкусвилл', 'вкусвил', 'самокат', 'азбука вкуса', 'metro', 'metro c&c', 'окей', 'okey'], category: 'Продукты' },
  // Кафе
  { keys: ['яндекс еда', 'yandex eda', 'delivery club', 'deliveryclub', 'самокат еда', 'купер', 'kuper', 'ресторан', 'кафе', 'кофе', 'coffee', 'starbucks', 'шоколадниц', 'теремок', 'бургер', 'kfc', 'макдон', 'mcdonald', 'vkusno', 'додо', 'dodo', 'pizza', 'суши', 'тайм кафе'], category: 'Кафе' },
  // Транспорт
  { keys: ['такси', 'taxi', 'яндекс го', 'yandex go', 'uber', 'ситимобил', 'метро', 'мосгорпас', 'тройка', 'парковк', 'parking', 'азс', 'газпром нефть', 'лукойл', 'роснефть', 'shell', 'аэрофлот', 'rzd', 'ржд', 'туту', 'tutu', 'blablacar'], category: 'Транспорт' },
  // Связь
  { keys: ['мтс', 'mts', 'мегафон', 'megafon', 'билайн', 'beeline', 'теле2', 'tele2', 'ростелеком', 'yota', 'йота', 'тинькофф мобайл', 'т-мобайл'], category: 'Связь' },
  // Жильё / коммуналка
  { keys: ['жкх', 'квартплат', 'гку', 'мосэнерго', 'мособлгаз', 'водоканал', 'тсж', 'ук ', 'капитальн', 'интернет дом', 'дом.ру', 'домру', 'роустелеком'], category: 'Жильё' },
  // Здоровье
  { keys: ['аптека', 'pharmacy', 'здравсити', 'ригла', '36,6', 'стомат', 'клиник', 'инвитро', 'гемотест', 'больниц'], category: 'Здоровье' },
  // Одежда
  { keys: ['zara', 'h&m', 'остин', 'ostin', 'lamoda', 'la moda', 'wildberries одеж', 'спортмастер', 'demix', 'reserv'], category: 'Одежда' },
  // Развлечения
  { keys: ['кино', 'cinema', 'театр', 'steam', 'playstation', 'xbox', 'spotify', 'ivi', 'okko', 'кинопоиск', 'netflix', 'youtube', 'vk music', 'яндекс плюс', 'yandex plus'], category: 'Развлечения' },
  // Маркетплейсы → чаще Прочее или Продукты; кладём в Прочее
  { keys: ['wildberries', 'вайлдберриз', 'wb ', 'ozon', 'озон', 'aliexpress', 'алиэкспресс', 'avito', 'авито', 'мегамаркет', 'citilink', 'dns ', 'м.видео', 'мвидео', 'eldorado', 'эльдорадо'], category: 'Прочее' },
];

/**
 * @param {string} text
 * @param {'expense'|'income'} type
 * @param {Array<{id:number,name:string,type:string}>} categories
 * @returns {{ category_id: number|null, category_name: string|null, confidence: string }}
 */
export function suggestCategory(text, type, categories) {
  if (!text || type !== 'expense') {
    // для дохода — зарплата по ключевым словам
    if (type === 'income') {
      const low = (text || '').toLowerCase();
      if (/зарплат|salary|аванс|премия/.test(low)) {
        const c = categories.find((x) => x.type === 'income' && /зарплат/i.test(x.name));
        if (c) return { category_id: c.id, category_name: c.name, confidence: 'high' };
      }
    }
    const fallback = categories.find((c) => c.type === type);
    return {
      category_id: fallback?.id ?? null,
      category_name: fallback?.name ?? null,
      confidence: 'low',
    };
  }

  const low = text.toLowerCase();
  for (const rule of MERCHANT_RULES) {
    if (rule.keys.some((k) => low.includes(k))) {
      const c = categories.find((x) => x.type === 'expense' && x.name === rule.category);
      if (c) {
        return { category_id: c.id, category_name: c.name, confidence: 'high' };
      }
    }
  }

  const other = categories.find((c) => c.type === 'expense' && c.name === 'Прочее');
  return {
    category_id: other?.id ?? categories.find((c) => c.type === 'expense')?.id ?? null,
    category_name: other?.name ?? 'Прочее',
    confidence: 'low',
  };
}
