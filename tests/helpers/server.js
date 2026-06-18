'use strict';
// Set DB_PATH to in-memory SQLite BEFORE any app module is loaded.
// Each test file runs in its own subprocess (node --test), so this
// gives every file a clean, isolated database.
process.env.DB_PATH = ':memory:';

const http = require('node:http');

async function startServer() {
  const app = require('../../src/app');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function stopServer(server) {
  await new Promise((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve()))
  );
}

/** Register a merchant and return credentials ready to use. */
async function registerMerchant(base, { name = 'Test Merchant', email, password = 'password123' } = {}) {
  const r = await fetch(`${base}/v1/merchants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email: email ?? `m_${Date.now()}@example.com`, password }),
  });
  if (!r.ok) throw new Error(`registerMerchant failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  data.authHeader = 'Basic ' + Buffer.from(`${data.key_id}:${data.key_secret}`).toString('base64');
  return data;
}

/** POST helper — returns parsed JSON + status. */
async function post(base, path, body, authHeader) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** GET helper — returns parsed JSON + status. */
async function get(base, path, authHeader) {
  const r = await fetch(`${base}${path}`, {
    headers: authHeader ? { Authorization: authHeader } : {},
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

module.exports = { startServer, stopServer, registerMerchant, post, get };
