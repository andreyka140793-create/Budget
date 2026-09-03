import crypto from 'node:crypto';

const MAX_AGE_SECONDS = 24 * 60 * 60;

/** Strict Telegram Mini App initData validation. No soft fallback. */
export function validateInitData(initData, botToken, { allowDev = false } = {}) {
  if (allowDev && initData === 'dev' && process.env.NODE_ENV !== 'production') {
    return { id: 1, first_name: 'Dev', username: 'devuser' };
  }
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isInteger(authDate)) return null;

  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > MAX_AGE_SECONDS) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch {
    return null;
  }
}
