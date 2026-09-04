import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Проверка Telegram WebApp initData
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function buildSecretKey(botToken) {
  // Официально: HMAC_SHA256("WebAppData", bot_token) как key/message в разных нотациях.
  // Node-community + Telegram samples: key = "WebAppData", data = botToken
  return crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
}

function buildSecretKeyAlt(botToken) {
  // Запасной порядок (на случай расхождений в доках)
  return crypto.createHmac('sha256', botToken).update('WebAppData').digest();
}

function parsePairs(initData) {
  // Ручной разбор: '+' не превращаем в пробел до decode
  return initData
    .split('&')
    .map((p) => {
      const i = p.indexOf('=');
      const k = i === -1 ? p : p.slice(0, i);
      const v = i === -1 ? '' : p.slice(i + 1);
      return [decodeURIComponent(k.replace(/\+/g, '%20')), decodeURIComponent(v.replace(/\+/g, '%20'))];
    })
    .filter(([k]) => k && k !== 'hash' && k !== 'signature');
}

function parsePairsKeepPlus(initData) {
  return initData
    .split('&')
    .map((p) => {
      const i = p.indexOf('=');
      const k = i === -1 ? p : p.slice(0, i);
      const v = i === -1 ? '' : p.slice(i + 1);
      return [decodeURIComponent(k), decodeURIComponent(v)];
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

function hmacHex(secretKey, message) {
  return crypto.createHmac('sha256', secretKey).update(message).digest('hex');
}

function hashesMatch(calcHex, receivedHex) {
  try {
    const a = Buffer.from(calcHex, 'hex');
    const b = Buffer.from(String(receivedHex).toLowerCase(), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function validateInitData(initData, botToken = config.botToken) {
  const token = String(botToken || '').trim();
  const raw = String(initData || '').trim();

  if (!raw || raw === 'dev') return null;
  if (!token) {
    console.warn('[auth] BOT_TOKEN пуст');
    return null;
  }

  let hash = null;
  try {
    hash = new URLSearchParams(raw).get('hash');
  } catch {
    return null;
  }
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

  const variants = [
    dataCheckString(parsePairs(raw)),
    dataCheckString(parsePairsKeepPlus(raw)),
  ];
  // URLSearchParams path
  try {
    const params = new URLSearchParams(raw);
    params.delete('hash');
    params.delete('signature');
    variants.push(
      [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    );
  } catch {}

  const secrets = [buildSecretKey(token), buildSecretKeyAlt(token)];
  let ok = false;
  for (const secret of secrets) {
    for (const msg of variants) {
      if (msg && hashesMatch(hmacHex(secret, msg), hash)) {
        ok = true;
        break;
      }
    }
    if (ok) break;
  }

  if (!ok) {
    console.warn('[auth] подпись initData не совпала', {
      tokenLen: token.length,
      tokenFp: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12),
      initLen: raw.length,
      hashPrefix: hash.slice(0, 8),
    });
    return null;
  }

  // auth_date
  let authDate = 0;
  try {
    authDate = Number.parseInt(new URLSearchParams(raw).get('auth_date') || '0', 10);
  } catch {}
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageSec = Math.abs(Date.now() / 1000 - authDate);
  if (ageSec > config.initDataMaxAgeSec) {
    console.warn('[auth] initData устарел', { ageSec, max: config.initDataMaxAgeSec });
    return null;
  }

  try {
    const userRaw = new URLSearchParams(raw).get('user');
    const user = JSON.parse(userRaw || 'null');
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

export function devUser(initDataHeader) {
  if (!config.allowDevAuth) return null;
  if (String(initDataHeader || '') !== 'dev') return null;
  return { id: 1, first_name: 'Dev', username: 'devuser' };
}
