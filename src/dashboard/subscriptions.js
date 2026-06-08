const express = require('express');
const { getDb } = require('../db/database');
const { toMonthlyAmount } = require('../subscriptions/plans');

const router = express.Router();

// GET /api/dashboard/subscriptions/overview — MRR, ARR, churn, active count
router.get('/overview', (req, res) => {
  const db  = getDb();
  const mid = req.merchantId;
  const now = Math.floor(Date.now() / 1000);
  const monthAgo = now - 30 * 86400;

  // Active subscriptions with plan details (for MRR)
  const activeSubs = db.prepare(`
    SELECT s.*, p.amount, p.interval, p.interval_count
    FROM subscriptions s JOIN plans p ON s.plan_id = p.id
    WHERE s.merchant_id = ? AND s.status = 'active'
  `).all(mid);

  const mrr = activeSubs.reduce((sum, s) =>
    sum + toMonthlyAmount(s.amount, s.interval, s.interval_count), 0);

  // New subscriptions in last 30 days
  const newThisMonth = db.prepare(`
    SELECT COUNT(*) AS count FROM subscriptions
    WHERE merchant_id=? AND created_at >= ?
  `).get(mid, monthAgo).count;

  // Cancelled in last 30 days (churn)
  const cancelledThisMonth = db.prepare(`
    SELECT COUNT(*) AS count FROM subscriptions
    WHERE merchant_id=? AND status='cancelled' AND cancelled_at >= ?
  `).get(mid, monthAgo).count;

  // Total active at start of period (approximation)
  const activeStart = db.prepare(`
    SELECT COUNT(*) AS count FROM subscriptions
    WHERE merchant_id=? AND status='active' AND created_at < ?
  `).get(mid, monthAgo).count;

  const churnRate = activeStart > 0
    ? ((cancelledThisMonth / activeStart) * 100).toFixed(1)
    : '0.0';

  // Status breakdown
  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) AS count FROM subscriptions
    WHERE merchant_id=? GROUP BY status
  `).all(mid);

  // Revenue from subscriptions last 30 days
  const subRevenue = db.prepare(`
    SELECT COALESCE(SUM(si.amount), 0) AS total
    FROM subscription_invoices si
    WHERE si.merchant_id=? AND si.status='paid' AND si.paid_at >= ?
  `).get(mid, monthAgo).total;

  // MRR movement — new vs churned
  const newMRR = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS total
    FROM subscriptions s JOIN plans p ON s.plan_id=p.id
    WHERE s.merchant_id=? AND s.created_at >= ? AND s.status='active'
  `).get(mid, monthAgo).total;

  res.json({
    mrr,
    arr:                Math.round(mrr * 12),
    active_count:       activeSubs.length,
    new_this_month:     newThisMonth,
    cancelled_this_month: cancelledThisMonth,
    churn_rate:         parseFloat(churnRate),
    sub_revenue_30d:    subRevenue,
    new_mrr:            newMRR,
    status_breakdown:   statusBreakdown,
  });
});

// GET /api/dashboard/subscriptions/plans — plans with subscriber counts
router.get('/plans', (req, res) => {
  const items = getDb().prepare(`
    SELECT p.*,
      COUNT(CASE WHEN s.status='active' THEN 1 END) AS active_subscribers,
      COUNT(s.id) AS total_subscribers,
      COALESCE(SUM(CASE WHEN s.status='active' THEN p.amount END), 0) AS monthly_revenue
    FROM plans p
    LEFT JOIN subscriptions s ON s.plan_id=p.id AND s.merchant_id=p.merchant_id
    WHERE p.merchant_id=?
    GROUP BY p.id ORDER BY active_subscribers DESC
  `).all(req.merchantId);
  res.json({ items });
});

// GET /api/dashboard/subscriptions/list — paginated subscription list
router.get('/list', (req, res) => {
  const db     = getDb();
  const mid    = req.merchantId;
  const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;

  let where = 'WHERE s.merchant_id=?';
  const params = [mid];
  if (status) { where += ' AND s.status=?'; params.push(status); }

  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM subscriptions s ${where}`).get(...params);
  const items = db.prepare(`
    SELECT s.*, p.name AS plan_name, p.amount AS plan_amount, p.interval,
           c.name AS customer_name, c.email AS customer_email
    FROM subscriptions s
    JOIN plans p ON s.plan_id=p.id
    JOIN customers c ON s.customer_id=c.id
    ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total: count, items });
});

// GET /api/dashboard/subscriptions/mrr-chart — MRR over last 12 months
router.get('/mrr-chart', (req, res) => {
  const db  = getDb();
  const mid = req.merchantId;

  // Get paid invoices grouped by month for the last 12 months
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', paid_at, 'unixepoch', 'localtime') AS month,
           SUM(amount) AS revenue,
           COUNT(*) AS invoices
    FROM subscription_invoices
    WHERE merchant_id=? AND status='paid'
      AND paid_at >= strftime('%s','now','-12 months')
    GROUP BY month ORDER BY month ASC
  `).all(mid);

  res.json({ items: rows });
});

module.exports = router;
