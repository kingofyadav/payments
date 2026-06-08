// Billing engine — runs on a fixed interval, charges due subscriptions
const { randomUUID } = require('crypto');
const { getDb }          = require('../db/database');
const { routePayment }   = require('../systems/routing');
const { queueWebhook }   = require('../systems/webhook');
const { createOrder, transitionOrder } = require('../systems/order');
const { nextChargeAt, RETRY_DELAYS } = require('./manager');

let isRunning = false; // prevent overlapping runs

async function runBillingCycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    await _processRetries();
    await _processNewCharges();
  } finally {
    isRunning = false;
  }
}

// Retry failed invoices whose next_retry_at has passed
async function _processRetries() {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  const pending = db.prepare(`
    SELECT si.*, s.plan_id, s.merchant_id, s.total_count, s.paid_count,
           s.current_cycle, s.charge_at,
           p.amount AS plan_amount, p.interval AS plan_interval, p.interval_count AS plan_interval_count
    FROM subscription_invoices si
    JOIN subscriptions s ON si.subscription_id = s.id
    JOIN plans p ON s.plan_id = p.id
    WHERE si.status = 'pending'
      AND si.next_retry_at IS NOT NULL
      AND si.next_retry_at <= ?
      AND s.status NOT IN ('cancelled','completed','paused')
    LIMIT 50
  `).all(now);

  for (const inv of pending) {
    await _attemptCharge(inv, true);
  }
}

// Find subscriptions whose charge_at has come due and create a new invoice
async function _processNewCharges() {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  const dueSubs = db.prepare(`
    SELECT s.*, p.amount AS plan_amount, p.interval AS plan_interval,
           p.interval_count AS plan_interval_count, p.total_count AS plan_total_count
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.status IN ('authenticated', 'active')
      AND s.charge_at IS NOT NULL
      AND s.charge_at <= ?
    LIMIT 50
  `).all(now);

  for (const sub of dueSubs) {
    const db  = getDb();
    const now = Math.floor(Date.now() / 1000);
    const cycle = (sub.current_cycle ?? 0) + 1;
    const invId = 'inv_' + randomUUID().replace(/-/g, '').slice(0, 16);

    // Atomically create the invoice and advance charge_at so a crash cannot
    // produce a second invoice for the same cycle on the next billing run.
    const nextCharge = nextChargeAt(now, sub.plan_interval, sub.plan_interval_count);
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO subscription_invoices
          (id, subscription_id, merchant_id, cycle_number, amount, due_at, next_retry_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(invId, sub.id, sub.merchant_id, cycle, sub.plan_amount, now, now);
      db.prepare('UPDATE subscriptions SET current_cycle=?, charge_at=? WHERE id=?')
        .run(cycle, nextCharge, sub.id);
    })();

    // Fetch the actual invoice (may have been created by a prior crashed run)
    const inv = db.prepare('SELECT * FROM subscription_invoices WHERE subscription_id=? AND cycle_number=?')
      .get(sub.id, cycle);
    if (!inv || inv.status !== 'pending') continue;

    await _attemptCharge({ ...sub, ...inv, retry_count: inv.retry_count ?? 0 }, false);
  }
}

async function _attemptCharge(inv, isRetry) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Simulate: 92% success rate, failure on retry still 85%
  const successRate = isRetry ? 0.85 : 0.92;
  const success = Math.random() < successRate;

  if (success) {
    const paymentId = 'pay_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const { processor } = routePayment({ method: 'upi' });

    const order = createOrder({ merchantId: inv.merchant_id, amount: inv.amount });
    transitionOrder(order.id, 'attempted');
    transitionOrder(order.id, 'paid');

    const newPaidCount    = (inv.paid_count ?? 0) + 1;
    const newCurrentCycle = inv.cycle_number;
    const effectiveTotal  = inv.total_count ?? inv.plan_total_count ?? null;
    const isComplete      = effectiveTotal && newPaidCount >= effectiveTotal;
    const newStatus       = isComplete ? 'completed' : 'active';

    // Wrap payment record + invoice update + subscription status in one transaction.
    // charge_at was already advanced during invoice creation; only null it for completed subs.
    db.transaction(() => {
      db.prepare(`
        INSERT INTO payments (id, order_id, merchant_id, amount, currency, method, status, processor, captured_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(paymentId, order.id, inv.merchant_id, inv.amount, 'INR',
          'upi', 'captured', processor, now);

      db.prepare(`
        UPDATE subscription_invoices SET status='paid', payment_id=?, paid_at=?, next_retry_at=NULL
        WHERE id=?
      `).run(paymentId, now, inv.id);

      if (isComplete) {
        db.prepare(`UPDATE subscriptions SET status='completed', paid_count=?, charge_at=NULL WHERE id=?`)
          .run(newPaidCount, inv.subscription_id);
      } else {
        db.prepare(`UPDATE subscriptions SET status='active', paid_count=? WHERE id=?`)
          .run(newPaidCount, inv.subscription_id);
      }
    })();

    queueWebhook({
      merchantId: inv.merchant_id,
      event: isComplete ? 'subscription.completed' : 'subscription.charged',
      payload: {
        event: isComplete ? 'subscription.completed' : 'subscription.charged',
        subscription_id: inv.subscription_id,
        invoice_id:      inv.id,
        payment_id:      paymentId,
        amount:          inv.amount,
        cycle:           newCurrentCycle,
        timestamp:       new Date().toISOString(),
      },
    });

  } else {
    // Charge failed — schedule retry or halt
    const retryCount  = (inv.retry_count ?? 0) + 1;
    const retryDelay  = RETRY_DELAYS[retryCount - 1];

    if (retryDelay) {
      db.prepare(`
        UPDATE subscription_invoices SET retry_count=?, next_retry_at=?
        WHERE id=?
      `).run(retryCount, now + retryDelay, inv.id);
    } else {
      // All retries exhausted — halt subscription
      db.prepare("UPDATE subscription_invoices SET status='failed', next_retry_at=NULL WHERE id=?")
        .run(inv.id);
      db.prepare("UPDATE subscriptions SET status='halted', charge_at=NULL WHERE id=?")
        .run(inv.subscription_id);

      queueWebhook({
        merchantId: inv.merchant_id,
        event: 'subscription.halted',
        payload: {
          event: 'subscription.halted',
          subscription_id: inv.subscription_id,
          invoice_id: inv.id,
          reason: 'All retry attempts exhausted',
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
}

module.exports = { runBillingCycle };
