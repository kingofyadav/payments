'use strict';
const crypto = require('node:crypto');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, hashSecret, verifySecret, signPayload, verifySignature } = require('../../src/systems/signature');

describe('generateKeyPair', () => {
  test('produces unique pairs', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    assert.notEqual(a.keyId, b.keyId);
    assert.notEqual(a.keySecret, b.keySecret);
  });

  test('keyId starts with key_', () => {
    const { keyId } = generateKeyPair();
    assert.ok(keyId.startsWith('key_'), `expected key_ prefix, got: ${keyId}`);
  });

  test('keySecret is a hex string', () => {
    const { keySecret } = generateKeyPair();
    assert.match(keySecret, /^[0-9a-f]+$/);
  });
});

describe('hashSecret', () => {
  test('produces unique output each call (random salt)', () => {
    assert.notEqual(hashSecret('mysecret'), hashSecret('mysecret'));
  });

  test('different inputs produce different hashes', () => {
    assert.notEqual(hashSecret('a'), hashSecret('b'));
  });

  test('output is salt:hmac format (32-char salt + colon + 64-char hmac)', () => {
    const h = hashSecret('test');
    assert.ok(h.includes(':'), 'stored hash must include a colon separator');
    const [salt, hmac] = h.split(':');
    assert.match(salt, /^[0-9a-f]{32}$/, 'salt must be 16 bytes (32 hex chars)');
    assert.match(hmac, /^[0-9a-f]{64}$/, 'hmac must be 32 bytes (64 hex chars)');
  });
});

describe('verifySecret', () => {
  test('round-trip: hash then verify succeeds', () => {
    const stored = hashSecret('my_api_key_secret');
    assert.ok(verifySecret('my_api_key_secret', stored));
  });

  test('wrong plaintext fails verification', () => {
    const stored = hashSecret('my_api_key_secret');
    assert.equal(verifySecret('wrong_secret', stored), false);
  });

  test('backward-compat: verifies legacy unsalted SHA-256 hashes', () => {
    const legacy = crypto.createHash('sha256').update('old_key_secret').digest('hex');
    assert.ok(verifySecret('old_key_secret', legacy));
    assert.equal(verifySecret('wrong_secret', legacy), false);
  });

  test('returns false for malformed stored hash', () => {
    assert.equal(verifySecret('anything', 'not-a-valid-hash'), false);
    assert.equal(verifySecret('anything', ''), false);
  });
});

describe('signPayload + verifySignature', () => {
  const secret = 'webhook_secret_abc';

  test('round-trip: sign then verify returns true', () => {
    const payload = { event: 'payment.captured', amount: 10000 };
    const sig = signPayload(payload, secret);
    assert.ok(verifySignature(payload, secret, sig));
  });

  test('tampered payload fails verification', () => {
    const original = { event: 'payment.captured', amount: 10000 };
    const sig = signPayload(original, secret);
    const tampered = { ...original, amount: 99999 };
    assert.equal(verifySignature(tampered, secret, sig), false);
  });

  test('wrong secret fails verification', () => {
    const payload = { event: 'payment.captured', amount: 10000 };
    const sig = signPayload(payload, secret);
    assert.equal(verifySignature(payload, 'wrong_secret', sig), false);
  });

  test('signature is deterministic regardless of key insertion order', () => {
    const a = signPayload({ b: 2, a: 1 }, secret);
    const b = signPayload({ a: 1, b: 2 }, secret);
    assert.equal(a, b);
  });

  test('verifySignature returns false for malformed signature', () => {
    const payload = { event: 'test' };
    assert.equal(verifySignature(payload, secret, 'not-hex'), false);
  });
});
