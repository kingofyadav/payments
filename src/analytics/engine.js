const { getDb } = require('../db/database');

function unixDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function monthStart(monthsAgo = 0) {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - monthsAgo);
  return Math.floor(d.getTime() / 1000);
}

// ── Revenue ──────────────────────────────────────────────────────────────────

function getRevenueSummary(merchantId) {
  const db = getDb();
  const now  = Math.floor(Date.now() / 1000);
  const tod  = unixDaysAgo(0);
  const mtd  = monthStart(0);
  const lmS  = monthStart(1);
  const lmE  = mtd - 1;
  const ytdS = new Date(new Date().getFullYear(), 0, 1, 0, 0, 0, 0);
  const ytdStart = Math.floor(ytdS.getTime() / 1000);
  const d30  = unixDaysAgo(30);
  const d60  = unixDaysAgo(60);

  const row = (from, to = now) => db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0) AS revenue,
      COUNT(*)                                                       AS total,
      COUNT(CASE WHEN status='captured' THEN 1 END)                 AS captured
    FROM payments WHERE merchant_id=? AND created_at>=? AND created_at<=?
  `).get(merchantId, from, to);

  const today    = row(tod);
  const mtdRow   = row(mtd);
  const lmRow    = row(lmS, lmE);
  const ytd      = row(ytdStart);
  const last30   = row(d30);
  const prev30   = row(d60, d30 - 1);

  const growthMoM = lmRow.revenue > 0
    ? (((mtdRow.revenue - lmRow.revenue) / lmRow.revenue) * 100).toFixed(1)
    : null;
  const growth30d = prev30.revenue > 0
    ? (((last30.revenue - prev30.revenue) / prev30.revenue) * 100).toFixed(1)
    : null;

  return {
    today_revenue:   today.revenue,
    mtd_revenue:     mtdRow.revenue,
    last_month:      lmRow.revenue,
    ytd_revenue:     ytd.revenue,
    last_30d:        last30.revenue,
    prev_30d:        prev30.revenue,
    growth_mom:      growthMoM !== null ? parseFloat(growthMoM) : null,
    growth_30d:      growth30d !== null ? parseFloat(growth30d) : null,
    today_txns:      today.total,
    today_captured:  today.captured,
    today_rate:      today.total > 0 ? parseFloat(((today.captured / today.total) * 100).toFixed(1)) : 0,
  };
}

function getRevenueTrend(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days - 1);
  return db.prepare(`
    SELECT
      date(created_at, 'unixepoch', 'localtime') AS day,
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0) AS revenue,
      COUNT(*)                                                       AS total,
      COUNT(CASE WHEN status='captured' THEN 1 END)                 AS captured
    FROM payments
    WHERE merchant_id=? AND created_at>=?
    GROUP BY day ORDER BY day
  `).all(merchantId, from);
}

function getRevenueByMethod(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days);
  return db.prepare(`
    SELECT
      COALESCE(method, 'unknown') AS method,
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0)  AS revenue,
      COUNT(CASE WHEN status='captured' THEN 1 END)                  AS txns,
      COUNT(*)                                                        AS attempts
    FROM payments
    WHERE merchant_id=? AND created_at>=?
    GROUP BY method ORDER BY revenue DESC
  `).all(merchantId, from);
}

function getRevenueByHour(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days);
  return db.prepare(`
    SELECT
      CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0) AS revenue,
      COUNT(CASE WHEN status='captured' THEN 1 END)                 AS txns
    FROM payments
    WHERE merchant_id=? AND created_at>=?
    GROUP BY hour ORDER BY hour
  `).all(merchantId, from);
}

// ── Payments ─────────────────────────────────────────────────────────────────

function getPaymentSummary(merchantId) {
  const db   = getDb();
  const d30  = unixDaysAgo(30);

  const agg = db.prepare(`
    SELECT
      COUNT(*)                                                        AS total,
      COUNT(CASE WHEN status='captured' THEN 1 END)                  AS captured,
      COUNT(CASE WHEN status='failed'   THEN 1 END)                  AS failed,
      COUNT(CASE WHEN status='refunded' THEN 1 END)                  AS refunded,
      COALESCE(AVG(CASE WHEN status='captured' THEN amount END), 0)  AS avg_ticket,
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0)  AS total_revenue
    FROM payments WHERE merchant_id=? AND created_at>=?
  `).get(merchantId, d30);

  // p90 ticket (captured only)
  const captured = db.prepare(`
    SELECT amount FROM payments
    WHERE merchant_id=? AND status='captured' AND created_at>=?
    ORDER BY amount
  `).all(merchantId, d30).map(r => r.amount);

  const p90 = captured.length
    ? captured[Math.floor(captured.length * 0.9)]
    : 0;

  return {
    total:          agg.total,
    captured:       agg.captured,
    failed:         agg.failed,
    refunded:       agg.refunded,
    success_rate:   agg.total > 0 ? parseFloat(((agg.captured / agg.total) * 100).toFixed(1)) : 0,
    avg_ticket:     Math.round(agg.avg_ticket),
    p90_ticket:     p90,
    total_revenue:  agg.total_revenue,
  };
}

function getPaymentsByMethodBreakdown(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days);
  return db.prepare(`
    SELECT
      COALESCE(method, 'unknown')                                    AS method,
      COUNT(*)                                                       AS total,
      COUNT(CASE WHEN status='captured' THEN 1 END)                 AS captured,
      COUNT(CASE WHEN status='failed'   THEN 1 END)                 AS failed,
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0) AS revenue,
      COALESCE(AVG(CASE WHEN status='captured' THEN amount END), 0) AS avg_ticket
    FROM payments
    WHERE merchant_id=? AND created_at>=?
    GROUP BY method ORDER BY revenue DESC
  `).all(merchantId, from).map(r => ({
    ...r,
    success_rate: r.total > 0 ? parseFloat(((r.captured / r.total) * 100).toFixed(1)) : 0,
    avg_ticket:   Math.round(r.avg_ticket),
  }));
}

function getDailySuccessRates(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days - 1);
  return db.prepare(`
    SELECT
      date(created_at, 'unixepoch', 'localtime')       AS day,
      COUNT(*)                                          AS total,
      COUNT(CASE WHEN status='captured' THEN 1 END)    AS captured
    FROM payments
    WHERE merchant_id=? AND created_at>=?
    GROUP BY day ORDER BY day
  `).all(merchantId, from).map(r => ({
    day:          r.day,
    total:        r.total,
    captured:     r.captured,
    success_rate: r.total > 0 ? parseFloat(((r.captured / r.total) * 100).toFixed(1)) : 0,
  }));
}

// ── Customers ─────────────────────────────────────────────────────────────────

function getCustomerSummary(merchantId) {
  const db  = getDb();
  const mtd = monthStart(0);
  const lm  = monthStart(1);

  // Unique payers from payments table (email-based)
  const agg = db.prepare(`
    SELECT
      COUNT(DISTINCT o.customer_email)                              AS total_unique,
      COUNT(DISTINCT CASE WHEN p.created_at>=? THEN o.customer_email END) AS new_this_month,
      COUNT(DISTINCT CASE WHEN p.created_at>=? AND p.created_at<? THEN o.customer_email END) AS new_last_month
    FROM payments p
    JOIN orders o ON p.order_id = o.id
    WHERE p.merchant_id=? AND p.status='captured' AND o.customer_email IS NOT NULL
  `).get(mtd, lm, mtd, merchantId);

  // Avg LTV: total revenue / unique customers
  const ltv = db.prepare(`
    SELECT
      COALESCE(SUM(p.amount), 0)                     AS total,
      COUNT(DISTINCT o.customer_email)               AS unique_customers
    FROM payments p
    JOIN orders o ON p.order_id = o.id
    WHERE p.merchant_id=? AND p.status='captured' AND o.customer_email IS NOT NULL
  `).get(merchantId);

  // Repeat customers: those with >1 captured payment
  const repeat = db.prepare(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT o.customer_email
      FROM payments p JOIN orders o ON p.order_id=o.id
      WHERE p.merchant_id=? AND p.status='captured' AND o.customer_email IS NOT NULL
      GROUP BY o.customer_email HAVING COUNT(p.id) > 1
    )
  `).get(merchantId);

  const growthMoM = agg.new_last_month > 0
    ? parseFloat((((agg.new_this_month - agg.new_last_month) / agg.new_last_month) * 100).toFixed(1))
    : null;

  return {
    total_unique:      agg.total_unique,
    new_this_month:    agg.new_this_month,
    new_last_month:    agg.new_last_month,
    repeat_customers:  repeat.cnt,
    retention_rate:    agg.total_unique > 0
      ? parseFloat(((repeat.cnt / agg.total_unique) * 100).toFixed(1))
      : 0,
    avg_ltv:           ltv.unique_customers > 0
      ? Math.round(ltv.total / ltv.unique_customers)
      : 0,
    growth_mom:        growthMoM,
  };
}

