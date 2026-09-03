import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Строгая проверка Telegram WebApp initData.
 * Возвращает объект user или null. Никаких «мягких» проходов.
 */
export function validateInitData(initData, botToken = config.botToken) {
  if (!initData || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

  params.delete('hash');
  params.delete('signature');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number.parseInt(params.get('auth_date') || '0', 10);
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (Math.abs(Date.now() / 1000 - authDate) > config.initDataMaxAgeSec) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || typeof user.id !== 'number') return null;
    return {
      id: user.id,
      first_name: String(user.first_name || ''),
      username: String(user.username || ''),
    };
  } catch {
    return null;
  }
}

/** Только для локальной разработки: NODE_ENV!=production и ALLOW_DEV_AUTH=1 */
export function devUser(initDataHeader) {
  if (!config.allowDevAuth) return null;
  if (initDataHeader !== 'dev') return null;
  return { id: 1, first_name: 'Dev', username: 'devuser' };
}
