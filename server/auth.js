import crypto from 'node:crypto';
import { config } from './config.js';

function cleanToken(botToken) {
  return String(botToken || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\r|\n/g, '');
}

function secretKeyWebAppData(botToken) {
  // Стандартный вариант для Telegram WebApp
  return crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
}

function secretKeyTokenFirst(botToken) {
  return crypto.createHmac('sha256', botToken).update('WebAppData').digest();
}

function parsePairs(initData, plusAsSpace) {
  return initData
    .split('&')
    .map((p) => {
      const i = p.indexOf('=');
      const k = i === -1 ? p : p.slice(0, i);
      const v = i === -1 ? '' : p.slice(i + 1);
      const dk = plusAsSpace ? decodeURIComponent(k.replace(/\+/g, '%20')) : decodeURIComponent(k);
      const dv = plusAsSpace ? decodeURIComponent(v.replace(/\+/g, '%20')) : decodeURIComponent(v);
      return [dk, dv];
    })
    .filter(([k]) => k && k !== 'hash' && k !== 'signature');
}

function dataCheckString(pairs) {
  return pairs
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function matchHash(secret, message, hash) {
  try {
    const calc = crypto.createHmac('sha256', secret).update(message).digest('hex');
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(String(hash).toLowerCase(), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseUser(initData) {
  try {
    const user = JSON.parse(new URLSearchParams(initData).get('user') || 'null');
    const id = Number(user?.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    return {
      id,
      first_name: String(user.first_name || ''),
      username: String(user.username || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Проверка initData. При несовпадении подписи:
 * ALLOW_SOFT_AUTH=1 (по умолчанию) — пускаем по полю user (личный бот),
 * иначе — отказ.
 */
export function validateInitData(initData, botToken = config.botToken) {
  const token = cleanToken(botToken);
  const raw = String(initData || '').trim();
  if (!raw || raw === 'dev') return null;

  const user = parseUser(raw);
  if (!token) {
    console.warn('[auth] BOT_TOKEN пуст');
    return softAllow(user, 'no-token');
  }

  let hash = null;
  try {
    hash = new URLSearchParams(raw).get('hash');
  } catch {
    return softAllow(user, 'bad-init');
  }
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return softAllow(user, 'no-hash');
  }

  const messages = [
    dataCheckString(parsePairs(raw, true)),
    dataCheckString(parsePairs(raw, false)),
  ];
  try {
    const params = new URLSearchParams(raw);
    params.delete('hash');
    params.delete('signature');
    messages.push(
      [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    );
  } catch {}

  const secrets = [secretKeyWebAppData(token), secretKeyTokenFirst(token)];
  for (const secret of secrets) {
    for (const msg of messages) {
      if (msg && matchHash(secret, msg, hash)) {
        // auth_date
        const authDate = Number.parseInt(new URLSearchParams(raw).get('auth_date') || '0', 10);
        if (Number.isFinite(authDate) && authDate > 0) {
          const age = Math.abs(Date.now() / 1000 - authDate);
          if (age > config.initDataMaxAgeSec) {
            console.warn('[auth] initData устарел', age);
            return softAllow(user, 'stale');
          }
        }
        return user;
      }
    }
  }

  console.warn('[auth] подпись не совпала', {
    tokenLen: token.length,
    tokenFp: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12),
    hasUser: Boolean(user),
  });
  return softAllow(user, 'bad-signature');
}

function softAllow(user, reason) {
  const soft =
    process.env.ALLOW_SOFT_AUTH === undefined ||
    process.env.ALLOW_SOFT_AUTH === '' ||
    process.env.ALLOW_SOFT_AUTH === '1';
  if (soft && user) {
    console.warn('[auth] soft-auth:', reason, 'user', user.id);
    return user;
  }
  return null;
}

export function devUser(initDataHeader) {
  if (!config.allowDevAuth) return null;
  if (String(initDataHeader || '') !== 'dev') return null;
  return { id: 1, first_name: 'Dev', username: 'devuser' };
}
