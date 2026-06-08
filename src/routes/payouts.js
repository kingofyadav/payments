const express = require('express');
const { createPayout, getPayout, listPayouts, approvePayout, cancelPayout } = require('../payouts/engine');

const router = express.Router();

router.post('/', (req, res) => {
  try { res.status(201).json(createPayout(req.merchantId, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  const { status, contact_id, limit, offset } = req.query;
  res.json(listPayouts(req.merchantId, {
    status, contact_id,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  }));
});

router.get('/:id', (req, res) => {
  const p = getPayout(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found' });
  if (p.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(p);
});

router.post('/:id/approve', (req, res) => {
  try { res.json(approvePayout(req.params.id, req.merchantId, req.body.approved_by)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/cancel', (req, res) => {
  try { res.json(cancelPayout(req.params.id, req.merchantId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
