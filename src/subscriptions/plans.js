const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const VALID_INTERVALS = ['daily', 'weekly', 'monthly', 'yearly'];

function createPlan(merchantId, opts) {
  const {
    name, description, amount, currency = 'INR',
    interval, interval_count = 1, total_count,
    trial_period_days = 0,
  } = opts;

  if (!name)   throw new Error('name is required');
  if (!amount || !Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer in paise');
  if (currency !== 'INR') throw new Error('Only INR is supported');
  if (!VALID_INTERVALS.includes(interval)) throw new Error(`interval must be one of: ${VALID_INTERVALS.join(', ')}`);
  if (!Number.isInteger(interval_count) || interval_count < 1) throw new Error('interval_count must be a positive integer');
  if (total_count !== undefined && total_count !== null && total_count < 1) throw new Error('total_count must be at least 1');

  const db = getDb();
  const id = 'plan_' + randomUUID().replace(/-/g, '').slice(0, 16);

  db.prepare(`
    INSERT INTO plans (id, merchant_id, name, description, amount, currency, interval, interval_count, total_count, trial_period_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, merchantId, name, description ?? null, amount, currency, interval, interval_count, total_count ?? null, trial_period_days);

  return getPlan(id);
}

function getPlan(id) {
  return getDb().prepare('SELECT * FROM plans WHERE id=?').get(id);
}

function listPlans(merchantId, { status = 'active' } = {}) {
  return getDb().prepare(
    'SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id=p.id AND s.status IN (\'active\',\'authenticated\')) AS active_subscribers FROM plans p WHERE p.merchant_id=? AND p.status=? ORDER BY p.created_at DESC'
  ).all(merchantId, status);
}

function archivePlan(id, merchantId) {
  const db = getDb();
  const { active } = db.prepare(`
    SELECT COUNT(*) AS active FROM subscriptions
    WHERE plan_id=? AND status IN ('active','authenticated','paused')
  `).get(id);
  if (active > 0)
    throw new Error(`Cannot archive: ${active} subscriber(s) still on this plan. Cancel or migrate them first.`);
  const result = db.prepare("UPDATE plans SET status='archived' WHERE id=? AND merchant_id=?").run(id, merchantId);
  return result.changes > 0;
}

// Normalize any plan's amount to monthly equivalent (for MRR calculation)
function toMonthlyAmount(amount, interval, intervalCount) {
  const monthly = { daily: 30, weekly: 4.33, monthly: 1, yearly: 1 / 12 };
  return Math.round(amount * (monthly[interval] ?? 1) / intervalCount);
}

module.exports = { createPlan, getPlan, listPlans, archivePlan, toMonthlyAmount };
