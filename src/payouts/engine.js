const { randomUUID } = require('crypto');
const { getDb }         = require('../db/database');
const { queueWebhook }  = require('../systems/webhook');
const { getFundAccount } = require('./fund_accounts');

const APPROVAL_THRESHOLD = 1_000_000;   // ₹10,000 — above this needs maker-checker
const DAILY_LIMIT        = 100_000_000; // ₹10,00,000 per merchant per day
const PAYOUT_MODES       = ['IMPS', 'NEFT', 'RTGS', 'UPI'];
const PAYOUT_PURPOSES    = ['payout', 'refund', 'cashback', 'salary', 'vendor_payment', 'loan_disbursement'];

// Auto-select mode based on amount and fund account type
function autoSelectMode(amount, accountType) {
  const INR_1L = 10_000_000;  // ₹1,00,000 in paise
  const INR_5L = 50_000_000;  // ₹5,00,000 in paise
  if (accountType === 'vpa' && amount <= INR_1L) return 'UPI';
  if (amount <= INR_5L) return 'IMPS';
  return 'RTGS';
}

function _checkDailyLimit(db, merchantId, amount) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const { total } = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM payouts
    WHERE merchant_id=? AND status NOT IN ('failed','cancelled','reversed') AND created_at >= ?
  `).get(merchantId, since);
  if (total + amount > DAILY_LIMIT) {
    throw new Error(`Daily payout limit of ₹${(DAILY_LIMIT / 100).toLocaleString('en-IN')} exceeded`);
  }
}

function createPayout(merchantId, opts) {
  const {
    fund_account_id, amount, currency = 'INR',
    mode = 'auto', purpose = 'payout',
    reference_id, narration, notes,
  } = opts;

  if (!fund_account_id) throw new Error('fund_account_id is required');
  if (!amount || !Number.isInteger(amount) || amount <= 0)
    throw new Error('amount must be a positive integer in paise');
  if (currency !== 'INR') throw new Error('Only INR is supported');
  if (purpose && !PAYOUT_PURPOSES.includes(purpose))
    throw new Error(`purpose must be one of: ${PAYOUT_PURPOSES.join(', ')}`);

  const db = getDb();
  const fa = getFundAccount(fund_account_id);
  if (!fa || fa.merchant_id !== merchantId) throw new Error('Fund account not found');
  if (!fa.active) throw new Error('Fund account is inactive');
  if (fa.account_type === 'bank_account' && !fa.verified)
    throw new Error('Bank account must be penny-drop verified before first payout');

  _checkDailyLimit(db, merchantId, amount);

  const resolvedMode      = PAYOUT_MODES.includes(mode) ? mode : autoSelectMode(amount, fa.account_type);
  const requiresApproval  = amount >= APPROVAL_THRESHOLD ? 1 : 0;
  const id                = 'pout_' + randomUUID().replace(/-/g, '').slice(0, 14);
  const now               = Math.floor(Date.now() / 1000);
  const status            = requiresApproval ? 'pending_approval' : 'queued';

  db.prepare(`
    INSERT INTO payouts
      (id, merchant_id, fund_account_id, contact_id, amount, currency, mode, purpose,
       status, requires_approval, reference_id, narration, notes, queued_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, merchantId, fund_account_id, fa.contact_id, amount, currency,
    resolvedMode, purpose, status, requiresApproval,
    reference_id ?? null, narration ?? null,
    notes ? JSON.stringify(notes) : null,
    requiresApproval ? null : now);

  return getPayout(id);
}