function getTopCustomers(merchantId, limit = 20) {
  return getDb().prepare(`
    SELECT
      o.customer_email                                           AS email,
      o.customer_name                                            AS name,
      o.customer_phone                                           AS phone,
      COUNT(p.id)                                                AS payment_count,
      COALESCE(SUM(CASE WHEN p.status='captured' THEN p.amount END), 0) AS total_paid,
      MAX(p.created_at)                                          AS last_payment_at,
      COUNT(CASE WHEN p.created_at >= ? THEN 1 END)             AS payments_30d
    FROM payments p
    JOIN orders o ON p.order_id = o.id
    WHERE p.merchant_id=? AND o.customer_email IS NOT NULL
    GROUP BY o.customer_email
    ORDER BY total_paid DESC LIMIT ?
  `).all(unixDaysAgo(30), merchantId, limit);
}

function getMonthlyCohorts(merchantId, months = 12) {
  const db   = getDb();
  const from = monthStart(months - 1);
  return db.prepare(`
    SELECT
      strftime('%Y-%m', p.created_at, 'unixepoch', 'localtime') AS month,
      COUNT(DISTINCT o.customer_email)                            AS new_customers,
      COALESCE(SUM(p.amount), 0)                                 AS revenue,
      COUNT(p.id)                                                AS payments
    FROM payments p
    JOIN orders o ON p.order_id = o.id
    WHERE p.merchant_id=? AND p.status='captured'
      AND o.customer_email IS NOT NULL AND p.created_at>=?
    GROUP BY month ORDER BY month
  `).all(merchantId, from);
}

