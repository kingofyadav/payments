// Sliding window rate limiter — 600 requests per minute per API key
// Uses in-memory store (resets on restart; swap for Redis in prod)

const WINDOW_MS  = 60_000;
const MAX_REQ    = 600;

const windows = new Map(); // keyId → { count, windowStart }

function rateLimiter(req, res, next) {
  // Only applies after apiKeyAuth sets req.merchantId + req.apiKeyId
  const keyId = req.apiKeyId || req.merchantId || 'anon';
  const now   = Date.now();

  let w = windows.get(keyId);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    w = { count: 0, windowStart: now };
    windows.set(keyId, w);
  }
  w.count++;

  const remaining = Math.max(0, MAX_REQ - w.count);
  const reset      = Math.ceil((w.windowStart + WINDOW_MS) / 1000);

  res.set('X-RateLimit-Limit',     MAX_REQ);
  res.set('X-RateLimit-Remaining', remaining);
  res.set('X-RateLimit-Reset',     reset);

  if (w.count > MAX_REQ) {
    return res.status(429).json({
      error: {
        code:        'RATE_LIMIT_ERROR',
        description: 'Too many requests — limit is 600 per minute',
        source:      'gateway',
      },
    });
  }
  next();
}

// Expose so auth middleware can set req.apiKeyId before rate check
module.exports = { rateLimiter };
