'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { assertOrderTransition, assertPaymentTransition } = require('../../src/systems/state-machine');

describe('Order state machine', () => {
  test('created → attempted is valid', () => {
    assert.doesNotThrow(() => assertOrderTransition('created', 'attempted'));
  });

  test('created → expired is valid', () => {
    assert.doesNotThrow(() => assertOrderTransition('created', 'expired'));
  });

  test('attempted → paid is valid', () => {
    assert.doesNotThrow(() => assertOrderTransition('attempted', 'paid'));
  });

  test('attempted → failed is valid', () => {
    assert.doesNotThrow(() => assertOrderTransition('attempted', 'failed'));
  });

  test('paid → anything throws', () => {
    assert.throws(() => assertOrderTransition('paid', 'created'), /Invalid order transition/);
    assert.throws(() => assertOrderTransition('paid', 'attempted'), /Invalid order transition/);
  });

  test('expired → anything throws', () => {
    assert.throws(() => assertOrderTransition('expired', 'attempted'), /Invalid order transition/);
    assert.throws(() => assertOrderTransition('expired', 'paid'), /Invalid order transition/);
  });

  test('created → paid (skip attempted) throws', () => {
    assert.throws(() => assertOrderTransition('created', 'paid'), /Invalid order transition/);
  });
});

describe('Payment state machine', () => {
  test('created → authorized is valid', () => {
    assert.doesNotThrow(() => assertPaymentTransition('created', 'authorized'));
  });

  test('created → failed is valid', () => {
    assert.doesNotThrow(() => assertPaymentTransition('created', 'failed'));
  });

  test('authorized → captured is valid', () => {
    assert.doesNotThrow(() => assertPaymentTransition('authorized', 'captured'));
  });

  test('captured → refunded is valid', () => {
    assert.doesNotThrow(() => assertPaymentTransition('captured', 'refunded'));
  });

  test('failed → anything throws', () => {
    assert.throws(() => assertPaymentTransition('failed', 'captured'), /Invalid payment transition/);
  });

  test('refunded → anything throws', () => {
    assert.throws(() => assertPaymentTransition('refunded', 'captured'), /Invalid payment transition/);
  });

  test('created → captured (skip authorized) throws', () => {
    assert.throws(() => assertPaymentTransition('created', 'captured'), /Invalid payment transition/);
  });
});
