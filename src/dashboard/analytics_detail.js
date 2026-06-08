const express = require('express');
const {
  getRevenueSummary, getRevenueTrend, getRevenueByMethod, getRevenueByHour,
  getPaymentSummary, getPaymentsByMethodBreakdown, getDailySuccessRates,
  getCustomerSummary, getTopCustomers, getMonthlyCohorts,
  getSubscriptionMetrics, getPayoutSummary, getBenchmarks,
} = require('../analytics/engine');

const router = express.Router();

// GET /api/dashboard/analytics/revenue?days=30
router.get('/revenue', (req, res) => {
  const mid  = req.merchantId;
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  res.json({
    summary: getRevenueSummary(mid),
    trend:   getRevenueTrend(mid, days),
    by_method: getRevenueByMethod(mid, days),
    by_hour:   getRevenueByHour(mid, days),
  });
});

// GET /api/dashboard/analytics/payments?days=30
router.get('/payments', (req, res) => {
  const mid  = req.merchantId;
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  res.json({
    summary:         getPaymentSummary(mid),
    by_method:       getPaymentsByMethodBreakdown(mid, days),
    daily_rates:     getDailySuccessRates(mid, days),
  });
});

// GET /api/dashboard/analytics/customers?months=12
router.get('/customers', (req, res) => {
  const mid    = req.merchantId;
  const months = Math.min(parseInt(req.query.months) || 12, 24);
  res.json({
    summary:  getCustomerSummary(mid),
    top:      getTopCustomers(mid, 20),
    cohorts:  getMonthlyCohorts(mid, months),
  });
});

// GET /api/dashboard/analytics/subscriptions
router.get('/subscriptions', (req, res) => {
  res.json(getSubscriptionMetrics(req.merchantId));
});

// GET /api/dashboard/analytics/payouts
router.get('/payouts', (req, res) => {
  res.json(getPayoutSummary(req.merchantId));
});

// GET /api/dashboard/analytics/benchmarks
router.get('/benchmarks', (req, res) => {
  const mid = req.merchantId;
  res.json({
    benchmarks:    getBenchmarks(mid),
    subscriptions: getSubscriptionMetrics(mid),
    payouts:       getPayoutSummary(mid),
  });
});

module.exports = router;
