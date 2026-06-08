'use strict';
const express = require('express');
const { getRBIMonthlyReport, getKYCStatus }  = require('../compliance/reporter');
const { listAMLAlerts, updateAMLAlert }      = require('../compliance/aml');
const { scoreMerchant, getMerchantRiskProfile, setKYCTier } = require('../risk/merchant_score');
const { getMerchantReserveBalance, listReserves } = require('../risk/rolling_reserve');
const { getChargebackRatio }                 = require('../risk/chargebacks');
const { apiError }                           = require('../middleware/errors');

const router = express.Router();

// ── Risk Profile ──────────────────────────────────────────────────────────────

router.get('/risk', (req, res) => {
  const profile = getMerchantRiskProfile(req.merchantId);
  if (!profile) {
    // Auto-create on first access
    return res.json(scoreMerchant(req.merchantId));
  }
  res.json(profile);
});

router.post('/risk/rescore', (req, res) => {
  res.json(scoreMerchant(req.merchantId));
});

// ── KYC ───────────────────────────────────────────────────────────────────────

router.get('/kyc', (req, res) => {
  res.json(getKYCStatus(req.merchantId));
});

router.post('/kyc/upgrade', (req, res) => {
  try {
    const { tier } = req.body;
    if (!tier) return apiError(res, 400, 'tier is required (tier1 | tier2 | tier3)');
    const profile = setKYCTier(req.merchantId, tier);
    res.json(profile);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// ── RBI Reporting ─────────────────────────────────────────────────────────────

router.get('/reports/rbi/:year/:month', (req, res) => {
  const year  = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  if (!year || month < 1 || month > 12)
    return apiError(res, 400, 'Invalid year or month (month must be 1–12)');
  try {
    res.json(getRBIMonthlyReport(req.merchantId, year, month));
  } catch (err) {
    apiError(res, 500, err.message);
  }
});

// ── AML Alerts ────────────────────────────────────────────────────────────────

router.get('/aml/alerts', (req, res) => {
  const { status, type, limit, offset } = req.query;
  res.json(listAMLAlerts(req.merchantId, {
    status,
    type,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  }));
});

router.patch('/aml/alerts/:id', (req, res) => {
  try {
    const alert = updateAMLAlert(req.params.id, req.merchantId, req.body);
    res.json(alert);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// ── Rolling Reserves ──────────────────────────────────────────────────────────

router.get('/reserves', (req, res) => {
  const { status, limit, offset } = req.query;
  const balance = getMerchantReserveBalance(req.merchantId);
  const list    = listReserves(req.merchantId, {
    status,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  });
  res.json({ balance, ...list });
});

// ── Compliance Dashboard (summary) ────────────────────────────────────────────

router.get('/dashboard', (req, res) => {
  const profile   = getMerchantRiskProfile(req.merchantId) ?? scoreMerchant(req.merchantId);
  const kyc       = getKYCStatus(req.merchantId);
  const cbRatio   = getChargebackRatio(req.merchantId, 30);
  const reserve   = getMerchantReserveBalance(req.merchantId);
  const { count: openAlerts } = listAMLAlerts(req.merchantId, { status: 'open', limit: 1 });

  res.json({
    risk:       { score: profile.risk_score, level: profile.risk_level, flags: profile.flags },
    kyc:        { tier: kyc.kyc_tier, transaction_limit: kyc.transaction_limit },
    chargebacks: {
      ratio_pct:       cbRatio.ratio_pct,
      risk_level:      cbRatio.risk_level,
      visa_vdmp_breach: cbRatio.visa_vdmp_breach,
    },
    reserves:   { held: reserve.held, reserve_pct: profile.reserve_pct },
    aml:        { open_alerts: openAlerts },
  });
});

module.exports = router;
