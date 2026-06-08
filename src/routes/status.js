'use strict';
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

// GET /status  — public, no auth
router.get('/', (req, res) => {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  const win = now - 300; // last 5 minutes

  const subsystems = {};

  // Payment API — check recent error rate
  try {
    const { total, errors } = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS errors
      FROM api_request_logs WHERE created_at >= ?
    `).get(win);
    const errRate = total > 0 ? (errors / total) * 100 : 0;
    subsystems.payment_api = errRate > 10
      ? { status: 'degraded', error_rate_pct: errRate.toFixed(1) }
      : { status: 'operational' };
  } catch {
    subsystems.payment_api = { status: 'operational' };
  }

  // Webhook delivery — check recent delivery rate
  try {
    const { total, delivered } = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered
      FROM webhook_events WHERE created_at >= ?
    `).get(win);
    const rate = total > 0 ? (delivered / total) * 100 : 100;
    subsystems.webhook_delivery = rate < 80
      ? { status: 'degraded', delivery_rate_pct: rate.toFixed(1) }
      : { status: 'operational' };
  } catch {
    subsystems.webhook_delivery = { status: 'operational' };
  }

  // Settlement engine — just check DB is up
  try {
    db.prepare('SELECT 1').get();
    subsystems.settlement_engine = { status: 'operational' };
  } catch {
    subsystems.settlement_engine = { status: 'outage' };
  }

  // Payout API
  try {
    const { failed } = db.prepare(`
      SELECT COUNT(*) AS failed FROM payouts WHERE status='failed' AND created_at >= ?
    `).get(win);
    subsystems.payout_api = failed > 20
      ? { status: 'degraded', recent_failures: failed }
      : { status: 'operational' };
  } catch {
    subsystems.payout_api = { status: 'operational' };
  }

  subsystems.merchant_dashboard = { status: 'operational' };

  const allOk    = Object.values(subsystems).every(s => s.status === 'operational');
  const anyOutage = Object.values(subsystems).some(s => s.status === 'outage');
  const overall  = anyOutage ? 'major_outage' : allOk ? 'all_systems_operational' : 'partial_outage';

  res.json({
    status:     overall,
    updated_at: new Date().toISOString(),
    subsystems,
  });
});

module.exports = router;
