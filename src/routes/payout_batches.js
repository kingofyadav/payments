const express = require('express');
const { createBatch, getBatch, listBatches, processBatch } = require('../payouts/bulk');

const router = express.Router();

router.post('/', (req, res) => {
  try { res.status(201).json(createBatch(req.merchantId, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  const { limit, offset } = req.query;
  res.json(listBatches(req.merchantId, { limit: parseInt(limit) || 20, offset: parseInt(offset) || 0 }));
});

router.get('/:id', (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(batch);
});

router.post('/:id/process', async (req, res) => {
  try { res.json(await processBatch(req.params.id, req.merchantId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
