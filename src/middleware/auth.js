const crypto = require('crypto');
const { getDb } = require('../db/database');
const { hashSecret } = require('../systems/signature');

function apiKeyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    return res.status(401).json({ error: 'Invalid Basic auth format — use key_id:key_secret' });
  }

  const keyId     = decoded.slice(0, colonIdx);
  const keySecret = decoded.slice(colonIdx + 1);

  const apiKey = getDb()
    .prepare('SELECT * FROM api_keys WHERE key_id = ? AND is_active = 1')
    .get(keyId);

  if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });

  const provided = Buffer.from(hashSecret(keySecret), 'hex');
  const stored   = Buffer.from(apiKey.key_secret, 'hex');

  if (provided.length !== stored.length || !crypto.timingSafeEqual(provided, stored)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.merchantId = apiKey.merchant_id;
  req.apiKeyId   = apiKey.key_id;   // used by rateLimiter for per-key bucketing
  next();
}

module.exports = { apiKeyAuth };
