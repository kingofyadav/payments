const { getDb } = require('../db/database');
const { verifySecret } = require('../systems/signature');

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

  if (!verifySecret(keySecret, apiKey.key_secret)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.merchantId = apiKey.merchant_id;
  req.apiKeyId   = apiKey.key_id;   // used by rateLimiter for per-key bucketing
  next();
}

module.exports = { apiKeyAuth };
