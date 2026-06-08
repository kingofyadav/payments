const { getDb } = require('../db/database');

function sessionAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const now = Math.floor(Date.now() / 1000);
  const session = getDb()
    .prepare('SELECT * FROM merchant_sessions WHERE token = ? AND expires_at > ?')
    .get(token, now);

  if (!session) return res.status(401).json({ error: 'Session expired' });

  req.merchantId = session.merchant_id;
  next();
}

module.exports = { sessionAuth };
