const state = new Map();

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Lightweight in-memory rate limiter.
 * Intended for single-instance backend deployments.
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 10,
  keyFn,
  message = 'Too many requests, please try again later.'
} = {}) {
  const safeWindowMs = toPositiveInt(windowMs, 60_000);
  const safeMax = toPositiveInt(max, 10);

  return (req, res, next) => {
    const now = Date.now();
    const key = typeof keyFn === 'function'
      ? keyFn(req)
      : (req.ip || req.headers['x-forwarded-for'] || 'unknown');

    const bucket = state.get(key);
    if (!bucket || bucket.resetAt <= now) {
      state.set(key, { count: 1, resetAt: now + safeWindowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count <= safeMax) {
      return next();
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: message,
      retryAfterSeconds
    });
  };
}

