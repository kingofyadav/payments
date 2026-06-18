'use strict';
process.env.DB_PATH = ':memory:';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, post, get } = require('../helpers/server');

let server, base, merchant;

// ─── helpers ─────────────────────────────────────────────────────────────────

async function createContact(base, auth, overrides = {}) {
  const { body, status } = await post(base, '/v1/contacts',
    { name: 'Vendor Co', type: 'vendor', ...overrides }, auth);
  assert.equal(status, 201, `createContact failed: ${JSON.stringify(body)}`);
  return body;
}

async function createVpaAccount(base, auth, contactId, vpa = 'vendor@upi') {
  const { body, status } = await post(base, '/v1/fund_accounts',
    { contact_id: contactId, account_type: 'vpa', vpa }, auth);
  assert.equal(status, 201, `createVpaAccount failed: ${JSON.stringify(body)}`);
  return body;
}

async function createBankAccount(base, auth, contactId) {
  const { body, status } = await post(base, '/v1/fund_accounts', {
    contact_id: contactId, account_type: 'bank_account',
    account_number: '9876543210', ifsc: 'HDFC0001234', account_holder: 'Vendor Co',
  }, auth);
  assert.equal(status, 201, `createBankAccount failed: ${JSON.stringify(body)}`);
  return body;
}

// ─── setup ───────────────────────────────────────────────────────────────────

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base);
});

after(() => stopServer(server));

// ─── contacts ─────────────────────────────────────────────────────────────────

describe('POST /v1/contacts', () => {
  test('creates a vendor contact', async () => {
    const { body, status } = await post(base, '/v1/contacts',
      { name: 'Test Vendor', type: 'vendor' }, merchant.authHeader);
    assert.equal(status, 201);
    assert.ok(body.id.startsWith('cont_'));
    assert.equal(body.name, 'Test Vendor');
    assert.equal(body.type, 'vendor');
  });

  test('rejects missing name', async () => {
    const { status } = await post(base, '/v1/contacts',
      { type: 'vendor' }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('rejects invalid type', async () => {
    const { status } = await post(base, '/v1/contacts',
      { name: 'X', type: 'ghost' }, merchant.authHeader);
    assert.equal(status, 400);
  });
});

// ─── fund accounts ────────────────────────────────────────────────────────────

describe('POST /v1/fund_accounts', () => {
  test('creates a VPA fund account', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const { body, status } = await post(base, '/v1/fund_accounts', {
      contact_id: contact.id, account_type: 'vpa', vpa: 'newvendor@upi',
    }, merchant.authHeader);
    assert.equal(status, 201);
    assert.equal(body.account_type, 'vpa');
    assert.equal(body.vpa, 'newvendor@upi');
  });

  test('creates a bank account fund account', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const { body, status } = await post(base, '/v1/fund_accounts', {
      contact_id: contact.id, account_type: 'bank_account',
      account_number: '1234567890', ifsc: 'ICIC0001234', account_holder: 'Test',
    }, merchant.authHeader);
    assert.equal(status, 201);
    assert.equal(body.account_type, 'bank_account');
    assert.equal(body.verified, 0);
  });

  test('rejects invalid IFSC format', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const { status } = await post(base, '/v1/fund_accounts', {
      contact_id: contact.id, account_type: 'bank_account',
      account_number: '111', ifsc: 'BADINPUT', account_holder: 'X',
    }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('rejects invalid VPA format', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const { status } = await post(base, '/v1/fund_accounts', {
      contact_id: contact.id, account_type: 'vpa', vpa: 'notavpa',
    }, merchant.authHeader);
    assert.equal(status, 400);
  });
});

// ─── penny drop ───────────────────────────────────────────────────────────────

describe('POST /v1/fund_accounts/:id/penny_drop', () => {
  test('bank account starts unverified and penny drop sets verified', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createBankAccount(base, merchant.authHeader, contact.id);
    assert.equal(fa.verified, 0, 'should start unverified');

    // 95% success rate — retry until it lands (max 20 attempts)
    let verified = false;
    for (let i = 0; i < 20; i++) {
      const { body } = await post(base, `/v1/fund_accounts/${fa.id}/penny_drop`,
        {}, merchant.authHeader);
      if (body.verified) { verified = true; break; }
    }
    assert.ok(verified, 'penny drop should succeed within 20 attempts');
  });

  test('rejects penny drop on VPA account', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'penny@upi');
    const { status } = await post(base, `/v1/fund_accounts/${fa.id}/penny_drop`,
      {}, merchant.authHeader);
    assert.equal(status, 400);
  });
});

