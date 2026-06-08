const express = require('express');
const { createFundAccount, getFundAccount, listFundAccounts, pennyDrop } = require('../payouts/fund_accounts');

const router = express.Router();

router.post('/', (req, res) => {
  try { res.status(201).json(createFundAccount(req.merchantId, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/', (req, res) => {
  const { contact_id } = req.query;
  res.json({ items: listFundAccounts(req.merchantId, { contact_id }) });
});

router.get('/:id', (req, res) => {
  const fa = getFundAccount(req.params.id);
  if (!fa) return res.status(404).json({ error: 'Fund account not found' });
  if (fa.merchant_id !== req.merchantId) return res.status(403).json({ error: 'Forbidden' });
  res.json(fa);
});

router.post('/:id/penny_drop', (req, res) => {
  try { res.json(pennyDrop(req.params.id, req.merchantId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
