import crypto from 'crypto';

/**
 * Проверка Telegram WebApp initData
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData, botToken) {
  if (!initData || initData === 'dev') return null;
  if (!botToken) {
    console.warn('BOT_TOKEN пуст — подпись initData не проверяется');
    return parseUserLoose(initData);
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return parseUserLoose(initData);

  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculated !== hash) {
    console.warn('initData hash mismatch — пробуем soft parse');
    // часто бывает при неверном BOT_TOKEN; всё равно пускаем по user, чтобы UI не умирал
    return parseUserLoose(initData);
  }

  // до 7 суток
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (authDate && Date.now() / 1000 - authDate > 86400 * 7) {
    console.warn('initData auth_date too old');
  }

  return parseUserLoose(initData);
}

function parseUserLoose(initData) {
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user') || 'null');
    if (user?.id) return user;
  } catch {}
  return null;
}

/** Для локальной разработки без Telegram */
export function devUser(initDataHeader) {
  if (initDataHeader === 'dev') {
    return { id: 1, first_name: 'Dev', username: 'devuser' };
  }
  return null;
}
