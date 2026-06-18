'use strict';
const express    = require('express');
const { getDb }  = require('../db/database');
const { apiError } = require('../middleware/errors');
const { getTestCards, getTestUpiHandles } = require('../systems/test_scenarios');
const { ALL_EVENTS } = require('./webhook_endpoints');
const { signPayload } = require('../systems/signature');
const { randomUUID }  = require('crypto');
const { validateWebhookUrl } = require('../middleware/validateUrl');

const router = express.Router();

// ── GET /v1/developer/logs ───────────────────────────────────────────────────
// Paginated API request log for the authenticated merchant
router.get('/logs', (req, res) => {
  const db     = getDb();
  const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  const { method, path: filterPath, status, from, to } = req.query;

  let where = 'WHERE merchant_id=?';
  const params = [req.merchantId];

  if (method)     { where += ' AND method=?';      params.push(method.toUpperCase()); }
  if (filterPath) { where += ' AND path LIKE ?';   params.push(`%${filterPath}%`); }
  if (status)     { where += ' AND status_code=?'; params.push(parseInt(status)); }
  if (from)       { where += ' AND created_at>=?'; params.push(parseInt(from)); }
  if (to)         { where += ' AND created_at<=?'; params.push(parseInt(to)); }

  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM api_request_logs ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM api_request_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset).map(row => ({
    ...row,
    req_body: row.req_body ? tryParse(row.req_body) : null,
    res_body: row.res_body ? tryParse(row.res_body) : null,
    query:    row.query    ? tryParse(row.query)    : null,
  }));

  res.json({ count, items });
});

// ── GET /v1/developer/stats ──────────────────────────────────────────────────
// Integration health: call counts, error rate, latency, webhook health
router.get('/stats', (req, res) => {
  const db  = getDb();
  const mid = req.merchantId;
  const now = Math.floor(Date.now() / 1000);
  const day = now - 86400;
  const hour = now - 3600;

  const { total_today, errors_today, avg_latency } = db.prepare(`
    SELECT
      COUNT(*)                                             AS total_today,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors_today,
      CAST(AVG(latency_ms) AS INTEGER)                     AS avg_latency
    FROM api_request_logs WHERE merchant_id=? AND created_at>=?
  `).get(mid, day);

  // True p95 via nearest-rank: sort ASC, skip to the 95th-percentile position.
  // For N=0 the query returns null and we fall back to 0.
  const p95offset = Math.max(0, Math.ceil((total_today ?? 0) * 0.95) - 1);
  const p95_latency = db.prepare(`
    SELECT latency_ms FROM api_request_logs
    WHERE merchant_id=? AND created_at>=?
    ORDER BY latency_ms ASC LIMIT 1 OFFSET ?
  `).get(mid, day, p95offset)?.latency_ms ?? 0;

  const { total_hour, errors_hour } = db.prepare(`
    SELECT
      COUNT(*)                                             AS total_hour,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors_hour
    FROM api_request_logs WHERE merchant_id=? AND created_at>=?
  `).get(mid, hour);

  // Webhook stats
  const { wh_total, wh_delivered, wh_failed } = db.prepare(`
    SELECT
      COUNT(*)                                                AS wh_total,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END)    AS wh_delivered,
      SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END)    AS wh_failed
    FROM webhook_events WHERE merchant_id=? AND created_at>=?
  `).get(mid, day);

  const error_rate_pct = total_today > 0
    ? ((errors_today / total_today) * 100).toFixed(2)
    : '0.00';
  const webhook_delivery_rate = wh_total > 0
    ? (((wh_delivered ?? 0) / wh_total) * 100).toFixed(2)
    : '100.00';

  res.json({
    period: '24h',
    api_calls: {
      total:          total_today  ?? 0,
      errors:         errors_today ?? 0,
      error_rate_pct: parseFloat(error_rate_pct),
      last_hour:      total_hour   ?? 0,
      last_hour_errors: errors_hour ?? 0,
    },
    latency: {
      avg_ms:  avg_latency ?? 0,
      p95_ms:  p95_latency ?? 0,
    },
    webhooks: {
      total:         wh_total     ?? 0,
      delivered:     wh_delivered ?? 0,
      failed:        wh_failed    ?? 0,
      delivery_rate: parseFloat(webhook_delivery_rate),
    },
  });
});

// ── GET /v1/developer/webhook_logs ───────────────────────────────────────────
// Webhook delivery log (test + real) for this merchant
router.get('/webhook_logs', (req, res) => {
  const db    = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const off   = parseInt(req.query.offset) || 0;
  const { is_test } = req.query;

  let where = 'WHERE merchant_id=?';
  const params = [req.merchantId];
  if (is_test !== undefined) { where += ' AND is_test=?'; params.push(is_test === '1' || is_test === 'true' ? 1 : 0); }

  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM webhook_delivery_log ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM webhook_delivery_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, off).map(row => ({
    ...row,
    payload: row.payload ? tryParse(row.payload) : null,
  }));

  res.json({ count, items });
});

