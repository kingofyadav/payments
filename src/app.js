require('dotenv').config();
const express = require('express');
const path    = require('path');
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

const app = express();
app.use(express.json());

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
app.use('/api/auth', require('./dashboard/auth'));

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

app.get('/health', (req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString(), version: 'v10' })
);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', description: 'Internal server error', source: 'server' } });
});

// ── Background jobs ──────────────────────────────────────────────────────────
setInterval(expireOverdueLinks,     60_000);
setInterval(runBillingCycle,        60_000);
setInterval(runPayoutCycle,         30_000);
setInterval(runSettlementCycle,     3_600_000);
setInterval(runWebhookDelivery,     10_000);
setInterval(runEscrowAutoRelease,   60_000);
setInterval(runTransferHoldRelease, 60_000);
setInterval(releaseMaturedReserves, 3_600_000); // check hourly for matured reserves

runBillingCycle();
runPayoutCycle();
runSettlementCycle();
runWebhookDelivery();
seedDefaultRules(); // idempotent — skips if rules already exist

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Payment engine on http://localhost:${PORT}`)
);
