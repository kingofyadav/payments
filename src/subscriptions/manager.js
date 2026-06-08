const { randomUUID } = require('crypto');
const { getDb }  = require('../db/database');
const { getPlan } = require('./plans');

// Retry delays in seconds: day 1, day 3, day 7
const RETRY_DELAYS = [86400, 3 * 86400, 7 * 86400];

function nextChargeAt(fromUnix, interval, intervalCount) {
  const d = new Date(fromUnix * 1000);
  switch (interval) {
    case 'daily':   d.setDate(d.getDate() + intervalCount); break;
    case 'weekly':  d.setDate(d.getDate() + 7 * intervalCount); break;
    case 'monthly': d.setMonth(d.getMonth() + intervalCount); break;
    case 'yearly':  d.setFullYear(d.getFullYear() + intervalCount); break;
  }
  return Math.floor(d.getTime() / 1000);
}

function upsertCustomer(merchantId, { name, email, phone }) {
  const db = getDb();
  const normalizedEmail = email && email.trim() ? email.trim().toLowerCase() : null;
  if (normalizedEmail) {
    const existing = db.prepare('SELECT * FROM customers WHERE merchant_id=? AND email=?').get(merchantId, normalizedEmail);
    if (existing) return existing;
  }
  const id = 'cust_' + randomUUID().replace(/-/g, '').slice(0, 16);
  db.prepare('INSERT INTO customers (id, merchant_id, name, email, phone) VALUES (?,?,?,?,?)')
    .run(id, merchantId, name ?? null, normalizedEmail, phone ?? null);
  return db.prepare('SELECT * FROM customers WHERE id=?').get(id);
}

function createSubscription(merchantId, opts) {
  const {
    plan_id, customer, mandate_type = 'upi_autopay',
    total_count, start_at, notes,
  } = opts;

  const plan = getPlan(plan_id);
  if (!plan) throw new Error('Plan not found');
  if (plan.merchant_id !== merchantId) throw new Error('Plan does not belong to this merchant');
  if (plan.status !== 'active') throw new Error('Plan is archived');

  const cust   = upsertCustomer(merchantId, customer || {});
  const now    = Math.floor(Date.now() / 1000);
  const startTs = start_at ?? now;

  // Trial period pushes the first charge date forward
  const trialDays = plan.trial_period_days ?? 0;
  const firstCharge = trialDays > 0
    ? startTs + trialDays * 86400
    : startTs;

  const db = getDb();
  const id = 'sub_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const effectiveTotal = total_count ?? plan.total_count ?? null;

  db.prepare(`
    INSERT INTO subscriptions
      (id, merchant_id, plan_id, customer_id, status, mandate_type,
       total_count, start_at, charge_at, trial_end_at, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, merchantId, plan_id, cust.id,
    'authenticated',           // Phase 4: auto-authenticate (mandate simulated)
    mandate_type,
    effectiveTotal, startTs,
    firstCharge,
    trialDays > 0 ? firstCharge : null,
    notes ? JSON.stringify(notes) : null
  );

  return getSubscription(id);
}

function getSubscription(id) {
  return getDb().prepare(`
    SELECT s.*, p.name AS plan_name, p.amount AS plan_amount,
           p.interval, p.interval_count,
           c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    JOIN customers c ON s.customer_id = c.id
    WHERE s.id = ?
  `).get(id);
}

function listSubscriptions(merchantId, { status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE s.merchant_id=?';
  const params = [merchantId];
  if (status) { where += ' AND s.status=?'; params.push(status); }
  const { count } = db.prepare(
    `SELECT COUNT(*) AS count FROM subscriptions s ${where}`
  ).get(...params);
  const items = db.prepare(
    `SELECT s.*, p.name AS plan_name, p.amount AS plan_amount, p.interval,
     c.name AS customer_name, c.email AS customer_email
     FROM subscriptions s JOIN plans p ON s.plan_id=p.id JOIN customers c ON s.customer_id=c.id
     ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  return { total: count, items };
}

function cancelSubscription(id, merchantId) {
  const db  = getDb();
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!sub) return null;
  if (['cancelled', 'completed'].includes(sub.status)) throw new Error(`Subscription is already ${sub.status}`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE subscriptions SET status='cancelled', cancelled_at=?, charge_at=NULL WHERE id=?").run(now, id);
  return getSubscription(id);
}

function pauseSubscription(id, merchantId) {
  const db  = getDb();
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!sub) return null;
  if (!['active', 'authenticated'].includes(sub.status))
    throw new Error(`Only active or authenticated subscriptions can be paused (current: ${sub.status})`);
  db.prepare("UPDATE subscriptions SET status='paused' WHERE id=?").run(id);
  return getSubscription(id);
}

function resumeSubscription(id, merchantId) {
  const db  = getDb();
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!sub) return null;
  if (sub.status !== 'paused') throw new Error('Only paused subscriptions can be resumed');
  const now = Math.floor(Date.now() / 1000);
  // If charge_at fell into the past while paused, reset to now so the next
  // billing run charges once — not retroactively for every missed cycle.
  const chargeAt = (sub.charge_at && sub.charge_at < now) ? now : sub.charge_at;
  db.prepare("UPDATE subscriptions SET status='active', charge_at=? WHERE id=?").run(chargeAt, id);
  return getSubscription(id);
}

function getInvoices(subscriptionId) {
  return getDb().prepare(
    'SELECT * FROM subscription_invoices WHERE subscription_id=? ORDER BY cycle_number ASC'
  ).all(subscriptionId);
}

module.exports = {
  createSubscription, getSubscription, listSubscriptions,
  cancelSubscription, pauseSubscription, resumeSubscription,
  getInvoices, upsertCustomer, nextChargeAt, RETRY_DELAYS,
};
