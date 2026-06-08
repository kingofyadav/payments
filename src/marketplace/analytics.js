'use strict';
const { getDb } = require('../db/database');

function unixDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function getMarketplaceSummary(merchantId) {
  const db  = getDb();
  const d30 = unixDaysAgo(30);

  // GMV = gross amount routed/transferred (last 30d)
  const transferAgg = db.prepare(`
    SELECT
      COUNT(*)                                                          AS total_transfers,
      COUNT(CASE WHEN status IN ('processed','reversed') THEN 1 END)   AS completed,
      COUNT(CASE WHEN status='on_hold' THEN 1 END)                     AS on_hold,
      COUNT(CASE WHEN status='reversed' THEN 1 END)                    AS reversed,
      COALESCE(SUM(CASE WHEN status IN ('processed','reversed') THEN amount END), 0) AS gross_transferred,
      COALESCE(SUM(CASE WHEN status IN ('processed','reversed') THEN commission END), 0) AS total_commission,
      COALESCE(SUM(CASE WHEN status IN ('processed','reversed') THEN net_amount END), 0) AS net_to_sellers,
      COALESCE(SUM(CASE WHEN status='on_hold' THEN amount END), 0)     AS held_amount
    FROM transfers WHERE merchant_id=? AND created_at>=?
  `).get(merchantId, d30);

  // Escrow summary
  const escrowAgg = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='funded'   THEN amount END), 0) AS funded,
      COALESCE(SUM(CASE WHEN status='released' THEN amount END), 0) AS released,
      COALESCE(SUM(CASE WHEN status='refunded' THEN amount END), 0) AS refunded,
      COALESCE(SUM(CASE WHEN status='disputed' THEN amount END), 0) AS disputed,
      COUNT(*) AS total_escrows
    FROM escrows WHERE merchant_id=? AND created_at>=?
  `).get(merchantId, d30);

  // Linked account counts
  const laAgg = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN status='activated' THEN 1 END) AS active,
      COUNT(CASE WHEN status='suspended' THEN 1 END) AS suspended
    FROM linked_accounts WHERE merchant_id=?
  `).get(merchantId);

  return {
    period_days:     30,
    transfers: {
      total:           transferAgg.total_transfers,
      completed:       transferAgg.completed,
      on_hold:         transferAgg.on_hold,
      reversed:        transferAgg.reversed,
      gross_gmv:       transferAgg.gross_transferred,
      total_commission: transferAgg.total_commission,
      net_to_sellers:  transferAgg.net_to_sellers,
      held_amount:     transferAgg.held_amount,
    },
    escrow: {
      total:    escrowAgg.total_escrows,
      funded:   escrowAgg.funded,
      released: escrowAgg.released,
      refunded: escrowAgg.refunded,
      disputed: escrowAgg.disputed,
    },
    linked_accounts: laAgg,
  };
}

function getGMVTrend(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days - 1);
  return db.prepare(`
    SELECT
      date(created_at, 'unixepoch', 'localtime') AS day,
      COUNT(*)                                                        AS transfers,
      COALESCE(SUM(amount), 0)                                        AS gmv,
      COALESCE(SUM(commission), 0)                                    AS commission,
      COALESCE(SUM(net_amount), 0)                                    AS net_to_sellers
    FROM transfers
    WHERE merchant_id=? AND status IN ('processed','reversed') AND created_at>=?
    GROUP BY day ORDER BY day
  `).all(merchantId, from);
}

function getTopSellers(merchantId, limit = 20) {
  return getDb().prepare(`
    SELECT
      la.id, la.name, la.business_name, la.commission_type, la.commission_pct, la.commission_flat,
      COUNT(t.id)                                                         AS transfer_count,
      COALESCE(SUM(CASE WHEN t.status IN ('processed','reversed') THEN t.amount END), 0)     AS gross_received,
      COALESCE(SUM(CASE WHEN t.status IN ('processed','reversed') THEN t.commission END), 0) AS commission_paid,
      COALESCE(SUM(CASE WHEN t.status IN ('processed','reversed') THEN t.net_amount END), 0) AS net_received,
      COALESCE(SUM(CASE WHEN t.status='on_hold' THEN t.amount END), 0)   AS held_amount,
      COUNT(CASE WHEN t.status='reversed' THEN 1 END)                     AS reversals
    FROM linked_accounts la
    LEFT JOIN transfers t ON t.linked_account_id=la.id AND t.merchant_id=la.merchant_id
    WHERE la.merchant_id=? AND la.status='activated'
    GROUP BY la.id
    ORDER BY gross_received DESC LIMIT ?
  `).all(merchantId, limit);
}

function getSellerHealth(merchantId) {
  return getDb().prepare(`
    SELECT
      la.id, la.name, la.business_name, la.status, la.kyc_status,
      COUNT(t.id)                                                         AS total_transfers,
      COUNT(CASE WHEN t.status='reversed' THEN 1 END)                    AS reversals,
      COUNT(CASE WHEN t.status='on_hold'  THEN 1 END)                    AS on_hold_count,
      COALESCE(SUM(CASE WHEN t.status='on_hold' THEN t.amount END), 0)   AS held_balance,
      COALESCE(SUM(CASE WHEN t.status IN ('processed','reversed') THEN t.net_amount END), 0) AS lifetime_net,
      COUNT(CASE WHEN e.status='disputed' THEN 1 END)                    AS disputes
    FROM linked_accounts la
    LEFT JOIN transfers t ON t.linked_account_id=la.id
    LEFT JOIN escrows e   ON e.linked_account_id=la.id
    WHERE la.merchant_id=?
    GROUP BY la.id
    ORDER BY la.created_at DESC
  `).all(merchantId);
}

function getCommissionBreakdown(merchantId, days = 30) {
  const db   = getDb();
  const from = unixDaysAgo(days);
  return db.prepare(`
    SELECT
      la.commission_type,
      COUNT(t.id)                     AS transfers,
      COALESCE(SUM(t.commission), 0)  AS total_commission,
      COALESCE(SUM(t.amount), 0)      AS gross_amount,
      COALESCE(AVG(t.commission_pct_actual), 0) AS avg_effective_pct
    FROM transfers t
    JOIN linked_accounts la ON t.linked_account_id=la.id
    WHERE t.merchant_id=? AND t.status IN ('processed','reversed') AND t.created_at>=?
    GROUP BY la.commission_type
  `).all(merchantId, from);
}

module.exports = {
  getMarketplaceSummary, getGMVTrend, getTopSellers, getSellerHealth, getCommissionBreakdown,
};
