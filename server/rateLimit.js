import { config } from './config.js';

const buckets = new Map();

function keyFor(req, scope) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${scope}:${req.user?.id ?? `ip:${ip}`}`;
}

export function rateLimit({ windowMs = 60_000, max = config.maxRequestsPerMinute, scope = 'default',
  message = 'Слишком много запросов. Попробуйте через минуту.' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFor(req, scope);
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) b = { start: now, count: 0 };
    b.count += 1;
    buckets.set(key, b);
    const remaining = Math.max(0, max - b.count);
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, v] of buckets) if (v.start < cutoff) buckets.delete(k);
}, 60_000);
sweeper.unref();
