'use strict';
const express = require('express');
const {
  createLinkedAccount, getLinkedAccount, listLinkedAccounts,
  updateLinkedAccount, activateLinkedAccount, suspendLinkedAccount,
} = require('../marketplace/accounts');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// POST /v1/linked_accounts
router.post('/', (req, res) => {
  try {
    const account = createLinkedAccount(req.merchantId, req.body);
    res.status(201).json(account);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'linked_account_creation' });
  }
});

// GET /v1/linked_accounts
router.get('/', (req, res) => {
  const { status, limit, offset } = req.query;
  const result = listLinkedAccounts(req.merchantId, {
    status,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  });
  res.json(result);
});

// GET /v1/linked_accounts/:id
router.get('/:id', (req, res) => {
  const la = getLinkedAccount(req.params.id);
  if (!la) return apiError(res, 404, 'Linked account not found');
  if (la.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(la);
});

// PATCH /v1/linked_accounts/:id
router.patch('/:id', (req, res) => {
  try {
    const la = updateLinkedAccount(req.params.id, req.merchantId, req.body);
    if (!la) return apiError(res, 404, 'Linked account not found');
    res.json(la);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// POST /v1/linked_accounts/:id/activate
router.post('/:id/activate', (req, res) => {
  try {
    const la = activateLinkedAccount(req.params.id, req.merchantId);
    if (!la) return apiError(res, 404, 'Linked account not found');
    res.json(la);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// POST /v1/linked_accounts/:id/suspend
router.post('/:id/suspend', (req, res) => {
  try {
    const la = suspendLinkedAccount(req.params.id, req.merchantId);
    if (!la) return apiError(res, 404, 'Linked account not found');
    res.json(la);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

module.exports = router;