// ── POST /v1/developer/webhooks/test ────────────────────────────────────────
// Advanced test webhook: pick any registered endpoint + event type
router.post('/webhooks/test', async (req, res) => {
  const { endpoint_id, event_type = 'webhook.test', url } = req.body;
  const db = getDb();

  // Resolve target endpoint
  let targetUrl, secret, epId;
  if (endpoint_id) {
    const ep = db.prepare('SELECT * FROM webhook_endpoints WHERE id=? AND is_active=1').get(endpoint_id);
    if (!ep) return apiError(res, 404, 'Webhook endpoint not found');
    if (ep.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
    targetUrl = ep.url;
    secret    = ep.secret;
    epId      = ep.id;
  } else if (url) {
    try { validateWebhookUrl(url); } catch (err) {
      return apiError(res, 400, err.message, { field: 'url' });
    }
    targetUrl = url;
    secret    = 'test_secret';
    epId      = null;
  } else {
    return apiError(res, 400, 'endpoint_id or url is required');
  }

  const payload = buildTestPayload(event_type, req.merchantId);
  const sig     = signPayload(payload, secret);
  const start   = Date.now();
  const logId   = 'wdl_' + randomUUID().replace(/-/g, '').slice(0, 14);

  let responseStatus = null, responseBody = null, errorMsg = null;

  try {
    const r = await fetch(targetUrl, {
      method:  'POST',
      headers: {
        'Content-Type':         'application/json',
        'X-Gateway-Signature':  sig,
        'X-Gateway-Event':      event_type,
        'X-Gateway-Delivery':   logId,
      },
      body:   JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = r.status;
    try { responseBody = await r.text(); } catch {}
  } catch (err) {
    errorMsg = err.message;
  }

  const latencyMs = Date.now() - start;

  // Persist to delivery log
  try {
    db.prepare(`
      INSERT INTO webhook_delivery_log
        (id, merchant_id, endpoint_id, event_type, payload, response_status, response_body, response_ms, error, is_test, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)
    `).run(logId, req.merchantId, epId ?? null, event_type,
        JSON.stringify(payload), responseStatus, responseBody, latencyMs,
        errorMsg, Math.floor(Date.now() / 1000));
  } catch {}

  res.json({
    id:              logId,
    endpoint_id:     epId,
    url:             targetUrl,
    event_type,
    payload,
    signature:       sig,
    response: {
      status:     responseStatus,
      body:       responseBody,
      latency_ms: latencyMs,
    },
    error:     errorMsg,
    delivered: responseStatus !== null && responseStatus >= 200 && responseStatus < 300,
  });
});

// ── GET /v1/developer/test_scenarios ────────────────────────────────────────
// Returns all test cards and UPI handles with expected outcomes
router.get('/test_scenarios', (req, res) => {
  res.json({
    cards:       getTestCards(),
    upi_handles: getTestUpiHandles(),
    note: 'Use these values in POST /v1/payments as card_number or upi_id field. All test mode only.',
  });
});

// ── GET /v1/developer/events (webhook event types) ───────────────────────────
router.get('/events', (req, res) => {
  res.json({ events: ALL_EVENTS });
});

// ── GET /v1/changelog ───────────────────────────────────────────────────────
router.get('/changelog', (req, res) => {
  res.json({
    versions: CHANGELOG,
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function tryParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function buildTestPayload(eventType, merchantId) {
  const base = { event: eventType, merchant_id: merchantId, timestamp: new Date().toISOString(), test: true };
  const fakes = {
    // Core payments
    'payment.captured':          { payment_id: 'pay_test000000000001', order_id: 'order_test0000001', amount: 50000, currency: 'INR', method: 'upi', status: 'captured' },
    'payment.failed':            { payment_id: 'pay_test000000000002', order_id: 'order_test0000002', amount: 50000, currency: 'INR', method: 'card', status: 'failed', reason: 'card_declined' },
    // Refunds & orders
    'refund.created':            { refund_id: 'ref_test00000000001', payment_id: 'pay_test000000000001', amount: 25000, status: 'processed' },
    'order.paid':                { order_id: 'order_test0000001', amount: 50000, status: 'paid' },
    // Payment links
    'payment_link.paid':         { link_id: 'plink_test00000001', link_code: 'TESTLINK01', payment_id: 'pay_test000000000001', amount: 50000, currency: 'INR' },
    // Subscriptions
    'subscription.charged':      { subscription_id: 'sub_test000000001', invoice_id: 'inv_test0000001', payment_id: 'pay_test000000000001', amount: 99900, cycle: 1 },
    'subscription.completed':    { subscription_id: 'sub_test000000001', invoice_id: 'inv_test0000002', payment_id: 'pay_test000000000002', amount: 99900, cycle: 12 },
    'subscription.halted':       { subscription_id: 'sub_test000000001', invoice_id: 'inv_test0000003', reason: 'All retry attempts exhausted' },
    'subscription.cancelled':    { subscription_id: 'sub_test000000001' },
    // Settlements & payouts
    'settlement.processed':      { settlement_id: 'setl_test00000001', amount: 980000, fee: 20000 },
    'payout.processed':          { payout_id: 'pout_test000000001', amount: 100000, status: 'processed' },
    'payout.failed':             { payout_id: 'pout_test000000002', amount: 100000, status: 'failed', reason: 'invalid_account' },
    // Marketplace — transfers
    'transfer.created':          { transfer_id: 'trf_test000000001', linked_account_id: 'la_test00001', amount: 50000, net_amount: 49000, on_hold: true },
    'transfer.processed':        { transfer_id: 'trf_test000000001', linked_account_id: 'la_test00001', amount: 50000, net_amount: 49000 },
    'transfer.released':         { transfer_id: 'trf_test000000001', linked_account_id: 'la_test00001' },
    'transfer.reversed':         { transfer_id: 'trf_test000000001', reversal_id: 'rev_test000000001', amount: 50000 },
    // Marketplace — escrow
    'escrow.funded':             { escrow_id: 'escw_test000000001', linked_account_id: 'la_test00001', amount: 50000 },
    'escrow.released':           { escrow_id: 'escw_test000000001', linked_account_id: 'la_test00001', amount: 50000 },
    'escrow.refunded':           { escrow_id: 'escw_test000000001', amount: 50000 },
    'escrow.disputed':           { escrow_id: 'escw_test000000001', reason: 'Goods not delivered' },
    // Marketplace — linked accounts
    'linked_account.activated':  { linked_account_id: 'la_test00001' },
    'linked_account.suspended':  { linked_account_id: 'la_test00001' },
  };
  return { ...base, ...(fakes[eventType] ?? { message: 'Test event from PayEngine' }) };
}

const CHANGELOG = [
  {
    version: 'v8.0',
    date: '2026-05-31',
    type: 'feature',
    breaking: false,
    summary: 'Marketplace / Route — multi-party payment splitting',
    changes: [
      'Added linked_accounts resource (CRUD + KYC lifecycle)',
      'Transfer engine with on_hold, hold_until, auto-release',
      'Transfer reversals with duplicate-reversal guard',
      'Escrow (fund → release / refund / dispute) with auto-release',
      'Route splits on POST /v1/payments via route[] array',
      'Commission engine: fixed_pct, flat_fee, hybrid models',
      'Marketplace analytics: GMV trend, top sellers, seller health',
    ],
  },
  {
    version: 'v7.0',
    date: '2026-05-30',
    type: 'feature',
    breaking: false,
    summary: 'Developer APIs & SDKs — Node.js SDK, idempotency, webhook signing',
    changes: [
      'Node.js SDK with all resources',
      'Idempotency key support (X-Idempotency-Key header)',
      'HMAC-SHA256 webhook signing with sorted-key canonical form',
      'Webhook delivery background job',
    ],
  },
  {
    version: 'v6.0',
    date: '2026-05-29',
    type: 'feature',
    breaking: false,
    summary: 'Analytics & Reporting — settlement recons, GMV trends',
    changes: [
      'Settlement reconciliation endpoints',
      'Dashboard analytics (revenue, orders, payment methods)',
      'Subscription analytics',
      'Payout analytics',
    ],
  },
  {
    version: 'v5.0',
    date: '2026-05-28',
    type: 'feature',
    breaking: false,
    summary: 'Payouts — contacts, fund accounts, penny drop, payout links',
    changes: [
      'Contacts and fund accounts (bank + VPA)',
      'Penny drop verification',
      'Payout engine with approval threshold and daily limits',
      'Payout batches',
      'Payout links (one-time claim URLs)',
    ],
  },
  {
    version: 'v4.0',
    date: '2026-05-27',
    type: 'feature',
    breaking: false,
    summary: 'Subscriptions — plans, billing cycles, retry logic',
    changes: [
      'Plans and Subscriptions resources',
      'Recurring billing engine with configurable retry',
      'Subscription invoices',
      'pause / resume / cancel lifecycle',
    ],
  },
  {
    version: 'v3.0',
    date: '2026-05-26',
    type: 'feature',
    breaking: false,
    summary: 'Payment Links — fixed, range, open amounts, partial payments',
    changes: [
      'Payment links (fixed / range / open amount)',
      'Partial payment support',
      'Link expiry and single-use mode',
      'Public checkout page for link payments',
    ],
  },
  {
    version: 'v2.0',
    date: '2026-05-25',
    type: 'feature',
    breaking: false,
    summary: 'Settlements & Webhooks — T+2 batching, webhook delivery',
    changes: [
      'T+2 settlement engine with fee + GST',
      'Webhook endpoints with HMAC signing',
      'Refunds engine',
    ],
  },
  {
    version: 'v1.0',
    date: '2026-05-24',
    type: 'initial',
    breaking: false,
    summary: 'Core payment engine — orders, payments, routing',
    changes: [
      'Orders and Payments resources',
      'Multi-processor routing (Razorpay, Cashfree, Paytm, Stripe)',
      'API key authentication',
      'Rate limiting (600 req/min)',
    ],
  },
];

module.exports = router;
