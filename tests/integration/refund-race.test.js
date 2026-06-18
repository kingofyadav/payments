'use strict';
// Regression test for Bug #1: race condition allowing over-refunding.
//
// Without the db.transaction() fix, two concurrent refund requests could
// both read the same "already refunded" balance and both succeed, resulting
// in total refunds exceeding the payment amount.
//
// With the fix, SQLite's exclusive write lock inside a transaction ensures
// exactly one of the concurrent requests wins; the rest see the updated
// balance and fail gracefully.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, post } = require('../helpers/server');

let server, base, merchant;

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base);
});

after(() => stopServer(server));

test('concurrent full-amount refunds: only one succeeds', async () => {
  const AMOUNT = 10000; // ₹100

  // Create and capture a payment
  const { body: order } = await post(base, '/v1/orders', { amount: AMOUNT }, merchant.authHeader);
  const { body: payment } = await post(base, '/v1/payments', {
    order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
  }, merchant.authHeader);
  assert.equal(payment.status, 'captured');

  // Fire 5 simultaneous full-amount refund requests
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      post(base, `/v1/payments/${payment.id}/refund`, { amount: AMOUNT }, merchant.authHeader)
    )
  );

  const succeeded = results.filter(r => r.status === 201);
  const failed    = results.filter(r => r.status === 400);

  assert.equal(succeeded.length, 1, 'exactly one refund should succeed');
  assert.equal(failed.length, 4,    'the other four should be rejected');

  // Total amount refunded must not exceed the payment amount
  const totalRefunded = succeeded.reduce((sum, r) => sum + r.body.amount, 0);
  assert.equal(totalRefunded, AMOUNT, 'total refunded must equal the payment amount exactly');
});

test('concurrent partial refunds: total never exceeds payment amount', async () => {
  const AMOUNT = 9000; // ₹90 — not evenly divisible by 3 concurrent refunds

  const { body: order } = await post(base, '/v1/orders', { amount: AMOUNT }, merchant.authHeader);
  const { body: payment } = await post(base, '/v1/payments', {
    order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
  }, merchant.authHeader);

  // Send 3 concurrent refunds of ₹5000 each (total would be ₹15000 > ₹9000)
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      post(base, `/v1/payments/${payment.id}/refund`, { amount: 5000 }, merchant.authHeader)
    )
  );

  const succeeded = results.filter(r => r.status === 201);
  const totalRefunded = succeeded.reduce((sum, r) => sum + r.body.amount, 0);

  assert.ok(totalRefunded <= AMOUNT, `total refunded (${totalRefunded}) must not exceed payment amount (${AMOUNT})`);
});

test('sequential refunds to full amount mark payment as refunded', async () => {
  const { body: order } = await post(base, '/v1/orders', { amount: 6000 }, merchant.authHeader);
  const { body: payment } = await post(base, '/v1/payments', {
    order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
  }, merchant.authHeader);

  await post(base, `/v1/payments/${payment.id}/refund`, { amount: 3000 }, merchant.authHeader);
  await post(base, `/v1/payments/${payment.id}/refund`, { amount: 3000 }, merchant.authHeader);

  // Payment should now be marked as refunded
  const { getDb } = require('../../src/db/database');
  const p = getDb().prepare('SELECT status FROM payments WHERE id=?').get(payment.id);
  assert.equal(p.status, 'refunded');

  // No further refunds should be possible
  const { status } = await post(base, `/v1/payments/${payment.id}/refund`, { amount: 1 }, merchant.authHeader);
  assert.equal(status, 400);
});
