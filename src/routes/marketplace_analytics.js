'use strict';
const express = require('express');
const {
  getMarketplaceSummary, getGMVTrend, getTopSellers,
  getSellerHealth, getCommissionBreakdown,
} = require('../marketplace/analytics');
const { apiError } = require('../middleware/errors');

const router = express.Router();

// GET /v1/marketplace/analytics/summary
router.get('/summary', (req, res) => {
  try {
    res.json(getMarketplaceSummary(req.merchantId));
  } catch (err) {
    apiError(res, 500, err.message);
  }
});

// GET /v1/marketplace/analytics/gmv?days=30
router.get('/gmv', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    res.json({ days, data: getGMVTrend(req.merchantId, days) });
  } catch (err) {
    apiError(res, 500, err.message);
  }
});

// GET /v1/marketplace/analytics/top_sellers?limit=20
router.get('/top_sellers', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    res.json({ items: getTopSellers(req.merchantId, limit) });
  } catch (err) {
    apiError(res, 500, err.message);
  }
});

// GET /v1/marketplace/analytics/seller_health
router.get('/seller_health', (req, res) => {
  try {
    res.json({ items: getSellerHealth(req.merchantId) });
  } catch (err) {
    apiError(res, 500, err.message);
  }
});

// GET /v1/marketplace/analytics/commission_breakdown?days=30
router.get('/commission_breakdown', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    res.json({ days, data: getCommissionBreakdown(req.merchantId, days) });
  } catch (err) {
    apiError(res, 500, err.message);
  }
});

module.exports = router;
