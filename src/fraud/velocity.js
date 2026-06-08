'use strict';
const { getDb } = require('../db/database');

// Each rule returns null (no hit) or { score, action, detail }
const VELOCITY_RULES = [
  {
    name: 'card_bin_failures_10min',
    description: '3+ failed attempts same card BIN in 10 minutes',
    check(db, ctx) {
      if (!ctx.card_bin) return null;
      const { count } = db.prepare(`
        SELECT COUNT(*) AS count FROM fraud_events
        WHERE card_bin=? AND action='block' AND created_at >= ?
      `).get(ctx.card_bin, ctx.now - 600);
      if (count >= 3) return { score: 45, action: 'block', detail: { failed_attempts: count } };
      return null;
    },
  },
  {
    name: 'ip_volume_1hour',
    description: '10+ transactions from same IP in 1 hour',
    check(db, ctx) {
      if (!ctx.ip) return null;
      const { count } = db.prepare(
        "SELECT COUNT(*) AS count FROM fraud_events WHERE ip=? AND created_at >= ?"
      ).get(ctx.ip, ctx.now - 3600);
      if (count >= 10) return { score: 35, action: 'flag', detail: { ip_count: count } };
      return null;
    },
  },
  {
    name: 'amount_vs_merchant_avg',
    description: 'Amount is 5x or more the merchant average order value',
    check(db, ctx) {
      if (!ctx.amount) return null;
      const { avg } = db.prepare(`
        SELECT COALESCE(AVG(amount), 0) AS avg FROM payments
        WHERE merchant_id=? AND status='captured' AND created_at >= ?
      `).get(ctx.merchant_id, ctx.now - 86400 * 30);
      if (avg > 0 && ctx.amount > avg * 5) {
        return { score: 25, action: 'review', detail: { ratio: +(ctx.amount / avg).toFixed(2), avg_aov: Math.round(avg) } };
      }
      return null;
    },
  },
  {
    name: 'merchant_failure_spike',
    description: 'Merchant failure rate above 40% in last 24 hours (min 10 transactions)',
    check(db, ctx) {
      const { total, failed } = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
        FROM payments WHERE merchant_id=? AND created_at >= ?
      `).get(ctx.merchant_id, ctx.now - 86400);
      if (total >= 10) {
        const rate = failed / total;
        if (rate > 0.40) return { score: 30, action: 'flag', detail: { failure_rate_pct: +(rate * 100).toFixed(1) } };
      }
      return null;
    },
  },
  {
    name: 'late_night_high_value',
    description: 'Transaction above ₹50,000 between 1 AM and 5 AM',
    check(_, ctx) {
      const hour = new Date().getHours();
      if (hour >= 1 && hour <= 5 && ctx.amount > 5000000) {
        return { score: 20, action: 'flag', detail: { hour, amount: ctx.amount } };
      }
      return null;
    },
  },
];

function checkVelocity(ctx) {
  const db     = getDb();
  const now    = Math.floor(Date.now() / 1000);
  const full   = { ...ctx, now };
  const signals = [];
  let totalScore = 0;

  for (const rule of VELOCITY_RULES) {
    try {
      const hit = rule.check(db, full);
      if (hit) {
        signals.push({ rule: rule.name, description: rule.description, ...hit });
        totalScore += hit.score;
      }
    } catch { /* never crash the fraud check */ }
  }

  return { signals, score: Math.min(totalScore, 100) };
}

module.exports = { checkVelocity };
