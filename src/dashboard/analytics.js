const express = require('express');
const { getDb } = require('../db/database');
const router = express.Router();

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// GET /api/dashboard/overview
router.get('/overview', (req, res) => {
  const db  = getDb();
  const mid = req.merchantId;
  const tod = todayStart();
  const weekAgo = tod - 6 * 86400;

  const today = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0) AS revenue,
      COUNT(*) AS total,
      COUNT(CASE WHEN status='captured' THEN 1 END) AS captured
    FROM payments WHERE merchant_id=? AND created_at>=?
  `).get(mid, tod);

  const chartRows = db.prepare(`
    SELECT date(created_at,'unixepoch','localtime') AS day,
           COALESCE(SUM(amount),0) AS revenue,
           COUNT(*) AS txns
    FROM payments
    WHERE merchant_id=? AND status='captured' AND created_at>=?
    GROUP BY day ORDER BY day
  `).all(mid, weekAgo);

  const methods = db.prepare(`
    SELECT method, COUNT(*) AS count,
           COALESCE(SUM(amount),0) AS amount
    FROM payments
    WHERE merchant_id=? AND status='captured' AND created_at>=?
    GROUP BY method
  `).all(mid, weekAgo);

  const recent = db.prepare(`
    SELECT p.id, p.amount, p.currency, p.method, p.status, p.created_at,
           o.customer_name, o.customer_email
    FROM payments p JOIN orders o ON p.order_id=o.id
    WHERE p.merchant_id=? ORDER BY p.created_at DESC LIMIT 8
  `).all(mid);

  const successRate = today.total > 0
    ? ((today.captured / today.total) * 100).toFixed(1)
    : '0.0';

  res.json({
    today: {
      revenue:      today.revenue,
      transactions: today.total,
      captured:     today.captured,
      success_rate: parseFloat(successRate),
    },
    chart:   chartRows,
    methods,
    recent,
  });
});

// GET /api/dashboard/transactions
router.get('/transactions', (req, res) => {
  const db     = getDb();
  const mid    = req.merchantId;
  const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const { status, method, search } = req.query;

  let where = 'WHERE p.merchant_id=?';
  const params = [mid];

  if (status) { where += ' AND p.status=?';  params.push(status); }
  if (method) { where += ' AND p.method=?';  params.push(method); }
  if (search) {
    where += ' AND (p.id LIKE ? OR o.customer_email LIKE ? OR o.customer_phone LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const { count } = db.prepare(
    `SELECT COUNT(*) AS count FROM payments p JOIN orders o ON p.order_id=o.id ${where}`
  ).get(...params);

  const items = db.prepare(`
    SELECT p.id, p.order_id, p.amount, p.currency, p.method,
           p.status, p.processor, p.created_at, p.captured_at,
           o.customer_name, o.customer_email, o.customer_phone
    FROM payments p JOIN orders o ON p.order_id=o.id
    ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total: count, items });
});

// GET /api/dashboard/customers
router.get('/customers', (req, res) => {
  const items = getDb().prepare(`
    SELECT o.customer_email AS email, o.customer_name AS name, o.customer_phone AS phone,
           COUNT(p.id) AS payment_count,
           COALESCE(SUM(CASE WHEN p.status='captured' THEN p.amount END),0) AS total_paid,
           MAX(p.created_at) AS last_payment
    FROM payments p JOIN orders o ON p.order_id=o.id
    WHERE p.merchant_id=? AND o.customer_email IS NOT NULL
    GROUP BY o.customer_email ORDER BY total_paid DESC LIMIT 50
  `).all(req.merchantId);
  res.json({ items });
});

// GET /api/dashboard/api-keys
router.get('/api-keys', (req, res) => {
  const keys = getDb().prepare(
    'SELECT id, key_id, is_active, created_at FROM api_keys WHERE merchant_id=?'
  ).all(req.merchantId);
  res.json({ items: keys });
});

module.exports = router;
