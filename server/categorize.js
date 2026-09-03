export const MERCHANT_RULES = [
  { keys: ['пятер', 'пятёр', 'pyater', 'magnit', 'магнит', 'перекр', 'лента', 'lenta', 'ашан', 'auchan', 'дикси', 'верны', 'вкусвил', 'самокат', 'азбука вкуса', 'metro', 'окей', 'okey', 'билла', 'спар', 'spar'], category: 'Продукты' },
  { keys: ['яндекс еда', 'yandex eda', 'delivery club', 'deliveryclub', 'купер', 'kuper', 'ресторан', 'кафе', 'кофе', 'coffee', 'starbucks', 'шоколадниц', 'теремок', 'бургер', 'kfc', 'макдон', 'mcdonald', 'vkusno', 'додо', 'dodo', 'pizza', 'суши', 'кофейн'], category: 'Кафе' },
  { keys: ['такси', 'taxi', 'яндекс го', 'yandex go', 'uber', 'ситимобил', 'метро', 'мосгорпас', 'тройка', 'парковк', 'parking', 'азс', 'газпром нефть', 'лукойл', 'роснефт', 'shell', 'аэрофлот', 'ржд', 'rzd', 'туту', 'tutu', 'blablacar', 'каршеринг', 'делимобиль'], category: 'Транспорт' },
  { keys: ['мтс', 'mts', 'мегафон', 'megafon', 'билайн', 'beeline', 'теле2', 'tele2', 'ростелеком', 'yota', 'йота', 'т-мобайл', 'тинькофф мобайл'], category: 'Связь' },
  { keys: ['жкх', 'квартплат', 'мосэнерго', 'мособлгаз', 'водоканал', 'тсж', 'капремонт', 'дом.ру', 'домру', 'аренда квартир', 'коммунальн'], category: 'Жильё' },
  { keys: ['аптека', 'pharmacy', 'здравсити', 'ригла', '36,6', 'стомат', 'клиник', 'инвитро', 'гемотест', 'больниц', 'медиц'], category: 'Здоровье' },
  { keys: ['zara', 'h&m', 'остин', 'ostin', 'lamoda', 'спортмастер', 'demix', 'reserved', 'uniqlo', 'befree'], category: 'Одежда' },
  { keys: ['кино', 'cinema', 'театр', 'steam', 'playstation', 'xbox', 'spotify', 'ivi', 'okko', 'кинопоиск', 'netflix', 'youtube', 'vk music', 'яндекс плюс', 'yandex plus', 'концерт', 'музей'], category: 'Развлечения' },
  { keys: ['wildberries', 'вайлдберриз', 'ozon', 'озон', 'aliexpress', 'алиэкспресс', 'avito', 'авито', 'мегамаркет', 'citilink', 'dns', 'м.видео', 'мвидео', 'эльдорадо', 'eldorado', 'леруа', 'икеа', 'ikea'], category: 'Прочее' },
];

const INCOME_RULES = [
  { keys: ['зарплат', 'salary', 'аванс', 'премия', 'оклад'], category: 'Зарплата' },
  { keys: ['подработ', 'фриланс', 'заказ', 'гонорар'], category: 'Подработка' },
  { keys: ['подарок', 'подарил', 'gift'], category: 'Подарок' },
];

/**
 * @param {string} text
 * @param {'expense'|'income'} type
 * @param {Array<{id:number,name:string,type:string}>} categories
 */
export function suggestCategory(text, type, categories = []) {
  const low = String(text || '').toLowerCase();
  const ofType = categories.filter((c) => c.type === type);
  const byName = (name) => ofType.find((c) => c.name.toLowerCase() === name.toLowerCase());

  const rules = type === 'income' ? INCOME_RULES : MERCHANT_RULES;
  for (const rule of rules) {
    if (rule.keys.some((k) => low.includes(k))) {
      const c = byName(rule.category);
      if (c) return { category_id: c.id, category_name: c.name, confidence: 'high' };
    }
  }

  const fallback = byName('Прочее') || ofType[0];
  return {
    category_id: fallback?.id ?? null,
    category_name: fallback?.name ?? null,
    confidence: 'low',
  };
}
