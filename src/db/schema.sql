CREATE TABLE IF NOT EXISTS merchants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  webhook_url TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  key_id      TEXT UNIQUE NOT NULL,   -- public:  key_xxxxxxxxxxxxxxxx
  key_secret  TEXT NOT NULL,          -- private: stored as sha256 hash
  is_active   INTEGER DEFAULT 1,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  amount         INTEGER NOT NULL,    -- in paise (₹1 = 100 paise)
  currency       TEXT DEFAULT 'INR',
  status         TEXT DEFAULT 'created', -- created | attempted | paid | failed | expired
  customer_name  TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  notes          TEXT,                -- JSON string
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id),
  merchant_id       TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT DEFAULT 'INR',
  method            TEXT,             -- upi | card | netbanking | wallet
  status            TEXT DEFAULT 'created', -- created | authorized | captured | failed | refunded
  processor         TEXT,             -- which PSP handled it
  processor_ref     TEXT,             -- processor's own transaction ID
  error_code        TEXT,
  error_description TEXT,
  captured_at       INTEGER,
  created_at        INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL,
  event        TEXT NOT NULL,         -- payment.captured | payment.failed | order.paid
  payload      TEXT NOT NULL,         -- JSON string
  status       TEXT DEFAULT 'pending', -- pending | delivered | failed
  attempts     INTEGER DEFAULT 0,
  next_retry_at INTEGER,
  delivered_at  INTEGER,
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  created_at  INTEGER DEFAULT (unixepoch()),
  UNIQUE(merchant_id, email)
);

