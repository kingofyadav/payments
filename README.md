# PayEngine — Full-Stack Payment Platform

> Built over 10 phases. Razorpay-level architecture. Node.js + Express + SQLite.
> Developer: **Amit Ku Yadav** | Verticals: Hospitality, Legal, Youth/NGO

---

## Platform Map — 10 Phases

| Phase | Name | What It Does | Status |
|---|---|---|---|
| 1 | Core Engine | Orders, payments, routing, refunds | ✅ Done |
| 2 | Merchant Dashboard | Analytics, session auth, UI | ✅ Done |
| 3 | Payment Links & Pages | Fixed/range/open amounts, partial payments | ✅ Done |
| 4 | Subscriptions | Plans, billing cycles, retry logic | ✅ Done |
| 5 | Payouts | Contacts, fund accounts, penny drop, payout links | ✅ Done |
| 6 | Analytics | Settlement recons, GMV trends, reporting | ✅ Done |
| 7 | APIs & SDKs | Node.js SDK, idempotency, webhook signing | ✅ Done |
| 8 | Marketplace / Route | Linked accounts, transfers, escrow, commissions | ✅ Done |
| 9 | Developer Experience | API logs, test scenarios, status page, SDK v2 | ✅ Done |
| 10 | Compliance / Risk / Fraud | Fraud engine, AML, chargebacks, rolling reserve | ✅ Done |

---

## Quick Start

```bash
npm install
cp .env.example .env
node src/app.js
# Server on http://localhost:3000
# Health: GET /health → { version: "v10" }
```

### First API Call

```bash
# 1. Register merchant
curl -X POST http://localhost:3000/v1/merchants \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Store","email":"me@store.com","password":"Secret123!","business_name":"My Store Pvt Ltd"}'

# 2. Create order
curl -X POST http://localhost:3000/v1/orders \
  -H 'Content-Type: application/json' \
  -u "key_id:key_secret" \
  -d '{"amount":50000,"currency":"INR","customer_name":"Rahul Sharma"}'

# 3. Capture payment
curl -X POST http://localhost:3000/v1/payments \
  -H 'Content-Type: application/json' \
  -u "key_id:key_secret" \
  -d '{"order_id":"order_xxx","method":"upi"}'
```

---

## API Reference

### Core

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/orders` | Create order |
| GET | `/v1/orders/:id` | Fetch order |
| POST | `/v1/payments` | Capture payment (with optional `route[]` for marketplace splits) |
| GET | `/v1/payments/:id` | Fetch payment |
| POST | `/v1/payments/:id/refund` | Refund payment |
| GET | `/v1/refunds` | List refunds |
| GET | `/v1/settlements` | List settlements |

### Subscriptions

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/plans` | Create plan |
| POST | `/v1/subscriptions` | Create subscription |
| POST | `/v1/subscriptions/:id/cancel` | Cancel |
| POST | `/v1/subscriptions/:id/pause` | Pause |
| POST | `/v1/subscriptions/:id/resume` | Resume |

### Payouts

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/contacts` | Create contact |
| POST | `/v1/fund_accounts` | Create fund account (bank/VPA) |
| POST | `/v1/fund_accounts/:id/penny_drop` | Verify account |
| POST | `/v1/payouts` | Create payout |
| POST | `/v1/payouts/:id/approve` | Approve payout |
| POST | `/v1/payout_links` | Create payout link |

### Marketplace / Route

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/linked_accounts` | Create seller account |
| POST | `/v1/linked_accounts/:id/activate` | Activate KYC |
| POST | `/v1/transfers` | Transfer to seller |
| POST | `/v1/transfers/:id/release` | Release on-hold transfer |
| POST | `/v1/transfers/:id/reversals` | Reverse transfer |
| POST | `/v1/escrows` | Fund escrow |
| POST | `/v1/escrows/:id/release` | Release escrow to seller |
| POST | `/v1/escrows/:id/dispute` | Raise dispute |
| GET | `/v1/marketplace/analytics/summary` | GMV, commissions, escrow summary |
| GET | `/v1/marketplace/analytics/top_sellers` | Top sellers by volume |

