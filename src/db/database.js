const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/payments.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');  // WAL mode: reads don't block writes
    db.pragma('foreign_keys = ON');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
    // Migrations
    try { db.exec('ALTER TABLE merchants ADD COLUMN password_hash TEXT'); } catch {}
    try { db.exec('CREATE UNIQUE INDEX idx_invoices_unique_cycle ON subscription_invoices(subscription_id, cycle_number)'); } catch {}
    try { db.exec('ALTER TABLE subscription_invoices ADD COLUMN merchant_id TEXT'); } catch {}

    // Phase 7: idempotency keys
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idem_key    TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        req_hash    TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response    TEXT NOT NULL,
        created_at  INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (idem_key, merchant_id)
      )
    `); } catch {}

    // Phase 7: refunds
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS refunds (
        id           TEXT PRIMARY KEY,
        payment_id   TEXT NOT NULL REFERENCES payments(id),
        merchant_id  TEXT NOT NULL,
        amount       INTEGER NOT NULL,
        currency     TEXT DEFAULT 'INR',
        status       TEXT DEFAULT 'pending',
        speed        TEXT DEFAULT 'normal',
        notes        TEXT,
        created_at   INTEGER DEFAULT (unixepoch()),
        processed_at INTEGER
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_refunds_merchant ON refunds(merchant_id)'); } catch {}

    // Phase 7: settlements
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        id          TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        fees        INTEGER DEFAULT 0,
        tax         INTEGER DEFAULT 0,
        utr         TEXT,
        status      TEXT DEFAULT 'pending',
        settled_at  INTEGER,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_items (
        id              TEXT PRIMARY KEY,
        settlement_id   TEXT NOT NULL REFERENCES settlements(id),
        entity_type     TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        amount          INTEGER NOT NULL,
        fee             INTEGER DEFAULT 0,
        tax             INTEGER DEFAULT 0,
        created_at      INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_settlements_merchant ON settlements(merchant_id)'); } catch {}
    try { db.exec('ALTER TABLE payments ADD COLUMN settled_at INTEGER'); } catch {}
    try { db.exec('ALTER TABLE refunds ADD COLUMN settled_at INTEGER'); } catch {}

    // Phase 7: webhook endpoints (multi-URL per merchant)
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id          TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id),
        url         TEXT NOT NULL,
        secret      TEXT NOT NULL,
        events      TEXT NOT NULL DEFAULT '*',
        is_active   INTEGER DEFAULT 1,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_webhook_ep_merchant ON webhook_endpoints(merchant_id)'); } catch {}

    // Phase 8: Marketplace / Route
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS linked_accounts (
        id               TEXT PRIMARY KEY,
        merchant_id      TEXT NOT NULL REFERENCES merchants(id),
        name             TEXT NOT NULL,
        email            TEXT,
        phone            TEXT,
        business_name    TEXT,
        business_type    TEXT DEFAULT 'individual',
        status           TEXT DEFAULT 'created',
        kyc_status       TEXT DEFAULT 'pending',
        commission_type  TEXT DEFAULT 'fixed_pct',
        commission_pct   REAL DEFAULT 0,
        commission_flat  INTEGER DEFAULT 0,
        notes            TEXT,
        created_at       INTEGER DEFAULT (unixepoch()),
        updated_at       INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_linked_accts_merchant ON linked_accounts(merchant_id)'); } catch {}

    try { db.exec(`
      CREATE TABLE IF NOT EXISTS route_splits (
        id                TEXT PRIMARY KEY,
        payment_id        TEXT NOT NULL REFERENCES payments(id),
        merchant_id       TEXT NOT NULL,
        linked_account_id TEXT NOT NULL REFERENCES linked_accounts(id),
        amount            INTEGER NOT NULL,
        commission        INTEGER NOT NULL DEFAULT 0,
        net_amount        INTEGER NOT NULL,
        currency          TEXT DEFAULT 'INR',
        on_hold           INTEGER DEFAULT 0,
        hold_until        INTEGER,
        transfer_id       TEXT,
        status            TEXT DEFAULT 'created',
        created_at        INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_route_splits_payment  ON route_splits(payment_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_route_splits_la       ON route_splits(linked_account_id)'); } catch {}

    try { db.exec(`
      CREATE TABLE IF NOT EXISTS transfers (
        id                TEXT PRIMARY KEY,
        merchant_id       TEXT NOT NULL,
        payment_id        TEXT REFERENCES payments(id),
        linked_account_id TEXT NOT NULL REFERENCES linked_accounts(id),
        amount            INTEGER NOT NULL,
        commission        INTEGER NOT NULL DEFAULT 0,
        net_amount        INTEGER NOT NULL,
        currency          TEXT DEFAULT 'INR',
        on_hold           INTEGER DEFAULT 0,
        hold_until        INTEGER,
        status            TEXT DEFAULT 'pending',
        source            TEXT DEFAULT 'transfer',
        notes             TEXT,
        created_at        INTEGER DEFAULT (unixepoch()),
        processed_at      INTEGER
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_merchant    ON transfers(merchant_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_payment     ON transfers(payment_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_la          ON transfers(linked_account_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_transfers_hold        ON transfers(status, hold_until)'); } catch {}

    try { db.exec(`
      CREATE TABLE IF NOT EXISTS transfer_reversals (
        id           TEXT PRIMARY KEY,
        transfer_id  TEXT NOT NULL REFERENCES transfers(id),
        merchant_id  TEXT NOT NULL,
        amount       INTEGER NOT NULL,
        currency     TEXT DEFAULT 'INR',
        reason       TEXT,
        notes        TEXT,
        status       TEXT DEFAULT 'processed',
        created_at   INTEGER DEFAULT (unixepoch()),
        processed_at INTEGER
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_trev_transfer ON transfer_reversals(transfer_id)'); } catch {}

    try { db.exec(`
      CREATE TABLE IF NOT EXISTS escrows (
        id                TEXT PRIMARY KEY,
        merchant_id       TEXT NOT NULL,
        payment_id        TEXT REFERENCES payments(id),
        linked_account_id TEXT NOT NULL REFERENCES linked_accounts(id),
        amount            INTEGER NOT NULL,
        currency          TEXT DEFAULT 'INR',
        status            TEXT DEFAULT 'funded',
        description       TEXT,
        auto_release_at   INTEGER,
        dispute_reason    TEXT,
        notes             TEXT,
        created_at        INTEGER DEFAULT (unixepoch()),
        released_at       INTEGER,
        refunded_at       INTEGER,
        disputed_at       INTEGER
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrows_merchant     ON escrows(merchant_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrows_la           ON escrows(linked_account_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_escrows_auto_release ON escrows(status, auto_release_at)'); } catch {}

    // Phase 9: API request logs
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS api_request_logs (
        id          TEXT PRIMARY KEY,
        merchant_id TEXT,
        key_id      TEXT,
        method      TEXT NOT NULL,
        path        TEXT NOT NULL,
        query       TEXT,
        status_code INTEGER,
        latency_ms  INTEGER,
        req_body    TEXT,
        res_body    TEXT,
        ip          TEXT,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_api_logs_merchant ON api_request_logs(merchant_id, created_at)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_api_logs_created  ON api_request_logs(created_at)'); } catch {}

    // Phase 9: webhook delivery log (per-endpoint detailed log for test tool)
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_log (
        id              TEXT PRIMARY KEY,
        merchant_id     TEXT NOT NULL,
        endpoint_id     TEXT,
        event_type      TEXT NOT NULL,
        payload         TEXT NOT NULL,
        response_status INTEGER,
        response_body   TEXT,
        response_ms     INTEGER,
        error           TEXT,
        is_test         INTEGER DEFAULT 0,
        created_at      INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_wdlog_merchant ON webhook_delivery_log(merchant_id, created_at)'); } catch {}

    // Phase 10: Fraud rules engine
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS fraud_rules (
        id          TEXT PRIMARY KEY,
        merchant_id TEXT,
        name        TEXT NOT NULL,
        description TEXT,
        field       TEXT NOT NULL,
        operator    TEXT NOT NULL,
        value       TEXT NOT NULL,
        action      TEXT NOT NULL DEFAULT 'flag',
        score       INTEGER DEFAULT 25,
        is_active   INTEGER DEFAULT 1,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_rules_merchant ON fraud_rules(merchant_id, is_active)'); } catch {}

    // Phase 10: Blacklists
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS blacklists (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        value       TEXT NOT NULL,
        reason      TEXT,
        added_by    TEXT DEFAULT 'system',
        expires_at  INTEGER,
        created_at  INTEGER DEFAULT (unixepoch()),
        UNIQUE(type, value)
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_blacklists_lookup ON blacklists(type, value)'); } catch {}

    // Phase 10: Fraud events (per-transaction risk log)
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS fraud_events (
        id          TEXT PRIMARY KEY,
        payment_id  TEXT,
        merchant_id TEXT,
        risk_score  INTEGER DEFAULT 0,
        action      TEXT NOT NULL,
        signals     TEXT,
        ip          TEXT,
        card_bin    TEXT,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_events_merchant ON fraud_events(merchant_id, created_at)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_fraud_events_ip       ON fraud_events(ip, created_at)'); } catch {}

    // Phase 10: Chargebacks
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS chargebacks (
        id          TEXT PRIMARY KEY,
        payment_id  TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        currency    TEXT DEFAULT 'INR',
        reason      TEXT,
        status      TEXT DEFAULT 'open',
        evidence    TEXT,
        due_date    INTEGER,
        resolved_at INTEGER,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_chargebacks_merchant ON chargebacks(merchant_id, created_at)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_chargebacks_payment  ON chargebacks(payment_id)'); } catch {}

    // Phase 10: Rolling reserves
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS rolling_reserves (
        id             TEXT PRIMARY KEY,
        merchant_id    TEXT NOT NULL,
        settlement_id  TEXT,
        gross_amount   INTEGER NOT NULL,
        reserve_pct    INTEGER NOT NULL,
        reserve_amount INTEGER NOT NULL,
        status         TEXT DEFAULT 'held',
        hold_until     INTEGER NOT NULL,
        released_at    INTEGER,
        created_at     INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_reserves_merchant  ON rolling_reserves(merchant_id, status)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_reserves_release   ON rolling_reserves(status, hold_until)'); } catch {}

    // Phase 10: Merchant risk profiles
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_risk (
        merchant_id    TEXT PRIMARY KEY,
        risk_score     INTEGER DEFAULT 50,
        risk_level     TEXT DEFAULT 'medium',
        reserve_pct    INTEGER DEFAULT 5,
        kyc_tier       TEXT DEFAULT 'tier1',
        monthly_limit  INTEGER,
        flags          TEXT,
        last_scored_at INTEGER,
        created_at     INTEGER DEFAULT (unixepoch()),
        updated_at     INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}

    // Phase 10: AML alerts
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS aml_alerts (
        id          TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        alert_type  TEXT NOT NULL,
        description TEXT,
        metadata    TEXT,
        status      TEXT DEFAULT 'open',
        reviewed_by TEXT,
        reviewed_at INTEGER,
        created_at  INTEGER DEFAULT (unixepoch())
      )
    `); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_aml_alerts_merchant ON aml_alerts(merchant_id, status)'); } catch {}
  }
  return db;
}

module.exports = { getDb };
