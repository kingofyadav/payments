'use strict';
const { randomUUID }    = require('crypto');
const { getDb }         = require('../db/database');
const { addToBlacklist } = require('../fraud/blacklist');

// Real Visa VDMP threshold — 0.65% ratio AND ≥10 disputes/month
const VISA_VDMP_RATIO      = 0.65;
const VISA_VDMP_MIN_DISPUTES = 10;

function createChargeback(merchantId, opts) {
  const { payment_id, amount, reason, due_date } = opts;
  if (!payment_id) throw new Error('payment_id is required');

  const db  = getDb();
  const pay = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(payment_id, merchantId);
  if (!pay) throw new Error('Payment not found');
  if (!['captured', 'refunded'].includes(pay.status))
    throw new Error(`Cannot dispute a ${pay.status} payment`);

  const existing = db.prepare(
    "SELECT id FROM chargebacks WHERE payment_id=? AND status NOT IN ('lost','auto_reversed')"
  ).get(payment_id);
  if (existing) throw new Error('Active chargeback already exists for this payment');

  const id       = 'cb_' + randomUUID().replace(/-/g, '').slice(0, 14);
  const now      = Math.floor(Date.now() / 1000);
  const cbAmount = amount ?? pay.amount;
  const dueDate  = due_date ?? (now + 7 * 86400); // 7-day response window

  db.prepare(`
    INSERT INTO chargebacks (id, payment_id, merchant_id, amount, reason, due_date, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, payment_id, merchantId, cbAmount, reason ?? null, dueDate, now);

  // Recompute chargeback ratio and auto-escalate if needed
  setImmediate(() => _checkAndFlagRatio(merchantId));

  return db.prepare('SELECT * FROM chargebacks WHERE id=?').get(id);
}

function submitEvidence(id, merchantId, evidence) {
  const db = getDb();
  const cb = db.prepare('SELECT * FROM chargebacks WHERE id=?').get(id);
  if (!cb)                             throw new Error('Chargeback not found');
  if (cb.merchant_id !== merchantId)   throw new Error('Forbidden');
  if (cb.status !== 'open')            throw new Error(`Cannot submit evidence — chargeback is ${cb.status}`);
  db.prepare("UPDATE chargebacks SET status='evidence_submitted', evidence=? WHERE id=?")
    .run(JSON.stringify(evidence), id);
  return db.prepare('SELECT * FROM chargebacks WHERE id=?').get(id);
}

function resolveChargeback(id, merchantId, outcome) {
  const db = getDb();
  const cb = db.prepare('SELECT * FROM chargebacks WHERE id=?').get(id);
  if (!cb)                             throw new Error('Chargeback not found');
  if (cb.merchant_id !== merchantId)   throw new Error('Forbidden');
  const valid = ['won', 'lost', 'auto_reversed'];
  if (!valid.includes(outcome)) throw new Error(`outcome must be: ${valid.join(', ')}`);

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE chargebacks SET status=?, resolved_at=? WHERE id=?').run(outcome, now, id);

  // Three consecutive lost chargebacks → auto-flag merchant
  if (outcome === 'lost') {
    const { lost_count } = db.prepare(
      "SELECT COUNT(*) AS lost_count FROM chargebacks WHERE merchant_id=? AND status='lost'"
    ).get(merchantId);
    if (lost_count >= 3) {
      _raiseAMLAlert(merchantId, 'high_chargebacks',
        `${lost_count} lost chargebacks — merchant may be engaging in fraudulent activity`);
    }
  }

  return db.prepare('SELECT * FROM chargebacks WHERE id=?').get(id);
}

function getChargebackRatio(merchantId, days = 30) {
  const db   = getDb();
  const from = Math.floor(Date.now() / 1000) - days * 86400;

  const { total_payments } = db.prepare(
    "SELECT COUNT(*) AS total_payments FROM payments WHERE merchant_id=? AND status='captured' AND created_at >= ?"
  ).get(merchantId, from);

  const { total_chargebacks, total_cb_amount } = db.prepare(`
    SELECT COUNT(*) AS total_chargebacks,
           COALESCE(SUM(amount), 0) AS total_cb_amount
    FROM chargebacks WHERE merchant_id=? AND created_at >= ?
  `).get(merchantId, from);

  const ratio_pct = total_payments > 0
    ? +((total_chargebacks / total_payments) * 100).toFixed(4)
    : 0;

  const visa_vdmp_breach = ratio_pct >= VISA_VDMP_RATIO && total_chargebacks >= VISA_VDMP_MIN_DISPUTES;

  return {
    period_days:      days,
    total_payments,
    total_chargebacks,
    total_cb_amount,
    ratio_pct,
    risk_level:        ratio_pct >= 2    ? 'critical'
                     : ratio_pct >= 1    ? 'high'
                     : ratio_pct >= 0.65 ? 'elevated'
                     :                    'normal',
    visa_vdmp_breach,
    visa_vdmp_threshold_pct: VISA_VDMP_RATIO,
  };
}

function listChargebacks(merchantId, { status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE merchant_id=?';
  const params = [merchantId];
  if (status) { where += ' AND status=?'; params.push(status); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM chargebacks ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM chargebacks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 100), offset).map(_parseEvidence);
  return { count, items };
}

function getChargeback(id) {
  const row = getDb().prepare('SELECT * FROM chargebacks WHERE id=?').get(id);
  return row ? _parseEvidence(row) : null;
}

function _checkAndFlagRatio(merchantId) {
  try {
    const ratio = getChargebackRatio(merchantId, 30);
    if (ratio.visa_vdmp_breach) {
      _raiseAMLAlert(merchantId, 'high_chargebacks',
        `Chargeback ratio ${ratio.ratio_pct}% with ${ratio.total_chargebacks} disputes — Visa VDMP threshold (${VISA_VDMP_RATIO}%) breached`);
    }
  } catch {}
}

function _raiseAMLAlert(merchantId, type, description) {
  try {
    const db  = getDb();
    const now = Math.floor(Date.now() / 1000);
    const exists = db.prepare(
      "SELECT id FROM aml_alerts WHERE merchant_id=? AND alert_type=? AND status='open' AND created_at >= ?"
    ).get(merchantId, type, now - 86400);
    if (!exists) {
      db.prepare(`
        INSERT INTO aml_alerts (id, merchant_id, alert_type, description, status, created_at)
        VALUES (?,?,?,?,'open',?)
      `).run('alrt_' + randomUUID().replace(/-/g, '').slice(0, 14), merchantId, type, description, now);
    }
  } catch {}
}

function _parseEvidence(row) {
  if (row?.evidence) { try { row.evidence = JSON.parse(row.evidence); } catch {} }
  return row;
}

module.exports = { createChargeback, submitEvidence, resolveChargeback, getChargebackRatio, listChargebacks, getChargeback };