### Compliance / Risk / Fraud (Phase 10)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/compliance/dashboard` | Risk score + KYC + chargeback + AML summary |
| GET | `/v1/compliance/kyc` | KYC tier and transaction limits |
| POST | `/v1/compliance/kyc/upgrade` | Upgrade KYC tier |
| GET | `/v1/compliance/reports/rbi/:year/:month` | RBI PA monthly report |
| GET | `/v1/compliance/aml/alerts` | AML alerts (structuring, volume spike, etc.) |
| GET | `/v1/compliance/reserves` | Rolling reserve balance and history |
| GET | `/v1/fraud/rules` | Active fraud rules |
| POST | `/v1/fraud/rules` | Create custom fraud rule |
| GET | `/v1/fraud/blacklists` | View blacklists |
| POST | `/v1/fraud/blacklists` | Block IP / card BIN / email |
| GET | `/v1/fraud/events` | Per-transaction fraud log |
| GET | `/v1/fraud/stats` | 7-day fraud stats and top signals |
| POST | `/v1/chargebacks` | File a chargeback |
| GET | `/v1/chargebacks/ratio` | Live ratio with Visa VDMP breach flag |
| POST | `/v1/chargebacks/:id/evidence` | Submit dispute evidence |
| POST | `/v1/chargebacks/:id/resolve` | Resolve chargeback (won/lost/auto_reversed) |

### Developer Tools

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/developer/logs` | API request log (paginated, filterable) |
| GET | `/v1/developer/stats` | Integration health (error rate, latency, webhook delivery) |
| GET | `/v1/developer/test_scenarios` | Test card numbers and UPI handles |
| POST | `/v1/developer/webhooks/test` | Test webhook delivery to any endpoint |
| GET | `/v1/developer/changelog` | API version history |
| GET | `/status` | Public system status page |

---

## Test Scenarios (Test Mode)

### Test Card Numbers

| Card Number | Outcome | Reason |
|---|---|---|
| `4111111111111111` | Success | Standard successful payment |
| `4000000000000002` | Fail | Insufficient funds |
| `4000000000000069` | Fail | Card declined by issuer |
| `4000000000003220` | Success | 3DS auto-authenticated in test mode |
| `4000000000009995` | Fail | Network timeout simulation |
| `4000000000000077` | Success | International card — FX applied |

### Test UPI Handles

| UPI Handle | Outcome |
|---|---|
| `success@yourbank` | Instant success |
| `failure@yourbank` | Instant failure |
| `pending@yourbank` | Simulated as immediate success |
| `timeout@yourbank` | Timeout simulation |

### Usage

```bash
curl -X POST /v1/payments \
  -d '{"order_id":"ord_xxx","method":"card","card_number":"4000000000000002"}'
