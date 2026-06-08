'use strict';
const { randomUUID } = require('crypto');
const { getDb }      = require('../db/database');

const MAX_BODY = 4096; // bytes stored per request/response

function truncate(obj) {
  if (!obj) return null;
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…[truncated]' : s;
}

function sanitize(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  // Scrub fields that should never appear in logs
  for (const key of ['key_secret', 'password', 'cvv', 'card_number', 'secret']) {
    if (copy[key] !== undefined) copy[key] = '••••';
  }
  return copy;
}

function apiLogger(req, res, next) {
  const start = Date.now();

  // Capture response body via json() override
  const originalJson = res.json.bind(res);
  let capturedBody   = null;
  res.json = function (body) {
    capturedBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    try {
      const latency = Date.now() - start;
      const id = 'arl_' + randomUUID().replace(/-/g, '').slice(0, 14);
      getDb().prepare(`
        INSERT INTO api_request_logs
          (id, merchant_id, key_id, method, path, query, status_code, latency_ms, req_body, res_body, ip, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        req.merchantId ?? null,
        req.apiKeyId   ?? null,
        req.method,
        req.path,
        Object.keys(req.query).length ? JSON.stringify(req.query) : null,
        res.statusCode,
        latency,
        truncate(sanitize(req.body)),
        truncate(capturedBody),
        req.ip ?? req.headers['x-forwarded-for'] ?? null,
        Math.floor(Date.now() / 1000),
      );
    } catch (_) { /* never crash the request */ }
  });

  next();
}

module.exports = { apiLogger };
