'use strict';
// Regression test for Bug #4: no rate limiting on login endpoint
//
// Isolated in its own file so the _loginWindows Map starts fresh
// (each test file runs in its own subprocess via node --test).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, registerMerchant, post } = require('../helpers/server');

let server, base, email;

before(async () => {
  ({ server, base } = await startServer());
  email = `rl_${Date.now()}@example.com`;
  await registerMerchant(base, { email, password: 'correct_pass' });
});

after(() => stopServer(server));

test('first 10 login attempts get 401 (wrong password), 11th gets 429', async () => {
  const statuses = [];

  for (let i = 0; i < 11; i++) {
    const { status } = await post(base, '/api/auth/login', {
      email, password: 'wrong_password',
    });
    statuses.push(status);
  }

  // Attempts 1–10: authentication failure, not yet rate-limited
  const first10 = statuses.slice(0, 10);
  assert.ok(
    first10.every(s => s === 401),
    `expected all 401 for first 10 attempts, got: ${first10}`
  );

  // Attempt 11: rate limited
  assert.equal(statuses[10], 429, '11th attempt should be rate-limited (429)');
});

test('rate-limited response includes Retry-After header', async () => {
  // Window is already exhausted from the previous test (same process, same Map)
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong_password' }),
  });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'), 'should include Retry-After header');
});
