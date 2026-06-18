require('dotenv').config();
const express = require('express');
const path    = require('path');
const { logger, captureException } = require('./systems/logger');
const { apiKeyAuth }         = require('./middleware/auth');
const { rateLimiter }        = require('./middleware/rateLimiter');
const { idempotency }        = require('./middleware/idempotency');
const { sessionAuth }        = require('./dashboard/guard');
const { expireOverdueLinks } = require('./links/manager');
const { runBillingCycle }    = require('./subscriptions/billing');
const { runPayoutCycle }     = require('./payouts/engine');
const { runSettlementCycle } = require('./systems/settlement');
const { runWebhookDelivery }     = require('./systems/webhook');
const { runEscrowAutoRelease }     = require('./marketplace/escrow');
const { runTransferHoldRelease }   = require('./marketplace/hold_release');
const { apiLogger }                = require('./middleware/apiLogger');
const { seedDefaultRules }         = require('./fraud/rules_engine');
const { releaseMaturedReserves }   = require('./risk/rolling_reserve');
const { purgeExpiredSessions }     = require('./dashboard/auth');

const app = express();
app.use(express.json());

// ── Security headers — applied to every response ──────────────────────────────
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options':       'nosniff',
    'X-Frame-Options':              'DENY',
    'Referrer-Policy':              'no-referrer',
    'Strict-Transport-Security':    'max-age=63072000; includeSubDomains',
    'Permissions-Policy':           'geolocation=(), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
});

// Strict CSP for JSON API responses — no documents or scripts should ever render.
// Dashboard HTML routes are excluded: they load chart.js from cdn.jsdelivr.net.
app.use('/v1', (req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'none'");
  next();
});

// ── API index (public — must precede static so `public/v1/` doesn't shadow it) ─
app.get('/v1', (req, res) => res.json({
  name:    'PayEngine',
  version: 'v10',
  auth:    'HTTP Basic — key_id:key_secret on every /v1/* call',
  resources: {
    merchants:       { register: 'POST /v1/merchants (public)' },
    orders:          'POST /v1/orders, GET /v1/orders/:id',
    payments:        'POST /v1/payments, GET /v1/payments/:id, POST /v1/payments/:id/refund',
    refunds:         'GET /v1/refunds',
    settlements:     'GET /v1/settlements',
    webhooks:        '/v1/webhooks',
    plans:           '/v1/plans',
    subscriptions:   '/v1/subscriptions (cancel|pause|resume)',
    customers:       '/v1/customers',
    contacts:        '/v1/contacts',
    fund_accounts:   '/v1/fund_accounts (penny_drop)',
    payouts:         '/v1/payouts (approve)',
    payout_links:    '/v1/payout_links',
    linked_accounts: '/v1/linked_accounts (activate)',
    transfers:       '/v1/transfers (release, reversals)',
    escrows:         '/v1/escrows (release, dispute)',
    marketplace:     '/v1/marketplace/analytics/{summary,top_sellers}',
    fraud:           '/v1/fraud/{rules,blacklists,events,stats}',
    chargebacks:     '/v1/chargebacks (ratio, evidence, resolve)',
    compliance:      '/v1/compliance/{dashboard,kyc,aml,reserves,reports}',
    developer:       '/v1/developer/{logs,stats,test_scenarios,changelog}',
  },
  health: '/health',
  status: '/status',
}));

app.use(express.static(path.join(__dirname, '../public')));

// ── Auth (public) ────────────────────────────────────────────────────────────
app.use('/api/auth', require('./dashboard/auth').router);

// ── Public checkout API (no auth — used by /l/:code pages) ──────────────────
app.use('/api/pub/links',        require('./links/checkout'));
app.use('/api/pub/payout_links', require('./payouts/checkout'));

// ── Dashboard API (session) ──────────────────────────────────────────────────
app.use('/api/dashboard/links',          sessionAuth, require('./dashboard/links'));
app.use('/api/dashboard/analytics',      sessionAuth, require('./dashboard/analytics_detail'));
app.use('/api/dashboard/subscriptions',  sessionAuth, require('./dashboard/subscriptions'));
app.use('/api/dashboard/payouts',        sessionAuth, require('./dashboard/payouts'));
app.use('/api/dashboard',                sessionAuth, require('./dashboard/analytics'));

// ── Merchant registration (no rate limit — needed to get keys) ───────────────
app.use('/v1/merchants', require('./routes/merchants'));

// ── API request logger — applied to all /v1/ calls after auth ─────────────────
app.use('/v1', apiLogger);

// ── API middleware: rate limit + idempotency on all /v1 routes ───────────────
// apiKeyAuth sets req.merchantId; rateLimiter uses it
const apiMiddleware = [apiKeyAuth, rateLimiter, idempotency];

// ── Core payment API ─────────────────────────────────────────────────────────
app.use('/v1/orders',        apiMiddleware, require('./routes/orders'));
app.use('/v1/payments',      apiMiddleware, require('./routes/payments'));
app.use('/v1/refunds',       apiMiddleware, require('./routes/refunds'));
app.use('/v1/settlements',   apiMiddleware, require('./routes/settlements'));
app.use('/v1/webhooks',      apiMiddleware, require('./routes/webhook_endpoints').router);

// ── Subscriptions ────────────────────────────────────────────────────────────
app.use('/v1/plans',         apiMiddleware, require('./routes/plans'));
app.use('/v1/subscriptions', apiMiddleware, require('./routes/subscriptions'));
app.use('/v1/customers',     apiMiddleware, require('./routes/customers'));

