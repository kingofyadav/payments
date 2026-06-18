'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeCommission } = require('../../src/marketplace/commission');

describe('computeCommission', () => {
  test('fixed_pct: 10% of 1000 paise', () => {
    const result = computeCommission(1000, { commission_type: 'fixed_pct', commission_pct: 10, commission_flat: 0 });
    assert.equal(result.commission, 100);
    assert.equal(result.net, 900);
    assert.equal(result.gross, 1000);
  });

  test('fixed_pct: 0% commission passes full amount through', () => {
    const result = computeCommission(5000, { commission_type: 'fixed_pct', commission_pct: 0, commission_flat: 0 });
    assert.equal(result.commission, 0);
    assert.equal(result.net, 5000);
  });

  test('flat_fee: ₹5 flat on ₹200', () => {
    const result = computeCommission(20000, { commission_type: 'flat_fee', commission_pct: 0, commission_flat: 500 });
    assert.equal(result.commission, 500);
    assert.equal(result.net, 19500);
  });

  test('hybrid: 5% + ₹10 flat on ₹1000', () => {
    const result = computeCommission(100000, { commission_type: 'hybrid', commission_pct: 5, commission_flat: 1000 });
    assert.equal(result.commission, 6000); // 5000 + 1000
    assert.equal(result.net, 94000);
  });

  test('commission never exceeds amount', () => {
    // 200% commission_pct would exceed the amount — should be capped
    const result = computeCommission(500, { commission_type: 'fixed_pct', commission_pct: 200, commission_flat: 0 });
    assert.equal(result.commission, 500);
    assert.equal(result.net, 0);
  });

  test('unknown commission_type defaults to zero commission', () => {
    const result = computeCommission(1000, { commission_type: 'unknown_type' });
    assert.equal(result.commission, 0);
    assert.equal(result.net, 1000);
  });

  test('always returns integers', () => {
    // 33.3% of 100 paise — result must be rounded integer
    const result = computeCommission(100, { commission_type: 'fixed_pct', commission_pct: 33.3, commission_flat: 0 });
    assert.equal(typeof result.commission, 'number');
    assert.equal(result.commission, Math.floor(result.commission)); // integer
  });
});