// ─── payouts ──────────────────────────────────────────────────────────────────

describe('POST /v1/payouts', () => {
  test('creates a queued payout via VPA (no penny drop required)', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'queued@upi');
    const { body, status } = await post(base, '/v1/payouts', {
      fund_account_id: fa.id, amount: 50000, purpose: 'vendor_payment',
    }, merchant.authHeader);
    assert.equal(status, 201);
    assert.ok(body.id.startsWith('pout_'));
    assert.equal(body.status, 'queued');
    assert.equal(body.amount, 50000);
  });

  test('payout above approval threshold gets status pending_approval', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'big@upi');
    const { body, status } = await post(base, '/v1/payouts', {
      fund_account_id: fa.id, amount: 1_000_000, // ₹10,000 = APPROVAL_THRESHOLD
    }, merchant.authHeader);
    assert.equal(status, 201);
    assert.equal(body.status, 'pending_approval');
    assert.equal(body.requires_approval, 1);
  });

  test('approved payout transitions to queued', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'approve@upi');
    const { body: payout } = await post(base, '/v1/payouts', {
      fund_account_id: fa.id, amount: 2_000_000,
    }, merchant.authHeader);
    assert.equal(payout.status, 'pending_approval');

    const { body: approved, status } = await post(base,
      `/v1/payouts/${payout.id}/approve`, { approved_by: 'test_admin' }, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(approved.status, 'queued');
  });

  test('bank account payout without penny drop is rejected', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createBankAccount(base, merchant.authHeader, contact.id);
    assert.equal(fa.verified, 0);
    const { status, body } = await post(base, '/v1/payouts', {
      fund_account_id: fa.id, amount: 10000,
    }, merchant.authHeader);
    assert.equal(status, 400);
    assert.match(body.error, /penny.drop.verified/i);
  });

  test('rejects missing fund_account_id', async () => {
    const { status } = await post(base, '/v1/payouts',
      { amount: 5000 }, merchant.authHeader);
    assert.equal(status, 400);
  });

  test('rejects non-integer amount', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'bad@upi');
    const { status } = await post(base, '/v1/payouts',
      { fund_account_id: fa.id, amount: 99.5 }, merchant.authHeader);
    assert.equal(status, 400);
  });
});

// ─── list / get ───────────────────────────────────────────────────────────────

describe('GET /v1/payouts', () => {
  test('lists payouts with total count', async () => {
    const { body, status } = await get(base, '/v1/payouts', merchant.authHeader);
    assert.equal(status, 200);
    assert.ok(typeof body.total === 'number');
    assert.ok(Array.isArray(body.items));
  });

  test('limit is capped at 100', async () => {
    const { body } = await get(base, '/v1/payouts?limit=9999', merchant.authHeader);
    assert.ok(body.items.length <= 100, 'items must never exceed cap of 100');
  });

  test('GET /v1/payouts/:id returns the payout', async () => {
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'get@upi');
    const { body: created } = await post(base, '/v1/payouts',
      { fund_account_id: fa.id, amount: 1000 }, merchant.authHeader);

    const { body, status } = await get(base, `/v1/payouts/${created.id}`, merchant.authHeader);
    assert.equal(status, 200);
    assert.equal(body.id, created.id);
    assert.equal(body.amount, 1000);
  });

  test('GET /v1/payouts/:id returns 403 for another merchant', async () => {
    const other = await registerMerchant(base);
    const contact = await createContact(base, merchant.authHeader);
    const fa      = await createVpaAccount(base, merchant.authHeader, contact.id, 'owned@upi');
    const { body: payout } = await post(base, '/v1/payouts',
      { fund_account_id: fa.id, amount: 500 }, merchant.authHeader);

    const { status } = await get(base, `/v1/payouts/${payout.id}`, other.authHeader);
    assert.equal(status, 403);
  });
});
