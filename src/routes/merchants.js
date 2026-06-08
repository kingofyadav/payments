const express = require('express');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { generateKeyPair, hashSecret } = require('../systems/signature');
const { hashPassword }  = require('../systems/password');
const { scoreMerchant } = require('../risk/merchant_score');

const router = express.Router();

// POST /v1/merchants — register a merchant
router.post('/', async (req, res) => {
  const { name, email, password, webhook_url } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const db          = getDb();
  const merchantId  = 'mrc_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const passwordHash = await hashPassword(password);

  try {
    db.prepare('INSERT INTO merchants (id, name, email, password_hash, webhook_url) VALUES (?, ?, ?, ?, ?)')
      .run(merchantId, name, email, passwordHash, webhook_url ?? null);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    throw err;
  }

  const { keyId, keySecret } = generateKeyPair();
  db.prepare('INSERT INTO api_keys (id, merchant_id, key_id, key_secret) VALUES (?, ?, ?, ?)')
    .run('apk_' + randomUUID().replace(/-/g, '').slice(0, 16), merchantId, keyId, hashSecret(keySecret));

  // Baseline risk score — non-blocking
  setImmediate(() => { try { scoreMerchant(merchantId); } catch {} });

  res.status(201).json({
    merchant_id: merchantId,
    name,
    email,
    key_id:     keyId,
    key_secret: keySecret,
    note: 'Save key_secret now — it is shown once only',
  });
});

module.exports = router;
