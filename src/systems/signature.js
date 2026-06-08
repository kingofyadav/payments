const crypto = require('crypto');

function generateKeyPair() {
  return {
    keyId:     'key_' + crypto.randomBytes(10).toString('hex'),
    keySecret: crypto.randomBytes(24).toString('hex'),
  };
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
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

module.exports = { generateKeyPair, hashSecret, signPayload, verifySignature };
