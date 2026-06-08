'use strict';
const { getDb } = require('../db/database');

/**
 * Compute or recompute a merchant's risk profile.
 * Called at registration (baseline) and after significant events.
 * Score 0–100: 0 = no risk, 100 = maximum risk.
 */
function scoreMerchant(merchantId) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  let   score = 50; // neutral baseline
  const flags = [];

  const merchant = db.prepare('SELECT * FROM merchants WHERE id=?').get(merchantId);
  if (!merchant) return null;

  // ── Merchant age ──────────────────────────────────────────────────────���───
  const ageDays = (now - merchant.created_at) / 86400;
  if      (ageDays < 7)   { score += 30; flags.push('very_new_merchant'); }
  else if (ageDays < 30)  { score += 15; flags.push('new_merchant'); }
  else if (ageDays > 365) { score -= 20; }  // established = lower risk

  // ── Payment success rate (last 30 days) ───────────────────────────────────
  const { total, failed } = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM payments WHERE merchant_id=? AND created_at >= ?
  `).get(merchantId, now - 86400 * 30);

  if (total >= 20) {
    const failRate = (failed / total) * 100;
    if      (failRate > 40) { score += 30; flags.push('very_high_failure_rate'); }
    else if (failRate > 20) { score += 15; flags.push('high_failure_rate'); }
    else if (failRate < 5)  { score -= 10; }
  }

  // ── Chargeback history ────────────────────────────────────────────────────
  const { cb_count } = db.prepare(
    "SELECT COUNT(*) AS cb_count FROM chargebacks WHERE merchant_id=?"
  ).get(merchantId);
  if      (cb_count > 20) { score += 30; flags.push('critical_chargebacks'); }
  else if (cb_count > 5)  { score += 15; flags.push('multiple_chargebacks'); }
  else if (cb_count > 0)  { score +=  5; flags.push('has_chargebacks'); }

  // ── Open AML alerts ───────────────────────────────────────────────────────
  const { aml_count } = db.prepare(
    "SELECT COUNT(*) AS aml_count FROM aml_alerts WHERE merchant_id=? AND status='open'"
  ).get(merchantId);
  if (aml_count > 0) { score += Math.min(aml_count * 10, 30); flags.push('aml_alerts'); }

  // ── Fraud events ──────────────────────────────────────────────────────────
  const { blocked } = db.prepare(`
    SELECT COUNT(*) AS blocked FROM fraud_events
    WHERE merchant_id=? AND action='block' AND created_at >= ?
  `).get(merchantId, now - 86400 * 7);
  if (blocked > 3) { score += 15; flags.push('repeated_fraud_blocks'); }

  score = Math.max(0, Math.min(100, score));

  const risk_level  = score >= 80 ? 'very_high' : score >= 60 ? 'high' : score >= 40 ? 'medium' : 'low';
  const reserve_pct = score >= 80 ? 10 : score >= 60 ? 7 : score >= 40 ? 5 : 3;
  const kyc_tier    = 'tier1'; // set separately via KYC flow

  db.prepare(`
    INSERT INTO merchant_risk
      (merchant_id, risk_score, risk_level, reserve_pct, kyc_tier, flags, last_scored_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(merchant_id) DO UPDATE SET
      risk_score=excluded.risk_score,
      risk_level=excluded.risk_level,
      reserve_pct=excluded.reserve_pct,
      flags=excluded.flags,
      last_scored_at=excluded.last_scored_at,
      updated_at=excluded.updated_at
  `).run(merchantId, score, risk_level, reserve_pct, kyc_tier,
      JSON.stringify(flags), now, now, now);

  return getMerchantRiskProfile(merchantId);
}

function getMerchantRiskProfile(merchantId) {
  const row = getDb().prepare('SELECT * FROM merchant_risk WHERE merchant_id=?').get(merchantId);
  if (!row) return null;
  if (row.flags) { try { row.flags = JSON.parse(row.flags); } catch {} }
  return row;
}

function setKYCTier(merchantId, tier) {
  const valid = ['tier1', 'tier2', 'tier3'];
  if (!valid.includes(tier)) throw new Error(`tier must be one of: ${valid.join(', ')}`);
  const now = Math.floor(Date.now() / 1000);

  const db  = getDb();
  const existing = db.prepare('SELECT merchant_id FROM merchant_risk WHERE merchant_id=?').get(merchantId);
  if (!existing) scoreMerchant(merchantId); // create profile first

  db.prepare('UPDATE merchant_risk SET kyc_tier=?, updated_at=? WHERE merchant_id=?').run(tier, now, merchantId);
  return getMerchantRiskProfile(merchantId);
}

module.exports = { scoreMerchant, getMerchantRiskProfile, setKYCTier };
