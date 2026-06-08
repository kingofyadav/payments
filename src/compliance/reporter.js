'use strict';
const { getDb } = require('../db/database');

// KYC tier → per-transaction limit in paise (null = no limit)
const KYC_TIER_LIMITS = { tier1: 1000000, tier2: 10000000, tier3: null }; // ₹10K, ₹1L, unlimited

/**
 * Enforce KYC transaction limit before payment processing.
 * Fails open if no risk profile exists (new merchant, no restriction yet).
 */
function checkKYCLimit(merchantId, amount) {
  const db   = getDb();
  const risk = db.prepare('SELECT kyc_tier, monthly_limit FROM merchant_risk WHERE merchant_id=?').get(merchantId);
  if (!risk) return { allowed: true }; // no profile = no restriction

  const tierLimit = KYC_TIER_LIMITS[risk.kyc_tier ?? 'tier1'];

  if (tierLimit !== null && amount > tierLimit) {
    return {
      allowed: false,
      message: `Transaction amount ₹${(amount / 100).toLocaleString()} exceeds ${risk.kyc_tier} limit of ₹${(tierLimit / 100).toLocaleString()}. Complete a higher KYC tier to proceed.`,
      kyc_tier: risk.kyc_tier,
      limit:    tierLimit,
    };
  }

  // Monthly rolling volume check (if configured)
  if (risk.monthly_limit) {
    const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
    const { monthly_vol } = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS monthly_vol FROM payments WHERE merchant_id=? AND status='captured' AND created_at >= ?"
    ).get(merchantId, startOfMonth);

    if (monthly_vol + amount > risk.monthly_limit) {
      return {
        allowed: false,
        message: `Monthly transaction limit of ₹${(risk.monthly_limit / 100).toLocaleString()} would be exceeded (current: ₹${(monthly_vol / 100).toLocaleString()}).`,
        monthly_limit: risk.monthly_limit,
        monthly_used:  monthly_vol,
      };
    }
  }

  return { allowed: true };
}

/**
 * Generate RBI-format monthly compliance report.
 * Used for regulatory submission to RBI PA division.
 */
function getRBIMonthlyReport(merchantId, year, month) {
  const db    = getDb();
  const start = Math.floor(new Date(year, month - 1, 1).getTime() / 1000);
  const end   = Math.floor(new Date(year, month,     1).getTime() / 1000);

  const txnStats = db.prepare(`
    SELECT
      COUNT(*)                                                                 AS total_transactions,
      SUM(CASE WHEN status='captured' THEN 1 ELSE 0 END)                      AS successful,
      SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END)                      AS failed,
      COALESCE(SUM(CASE WHEN status='captured' THEN amount END), 0)           AS total_volume,
      COALESCE(AVG(CASE WHEN status='captured' THEN amount END), 0)           AS avg_ticket_size,
      COALESCE(MAX(CASE WHEN status='captured' THEN amount END), 0)           AS max_ticket_size
    FROM payments WHERE merchant_id=? AND created_at >= ? AND created_at < ?
  `).get(merchantId, start, end);

  const methodBreakdown = db.prepare(`
    SELECT method,
           COUNT(*)                  AS count,
           COALESCE(SUM(amount), 0)  AS volume
    FROM payments
    WHERE merchant_id=? AND status='captured' AND created_at >= ? AND created_at < ?
    GROUP BY method ORDER BY volume DESC
  `).all(merchantId, start, end);

  const refundStats = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM refunds WHERE merchant_id=? AND created_at >= ? AND created_at < ?
  `).get(merchantId, start, end);

  const payoutStats = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM payouts WHERE merchant_id=? AND status='processed' AND created_at >= ? AND created_at < ?
  `).get(merchantId, start, end);

  const cbStats = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total,
           SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS lost_count
    FROM chargebacks WHERE merchant_id=? AND created_at >= ? AND created_at < ?
  `).get(merchantId, start, end);

  const amlStats = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='escalated' THEN 1 ELSE 0 END) AS escalated
    FROM aml_alerts WHERE merchant_id=? AND created_at >= ? AND created_at < ?
  `).get(merchantId, start, end);

  const settlementStats = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM settlements WHERE merchant_id=? AND status='processed' AND created_at >= ? AND created_at < ?
  `).get(merchantId, start, end);

  return {
    report_type:   'RBI_PA_MONTHLY',
    period:        `${year}-${String(month).padStart(2, '0')}`,
    merchant_id:   merchantId,
    generated_at:  new Date().toISOString(),
    transactions: {
      ...txnStats,
      avg_ticket_size:  Math.round(txnStats.avg_ticket_size),
      method_breakdown: methodBreakdown,
    },
    refunds:      refundStats,
    payouts:      payoutStats,
    chargebacks:  cbStats,
    settlements:  settlementStats,
    aml: {
      alerts_raised:    amlStats.total,
      alerts_escalated: amlStats.escalated,
      note: 'STRs filed separately with FIU-IND portal within 7 days of detection.',
    },
    compliance_notes: [
      'Data localization: all records stored in India.',
      'Audit trail retained for 5 years per RBI PA guidelines.',
      `Report covers period ${new Date(start * 1000).toISOString().slice(0, 10)} to ${new Date((end - 1) * 1000).toISOString().slice(0, 10)}.`,
    ],
  };
}

function getKYCStatus(merchantId) {
  const db   = getDb();
  const risk = db.prepare('SELECT * FROM merchant_risk WHERE merchant_id=?').get(merchantId);
  const tier = risk?.kyc_tier ?? 'tier1';

  return {
    merchant_id:       merchantId,
    kyc_tier:          tier,
    risk_level:        risk?.risk_level   ?? 'medium',
    transaction_limit: KYC_TIER_LIMITS[tier],
    monthly_limit:     risk?.monthly_limit ?? null,
    reserve_pct:       risk?.reserve_pct  ?? 5,
    last_scored_at:    risk?.last_scored_at ? new Date(risk.last_scored_at * 1000).toISOString() : null,
    tier_limits:       KYC_TIER_LIMITS,
  };
}

module.exports = { checkKYCLimit, getRBIMonthlyReport, getKYCStatus };
