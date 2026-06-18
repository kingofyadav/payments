'use strict';
process.env.DB_PATH = ':memory:';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, get, post } = require('../helpers/server');
const { ALL_EVENTS } = require('../../src/routes/webhook_endpoints');

let server, base, merchant;

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base);
});

after(() => stopServer(server));

// ─── GET /v1/developer/events ─────────────────────────────────────────────────

describe('GET /v1/developer/events', () => {
  test('returns the full ALL_EVENTS list', async () => {
    const { body, status } = await get(base, '/v1/developer/events', merchant.authHeader);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.events), 'response must have an events array');
    assert.deepEqual(body.events, ALL_EVENTS, 'events array must match ALL_EVENTS exactly');
  });

  test('includes all marketplace events', async () => {
    const { body } = await get(base, '/v1/developer/events', merchant.authHeader);
    const set = new Set(body.events);
    for (const e of ['transfer.created', 'transfer.processed', 'transfer.released', 'transfer.reversed',
                     'escrow.funded', 'escrow.released', 'escrow.refunded', 'escrow.disputed',
                     'linked_account.activated', 'linked_account.suspended']) {
      assert.ok(set.has(e), `missing marketplace event: ${e}`);
    }
  });

  test('includes subscription lifecycle events', async () => {
    const { body } = await get(base, '/v1/developer/events', merchant.authHeader);
    const set = new Set(body.events);
    for (const e of ['subscription.charged', 'subscription.completed',
                     'subscription.halted', 'subscription.cancelled', 'subscription.activated']) {
      assert.ok(set.has(e), `missing subscription event: ${e}`);
    }
  });

  test('requires authentication', async () => {
    const { status } = await get(base, '/v1/developer/events');
    assert.equal(status, 401);
  });
});

// ─── GET /v1/developer/stats ─────────────────────────────────────────────────

describe('GET /v1/developer/stats', () => {
  test('returns expected shape with p95_ms (not max)', async () => {
    const { body, status } = await get(base, '/v1/developer/stats', merchant.authHeader);
    assert.equal(status, 200);
    assert.ok(typeof body.api_calls.total          === 'number');
    assert.ok(typeof body.api_calls.error_rate_pct === 'number');
    assert.ok(typeof body.latency.avg_ms           === 'number');
    assert.ok(typeof body.latency.p95_ms           === 'number', 'p95_ms must be present');
    assert.ok(!('max_ms' in body.latency),          'old max_ms key must not appear');
    assert.ok(typeof body.webhooks.delivery_rate   === 'number');
  });

  test('p95_ms is 0 when no requests logged yet', async () => {
    const freshMerchant = await registerMerchant(base);
    const { body } = await get(base, '/v1/developer/stats', freshMerchant.authHeader);
    assert.equal(body.latency.p95_ms, 0);
    assert.equal(body.latency.avg_ms, 0);
  });
});

// ─── GET /v1/developer/logs ──────────────────────────────────────────────────

describe('GET /v1/developer/logs', () => {
  test('returns paginated request log', async () => {
    // Make a few API calls to generate log entries
    await get(base, '/v1/orders', merchant.authHeader);
    await get(base, '/v1/orders', merchant.authHeader);

    const { body, status } = await get(base, '/v1/developer/logs', merchant.authHeader);
    assert.equal(status, 200);
    assert.ok(typeof body.count === 'number');
    assert.ok(Array.isArray(body.items));
  });
});

// ─── POST /api/auth/login — email validation ──────────────────────────────────

describe('POST /api/auth/login — email validation', () => {
  test('rejects login with invalid email format', async () => {
    const { status, body } = await post(base, '/api/auth/login',
      { email: 'notanemail', password: 'password123' });
    assert.equal(status, 400);
    assert.match(body.error, /email/i);
  });

  test('rejects login with missing @', async () => {
    const { status } = await post(base, '/api/auth/login',
      { email: 'userexample.com', password: 'password123' });
    assert.equal(status, 400);
  });

  test('valid email format proceeds to credential check (returns 401 not 400)', async () => {
    const { status } = await post(base, '/api/auth/login',
      { email: 'nobody@example.com', password: 'password123' });
    assert.equal(status, 401, 'valid email format should pass validation and reach auth check');
  });
});
