const express = require('express');
const { getDb }            = require('../db/database');
const { createLink, listLinks, getLink, deactivateLink, getLinkPayments } = require('../links/manager');

const router = express.Router();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function withUrl(link) {
  return { ...link, url: `${BASE_URL}/l/${link.code}` };
}

// GET /api/dashboard/links
router.get('/', (req, res) => {
  const { type, limit, offset } = req.query;
  const items = listLinks(req.merchantId, {
    type,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  }).map(withUrl);

  const { count } = getDb()
    .prepare('SELECT COUNT(*) as count FROM payment_links WHERE merchant_id=?')
    .get(req.merchantId);

  res.json({ total: count, items });
});

// POST /api/dashboard/links
router.post('/', (req, res) => {
  try {
    const link = createLink(req.merchantId, req.body);
    res.status(201).json(withUrl(link));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/dashboard/links/:id
router.get('/:id', (req, res) => {
  const link = getLink(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  if (link.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(withUrl(link));
});

// PATCH /api/dashboard/links/:id/deactivate
router.patch('/:id/deactivate', (req, res) => {
  const ok = deactivateLink(req.params.id, req.merchantId);
  if (!ok) return res.status(404).json({ error: 'Not found or already deactivated' });
  res.json({ ok: true });
});

// GET /api/dashboard/links/:id/payments
router.get('/:id/payments', (req, res) => {
  const link = getLink(req.params.id);
  if (!link || link.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  const payments = getLinkPayments(link.id);
  res.json({ items: payments });
});

module.exports = router;
