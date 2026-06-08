'use strict';
const { randomUUID } = require('crypto');
const { getDb }      = require('../db/database');

const DEFAULT_RESERVE_PCT  = 5;
const DEFAULT_HOLD_DAYS    = 180;

function getReservePct(merchantId) {
  const row = getDb().prepare('SELECT reserve_pct FROM merchant_risk WHERE merchant_id=?').get(merchantId);
  return row?.reserve_pct ?? DEFAULT_RESERVE_PCT;
}

/**
 * Called during settlement — holds back a % of gross settlement.
 * Returns the reserve entry, or null if reserve amount is zero.
 */
function createReserveEntry(merchantId, settlementId, grossAmount) {
  const pct    = getReservePct(merchantId);
  const amount = Math.round(grossAmount * pct / 100);
  if (amount <= 0) return null;

  const db      = getDb();
  const id      = 'rres_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const now     = Math.floor(Date.now() / 1000);
  const holdEnd = now + DEFAULT_HOLD_DAYS * 86400;

  db.prepare(`
    INSERT INTO rolling_reserves
      (id, merchant_id, settlement_id, gross_amount, reserve_pct, reserve_amount, hold_until, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, merchantId, settlementId ?? null, grossAmount, pct, amount, holdEnd, now);

  return db.prepare('SELECT * FROM rolling_reserves WHERE id=?').get(id);
}

/** Background job — release reserves whose hold period has expired */
function releaseMaturedReserves() {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  const due = db.prepare(
    "SELECT id FROM rolling_reserves WHERE status='held' AND hold_until <= ?"
  ).all(now);
  for (const { id } of due) {
    try {
      db.prepare("UPDATE rolling_reserves SET status='released', released_at=? WHERE id=?").run(now, id);
    } catch {}
  }
  return due.length;
}

function getMerchantReserveBalance(merchantId) {
  const { held, released } = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='held'     THEN reserve_amount END), 0) AS held,
      COALESCE(SUM(CASE WHEN status='released' THEN reserve_amount END), 0) AS released
    FROM rolling_reserves WHERE merchant_id=?
  `).get(merchantId);
  return { held, released, total: held + released };
}

function listReserves(merchantId, { status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE merchant_id=?';
  const params = [merchantId];
  if (status) { where += ' AND status=?'; params.push(status); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM rolling_reserves ${where}`).get(...params);
  const items     = db.prepare(
    `SELECT * FROM rolling_reserves ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 100), offset);
  return { count, items };
}

module.exports = { createReserveEntry, releaseMaturedReserves, getMerchantReserveBalance, listReserves, getReservePct };
