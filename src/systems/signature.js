const crypto = require('crypto');

function generateKeyPair() {
  return {
    keyId:     'key_' + crypto.randomBytes(10).toString('hex'),
    keySecret: crypto.randomBytes(24).toString('hex'),
  };
}

// Produces a salted HMAC-SHA256 stored as "<salt_hex>:<hmac_hex>".
// A random 16-byte salt ensures two identical secrets produce different stored values.
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(secret).digest('hex');
  return `${salt}:${hash}`;
}

// Constant-time comparison that handles both the current salted format and
// legacy unsalted SHA-256 hashes still present in existing rows.
function verifySecret(plaintext, stored) {
  if (typeof stored === 'string' && stored.includes(':')) {
    const sep      = stored.indexOf(':');
    const salt     = stored.slice(0, sep);
    const expected = crypto.createHmac('sha256', salt).update(plaintext).digest('hex');
    const actual   = stored.slice(sep + 1);
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
    } catch { return false; }
  }
  // Legacy: plain SHA-256 without salt
  const legacy = crypto.createHash('sha256').update(plaintext).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(legacy, 'hex'), Buffer.from(stored, 'hex'));
  } catch { return false; }
}

function signPayload(payload, secret) {
  // Canonical form: sort keys so signature is deterministic regardless of insertion order.
  // Must match PayEngine.verifyWebhook() in the SDK.
  const data = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function verifySignature(payload, secret, received) {
  const expected = signPayload(payload, secret);
  try {
    // Constant-time compare prevents timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = { generateKeyPair, hashSecret, verifySecret, signPayload, verifySignature };
