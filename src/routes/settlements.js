const express = require('express');
const { listSettlements, getSettlement, getSettlementRecons } = require('../systems/settlement');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// GET /v1/settlements
router.get('/', (req, res) => {
  const result = listSettlements(req.merchantId, {
    limit:  parseInt(req.query.limit)  || 20,
    offset: parseInt(req.query.offset) || 0,
  });
  res.json({ count: result.count, items: result.items });
});

// GET /v1/settlements/:id
router.get('/:id', (req, res) => {
  const s = getSettlement(req.params.id);
  if (!s) return apiError(res, 404, 'Settlement not found');
  if (s.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(s);
});

// GET /v1/settlements/:id/recons — line items
router.get('/:id/recons', (req, res) => {
  const s = getSettlement(req.params.id);
  if (!s) return apiError(res, 404, 'Settlement not found');
  if (s.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  const items = getSettlementRecons(s.id);
  res.json({ count: items.length, items });
});

module.exports = router;
