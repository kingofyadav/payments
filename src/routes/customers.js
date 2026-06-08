const express = require('express');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const router = express.Router();

// GET /v1/customers — list with subscription stats + optional search
router.get('/', (req, res) => {
  const db     = getDb();
  const mid    = req.merchantId;
  const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search?.trim();

  let where = 'WHERE c.merchant_id=?';
  const params = [mid];
  if (search) {
    where += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const { count } = db.prepare(
    `SELECT COUNT(*) AS count FROM customers c ${where}`
  ).get(...params);

  const items = db.prepare(`
    SELECT
      c.*,
      COUNT(DISTINCT s.id)                                                          AS subscription_count,
      COUNT(DISTINCT CASE WHEN s.status='active' THEN s.id END)                    AS active_subscriptions,
      COALESCE(SUM(CASE WHEN si.status='paid' THEN si.amount END), 0)              AS total_paid,
      COUNT(CASE WHEN si.status='paid' THEN 1 END)                                 AS invoices_paid,
      MAX(si.paid_at)                                                               AS last_payment_at
    FROM customers c
    LEFT JOIN subscriptions s  ON s.customer_id = c.id
    LEFT JOIN subscription_invoices si ON si.subscription_id = s.id
    ${where}
    GROUP BY c.id
    ORDER BY total_paid DESC, c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total: count, items });
});

// POST /v1/customers — create customer explicitly (upsert by email)
router.post('/', (req, res) => {
  const { name, email, phone } = req.body;
  if (!name && !email && !phone)
    return res.status(400).json({ error: 'At least one of name, email, or phone is required' });

  const db  = getDb();
  const mid = req.merchantId;
  const normalizedEmail = email?.trim().toLowerCase() || null;

  // Upsert by email within this merchant
  if (normalizedEmail) {
    const existing = db.prepare('SELECT * FROM customers WHERE merchant_id=? AND email=?').get(mid, normalizedEmail);
    if (existing) return res.json(existing);
  }

  const id = 'cust_' + randomUUID().replace(/-/g, '').slice(0, 16);
  db.prepare('INSERT INTO customers (id, merchant_id, name, email, phone) VALUES (?,?,?,?,?)')
    .run(id, mid, name?.trim() ?? null, normalizedEmail, phone?.trim() ?? null);
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id=?').get(id));
});

// GET /v1/customers/:id — full detail with subscription list
router.get('/:id', (req, res) => {
  const db = getDb();
  const c  = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  if (c.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });

  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id)                                               AS subscription_count,
      COUNT(DISTINCT CASE WHEN s.status='active' THEN s.id END)         AS active_subscriptions,
      COALESCE(SUM(CASE WHEN si.status='paid' THEN si.amount END), 0)   AS total_paid,
      COUNT(CASE WHEN si.status='paid' THEN 1 END)                      AS invoices_paid,
      MAX(si.paid_at)                                                    AS last_payment_at
    FROM subscriptions s
    LEFT JOIN subscription_invoices si ON si.subscription_id = s.id
    WHERE s.customer_id=?
  `).get(c.id);

  const subscriptions = db.prepare(`
    SELECT s.id, s.status, s.paid_count, s.total_count, s.charge_at, s.start_at, s.created_at,
           p.name AS plan_name, p.amount AS plan_amount, p.interval, p.interval_count
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.customer_id=?
    ORDER BY s.created_at DESC
  `).all(c.id);

  res.json({ ...c, ...stats, subscriptions });
});

// PATCH /v1/customers/:id — update name / phone
router.patch('/:id', (req, res) => {
  const db = getDb();
  const c  = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  if (c.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });

  const sets = [], vals = [];
  if (req.body.name  !== undefined) { sets.push('name=?');  vals.push(req.body.name?.trim() ?? null); }
  if (req.body.phone !== undefined) { sets.push('phone=?'); vals.push(req.body.phone?.trim() ?? null); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update (name and phone are editable)' });

  db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id=?`).run(...vals, c.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(c.id));
});

module.exports = router;
