const crypto   = require('crypto');
const { getDb } = require('../db/database');

// Idempotency: only applied to POST/PATCH mutations via applyIdempotency()
// X-Idempotency-Key: <developer-supplied UUID or string, max 64 chars>

function reqHash(req) {
  const s = req.method + req.path + JSON.stringify(req.body || {});
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

function idempotency(req, res, next) {
  // Idempotency only matters for non-safe mutations
  if (SAFE_METHODS.has(req.method)) return next();
  const ikey = req.headers['x-idempotency-key'];
  if (!ikey) return next();
  if (ikey.length > 64) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST_ERROR', description: 'X-Idempotency-Key must be 64 chars or fewer', source: 'gateway' },
    });
  }

  const mid = req.merchantId;
  if (!mid) return next();

  const db   = getDb();
  const hash = reqHash(req);
  const row  = db.prepare('SELECT * FROM idempotency_keys WHERE idem_key=? AND merchant_id=?').get(ikey, mid);

  if (row) {
    if (row.req_hash !== hash) {
      return res.status(422).json({
        error: {
          code:        'IDEMPOTENCY_KEY_REUSE',
          description: 'This idempotency key was already used for a different request',
          source:      'gateway',
        },
      });
    }
    res.set('X-Idempotency-Replay', 'true');
    return res.status(row.status_code).json(JSON.parse(row.response));
  }

  // Intercept res.json to cache the response
  const origJson = res.json.bind(res);
  res.json = function (body) {
    const code = res.statusCode || 200;
    // Only cache non-5xx responses
    if (code < 500) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO idempotency_keys (idem_key, merchant_id, req_hash, status_code, response)
          VALUES (?, ?, ?, ?, ?)
        `).run(ikey, mid, hash, code, JSON.stringify(body));
      } catch { /* ignore race */ }
    }
    return origJson(body);
  };

  next();
}

module.exports = { idempotency };
