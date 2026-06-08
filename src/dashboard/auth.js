const express = require('express');
const { randomBytes } = require('crypto');
const { getDb } = require('../db/database');
const { verifyPassword } = require('../systems/password');

const router = express.Router();
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const merchant = getDb().prepare('SELECT * FROM merchants WHERE email = ?').get(email);
  if (!merchant?.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await verifyPassword(password, merchant.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token     = randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL;
  getDb()
    .prepare('INSERT INTO merchant_sessions (token, merchant_id, expires_at) VALUES (?, ?, ?)')
    .run(token, merchant.id, expiresAt);

  res.json({
    token,
    merchant: { id: merchant.id, name: merchant.name, email: merchant.email },
  });
});

router.post('/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) getDb().prepare('DELETE FROM merchant_sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const now  = Math.floor(Date.now() / 1000);
  const row  = getDb().prepare(`
    SELECT s.merchant_id, m.name, m.email, m.webhook_url
    FROM merchant_sessions s JOIN merchants m ON s.merchant_id = m.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);

  if (!row) return res.status(401).json({ error: 'Session expired' });
  res.json(row);
});

module.exports = router;
