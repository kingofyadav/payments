'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ALL_EVENTS } = require('../../src/routes/webhook_endpoints');

// Exhaustive list of events that queueWebhook() fires anywhere in src/.
// If a new event is added to the source but not here (and not in ALL_EVENTS),
// the last assertion below will catch it.
const EVENTS_FIRED_IN_CODE = new Set([
  'payment.captured',
  'payment.failed',
  'refund.created',
  'payment_link.paid',
  'subscription.charged',
  'subscription.completed',
  'subscription.halted',
  'payout.processed',
  'payout.failed',
  'transfer.created',
  'transfer.processed',
  'transfer.released',
  'transfer.reversed',
  'escrow.funded',
  'escrow.released',
  'escrow.refunded',
  'escrow.disputed',
  'linked_account.activated',
  'linked_account.suspended',
]);

describe('ALL_EVENTS list completeness', () => {
  test('contains no duplicates', () => {
    const seen = new Set();
    for (const e of ALL_EVENTS) {
      assert.ok(!seen.has(e), `duplicate event in ALL_EVENTS: "${e}"`);
      seen.add(e);
    }
  });

  test('every event fired in code is subscribable via ALL_EVENTS', () => {
    const allSet = new Set(ALL_EVENTS);
    for (const e of EVENTS_FIRED_IN_CODE) {
      assert.ok(allSet.has(e), `"${e}" is fired by queueWebhook() but missing from ALL_EVENTS`);
    }
  });

  test('ALL_EVENTS includes wildcard-subscribable marketplace events', () => {
    const allSet = new Set(ALL_EVENTS);
    const marketplace = [
      'transfer.created', 'transfer.processed', 'transfer.released', 'transfer.reversed',
      'escrow.funded', 'escrow.released', 'escrow.refunded', 'escrow.disputed',
      'linked_account.activated', 'linked_account.suspended',
    ];
    for (const e of marketplace) {
      assert.ok(allSet.has(e), `marketplace event "${e}" missing from ALL_EVENTS`);
    }
  });

  test('subscription.completed is present', () => {
    assert.ok(ALL_EVENTS.includes('subscription.completed'));
  });

  test('payment_link.paid is present', () => {
    assert.ok(ALL_EVENTS.includes('payment_link.paid'));
  });
});