# Returns: { status: "failed", failure_reason: "insufficient_funds" }
```

---

## Architecture

```
src/
├── app.js                    # Express app, routes, background jobs
├── db/
│   ├── schema.sql            # Base schema
│   └── database.js           # getDb() + all inline migrations (Phases 7–10)
├── middleware/
│   ├── auth.js               # API key auth (Basic HTTP)
│   ├── rateLimiter.js        # 600 req/min sliding window
│   ├── idempotency.js        # X-Idempotency-Key support
│   └── apiLogger.js          # Request/response logging to DB
├── systems/
│   ├── order.js              # Order state machine
│   ├── refund.js             # Refund engine
│   ├── settlement.js         # T+2 batch settlement + rolling reserve hook
│   ├── routing.js            # Payment processor selection
│   ├── webhook.js            # Webhook queue + delivery
│   ├── signature.js          # HMAC-SHA256 webhook signing
│   └── test_scenarios.js     # Test card/UPI outcome resolution
├── fraud/                    # Phase 10: Fraud Engine
│   ├── checker.js            # Orchestrator — fails open on error
│   ├── blacklist.js          # IP/card/email/phone block lists
│   ├── velocity.js           # Velocity rules (rate-of-change signals)
│   ├── rules_engine.js       # Configurable if/then rules
│   └── tokenizer.js          # PCI-DSS AES-256-GCM card tokenization
├── risk/                     # Phase 10: Risk Management
│   ├── merchant_score.js     # 0–100 risk score, auto reserve %
│   ├── rolling_reserve.js    # Hold % of settlement for 180 days
│   └── chargebacks.js        # Dispute lifecycle + 0.65% Visa VDMP check
├── compliance/               # Phase 10: Regulatory Compliance
│   ├── aml.js                # AML pattern detection (structuring, volume spike)
│   └── reporter.js           # KYC limits, RBI monthly report
├── marketplace/              # Phase 8: Multi-party payments
│   ├── accounts.js           # Linked accounts CRUD + KYC lifecycle
│   ├── transfers.js          # Transfer engine + route splits + reversals
│   ├── escrow.js             # Escrow state machine + auto-release
│   ├── commission.js         # Commission calculation (fixed/flat/hybrid)
│   ├── hold_release.js       # Background job: release on-hold transfers
│   └── analytics.js          # GMV trend, top sellers, seller health
├── routes/                   # All Express routers
├── links/                    # Phase 3: Payment links
├── subscriptions/            # Phase 4: Subscription billing
├── payouts/                  # Phase 5: Payout engine
├── analytics/                # Phase 6: Analytics engine
└── dashboard/                # Phase 2: Dashboard API + session auth

sdk/
└── payengine.js              # Node.js SDK v2.0 (auto-retry, auto-idempotency, mock mode)

public/
├── dashboard.html            # Merchant dashboard SPA
├── checkout.html             # Payment link checkout page
├── payout_claim.html         # Payout claim page
└── js/exit-popup.js          # Shared exit confirmation popup
```

---

## Background Jobs

| Job | Interval | Purpose |
|---|---|---|
| `expireOverdueLinks` | 60s | Expire payment links past due date |
| `runBillingCycle` | 60s | Charge due subscriptions |
| `runPayoutCycle` | 30s | Process approved payouts |
| `runSettlementCycle` | 1hr | Batch T+2 settlements |
| `runWebhookDelivery` | 10s | Deliver queued webhook events |
| `runEscrowAutoRelease` | 60s | Release escrows past auto_release_at |
| `runTransferHoldRelease` | 60s | Release on-hold transfers past hold_until |
| `releaseMaturedReserves` | 1hr | Release rolling reserves after 180 days |

---

## SDK Usage

```javascript
const PayEngine = require('./sdk/payengine');

const client = new PayEngine('key_id', 'key_secret', {
  baseUrl:        'http://localhost:3000',
  maxRetries:     3,       // auto-retry on 5xx with exponential backoff
  autoIdempotency: true,   // auto X-Idempotency-Key on POST/PATCH
  mode:           'live',  // or 'mock' for unit tests without network
});

// Create order
const order = await client.orders.create({ amount: 50000, currency: 'INR' });

// Capture payment with route split
const payment = await client.payments.create({
  order_id: order.id,
  method: 'upi',
  route: [{ linked_account_id: 'la_xxx', amount: 40000 }],
});

// Marketplace
const seller = await client.linkedAccounts.create({ name: 'Seller', commission_type: 'fixed_pct', commission_pct: 2 });
await client.linkedAccounts.activate(seller.id);

// Verify webhook signature
const isValid = PayEngine.verifyWebhook(rawBody, req.headers['x-gateway-signature'], webhookSecret);
```

---

## Database Tables (37 total)

```
Core:          merchants, api_keys, orders, payments, refunds
               settlements, settlement_items, webhook_events, webhook_endpoints
               merchant_sessions

Subscriptions: plans, subscriptions, subscription_invoices, customers

Payouts:       contacts, fund_accounts, payouts, payout_batches, payout_batch_items
               payout_links, payout_link_claims

Links:         payment_links, payment_link_payments

Marketplace:   linked_accounts, route_splits, transfers, transfer_reversals, escrows