function getPayout(id) {
  const row = getDb().prepare(`
    SELECT p.*, fa.account_type, fa.bank_name, fa.account_number, fa.ifsc, fa.vpa,
           c.name AS contact_name, c.email AS contact_email, c.type AS contact_type
    FROM payouts p
    JOIN fund_accounts fa ON p.fund_account_id = fa.id
    JOIN contacts c ON p.contact_id = c.id
    WHERE p.id=?
  `).get(id);
  if (row?.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

function listPayouts(merchantId, { status, contact_id, limit = 20, offset = 0 } = {}) {
  const db  = getDb();
  const cap = Math.min(Math.max(1, parseInt(limit) || 20), 100);
  let where = 'WHERE p.merchant_id=?';
  const params = [merchantId];
  if (status)     { where += ' AND p.status=?';     params.push(status); }
  if (contact_id) { where += ' AND p.contact_id=?'; params.push(contact_id); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM payouts p ${where}`).get(...params);
  const items = db.prepare(`
    SELECT p.*, c.name AS contact_name, fa.account_type, fa.bank_name, fa.vpa
    FROM payouts p
    JOIN fund_accounts fa ON p.fund_account_id=fa.id
    JOIN contacts c ON p.contact_id=c.id
    ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, cap, parseInt(offset) || 0);
  return { total: count, items };
}

function approvePayout(id, merchantId, approvedBy) {
  const db  = getDb();
  const p   = db.prepare('SELECT * FROM payouts WHERE id=?').get(id);
  if (!p) throw new Error('Payout not found');
  if (p.merchant_id !== merchantId) throw new Error('Forbidden');
  if (p.status !== 'pending_approval') throw new Error(`Payout is not pending approval (status: ${p.status})`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE payouts SET status='queued', approved_by=?, approved_at=?, queued_at=? WHERE id=?`)
    .run(approvedBy ?? 'dashboard', now, now, id);
  return getPayout(id);
}

function cancelPayout(id, merchantId) {
  const p = getDb().prepare('SELECT * FROM payouts WHERE id=?').get(id);
  if (!p) throw new Error('Payout not found');
  if (p.merchant_id !== merchantId) throw new Error('Forbidden');
  if (!['queued', 'pending_approval'].includes(p.status))
    throw new Error(`Cannot cancel payout in status: ${p.status}`);
  getDb().prepare("UPDATE payouts SET status='cancelled' WHERE id=?").run(id);
  return getPayout(id);
}

// Simulate bank processing for a single queued payout
async function _processSinglePayout(id, merchantId) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare("UPDATE payouts SET status='processing', processing_at=? WHERE id=?").run(now, id);

  // 97% success rate
  const success = Math.random() > 0.03;
  if (success) {
    const utr = 'UTR' + String(Date.now()).slice(-10) + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    db.prepare("UPDATE payouts SET status='processed', utr=?, processed_at=? WHERE id=?")
      .run(utr, now + Math.floor(Math.random() * 300), id);

    queueWebhook({
      merchantId,
      event: 'payout.processed',
      payload: { event: 'payout.processed', payout_id: id, utr, timestamp: new Date().toISOString() },
    });
  } else {
    const reasons = ['Account frozen', 'Invalid IFSC code', 'Beneficiary account closed', 'Bank server unavailable'];
    const reason  = reasons[Math.floor(Math.random() * reasons.length)];
    db.prepare("UPDATE payouts SET status='failed', failure_reason=?, failed_at=? WHERE id=?")
      .run(reason, now, id);

    queueWebhook({
      merchantId,
      event: 'payout.failed',
      payload: { event: 'payout.failed', payout_id: id, reason, timestamp: new Date().toISOString() },
    });
  }
}

// Background cycle — drains the queued list
let _isRunning = false;
async function runPayoutCycle() {
  if (_isRunning) return;
  _isRunning = true;
  try {
    const queued = getDb().prepare(
      "SELECT id, merchant_id FROM payouts WHERE status='queued' ORDER BY queued_at ASC LIMIT 50"
    ).all();
    for (const p of queued) {
      await _processSinglePayout(p.id, p.merchant_id);
    }
  } catch (err) {
    const { logger, captureException } = require('../systems/logger');
    logger.error({ err }, 'payout cycle error');
    captureException(err);
  } finally {
    _isRunning = false;
  }
}

module.exports = {
  createPayout, getPayout, listPayouts,
  approvePayout, cancelPayout, runPayoutCycle,
  autoSelectMode, APPROVAL_THRESHOLD,
};
