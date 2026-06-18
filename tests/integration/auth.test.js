'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, post, get } = require('../helpers/server');

let server, base, merchant;

before(async () => {
  ({ server, base } = await startServer());
  merchant = await registerMerchant(base, { email: 'auth_test@example.com', password: 'password123' });
});

after(() => stopServer(server));

describe('POST /api/auth/login', () => {
  test('returns token on valid credentials', async () => {
    const { body, status } = await post(base, '/api/auth/login', {
      email: 'auth_test@example.com', password: 'password123',
    });
    assert.equal(status, 200);
    assert.ok(body.token, 'should return a token');
    assert.equal(body.merchant.email, 'auth_test@example.com');
  });

  test('returns 401 on wrong password', async () => {
    const { status } = await post(base, '/api/auth/login', {
      email: 'auth_test@example.com', password: 'wrongpassword',
    });
    assert.equal(status, 401);
  });

  test('returns 401 for unknown email', async () => {
    const { status } = await post(base, '/api/auth/login', {
      email: 'nobody@example.com', password: 'password123',
    });
    assert.equal(status, 401);
  });

  test('returns 400 when email missing', async () => {
    const { status } = await post(base, '/api/auth/login', { password: 'password123' });
    assert.equal(status, 400);
  });
});

describe('GET /api/auth/me', () => {
  test('returns merchant info with valid session token', async () => {
    const { body: login } = await post(base, '/api/auth/login', {
      email: 'auth_test@example.com', password: 'password123',
    });
    const r = await fetch(`${base}/api/auth/me`, {
      headers: { 'X-Session-Token': login.token },
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.email, 'auth_test@example.com');
  });

  test('returns 401 with no token', async () => {
    const { status } = await get(base, '/api/auth/me');
    assert.equal(status, 401);
  });

  test('returns 401 with invalid token', async () => {
    const r = await fetch(`${base}/api/auth/me`, {
      headers: { 'X-Session-Token': 'invalidtoken' },
    });
    assert.equal(r.status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  test('invalidates session so /me returns 401 afterwards', async () => {
    const { body: login } = await post(base, '/api/auth/login', {
      email: 'auth_test@example.com', password: 'password123',
    });
    const token = login.token;

    // Confirm session is valid
    const r1 = await fetch(`${base}/api/auth/me`, { headers: { 'X-Session-Token': token } });
    assert.equal(r1.status, 200);

    // Logout
    const r2 = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'X-Session-Token': token },
    });
    assert.equal(r2.status, 200);

    // Session should now be invalid
    const r3 = await fetch(`${base}/api/auth/me`, { headers: { 'X-Session-Token': token } });
    assert.equal(r3.status, 401);
  });
});
