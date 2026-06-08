const express = require('express');
const { getDb }      = require('../db/database');
const { listPayouts } = require('../payouts/engine');

const router = express.Router();

// GET /api/dashboard/payouts/overview
router.get('/overview', (req, res) => {
  const db  = getDb();
  const mid = req.merchantId;
  const now = Math.floor(Date.now() / 1000);
  const dayStart   = now - 86400;
  const monthStart = now - 30 * 86400;

  const today = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='processed' THEN amount END), 0)  AS paid_today,
      COUNT(CASE WHEN status IN ('queued','processing') THEN 1 END)    AS pending_count,
      COUNT(CASE WHEN status='failed' THEN 1 END)                      AS failed_today,
      COUNT(CASE WHEN status='processed' THEN 1 END)                   AS success_count,
      COUNT(*)                                                          AS total_count
    FROM payouts WHERE merchant_id=? AND created_at >= ?
  `).get(mid, dayStart);

  const successRate = today.total_count > 0
    ? ((today.success_count / today.total_count) * 100).toFixed(1)
    : '100.0';

  const pendingApproval = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM payouts WHERE merchant_id=? AND status='pending_approval'
  `).get(mid);

  const monthTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM payouts
    WHERE merchant_id=? AND status='processed' AND created_at >= ?
  `).get(mid, monthStart).total;

  // Nodal balance = captured payments - processed payouts
  const totalIn  = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE merchant_id=? AND status='captured'").get(mid).t;
  const totalOut = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payouts WHERE merchant_id=? AND status='processed'").get(mid).t;

  res.json({
    paid_today:       today.paid_today,
    pending_count:    today.pending_count,
    failed_today:     today.failed_today,
    success_rate:     parseFloat(successRate),
    pending_approval: { count: pendingApproval.count, amount: pendingApproval.amount },
    month_total:      monthTotal,
    nodal_balance:    Math.max(0, totalIn - totalOut),
  });
});

// GET /api/dashboard/payouts/list
router.get('/list', (req, res) => {
  const { status, contact_id, limit, offset } = req.query;
  res.json(listPayouts(req.merchantId, {
    status, contact_id,
    limit:  parseInt(limit)  || 20,
    offset: parseInt(offset) || 0,
  }));
});

// GET /api/dashboard/payouts/by-contact — top contacts by total paid
router.get('/by-contact', (req, res) => {
  const rows = getDb().prepare(`
    SELECT c.id, c.name, c.type, c.email,
      COUNT(p.id)                                                                AS total_payouts,
      COALESCE(SUM(CASE WHEN p.status='processed' THEN p.amount END), 0)        AS total_paid,
      COUNT(CASE WHEN p.status='failed' THEN 1 END)                             AS failed_payouts,
      MAX(p.created_at)                                                          AS last_payout_at
    FROM contacts c
    LEFT JOIN payouts p ON p.contact_id=c.id AND p.merchant_id=c.merchant_id
    WHERE c.merchant_id=?
    GROUP BY c.id ORDER BY total_paid DESC LIMIT 20
  `).all(req.merchantId);
  res.json({ items: rows });
});

// GET /api/dashboard/payouts/mode-breakdown
router.get('/mode-breakdown', (req, res) => {
  const rows = getDb().prepare(`
    SELECT mode,
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN status='processed' THEN amount END), 0) AS amount_processed,
      COUNT(CASE WHEN status='failed' THEN 1 END)                     AS failed
    FROM payouts WHERE merchant_id=? GROUP BY mode
  `).all(req.merchantId);
  res.json({ items: rows });
});

// GET /api/dashboard/payouts/chart — daily payout volume last 30 days
router.get('/chart', (req, res) => {
  const rows = getDb().prepare(`
    SELECT strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime') AS day,
      COALESCE(SUM(CASE WHEN status='processed' THEN amount END), 0) AS amount,
      COUNT(*) AS count
    FROM payouts
    WHERE merchant_id=? AND created_at >= strftime('%s','now','-30 days')
    GROUP BY day ORDER BY day ASC
  `).all(req.merchantId);
  res.json({ items: rows });
});

// POST /api/dashboard/payouts/create — session-authenticated payout creation
router.post('/create', (req, res) => {
  const { createPayout } = require('../payouts/engine');
  try { res.status(201).json(createPayout(req.merchantId, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/dashboard/payouts/:id/approve
router.post('/:id/approve', (req, res) => {
  const { approvePayout } = require('../payouts/engine');
  try { res.json(approvePayout(req.params.id, req.merchantId, 'dashboard')); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/dashboard/payouts/:id/cancel
router.post('/:id/cancel', (req, res) => {
  const { cancelPayout } = require('../payouts/engine');
  try { res.json(cancelPayout(req.params.id, req.merchantId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
