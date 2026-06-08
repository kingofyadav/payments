const express = require('express');
const { getDb } = require('../db/database');
const { createOrder, getOrder, listOrders } = require('../systems/order');

const router = express.Router();

// POST /v1/orders
router.post('/', (req, res) => {
  const { amount, currency, customer, notes } = req.body;
  if (amount === undefined) return res.status(400).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'amount is required', field: 'amount', source: 'business' } });
  if (!Number.isInteger(amount)) return res.status(400).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be an integer in paise', field: 'amount', source: 'business' } });
  try {
    const order = createOrder({ merchantId: req.merchantId, amount, currency, customer, notes });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: { code: 'BAD_REQUEST_ERROR', description: err.message, source: 'business' } });
  }
});

// GET /v1/orders
router.get('/', (req, res) => {
  const limit  = Math.min(parseInt(req.query.count) || parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.skip) || parseInt(req.query.offset) || 0;
  const result = listOrders(req.merchantId, { limit, offset });
  res.json({ count: result.count, items: result.items });
});

// GET /v1/orders/:id
router.get('/:id', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: { code: 'NOT_FOUND_ERROR', description: 'Order not found', source: 'business' } });
  if (order.merchant_id !== req.merchantId) return res.status(403).json({ error: { code: 'AUTHORIZATION_ERROR', description: 'Forbidden', source: 'business' } });
  res.json(order);
});

// GET /v1/orders/:id/payments
router.get('/:id/payments', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: { code: 'NOT_FOUND_ERROR', description: 'Order not found', source: 'business' } });
  if (order.merchant_id !== req.merchantId) return res.status(403).json({ error: { code: 'AUTHORIZATION_ERROR', description: 'Forbidden', source: 'business' } });
  const items = getDb().prepare('SELECT * FROM payments WHERE order_id=? ORDER BY created_at ASC').all(order.id);
  res.json({ count: items.length, items });
});

module.exports = router;
