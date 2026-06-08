'use strict';
const express = require('express');
const {
  createChargeback, submitEvidence, resolveChargeback,
  getChargebackRatio, listChargebacks, getChargeback,
} = require('../risk/chargebacks');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// POST /v1/chargebacks
router.post('/', (req, res) => {
  try {
    const cb = createChargeback(req.merchantId, req.body);
    res.status(201).json(cb);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'chargeback_creation' });
  }
});

// GET /v1/chargebacks
router.get('/', (req, res) => {
  const { status, limit, offset } = req.query;
  res.json(listChargebacks(req.merchantId, {
    status,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  }));
});

// GET /v1/chargebacks/ratio
router.get('/ratio', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  res.json(getChargebackRatio(req.merchantId, days));
});

// GET /v1/chargebacks/:id
router.get('/:id', (req, res) => {
  const cb = getChargeback(req.params.id);
  if (!cb) return apiError(res, 404, 'Chargeback not found');
  if (cb.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(cb);
});

// POST /v1/chargebacks/:id/evidence
router.post('/:id/evidence', (req, res) => {
  try {
    const cb = submitEvidence(req.params.id, req.merchantId, req.body);
    res.json(cb);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// POST /v1/chargebacks/:id/resolve
router.post('/:id/resolve', (req, res) => {
  try {
    const { outcome } = req.body;
    if (!outcome) return apiError(res, 400, 'outcome is required (won | lost | auto_reversed)');
    const cb = resolveChargeback(req.params.id, req.merchantId, outcome);
    res.json(cb);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

module.exports = router;
