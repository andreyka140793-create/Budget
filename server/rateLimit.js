const buckets = new Map();

function keyFor(req, scope) {
  return `${scope}:${req.ip || req.socket.remoteAddress || 'unknown'}:${req.user?.id || 'anon'}`;
}

export function rateLimit({ windowMs = 60_000, max = 120, scope = 'default', message = 'Слишком много запросов. Попробуйте позже.' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFor(req, scope);
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) b = { start: now, count: 0 };
    b.count += 1;
    buckets.set(key, b);
    if (b.count > max) return res.status(429).json({ error: message });
    next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, v] of buckets) if (v.start < cutoff) buckets.delete(k);
}, 60_000).unref();