// ── Subscription Metrics ──────────────────────────────────────────────────────

function getSubscriptionMetrics(merchantId) {
  const db  = getDb();
  const { toMonthlyAmount } = require('../subscriptions/plans');

  // Active + authenticated count as "live" subscribers
  const subs = db.prepare(`
    SELECT s.status, p.amount AS plan_amount, p.interval, p.interval_count,
           s.paid_count, s.total_count
    FROM subscriptions s JOIN plans p ON s.plan_id=p.id
    WHERE s.merchant_id=?
  `).all(merchantId);

  let mrr = 0;
  let active = 0;
  let paused = 0;
  let halted = 0;
  let cancelled = 0;
  let completed = 0;

  for (const s of subs) {
    if (['active', 'authenticated'].includes(s.status)) {
      mrr += toMonthlyAmount(s.plan_amount, s.interval, s.interval_count);
      active++;
    } else if (s.status === 'paused')    paused++;
    else if (s.status === 'halted')      halted++;
    else if (s.status === 'cancelled')   cancelled++;
    else if (s.status === 'completed')   completed++;
  }

  // Churn: cancelled in last 30 days / (active + cancelled in last 30d)
  const d30 = unixDaysAgo(30);
  const { churned } = db.prepare(`
    SELECT COUNT(*) AS churned FROM subscriptions
    WHERE merchant_id=? AND status='cancelled' AND cancelled_at>=?
  `).get(merchantId, d30);

  const churnDenom = active + churned;
  const churnRate  = churnDenom > 0
    ? parseFloat(((churned / churnDenom) * 100).toFixed(1))
    : 0;

  // ARPU
  const arpu = active > 0 ? Math.round(mrr / active) : 0;

  // Total collected via subscriptions
  const { total_collected } = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total_collected
    FROM subscription_invoices WHERE merchant_id=? AND status='paid'
  `).get(merchantId);

  return {
    mrr, arr: mrr * 12, arpu,
    active_subs: active,
    paused_subs: paused,
    halted_subs: halted,
    cancelled_subs: cancelled,
    completed_subs: completed,
    total_subs: subs.length,
    churn_rate: churnRate,
    total_collected,
  };
}

// ── Payout Analytics ─────────────────────────────────────────────────────────

function getPayoutSummary(merchantId) {
  const db  = getDb();
  const d30 = unixDaysAgo(30);

  const agg = db.prepare(`
    SELECT
      COUNT(*)                                                     AS total,
      COUNT(CASE WHEN status='processed' THEN 1 END)              AS processed,
      COUNT(CASE WHEN status='failed'    THEN 1 END)              AS failed,
      COUNT(CASE WHEN status IN ('queued','processing') THEN 1 END) AS pending,
      COUNT(CASE WHEN status='pending_approval' THEN 1 END)       AS pending_approval,
      COALESCE(SUM(CASE WHEN status='processed' THEN amount END), 0) AS total_paid,
      COALESCE(AVG(CASE WHEN status='processed' THEN amount END), 0) AS avg_payout
    FROM payouts WHERE merchant_id=? AND created_at>=?
  `).get(merchantId, d30);

  // Average processing time (created_at → processed_at) in seconds
  const timing = db.prepare(`
    SELECT AVG(processed_at - created_at) AS avg_secs
    FROM payouts
    WHERE merchant_id=? AND status='processed' AND processed_at IS NOT NULL AND created_at>=?
  `).get(merchantId, d30);

  const modeBreak = db.prepare(`
    SELECT mode,
      COUNT(*)                                                      AS count,
      COALESCE(SUM(CASE WHEN status='processed' THEN amount END),0) AS amount,
      COUNT(CASE WHEN status='processed' THEN 1 END)               AS processed
    FROM payouts WHERE merchant_id=? AND created_at>=?
    GROUP BY mode ORDER BY amount DESC
  `).all(merchantId, d30);

  return {
    total:            agg.total,
    processed:        agg.processed,
    failed:           agg.failed,
    pending:          agg.pending,
    pending_approval: agg.pending_approval,
    total_paid:       agg.total_paid,
    avg_payout:       Math.round(agg.avg_payout),
    success_rate:     agg.total > 0
      ? parseFloat(((agg.processed / agg.total) * 100).toFixed(1))
      : 0,
    avg_processing_mins: timing.avg_secs
      ? parseFloat((timing.avg_secs / 60).toFixed(1))
      : null,
    mode_breakdown: modeBreak.map(m => ({
      ...m,
      success_rate: m.count > 0 ? parseFloat(((m.processed / m.count) * 100).toFixed(1)) : 0,
    })),
  };
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

function getBenchmarks(merchantId) {
  const db  = getDb();
  const d30 = unixDaysAgo(30);

  // Payment success rate
  const pay = db.prepare(`
    SELECT COUNT(*) AS total, COUNT(CASE WHEN status='captured' THEN 1 END) AS cap
    FROM payments WHERE merchant_id=? AND created_at>=?
  `).get(merchantId, d30);
  const successRate = pay.total > 0 ? parseFloat(((pay.cap / pay.total) * 100).toFixed(1)) : 0;

  // UPI adoption
  const upi = db.prepare(`
    SELECT COUNT(*) AS upi_count FROM payments
    WHERE merchant_id=? AND method='upi' AND status='captured' AND created_at>=?
  `).get(merchantId, d30);
  const upiAdoption = pay.cap > 0
    ? parseFloat(((upi.upi_count / pay.cap) * 100).toFixed(1))
    : 0;

  // Avg ticket size (captured, last 30d)
  const { avg_ticket } = db.prepare(`
    SELECT COALESCE(AVG(amount), 0) AS avg_ticket
    FROM payments WHERE merchant_id=? AND status='captured' AND created_at>=?
  `).get(merchantId, d30);

  // Repeat customer rate
  const custStats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN cnt > 1 THEN 1 ELSE 0 END) AS repeat_count
    FROM (
      SELECT o.customer_email, COUNT(p.id) AS cnt
      FROM payments p JOIN orders o ON p.order_id=o.id
      WHERE p.merchant_id=? AND p.status='captured' AND o.customer_email IS NOT NULL
      GROUP BY o.customer_email
    )
  `).get(merchantId);
  const repeatRate = custStats.total > 0
    ? parseFloat(((custStats.repeat_count / custStats.total) * 100).toFixed(1))
    : 0;

  // Payout SLA
  const sla = db.prepare(`
    SELECT AVG(processed_at - created_at) AS avg_secs
    FROM payouts WHERE merchant_id=? AND status='processed'
      AND processed_at IS NOT NULL AND created_at>=?
  `).get(merchantId, d30);

  // Industry benchmarks (Indian payment gateway standards)
  const INDUSTRY = {
    success_rate:   85,
    upi_adoption:   60,
    avg_ticket_inr: 85000,   // ₹850 in paise
    repeat_rate:    35,
    payout_sla_mins: 30,
  };

  return {
    merchant: {
      success_rate:    successRate,
      upi_adoption:    upiAdoption,
      avg_ticket:      Math.round(avg_ticket),
      repeat_rate:     repeatRate,
      payout_sla_mins: sla.avg_secs ? parseFloat((sla.avg_secs / 60).toFixed(1)) : null,
    },
    industry: INDUSTRY,
    scores: {
      success_rate:    Math.min(100, parseFloat(((successRate / INDUSTRY.success_rate) * 100).toFixed(1))),
      upi_adoption:    Math.min(100, parseFloat(((upiAdoption / INDUSTRY.upi_adoption) * 100).toFixed(1))),
      avg_ticket:      parseFloat(((Math.round(avg_ticket) / INDUSTRY.avg_ticket_inr) * 100).toFixed(1)),
      repeat_rate:     Math.min(100, parseFloat(((repeatRate / INDUSTRY.repeat_rate) * 100).toFixed(1))),
    },
  };
}

module.exports = {
  getRevenueSummary, getRevenueTrend, getRevenueByMethod, getRevenueByHour,
  getPaymentSummary, getPaymentsByMethodBreakdown, getDailySuccessRates,
  getCustomerSummary, getTopCustomers, getMonthlyCohorts,
  getSubscriptionMetrics, getPayoutSummary, getBenchmarks,
};
