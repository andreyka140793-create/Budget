import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Строгая проверка Telegram WebApp initData.
 * Возвращает объект user или null. Никаких «мягких» проходов.
 */
export function validateInitData(initData, botToken = config.botToken) {
  // ВРЕМЕННАЯ ДИАГНОСТИКА — удалить после того, как разберёмся с 401.
  // Печатает ПРИЧИНУ отказа в логи, не печатает сам токен и хэш целиком.
  const DEBUG = true;
  const dbg = (reason, extra = {}) => {
    if (DEBUG) console.warn('[auth] отказ:', reason, extra);
  };

  if (!initData) { dbg('initData пустой (Mini App открыт не через кнопку бота, или tg.initData не отдался)'); return null; }
  if (!botToken) { dbg('BOT_TOKEN пуст на сервере — переменная не задана в этом окружении'); return null; }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    dbg('initData не парсится как query-string', { initDataPreview: initData.slice(0, 60) });
    return null;
  }

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    dbg('hash отсутствует или не похож на sha256-hex', { hasHash: Boolean(hash) });
    return null;
  }

  params.delete('hash');
  params.delete('signature');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // ВТОРОЙ, независимый способ построения dataCheckString — вручную, через
  // decodeURIComponent, который НЕ трогает символ '+' (в отличие от
  // URLSearchParams, который по стандарту form-urlencoded превращает '+' в
  // пробел). Если query_id/hash/user содержат литеральный '+', это разойдётся
  // с основным способом — и мы это увидим.
  let calculatedAlt = null;
  try {
    const rawPairs = initData
      .split('&')
      .map((p) => {
        const i = p.indexOf('=');
        const k = i === -1 ? p : p.slice(0, i);
        const v = i === -1 ? '' : p.slice(i + 1);
        return [decodeURIComponent(k), decodeURIComponent(v)];
      })
      .filter(([k]) => k !== 'hash' && k !== 'signature')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const dataCheckStringAlt = rawPairs.map(([k, v]) => `${k}=${v}`).join('\n');
    calculatedAlt = crypto.createHmac('sha256', secretKey).update(dataCheckStringAlt).digest('hex');
    if (dataCheckStringAlt !== dataCheckString) {
      dbg('РАСХОЖДЕНИЕ между URLSearchParams и ручным decodeURIComponent — похоже на баг с "+" → пробел', {
        dataCheckStringAlt,
        altMatchesReceived: calculatedAlt === hash.toLowerCase(),
      });
    }
  } catch (e) {
    dbg('альтернативный парсинг упал', { error: String(e) });
  }

  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash.toLowerCase(), 'hex');
  const mainMatches = a.length === b.length && crypto.timingSafeEqual(a, b);

  let altMatches = false;
  if (!mainMatches && calculatedAlt) {
    const aAlt = Buffer.from(calculatedAlt, 'hex');
    altMatches = aAlt.length === b.length && crypto.timingSafeEqual(aAlt, b);
  }

  if (!mainMatches && !altMatches) {
    dbg('ПОДПИСЬ НЕ СОВПАЛА (оба способа)', {
      botTokenFingerprint: crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 12),
      botTokenLength: botToken.length,
      calculatedPrefix: calculated.slice(0, 10),
      calculatedAltPrefix: calculatedAlt ? calculatedAlt.slice(0, 10) : null,
      receivedPrefix: hash.slice(0, 10),
      dataCheckString,
      rawInitDataLength: initData.length,
    });
    return null;
  }
  if (altMatches) {
    dbg('ОСНОВНОЙ способ не совпал, но АЛЬТЕРНАТИВНЫЙ (без +→пробел) СОВПАЛ — пускаем, но это подтверждает баг с "+" в URLSearchParams, не в токене!');
  }

  const authDate = Number.parseInt(params.get('auth_date') || '0', 10);
  if (!Number.isFinite(authDate) || authDate <= 0) { dbg('auth_date отсутствует/некорректен'); return null; }
  const ageSec = Math.abs(Date.now() / 1000 - authDate);
  if (ageSec > config.initDataMaxAgeSec) {
    dbg('initData слишком старый (проверьте время на сервере и телефоне)', { ageSec, maxAllowed: config.initDataMaxAgeSec });
    return null;
  }

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || typeof user.id !== 'number') { dbg('поле user отсутствует/битое', { raw: params.get('user') }); return null; }
    dbg('УСПЕХ — это не должно печататься при отказе, если видите это — баг в логике выше');
    return {
      id: user.id,
      first_name: String(user.first_name || ''),
      username: String(user.username || ''),
    };
  } catch {
    dbg('JSON.parse(user) упал');
    return null;
  }
}

/** Только для локальной разработки: NODE_ENV!=production и ALLOW_DEV_AUTH=1 */
export function devUser(initDataHeader) {
  if (!config.allowDevAuth) return null;
  if (initDataHeader !== 'dev') return null;
  return { id: 1, first_name: 'Dev', username: 'devuser' };
}