Dev Tools:     api_request_logs, webhook_delivery_log, idempotency_keys

Phase 10:      fraud_rules, blacklists, fraud_events, chargebacks
               rolling_reserves, merchant_risk, aml_alerts
```

---

## Compliance Reference

### KYC Tiers (RBI PA Guidelines)

| Tier | Transaction Limit | Documents Required |
|---|---|---|
| Tier 1 | ₹10,000 per txn | Name + phone |
| Tier 2 | ₹1,00,000 per txn | PAN + Aadhaar + bank account |
| Tier 3 | No limit | GST + CIN + director KYC + business proof |

### Chargeback Thresholds

| Level | Threshold | Consequence |
|---|---|---|
| Elevated | ≥ 0.65% ratio AND ≥10 disputes/month | Visa VDMP monitoring program |
| High | ≥ 1% | Enhanced monitoring |
| Critical | ≥ 2% | Visa/MC may terminate acquiring |

### AML Patterns Detected Automatically

| Pattern | Trigger |
|---|---|
| Structuring | 3+ transactions between ₹8.5L–₹10L in 7 days |
| Volume spike | Today's volume > 3x 30-day average |
| Round amounts | 5+ round-number large transactions in 24h |
| Repeated amounts | Same exact amount 5+ times in 1 hour |

---

## Indian Payments Industry — Gaps & Future Opportunities

> Documented 2026-06-01. These are the real unsolved problems.
> Pick one. Go deep. Build something that can't be ignored.

---

### Gap 1: Payment Success Rates Are Embarrassing

**Industry average: 75–80% success rate. 20–25 in 100 payments fail.**

The customer tries to pay → payment fails → customer leaves → merchant loses the sale. This is the single biggest unsolved problem in Indian payments.

**Why it's broken:**
- Bank servers go down randomly
- NPCI has peak-hour congestion
- Routing engines use historical success rates, not real-time health
- Retry logic is poorly implemented
- Error messages are meaningless to customers

**What's needed:**
AI-powered routing that predicts which bank will succeed *right now* — based on live latency signals, live error rates, per bank, per payment method, per time of day. Not historical averages. Live intelligence.

**Upgrade path for this platform:**
```
src/systems/routing.js → replace static routing with live bank health scores
New: src/systems/bank_health_monitor.js → poll bank APIs every 30s
New: POST /v1/payments → smart retry with method fallback + reason messaging
```

---

### Gap 2: Payment Failure UX is Terrible

**Current state:** "Transaction failed. Please try again." Full stop.

Customer has no idea: Was I charged? Should I retry? Which method works right now? Is my money safe?

**What's needed:**
```
"Your UPI app timed out. Your money is safe — not deducted.
Try paying with your HDFC card instead — HDFC is working perfectly right now."
```

Specific. Helpful. Method-aware. Bank-aware. Builds trust. Zero players do this today.

**Upgrade path:**
```
New: failure_reason in payment response (already started in Phase 10)
New: src/systems/failure_advisor.js → maps failure codes to actionable messages
New: GET /v1/payments/:id/alternatives → suggest best alternative method right now
```

---

### Gap 3: Reconciliation is Still Manual

**Every finance team in India reconciles manually — 2 people full-time at mid-size companies.**

The problem: Gateway files (Excel) + Bank MIS (different Excel) + Accounting software (third format) → manual matching every day. Errors happen. Money gets lost in the gaps. Monthly close takes 2–3 days.

**What's needed:**
Automated reconciliation engine:
- Ingest all three data sources
- Auto-match transactions by UTR/amount/date
- Flag only genuine exceptions
- One-click month-end close

**This is the biggest B2B SaaS opportunity in Indian fintech right now.**

**Upgrade path:**
```
New: src/reconciliation/ module
New: POST /v1/recon/import → accept bank MIS CSV/Excel upload
New: GET /v1/recon/exceptions → only show unmatched transactions
New: GET /v1/recon/report → auto-generated month-end report
```

---

### Gap 4: Embedded Lending is Untapped

**Small merchant processes ₹5L/month. Needs ₹2L loan. Bank rejects — no collateral.**

But the payment gateway already has 12 months of transaction data: monthly revenue, consistency, growth trend, seasonality, customer retention. Perfect credit underwriting data. Sitting unused.

**What's needed:**
```
"You've processed ₹5L consistently for 8 months.
You qualify for ₹1.5L at 1.2% monthly. Accept?"
One click. Instant disbursal.
Repayment auto-deducted from daily settlements.
```

**Upgrade path:**
```
New: src/lending/ module
New: GET /v1/lending/eligibility → score based on transaction history
New: POST /v1/lending/apply → instant credit decision
New: Repayment deducted in src/systems/settlement.js before net payout
```

---

### Gap 5: International Payments are a Nightmare

Indian freelancers and SaaS companies trying to accept USD face weeks of verification, FEMA compliance confusion, complex repatriation rules, and expensive FX rates.

**What's needed:**
One platform handling:
- Accept payments in 50 currencies
- Auto-convert to INR at live rates
- RBI compliance built-in
- Auto-generated FEMA documentation
- GST on exports handled automatically

**Upgrade path:**
```
New: src/international/ module
New: src/compliance/fema.js → auto-generate Form A2, FIRC
New: currency support in orders table (currently INR-only)
New: FX rate feed integration
```

---

### Gap 6: Bharat is Completely Underserved

**100 million small merchants in India. Only 10 million use digital payments. 90 million are untouched.**

Razorpay, Cashfree, PayU were built for urban, English-speaking, tech-savvy users. The other 90M merchants: Hindi/regional language first, never used a dashboard, trust only people they know, many on feature phones.

**What's needed:**
- Full Hindi + 8 regional language UI
- Voice-based merchant onboarding
- WhatsApp-based dashboard (check sales by WhatsApp message)
- Feature phone USSD payments
- Assisted onboarding via local agents
- Vernacular customer support

**This is the vertical opportunity for someone with ground-level market knowledge.**

---

### Gap 7: Subscription Infrastructure is Primitive

**UPI AutoPay limit: ₹15,000/month. Above that → manual approval every single month.**

Enterprise SaaS at ₹50,000/month = customer must manually approve every cycle. One missed approval = subscription failure = churn.

**What's needed:**
Fallback orchestration:
```
UPI AutoPay fails → try eNACH → try credit card SI → notify customer
```
Nobody has built this properly. The platform already has subscription infrastructure (Phase 4) — this is an extension.

**Upgrade path:**
```
src/subscriptions/billing.js → add payment method fallback chain
New: POST /v1/subscriptions/:id/payment_methods → priority-ordered list
Automatic failover with customer notification webhook
```

---

### Gap 8: Dispute Resolution is Merchant-Hostile

**Bank almost always sides with customer. Merchant has no visibility, no reasoning, no appeal. High chargebacks = account terminated.**

**What's needed:**
- Auto-collect evidence from merchant systems (order data, delivery logs, IP records)
- AI-generated dispute response letters
- Win probability prediction before submitting
- Track dispute patterns per bank
- Industry-level dispute data sharing

**Upgrade path:**
```
src/risk/chargebacks.js → add evidence auto-collection hooks
New: POST /v1/chargebacks/:id/ai_response → generate dispute letter from transaction data
New: GET /v1/chargebacks/:id/win_probability → ML-based prediction
```

---

### Gap 9: No Unified Online + Offline Analytics

Merchant has: online store + physical POS + WhatsApp orders + phone orders. Revenue data in 4 different places. Nobody sees: "online sales spike when it rains, physical store drops."

**What's needed:**
- All channels → one dashboard
- Single customer view across channels
- Cross-channel attribution
- Inventory sync
- Unified loyalty program

**Upgrade path:**
```
New: POST /v1/pos/transactions → ingest offline POS data
New: src/analytics/unified.js → merge online + offline into one view
New: GET /v1/analytics/customers/:id → cross-channel customer journey
```

---

### Gap 10: Trust Infrastructure Doesn't Exist

Cash is still 60% of transactions by value in India. COD still dominant. Senior citizens scared of online fraud. Rural merchants don't trust gateways.

**What's needed:**
A national merchant trust layer — visible to customers before they pay:
```
"This merchant has processed 10,000 payments
with 98.7% satisfaction. Verified by MCA.
In business since 2019."
```

Requires industry + government collaboration. Whoever builds it changes consumer behavior permanently.

---

## The Three Biggest Build Opportunities

### Opportunity 1: Reconciliation Automation
- **Target:** Every finance team in India
- **Pain level:** Massive, daily, expensive
- **Competition:** Almost none
- **Model:** B2B SaaS, not a gateway feature
- **Moat:** Data + integrations

### Opportunity 2: Bharat Merchant Onboarding
- **Target:** 90M undigitized merchants
- **Pain level:** Language + trust + complexity
- **Competition:** Nobody doing it right
- **Model:** Regional language + WhatsApp-first + agent network
- **Moat:** Distribution and language

### Opportunity 3: Embedded Lending
- **Target:** Merchants already on your platform
- **Pain level:** Credit access is broken for small business
- **Competition:** Razorpay Capital (limited), PayU Finance (expensive)
- **Model:** Built on your own transaction data
- **Moat:** Data advantage is insurmountable for outsiders

---

## Personal Context

**Developer:** Amit Ku Yadav
**Vertical experience:**
- Hospitality → Royal Heritage Resort (payment chaos: OTA + direct + POS)
- Legal → Jhon Aamit LLP (B2B invoicing, delayed payments, reconciliation pain)
- Youth/NGO → National Youth Force (donation flows, compliance, trust)

**Real opportunity:** Not building another generic Razorpay.

Pick one gap. Pick the vertical you know deepest. Build it so well that merchants in that vertical cannot imagine life without it.

Example specific to your experience:
> "Reconciliation automation for hotels"
> Every hotel has payment chaos: multiple OTAs + direct booking + POS + room service.
> Nobody reconciles it automatically.
> You understand hotels.
> You can build this better than anyone who doesn't.

---

## Version History

| Version | Date | Highlights |
|---|---|---|
| v10 | 2026-06-01 | Fraud engine, AML, chargebacks, rolling reserve, KYC enforcement, PCI tokenization |
| v9 | 2026-05-31 | API logger, test scenarios, developer tools, status page, SDK v2 (auto-retry, mock mode) |
| v8 | 2026-05-31 | Marketplace / Route: linked accounts, transfers, escrow, commissions, marketplace analytics |
| v7 | 2026-05-30 | Node.js SDK, idempotency keys, HMAC webhook signing, webhook delivery background job |
| v6 | 2026-05-29 | Settlement reconciliation, dashboard analytics, subscription/payout analytics |
| v5 | 2026-05-28 | Payouts, fund accounts, penny drop, payout links |
| v4 | 2026-05-27 | Subscriptions, billing cycles, retry logic, pause/resume/cancel |
| v3 | 2026-05-26 | Payment links (fixed/range/open), partial payments, checkout SPA |
| v2 | 2026-05-25 | T+2 settlements, webhook delivery, refunds |
| v1 | 2026-05-24 | Core payment engine: orders, payments, routing, API auth, rate limiting |

---

## What This Platform Is Not (Yet)

- Not PCI-DSS certified (tokenizer pattern is correct, full certification requires QSA audit)
- Not RBI PA licensed (requires 12–18 month government approval process)
- Not connected to real bank APIs (all processing is simulated)
- Not multi-region / horizontally scalable (SQLite is single-node by design for now)
- Not DPDP Act 2023 certified (data minimization + consent management not yet implemented)
- ML-based fraud scoring not yet implemented (rules engine is the current approach)

These are the Phase 11+ items when real volume and licensing are in scope.

---

*Built in 2 days. Complete blueprint for a production-grade Indian payment platform.*
*Everything Razorpay built over 10 years — mapped, understood, and implemented as a developer.*
