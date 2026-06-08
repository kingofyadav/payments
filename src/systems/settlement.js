const { randomUUID }        = require('crypto');
const { getDb }             = require('../db/database');
const { createReserveEntry } = require('../risk/rolling_reserve');

const FEE_PCT  = 0.02;   // 2% payment processing fee
const TAX_PCT  = 0.18;   // 18% GST on fee

function generateUTR() {
  return 'SETT' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// Creates settlements for captured payments that haven't been settled yet.
// Groups by merchant, batches payments older than 2 days (T+2).
function runSettlementCycle() {
  const db  = getDb();
  const t2  = Math.floor(Date.now() / 1000) - 2 * 86400;

  // Find unsettled merchants
  const merchants = db.prepare(`
    SELECT DISTINCT merchant_id FROM payments
    WHERE status='captured' AND settled_at IS NULL AND captured_at <= ?
  `).all(t2);

  for (const { merchant_id } of merchants) {
    const payments = db.prepare(`
      SELECT * FROM payments
      WHERE merchant_id=? AND status='captured' AND settled_at IS NULL AND captured_at <= ?
    `).all(merchant_id, t2);

    if (!payments.length) continue;

    // Refunds that offset this settlement (parameterized — no string interpolation)
    const placeholders = payments.map(() => '?').join(',');
    const refunds = db.prepare(
      `SELECT * FROM refunds WHERE payment_id IN (${placeholders}) AND status='processed' AND settled_at IS NULL`
    ).all(...payments.map(p => p.id));

    const grossPayments = payments.reduce((s, p) => s + p.amount, 0);
    const grossRefunds  = refunds.reduce((s, r) => s + r.amount, 0);
    const gross         = grossPayments - grossRefunds;
    const fee           = Math.round(grossPayments * FEE_PCT);
    const tax           = Math.round(fee * TAX_PCT);
    const net           = gross - fee - tax;
    if (net <= 0) continue;

    const sId  = 'setl_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const now  = Math.floor(Date.now() / 1000);
    const utr  = generateUTR();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO settlements (id, merchant_id, amount, fees, tax, utr, status, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, 'processed', ?)
      `).run(sId, merchant_id, net, fee, tax, utr, now);

      // Rolling reserve — hold % of gross before paying out
      try { createReserveEntry(merchant_id, sId, gross); } catch {}

      for (const p of payments) {
        const pFee = Math.round(p.amount * FEE_PCT);
        const pTax = Math.round(pFee * TAX_PCT);
        db.prepare(`
          INSERT INTO settlement_items (id, settlement_id, entity_type, entity_id, amount, fee, tax)
          VALUES (?, ?, 'payment', ?, ?, ?, ?)
        `).run('si_' + randomUUID().replace(/-/g, '').slice(0, 12), sId, p.id, p.amount, pFee, pTax);
        db.prepare('UPDATE payments SET settled_at=? WHERE id=?').run(now, p.id);
      }

      for (const r of refunds) {
        db.prepare(`
          INSERT INTO settlement_items (id, settlement_id, entity_type, entity_id, amount, fee, tax)
          VALUES (?, ?, 'refund', ?, ?, 0, 0)
        `).run('si_' + randomUUID().replace(/-/g, '').slice(0, 12), sId, r.id, -r.amount);
        db.prepare('UPDATE refunds SET settled_at=? WHERE id=?').run(now, r.id);
      }
    })();
  }
}

function listSettlements(merchantId, { limit = 20, offset = 0 } = {}) {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM settlements WHERE merchant_id=?').get(merchantId);
  const items = db.prepare(
    'SELECT * FROM settlements WHERE merchant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(merchantId, Math.min(limit, 100), offset);
  return { count, items };
}

function getSettlement(id) {
  return getDb().prepare('SELECT * FROM settlements WHERE id=?').get(id);
}

function getSettlementRecons(settlementId) {
  return getDb().prepare(
    'SELECT * FROM settlement_items WHERE settlement_id=? ORDER BY created_at ASC'
  ).all(settlementId);
}

module.exports = { runSettlementCycle, listSettlements, getSettlement, getSettlementRecons };
