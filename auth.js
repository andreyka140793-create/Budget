import crypto from 'crypto';

/**
 * Проверка Telegram WebApp initData
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculated !== hash) return null;

  // auth_date не старше 24ч
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (Date.now() / 1000 - authDate > 86400) return null;

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  return user;
}

/** Для локальной разработки без Telegram */
export function devUser(initDataHeader) {
  if (process.env.NODE_ENV === 'production') return null;
  if (initDataHeader === 'dev') {
    return { id: 1, first_name: 'Dev', username: 'devuser' };
  }
  return null;
}
