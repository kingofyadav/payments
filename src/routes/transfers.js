'use strict';
const express = require('express');
const {
  createTransfer, getTransfer, listTransfers,
  releaseTransfer, createReversal, getReversal, listReversals,
} = require('../marketplace/transfers');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// POST /v1/transfers
router.post('/', (req, res) => {
  try {
    const transfer = createTransfer(req.merchantId, req.body);
    res.status(201).json(transfer);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'transfer_creation' });
  }
});

// GET /v1/transfers
router.get('/', (req, res) => {
  const { linked_account_id, payment_id, status, limit, offset } = req.query;
  const result = listTransfers(req.merchantId, {
    linked_account_id,
    payment_id,
    status,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  });
  res.json(result);
});

// GET /v1/transfers/:id
router.get('/:id', (req, res) => {
  const t = getTransfer(req.params.id);
  if (!t) return apiError(res, 404, 'Transfer not found');
  if (t.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(t);
});

// POST /v1/transfers/:id/release  — manually release an on_hold transfer
router.post('/:id/release', (req, res) => {
  try {
    const t = releaseTransfer(req.params.id, req.merchantId);
    res.json(t);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// POST /v1/transfers/:id/reversals
router.post('/:id/reversals', (req, res) => {
  try {
    const reversal = createReversal(req.params.id, req.merchantId, req.body);
    res.status(201).json(reversal);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'reversal_creation' });
  }
});

// GET /v1/transfers/:id/reversals
router.get('/:id/reversals', (req, res) => {
  const reversals = listReversals(req.params.id, req.merchantId);
  if (reversals === null) return apiError(res, 404, 'Transfer not found');
  res.json({ count: reversals.length, items: reversals });
});

// GET /v1/transfers/:id/reversals/:rev_id
router.get('/:id/reversals/:rev_id', (req, res) => {
  const rev = getReversal(req.params.rev_id);
  if (!rev) return apiError(res, 404, 'Reversal not found');
  if (rev.transfer_id !== req.params.id) return apiError(res, 404, 'Reversal not found');
  if (rev.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(rev);
});

module.exports = router;
