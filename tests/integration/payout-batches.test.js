'use strict';
process.env.DB_PATH = ':memory:';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, post, get } = require('../helpers/server');

let server, base, merchant;

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base);
});

after(() => stopServer(server));

// ─── helpers ──────────────────────────────────────────────────────────────────

function vpaItem(i) {
  return { name: `Vendor ${i}`, vpa: `vendor${i}@upi`, amount: 5000 + i, purpose: 'vendor_payment' };
}

function bankItem(i) {
  return {
    name: `Employee ${i}`,
    account_number: `ACC${String(i).padStart(8, '0')}`,
    ifsc: 'HDFC0001234',
    amount: 2000 + i,
    purpose: 'salary',
  };
}

async function createBatch(items, name = 'Test Batch') {
  return post(base, '/v1/payout_batches', { name, items }, merchant.authHeader);
}

// ─── creation ─────────────────────────────────────────────────────────────────

describe('POST /v1/payout_batches', () => {
  test('creates a batch and returns draft status', async () => {
    const { body, status } = await createBatch([vpaItem(1), vpaItem(2)]);
    assert.equal(status, 201);
    assert.ok(body.id.startsWith('batch_'));
    assert.equal(body.status, 'draft');
    assert.equal(body.total_count, 2);
    assert.equal(body.items.length, 2);
  });

  test('rejects missing name', async () => {
    const { status } = await post(base, '/v1/payout_batches',
      { items: [vpaItem(1)] }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('rejects empty items array', async () => {
    const { status } = await createBatch([]);
    assert.equal(status, 400);
  });

  test('rejects batch larger than 1000 items', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => vpaItem(i));
    const { status } = await createBatch(items);
    assert.equal(status, 400);
  });
});

// ─── get / list ───────────────────────────────────────────────────────────────

describe('GET /v1/payout_batches', () => {
  test('lists batches with total count', async () => {
    await createBatch([vpaItem(10)], 'List Batch');
    const { body, status } = await get(base, '/v1/payout_batches', merchant.authHeader);
    assert.equal(status, 200);
    assert.ok(body.total >= 1);
    assert.ok(Array.isArray(body.items));
  });

  test('GET /v1/payout_batches/:id returns the batch', async () => {
    const { body: created } = await createBatch([vpaItem(20)], 'Get Batch');
    const { body, status } = await get(base, `/v1/payout_batches/${created.id}`, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(body.id, created.id);
    assert.equal(body.items.length, 1);
  });
});

// ─── processing ───────────────────────────────────────────────────────────────

describe('POST /v1/payout_batches/:id/process', () => {
  test('VPA batch processes successfully — all items queued', async () => {
    const { body: batch } = await createBatch([vpaItem(30), vpaItem(31)], 'VPA Batch');
    const { body, status } = await post(base,
      `/v1/payout_batches/${batch.id}/process`, {}, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(body.status, 'processing');
    assert.equal(body.success_count, 2);
    assert.equal(body.failed_count, 0);
    const queued = body.items.filter(i => i.status === 'queued');
    assert.equal(queued.length, 2);
  });

  test('cannot process a batch twice', async () => {
    const { body: batch } = await createBatch([vpaItem(40)], 'Once Batch');
    await post(base, `/v1/payout_batches/${batch.id}/process`, {}, merchant.authHeader);
    const { status } = await post(base,
      `/v1/payout_batches/${batch.id}/process`, {}, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('regression #7 — new bank account items fail without penny drop (no auto-verify)', async () => {
    const { body: batch } = await createBatch(
      [bankItem(50), bankItem(51)], 'Bank Batch'
    );
    const { body, status } = await post(base,
      `/v1/payout_batches/${batch.id}/process`, {}, merchant.authHeader);
    assert.equal(status, 200);
    // All bank account items should fail because verified=0 and no auto-verify
    assert.equal(body.failed_count, 2, 'unverified bank accounts must fail');
    assert.equal(body.success_count, 0);
    const failed = body.items.filter(i => i.status === 'failed');
    assert.equal(failed.length, 2);
    assert.match(failed[0].error, /penny.drop.verified/i);
  });

  test('mixed batch: VPA items succeed, bank items fail', async () => {
    const { body: batch } = await createBatch(
      [vpaItem(60), bankItem(61)], 'Mixed Batch'
    );
    const { body, status } = await post(base,
      `/v1/payout_batches/${batch.id}/process`, {}, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(body.success_count, 1, 'VPA item should succeed');
    assert.equal(body.failed_count, 1,  'bank item should fail without penny drop');
  });

  test('batch item with zero amount is rejected', async () => {
    const { body: batch } = await createBatch(
      [{ name: 'Zero', vpa: 'zero@upi', amount: 0 }], 'Zero Batch'
    );
    const { body } = await post(base,
      `/v1/payout_batches/${batch.id}/process`, {}, merchant.authHeader);
    assert.equal(body.failed_count, 1);
    assert.match(body.items[0].error, /positive integer/i);
  });
});
