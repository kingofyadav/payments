const express = require('express');
const { randomBytes } = require('crypto');
const { getDb } = require('../db/database');
const { verifyPassword } = require('../systems/password');

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

const router = express.Router();
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

// IP-based rate limiter: 10 attempts per 15 minutes
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const _loginWindows = new Map(); // ip → { count, windowStart }

// Sweep expired rate-limit windows once per window period so the Map
// doesn't grow unboundedly under sustained traffic.
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of _loginWindows) {
    if (now - w.windowStart >= LOGIN_WINDOW_MS) _loginWindows.delete(ip);
  }
}, LOGIN_WINDOW_MS).unref();

function _loginRateLimit(req, res, next) {
  const ip  = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  let w = _loginWindows.get(ip);
  if (!w || now - w.windowStart >= LOGIN_WINDOW_MS) {
    w = { count: 0, windowStart: now };
    _loginWindows.set(ip, w);
  }
  w.count++;
  if (w.count > LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((w.windowStart + LOGIN_WINDOW_MS - now) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  next();
}

router.post('/login', _loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
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

// Delete rows whose TTL has passed — called hourly by app.js background jobs.
function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM merchant_sessions WHERE expires_at < ?')
    .run(Math.floor(Date.now() / 1000));
}

module.exports = { router, purgeExpiredSessions };
