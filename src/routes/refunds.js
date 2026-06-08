const express = require('express');
const { createRefund, getRefund, listRefunds } = require('../systems/refund');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// POST /v1/refunds
router.post('/', (req, res) => {
  try {
    const refund = createRefund(req.merchantId, req.body);
    res.status(201).json(refund);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'refund_creation', source: 'business' });
  }
});

// GET /v1/refunds
router.get('/', (req, res) => {
  const { payment_id, limit, offset } = req.query;
  const result = listRefunds(req.merchantId, {
    payment_id,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  });
  res.json({ count: result.count, items: result.items });
});

// GET /v1/refunds/:id
router.get('/:id', (req, res) => {
  const refund = getRefund(req.params.id);
  if (!refund) return apiError(res, 404, 'Refund not found');
  if (refund.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(refund);
});

module.exports = router;
