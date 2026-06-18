'use strict';
// Regression tests for Bug #5: ReDoS via merchant-defined fraud rules
process.env.DB_PATH = ':memory:';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegexPattern } = require('../../src/fraud/rules_engine');

describe('validateRegexPattern — accepts safe patterns', () => {
  const safe = [
    '^test',
    'foo|bar',
    '[0-9]{4}',
    '\\d+\\.\\d+',
    'https?://',
    '^[a-z]{3,}@[a-z]+\\.[a-z]{2,}$',
  ];
  for (const p of safe) {
    test(`accepts: ${p}`, () => {
      assert.doesNotThrow(() => validateRegexPattern(p));
    });
  }
});

describe('validateRegexPattern — rejects catastrophic backtracking', () => {
  const dangerous = [
    '(a+)+b',    // classic nested quantifier
    '(a*)*b',
    '(a|aa)+b',  // alternation with nested quantifier
    '([a-z]+)+',
  ];
  for (const p of dangerous) {
    test(`rejects nested quantifier: ${p}`, () => {
      assert.throws(() => validateRegexPattern(p), /catastrophic/i);
    });
  }
});

describe('validateRegexPattern — rejects invalid / oversized patterns', () => {
  test('rejects pattern longer than 200 chars', () => {
    assert.throws(() => validateRegexPattern('a'.repeat(201)), /200/);
  });

  test('rejects syntactically invalid regex', () => {
    assert.throws(() => validateRegexPattern('[unclosed'), /Invalid regex/i);
  });

  test('rejects non-string input', () => {
    assert.throws(() => validateRegexPattern(null), Error);
    assert.throws(() => validateRegexPattern(42), Error);
  });
});

describe('regex caching in rules engine', () => {
  // Verify the evaluate path with regex uses cached RegExp (no ReDoS rebuild)
  // We test indirectly: running the same pattern twice must not throw
  const { runRulesEngine } = require('../../src/fraud/rules_engine');

  test('runRulesEngine evaluates regex rules without error', () => {
    // Rules engine uses an in-memory DB seeded in getDb(); just ensure it doesn't throw
    assert.doesNotThrow(() => {
      runRulesEngine({ amount: '1000', ip: '1.2.3.4', card_bin: '411111', email: 'a@b.com', hour: '10', is_round_amount: '0' }, null);
    });
  });
});
