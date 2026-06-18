'use strict';
// Integration test: subscription billing engine fires payment.captured.
//
// The billing cycle is a background job that's guarded by require.main === module
// in app.js, so it never runs automatically in tests. We import and call
// runBillingCycle() directly, seeding the DB with a past-due subscription
// so there's guaranteed work to do.
process.env.DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant } = require('../helpers/server');

let server, base, merchant;

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base);
});

after(() => stopServer(server));

test('successful subscription charge queues both payment.captured and subscription.charged', async () => {
  const { getDb } = require('../../src/db/database');
  const { runBillingCycle } = require('../../src/subscriptions/billing');
  const { randomUUID } = require('crypto');
  const db = getDb();

  const now = Math.floor(Date.now() / 1000);

  // Insert a customer (required FK on subscriptions)
  const custId = 'cust_' + randomUUID().replace(/-/g, '').slice(0, 14);
  db.prepare(`
    INSERT INTO customers (id, merchant_id, name, email, created_at)
    VALUES (?,?,?,?,?)
  `).run(custId, merchant.merchant_id, 'Billing Test User', `billing_${Date.now()}@example.com`, now);

  // Insert a plan
  const planId = 'plan_' + randomUUID().replace(/-/g, '').slice(0, 16);
  db.prepare(`
    INSERT INTO plans (id, merchant_id, name, interval, interval_count, amount, currency, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(planId, merchant.merchant_id, 'Monthly Test', 'monthly', 1, 9900, 'INR', now);

  // Insert a subscription that is overdue (charge_at in the past)
  const subId = 'sub_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const pastDue = now - 3600;
  db.prepare(`
    INSERT INTO subscriptions
      (id, plan_id, merchant_id, customer_id, status, current_cycle, paid_count, charge_at, start_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(subId, planId, merchant.merchant_id, custId, 'active', 0, 0, pastDue, pastDue, now);

  // Run the billing engine — Math.random() makes success non-deterministic,
  // so retry until we get at least one successful charge (max 10 runs).
  let attempts = 0;
  let capturedEvents;
  do {
    try { await runBillingCycle(); } catch (e) { throw new Error(`runBillingCycle failed: ${e.message}\n${e.stack}`); }
    capturedEvents = db.prepare(
      "SELECT * FROM webhook_events WHERE merchant_id=? AND event='payment.captured'"
    ).all(merchant.merchant_id);

    if (capturedEvents.length > 0) break;

    // Billing failed — reset to allow another attempt
    db.prepare("UPDATE subscriptions SET charge_at=? WHERE id=?").run(pastDue, subId);
    db.prepare("UPDATE subscription_invoices SET status='pending', next_retry_at=? WHERE subscription_id=?")
      .run(pastDue, subId);
    attempts++;
  } while (attempts < 10);

  assert.ok(capturedEvents.length > 0, 'payment.captured webhook should be queued after a successful subscription charge');

  // Verify the payload carries the subscription context
  const payload = JSON.parse(capturedEvents[0].payload);
  assert.equal(payload.event, 'payment.captured');
  assert.ok(payload.subscription_id, 'payload should include subscription_id');
  assert.ok(payload.invoice_id, 'payload should include invoice_id');
  assert.equal(payload.source, 'subscription');
  assert.equal(payload.currency, 'INR');

  // subscription.charged (or subscription.completed) must also be queued
  const subEvents = db.prepare(
    "SELECT * FROM webhook_events WHERE merchant_id=? AND event IN ('subscription.charged','subscription.completed')"
  ).all(merchant.merchant_id);
  assert.ok(subEvents.length > 0, 'subscription.charged or subscription.completed should also be queued');
});
