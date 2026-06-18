'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, post, get } = require('../helpers/server');

let server, base, merchant;

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base);
});

after(() => stopServer(server));

// ── Merchant registration ─────────────────────────────────────────────────────

test('POST /v1/merchants returns key_id and key_secret', async () => {
  const { body, status } = await post(base, '/v1/merchants', {
    name: 'Acme Corp', email: 'acme@example.com', password: 'securepass',
  });
  assert.equal(status, 201);
  assert.match(body.key_id, /^key_/);
  assert.ok(body.key_secret, 'key_secret should be present');
  assert.equal(body.note, 'Save key_secret now — it is shown once only');
});

test('POST /v1/merchants rejects duplicate email', async () => {
  await post(base, '/v1/merchants', { name: 'A', email: 'dup@example.com', password: 'pass1234' });
  const { status } = await post(base, '/v1/merchants', { name: 'B', email: 'dup@example.com', password: 'pass1234' });
  assert.equal(status, 409);
});

test('POST /v1/merchants rejects short password', async () => {
  const { status } = await post(base, '/v1/merchants', { name: 'X', email: 'x@example.com', password: 'short' });
  assert.equal(status, 400);
});

// ── Orders ────────────────────────────────────────────────────────────────────

describe('Orders', () => {
  test('POST /v1/orders creates an order', async () => {
    const { body, status } = await post(base, '/v1/orders', { amount: 50000, currency: 'INR' }, merchant.authHeader);
    assert.equal(status, 201);
    assert.match(body.id, /^order_/);
    assert.equal(body.amount, 50000);
    assert.equal(body.status, 'created');
    assert.equal(body.merchant_id, merchant.merchant_id);
  });

  test('POST /v1/orders rejects non-integer amount', async () => {
    const { status } = await post(base, '/v1/orders', { amount: 100.5 }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('GET /v1/orders/:id returns the order', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 10000 }, merchant.authHeader);
    const { body, status } = await get(base, `/v1/orders/${order.id}`, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(body.id, order.id);
    assert.equal(body.amount, 10000);
  });

  test('GET /v1/orders/:id returns 403 for another merchant\'s order', async () => {
    const other = await registerMerchant(base);
    const { body: order } = await post(base, '/v1/orders', { amount: 10000 }, merchant.authHeader);
    const { status } = await get(base, `/v1/orders/${order.id}`, other.authHeader);
    assert.equal(status, 403);
  });
});

// ── Payments ──────────────────────────────────────────────────────────────────

describe('Payments', () => {
  test('POST /v1/payments captures a UPI payment', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 50000 }, merchant.authHeader);
    const { body, status } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
    }, merchant.authHeader);
    assert.equal(status, 200);
    assert.match(body.id, /^pay_/);
    assert.equal(body.status, 'captured');
    assert.equal(body.amount, 50000);
    assert.equal(body.method, 'upi');
  });

  test('POST /v1/payments returns 402 on simulated failure', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 10000 }, merchant.authHeader);
    const { body, status } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi', simulate: 'failure',
    }, merchant.authHeader);
    assert.equal(status, 402);
    assert.equal(body.status, 'failed');
    assert.ok(body.failure_reason);
  });

  test('POST /v1/payments on a paid order returns 400', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 10000 }, merchant.authHeader);
    await post(base, '/v1/payments', { order_id: order.id, method: 'upi', upi_id: 'success@yourbank' }, merchant.authHeader);
    const { status } = await post(base, '/v1/payments', { order_id: order.id, method: 'upi' }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('GET /v1/payments/:id returns the payment', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 20000 }, merchant.authHeader);
    const { body: payment } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'card', card_number: '4111111111111111',
    }, merchant.authHeader);
    const { body, status } = await get(base, `/v1/payments/${payment.id}`, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(body.id, payment.id);
    assert.equal(body.status, 'captured');
  });

  // Regression: Bug #2 — expired order previously caused unhandled 500
  test('payment on expired order returns 400 not 500', async () => {
    const { getDb } = require('../../src/db/database');
    // Create an order and manually backdate its expiry
    const { body: order } = await post(base, '/v1/orders', { amount: 5000 }, merchant.authHeader);
    getDb().prepare('UPDATE orders SET expires_at = 1 WHERE id = ?').run(order.id);

    const { status, body } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi',
    }, merchant.authHeader);
    assert.equal(status, 400);
    assert.equal(body.error?.reason, 'order_expired');
  });

  test('payment on already-expired order returns 400 not 500 (Bug #2 regression)', async () => {
    const { getDb } = require('../../src/db/database');
    const { body: order } = await post(base, '/v1/orders', { amount: 5000 }, merchant.authHeader);
    getDb().prepare("UPDATE orders SET expires_at = 1, status = 'expired' WHERE id = ?").run(order.id);

    const { status, body } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi',
    }, merchant.authHeader);
    // Must be 400, not 500
    assert.equal(status, 400);
    assert.equal(body.error?.reason, 'order_expired');
  });
});

// ── Refunds ───────────────────────────────────────────────────────────────────

describe('Refunds', () => {
  test('POST /v1/payments/:id/refund refunds a captured payment', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 30000 }, merchant.authHeader);
    const { body: payment } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
    }, merchant.authHeader);

    const { body, status } = await post(base, `/v1/payments/${payment.id}/refund`, { amount: 30000 }, merchant.authHeader);
    assert.equal(status, 201);
    assert.match(body.id, /^rfnd_/);
    assert.equal(body.status, 'processed');
    assert.equal(body.amount, 30000);
  });

  test('partial refund leaves remaining balance refundable', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 10000 }, merchant.authHeader);
    const { body: payment } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
    }, merchant.authHeader);

    await post(base, `/v1/payments/${payment.id}/refund`, { amount: 4000 }, merchant.authHeader);
    const { body, status } = await post(base, `/v1/payments/${payment.id}/refund`, { amount: 6000 }, merchant.authHeader);
    assert.equal(status, 201);
    assert.equal(body.amount, 6000);
  });

  test('refund over payment amount returns 400', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 5000 }, merchant.authHeader);
    const { body: payment } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi', upi_id: 'success@yourbank',
    }, merchant.authHeader);
    const { status } = await post(base, `/v1/payments/${payment.id}/refund`, { amount: 6000 }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('refund on a failed payment returns 400', async () => {
    const { body: order } = await post(base, '/v1/orders', { amount: 5000 }, merchant.authHeader);
    const { body: payment } = await post(base, '/v1/payments', {
      order_id: order.id, method: 'upi', simulate: 'failure',
    }, merchant.authHeader);
    const { status } = await post(base, `/v1/payments/${payment.id}/refund`, {}, merchant.authHeader);
    assert.equal(status, 400);
  });
});

// ── Auth middleware ───────────────────────────────────────────────────────────

describe('API auth', () => {
  test('missing Authorization header returns 401', async () => {
    const { status } = await get(base, '/v1/orders');
    assert.equal(status, 401);
  });

  test('wrong key_secret returns 401', async () => {
    const badHeader = 'Basic ' + Buffer.from(`${merchant.key_id}:wrongsecret`).toString('base64');
    const { status } = await get(base, '/v1/orders', badHeader);
    assert.equal(status, 401);
  });
});