CREATE TABLE IF NOT EXISTS plans (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  name              TEXT NOT NULL,
  description       TEXT,
  amount            INTEGER NOT NULL,   -- in paise
  currency          TEXT DEFAULT 'INR',
  interval          TEXT NOT NULL,      -- daily | weekly | monthly | yearly
  interval_count    INTEGER DEFAULT 1,  -- every N intervals
  total_count       INTEGER,            -- NULL = forever
  trial_period_days INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'active', -- active | archived
  created_at        INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  status        TEXT DEFAULT 'created',
  -- created | authenticated | active | paused | halted | cancelled | completed
  mandate_type  TEXT DEFAULT 'upi_autopay',
  current_cycle INTEGER DEFAULT 0,
  paid_count    INTEGER DEFAULT 0,
  total_count   INTEGER,               -- overrides plan if set
  start_at      INTEGER NOT NULL,
  charge_at     INTEGER,               -- next charge timestamp
  trial_end_at  INTEGER,
  cancelled_at  INTEGER,
  notes         TEXT,
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  merchant_id     TEXT NOT NULL,
  cycle_number    INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  currency        TEXT DEFAULT 'INR',
  status          TEXT DEFAULT 'pending', -- pending | paid | failed | waived
  payment_id      TEXT,
  due_at          INTEGER NOT NULL,
  paid_at         INTEGER,
  retry_count     INTEGER DEFAULT 0,
  next_retry_at   INTEGER,
  created_at      INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_plans_merchant     ON plans(merchant_id);
CREATE INDEX IF NOT EXISTS idx_subs_merchant      ON subscriptions(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_charge        ON subscriptions(charge_at, status);
CREATE INDEX IF NOT EXISTS idx_invoices_sub       ON subscription_invoices(subscription_id);
CREATE INDEX IF NOT EXISTS idx_invoices_retry     ON subscription_invoices(status, next_retry_at);

CREATE TABLE IF NOT EXISTS payment_links (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  code            TEXT UNIQUE NOT NULL,   -- short code "abc12345"
  type            TEXT DEFAULT 'link',    -- link | page
  title           TEXT NOT NULL,
  description     TEXT,
  image_url       TEXT,
  amount          INTEGER,               -- NULL = customer fills
  amount_type     TEXT DEFAULT 'fixed',  -- fixed | open | range
  min_amount      INTEGER,
  max_amount      INTEGER,
  currency        TEXT DEFAULT 'INR',
  allow_partial   INTEGER DEFAULT 0,
  amount_paid     INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'active', -- active | partially_paid | paid | expired | deactivated
  customer_name   TEXT,
  customer_email  TEXT,
  customer_phone  TEXT,
  custom_fields   TEXT,                  -- JSON array of field definitions (pages only)
  max_payments    INTEGER,               -- NULL = unlimited
  payment_count   INTEGER DEFAULT 0,
  expires_at      INTEGER,               -- NULL = never expires
  success_message TEXT,
  redirect_url    TEXT,
  created_at      INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS link_payments (
  id          TEXT PRIMARY KEY,
  link_id     TEXT NOT NULL REFERENCES payment_links(id),
  payment_id  TEXT REFERENCES payments(id),
  order_id    TEXT REFERENCES orders(id),
  amount      INTEGER NOT NULL,
  status      TEXT DEFAULT 'pending',    -- pending | paid | failed
  payer_name  TEXT,
  payer_email TEXT,
  payer_phone TEXT,
  form_data   TEXT,                      -- JSON: custom field responses
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_links_merchant ON payment_links(merchant_id);
CREATE INDEX IF NOT EXISTS idx_links_code     ON payment_links(code);
CREATE INDEX IF NOT EXISTS idx_link_payments  ON link_payments(link_id);

CREATE TABLE IF NOT EXISTS merchant_sessions (
  token       TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_orders_merchant   ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_webhook_pending   ON webhook_events(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_sessions_merchant ON merchant_sessions(merchant_id);

-- ── Phase 5: Payouts ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  type        TEXT DEFAULT 'vendor',  -- vendor | employee | customer | self
  gstin       TEXT,
  notes       TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS fund_accounts (
  id              TEXT PRIMARY KEY,
  contact_id      TEXT NOT NULL REFERENCES contacts(id),
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  account_type    TEXT NOT NULL,   -- bank_account | vpa
  bank_name       TEXT,
  account_number  TEXT,
  ifsc            TEXT,
  account_holder  TEXT,
  vpa             TEXT,
  verified        INTEGER DEFAULT 0,
  penny_drop_id   TEXT,
  active          INTEGER DEFAULT 1,
  created_at      INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS payouts (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  fund_account_id   TEXT NOT NULL REFERENCES fund_accounts(id),
  contact_id        TEXT NOT NULL REFERENCES contacts(id),
  amount            INTEGER NOT NULL,    -- in paise
  currency          TEXT DEFAULT 'INR',
  mode              TEXT NOT NULL,       -- IMPS | NEFT | RTGS | UPI
  purpose           TEXT DEFAULT 'payout',
  status            TEXT DEFAULT 'queued',
  -- queued | processing | processed | failed | reversed | cancelled | pending_approval
  utr               TEXT,
  failure_reason    TEXT,
  reference_id      TEXT,
  narration         TEXT,
  notes             TEXT,
  requires_approval INTEGER DEFAULT 0,
  approved_by       TEXT,
  approved_at       INTEGER,
  queued_at         INTEGER,
  processing_at     INTEGER,
  processed_at      INTEGER,
  failed_at         INTEGER,
  created_at        INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS payout_links (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  code        TEXT UNIQUE NOT NULL,
  amount      INTEGER NOT NULL,
  currency    TEXT DEFAULT 'INR',
  purpose     TEXT DEFAULT 'payout',
  description TEXT,
  contact_id  TEXT REFERENCES contacts(id),
  status      TEXT DEFAULT 'pending', -- pending | processing | processed | cancelled | expired
  expires_at  INTEGER,
  payout_id   TEXT REFERENCES payouts(id),
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS payout_batches (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  name          TEXT NOT NULL,
  description   TEXT,
  total_count   INTEGER DEFAULT 0,
  total_amount  INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count  INTEGER DEFAULT 0,
  pending_count INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'draft', -- draft | validating | processing | completed | failed
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS payout_batch_items (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES payout_batches(id),
  merchant_id     TEXT NOT NULL,
  fund_account_id TEXT REFERENCES fund_accounts(id),
  contact_id      TEXT REFERENCES contacts(id),
  name            TEXT,
  account_number  TEXT,
  ifsc            TEXT,
  vpa             TEXT,
  amount          INTEGER NOT NULL,
  purpose         TEXT DEFAULT 'payout',
  reference_id    TEXT,
  narration       TEXT,
  payout_id       TEXT REFERENCES payouts(id),
  status          TEXT DEFAULT 'pending', -- pending | queued | processed | failed
  error           TEXT,
  created_at      INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_contacts_merchant   ON contacts(merchant_id);
CREATE INDEX IF NOT EXISTS idx_fund_accts_contact  ON fund_accounts(contact_id, merchant_id);
CREATE INDEX IF NOT EXISTS idx_payouts_merchant    ON payouts(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_payouts_fund_acc    ON payouts(fund_account_id);
CREATE INDEX IF NOT EXISTS idx_payouts_queued      ON payouts(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_pout_links_code     ON payout_links(code);
CREATE INDEX IF NOT EXISTS idx_pout_links_merchant ON payout_links(merchant_id);
CREATE INDEX IF NOT EXISTS idx_pout_batches        ON payout_batches(merchant_id);
CREATE INDEX IF NOT EXISTS idx_pout_batch_items    ON payout_batch_items(batch_id);
