const express = require('express');
const { createPayoutLink, getPayoutLink, listPayoutLinks } = require('../payouts/links');

const router = express.Router();

router.post('/', (req, res) => {
  try { res.status(201).json(createPayoutLink(req.merchantId, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  const { limit, offset } = req.query;
  res.json(listPayoutLinks(req.merchantId, { limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 }));
});

router.get('/:id', (req, res) => {
  const link = getPayoutLink(req.params.id);
  if (!link) return res.status(404).json({ error: 'Payout link not found' });
  if (link.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(link);
});

module.exports = router;