// ── Payouts ──────────────────────────────────────────────────────────────────
app.use('/v1/contacts',       apiMiddleware, require('./routes/contacts'));
app.use('/v1/fund_accounts',  apiMiddleware, require('./routes/fund_accounts'));
app.use('/v1/payouts',        apiMiddleware, require('./routes/payouts'));
app.use('/v1/payout_batches', apiMiddleware, require('./routes/payout_batches'));
app.use('/v1/payout_links',   apiMiddleware, require('./routes/payout_links'));

// ── Marketplace / Route ───────────────────────────────────────────────────────
app.use('/v1/linked_accounts',            apiMiddleware, require('./routes/linked_accounts'));
app.use('/v1/transfers',                  apiMiddleware, require('./routes/transfers'));
app.use('/v1/escrows',                    apiMiddleware, require('./routes/escrows'));
app.use('/v1/marketplace/analytics',      apiMiddleware, require('./routes/marketplace_analytics'));

// ── Compliance / Risk / Fraud (Phase 10) ─────────────────────────────────────
app.use('/v1/fraud',       apiMiddleware, require('./routes/fraud'));
app.use('/v1/chargebacks', apiMiddleware, require('./routes/chargebacks'));
app.use('/v1/compliance',  apiMiddleware, require('./routes/compliance'));

// ── Developer Experience ──────────────────────────────────────────────────────
app.use('/v1/developer', apiMiddleware, require('./routes/developer'));

// ── Status page (public) ──────────────────────────────────────────────────────
app.use('/status', require('./routes/status'));

// ── Payout claim SPA ─────────────────────────────────────────────────────────
app.get('/pout/:code', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/payout_claim.html'))
);

// ── Checkout SPA ─────────────────────────────────────────────────────────────
app.get('/l/:code', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/checkout.html'))
);

app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/dashboard.html'))
);

app.get('/health', (req, res) => {
  try {
    require('./db/database').getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', ts: new Date().toISOString(), version: 'v10' });
  } catch (err) {
    logger.error({ err }, 'health check: DB connectivity failure');
    res.status(503).json({ status: 'error', reason: 'database_unavailable' });
  }
});

app.get('/metrics', (req, res) => {
  const db  = require('./db/database').getDb();
  const now = Math.floor(Date.now() / 1000);
  const day = now - 86400;
  const win = now - 300; // 5-min window for delivery rate

  const lines = [];
  const g = (name, help, value) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };

  try {
    const req24 = db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN status_code>=400 THEN 1 ELSE 0 END) AS errors FROM api_request_logs WHERE created_at>=?'
    ).get(day);
    g('payengine_http_requests_total',   'Total API requests in the last 24 hours',  req24.total  ?? 0);
    g('payengine_http_errors_total',     'Total 4xx/5xx responses in the last 24h',  req24.errors ?? 0);

    const n = req24.total ?? 0;
    const p95offset = Math.max(0, Math.ceil(n * 0.95) - 1);
    const p95 = n > 0
      ? db.prepare('SELECT latency_ms FROM api_request_logs WHERE created_at>=? ORDER BY latency_ms ASC LIMIT 1 OFFSET ?')
          .get(day, p95offset)?.latency_ms ?? 0
      : 0;
    g('payengine_http_latency_p95_ms', 'p95 request latency in milliseconds (last 24h)', p95);
  } catch { g('payengine_http_requests_total', 'Total API requests', 0); }

  try {
    const wq = db.prepare("SELECT COUNT(*) AS c FROM webhook_events WHERE status='pending'").get();
    g('payengine_webhook_queue_depth', 'Pending webhook events awaiting delivery', wq.c ?? 0);

    const wh = db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered FROM webhook_events WHERE created_at>=?"
    ).get(win);
    const rate = (wh.total ?? 0) > 0 ? ((wh.delivered ?? 0) / wh.total) * 100 : 100;
    g('payengine_webhook_delivery_rate_pct', 'Webhook delivery rate (last 5 minutes)', +rate.toFixed(2));
  } catch { g('payengine_webhook_queue_depth', 'Pending webhook events', 0); }

  try {
    const subs = db.prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE status='active'").get();
    g('payengine_active_subscriptions', 'Currently active subscriptions', subs.c ?? 0);
  } catch { g('payengine_active_subscriptions', 'Currently active subscriptions', 0); }

  try {
    const pp = db.prepare("SELECT COUNT(*) AS c FROM payouts WHERE status IN ('queued','pending_approval')").get();
    g('payengine_pending_payouts', 'Payouts in queued or pending_approval state', pp.c ?? 0);
  } catch { g('payengine_pending_payouts', 'Pending payouts', 0); }

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error({ err, method: req.method, path: req.path }, 'unhandled request error');
  captureException(err, { method: req.method, path: req.path });
  res.status(500).json({ error: { code: 'SERVER_ERROR', description: 'Internal server error', source: 'server' } });
});

// Always seed fraud rules — idempotent, needed for all environments
seedDefaultRules();

// ── Background jobs + server start (skipped when imported by tests) ───────────
if (require.main === module) {
  setInterval(expireOverdueLinks,     60_000);
  setInterval(runBillingCycle,        60_000);
  setInterval(runPayoutCycle,         30_000);
  setInterval(runSettlementCycle,     3_600_000);
  setInterval(runWebhookDelivery,     10_000);
  setInterval(runEscrowAutoRelease,   60_000);
  setInterval(runTransferHoldRelease, 60_000);
  setInterval(releaseMaturedReserves,   3_600_000);
  setInterval(purgeExpiredSessions,     3_600_000);

  runBillingCycle();
  runPayoutCycle();
  runSettlementCycle();
  runWebhookDelivery();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    logger.info({ port: PORT }, `PayEngine listening on http://localhost:${PORT}`)
  );
}

module.exports = app;
