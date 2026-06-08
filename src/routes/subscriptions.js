const express = require('express');
const {
  createSubscription, getSubscription, listSubscriptions,
  cancelSubscription, pauseSubscription, resumeSubscription, getInvoices,
} = require('../subscriptions/manager');

const router = express.Router();

router.post('/', (req, res) => {
  try {
    const sub = createSubscription(req.merchantId, req.body);
    res.status(201).json(sub);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { status, limit, offset } = req.query;
  const result = listSubscriptions(req.merchantId, {
    status,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  });
  res.json(result);
});

router.get('/:id', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(sub);
});

router.get('/:id/invoices', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json({ items: getInvoices(sub.id) });
});

router.post('/:id/cancel', (req, res) => {
  try {
    const sub = cancelSubscription(req.params.id, req.merchantId);
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json(sub);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/pause', (req, res) => {
  try {
    const sub = pauseSubscription(req.params.id, req.merchantId);
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json(sub);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/resume', (req, res) => {
  try {
    const sub = resumeSubscription(req.params.id, req.merchantId);
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json(sub);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
