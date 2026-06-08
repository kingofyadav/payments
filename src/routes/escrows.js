'use strict';
const express = require('express');
const {
  fundEscrow, releaseEscrow, refundEscrow, disputeEscrow,
  getEscrow, listEscrows,
} = require('../marketplace/escrow');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// POST /v1/escrows
router.post('/', (req, res) => {
  try {
    const escrow = fundEscrow(req.merchantId, req.body);
    res.status(201).json(escrow);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'escrow_fund' });
  }
});

// GET /v1/escrows
router.get('/', (req, res) => {
  const { linked_account_id, status, limit, offset } = req.query;
  const result = listEscrows(req.merchantId, {
    linked_account_id,
    status,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  });
  res.json(result);
});

// GET /v1/escrows/:id
router.get('/:id', (req, res) => {
  const e = getEscrow(req.params.id);
  if (!e) return apiError(res, 404, 'Escrow not found');
  if (e.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(e);
});

// POST /v1/escrows/:id/release
router.post('/:id/release', (req, res) => {
  try {
    const e = releaseEscrow(req.params.id, req.merchantId);
    res.json(e);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// POST /v1/escrows/:id/refund
router.post('/:id/refund', (req, res) => {
  try {
    const e = refundEscrow(req.params.id, req.merchantId);
    res.json(e);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// POST /v1/escrows/:id/dispute
router.post('/:id/dispute', (req, res) => {
  try {
    const e = disputeEscrow(req.params.id, req.merchantId, req.body.reason);
    res.json(e);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

module.exports = router;
