const express = require('express');
const { createPlan, getPlan, listPlans, archivePlan } = require('../subscriptions/plans');

const router = express.Router();

router.post('/', (req, res) => {
  try {
    const plan = createPlan(req.merchantId, req.body);
    res.status(201).json(plan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { status = 'active' } = req.query;
  const items = listPlans(req.merchantId, { status });
  res.json({ total: items.length, items });
});

router.get('/:id', (req, res) => {
  const plan = getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(plan);
});

router.delete('/:id', (req, res) => {
  try {
    const ok = archivePlan(req.params.id, req.merchantId);
    if (!ok) return res.status(404).json({ error: 'Plan not found' });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
