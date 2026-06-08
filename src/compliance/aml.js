'use strict';
const { randomUUID } = require('crypto');
const { getDb }      = require('../db/database');

// RBI reporting threshold for structuring detection
const REPORTING_THRESHOLD = 1000000; // ₹10,00,000

/**
 * Run AML pattern checks after a successful payment.
 * Non-blocking — always called via setImmediate.
 * Silently raises alerts to aml_alerts table; never affects payment flow.
 */
function runAMLChecks(merchantId, paymentId, amount) {
  try {
    const db  = getDb();
    const now = Math.floor(Date.now() / 1000);

    // 1. Structuring: amounts between 85% and 99% of ₹10L threshold
    if (amount >= REPORTING_THRESHOLD * 0.85 && amount < REPORTING_THRESHOLD) {
      const { count } = db.prepare(`
        SELECT COUNT(*) AS count FROM payments
        WHERE merchant_id=? AND amount >= ? AND amount < ? AND created_at >= ? AND status='captured'
      `).get(merchantId, REPORTING_THRESHOLD * 0.85, REPORTING_THRESHOLD, now - 86400 * 7);
      if (count >= 3) {
        _raise(db, merchantId, 'structuring',
          `${count} transactions between ₹${Math.round(REPORTING_THRESHOLD * 0.85 / 100).toLocaleString()} and ₹${(REPORTING_THRESHOLD / 100).toLocaleString()} within 7 days — possible structuring`,
          { count, window_days: 7, threshold: REPORTING_THRESHOLD });
      }
    }

    // 2. Volume spike: today's volume is 3x the 30-day average
    const { avg_daily } = db.prepare(`
      SELECT COALESCE(AVG(daily_vol), 0) AS avg_daily FROM (
        SELECT date(created_at, 'unixepoch') AS d, SUM(amount) AS daily_vol
        FROM payments WHERE merchant_id=? AND status='captured' AND created_at >= ?
        GROUP BY d
      )
    `).get(merchantId, now - 86400 * 30);

    const { today_vol } = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS today_vol FROM payments
      WHERE merchant_id=? AND status='captured' AND created_at >= ?
    `).get(merchantId, now - 86400);

    if (avg_daily > 0 && today_vol > avg_daily * 3 && today_vol > 500000) {
      _raise(db, merchantId, 'volume_spike',
        `Today's volume ₹${(today_vol / 100).toLocaleString()} is ${(today_vol / avg_daily).toFixed(1)}x the 30-day daily average`,
        { today_vol, avg_daily: Math.round(avg_daily), ratio: +(today_vol / avg_daily).toFixed(2) });
    }

    // 3. Round-amount pattern: ≥5 perfectly round large amounts in 24h
    const { round_count } = db.prepare(`
      SELECT COUNT(*) AS round_count FROM payments
      WHERE merchant_id=? AND amount % 100000 = 0 AND amount >= 100000
        AND created_at >= ? AND status='captured'
    `).get(merchantId, now - 86400);
    if (round_count >= 5) {
      _raise(db, merchantId, 'round_amounts',
        `${round_count} large round-amount transactions in 24 hours — AML structuring signal`,
        { count: round_count });
    }

    // 4. Identical repeated amounts: same amount ≥5 times in 1 hour (structuring)
    const { repeat_count } = db.prepare(`
      SELECT COUNT(*) AS repeat_count FROM payments
      WHERE merchant_id=? AND amount=? AND created_at >= ? AND status='captured'
    `).get(merchantId, amount, now - 3600);
    if (repeat_count >= 5) {
      _raise(db, merchantId, 'repeated_amounts',
        `Same amount ₹${(amount / 100).toLocaleString()} processed ${repeat_count} times in 1 hour`,
        { amount, count: repeat_count });
    }

  } catch { /* AML checks must never crash */ }
}

function _raise(db, merchantId, alertType, description, metadata = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    // Dedup: skip if same type already open within last 24h
    const exists = db.prepare(
      "SELECT id FROM aml_alerts WHERE merchant_id=? AND alert_type=? AND status='open' AND created_at >= ?"
    ).get(merchantId, alertType, now - 86400);
    if (exists) return;

    db.prepare(`
      INSERT INTO aml_alerts (id, merchant_id, alert_type, description, metadata, status, created_at)
      VALUES (?,?,?,?,?,'open',?)
    `).run('alrt_' + randomUUID().replace(/-/g, '').slice(0, 14),
        merchantId, alertType, description, JSON.stringify(metadata), now);
  } catch {}
}

function listAMLAlerts(merchantId, { status, type, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE merchant_id=?';
  const params = [merchantId];
  if (status) { where += ' AND status=?'; params.push(status); }
  if (type)   { where += ' AND alert_type=?'; params.push(type); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM aml_alerts ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM aml_alerts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 100), offset).map(_parse);
  return { count, items };
}

function updateAMLAlert(id, merchantId, { status, reviewed_by } = {}) {
  const db    = getDb();
  const alert = db.prepare('SELECT * FROM aml_alerts WHERE id=?').get(id);
  if (!alert)                          throw new Error('Alert not found');
  if (alert.merchant_id !== merchantId) throw new Error('Forbidden');
  const valid = ['reviewed', 'escalated', 'closed'];
  if (!valid.includes(status)) throw new Error(`status must be one of: ${valid.join(', ')}`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE aml_alerts SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?')
    .run(status, reviewed_by ?? null, now, id);
  return _parse(db.prepare('SELECT * FROM aml_alerts WHERE id=?').get(id));
}

function _parse(row) {
  if (row?.metadata) { try { row.metadata = JSON.parse(row.metadata); } catch {} }
  return row;
}

module.exports = { runAMLChecks, listAMLAlerts, updateAMLAlert };
