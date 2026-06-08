'use strict';
const { randomUUID }      = require('crypto');
const { getDb }           = require('../db/database');
const { checkBlacklists } = require('./blacklist');
const { checkVelocity }   = require('./velocity');
const { runRulesEngine }  = require('./rules_engine');

const BLOCK_THRESHOLD  = 70; // score ≥ 70 → block
const REVIEW_THRESHOLD = 40; // score ≥ 40 → manual review (allow but flag)

/**
 * Main entry point — runs all fraud layers sequentially.
 * Fails open: any internal exception results in 'allow' so legitimate
 * payments are never blocked by a fraud engine bug.
 *
 * @param {object} ctx
 * @param {string} ctx.merchantId
 * @param {number} ctx.amount        - in paise
 * @param {string} [ctx.ip]
 * @param {string} [ctx.cardBin]     - first 6 digits
 * @param {string} [ctx.email]
 * @param {string} [ctx.deviceId]
 * @param {string} [ctx.paymentId]   - for linking the event log
 */
function runFraudChecks(ctx) {
  try {
    const { merchantId, amount, ip, cardBin, email, deviceId, paymentId } = ctx;
    const signals    = [];
    let   totalScore = 0;

    // ── Layer 1: Blacklists (instant block, no scoring needed) ────────────
    const blResult = checkBlacklists({ ip, card_bin: cardBin, email });
    if (blResult.blocked) {
      const eventId = _log({ merchantId, paymentId, amount, ip, cardBin, action: 'block', score: 100, signals: [{ type: 'blacklist', ...blResult }] });
      return { action: 'block', score: 100, reason: `Blacklisted ${blResult.type}: ${blResult.value}`, signals: [{ type: 'blacklist', ...blResult }], event_id: eventId };
    }

    // ── Layer 2: Velocity checks ──────────────────────────────────────────
    const velResult = checkVelocity({ merchant_id: merchantId, amount, ip, card_bin: cardBin });
    for (const s of velResult.signals) signals.push({ type: 'velocity', ...s });
    totalScore += velResult.score;

    // Early exit: velocity alone is enough to block
    if (totalScore >= BLOCK_THRESHOLD) {
      const eventId = _log({ merchantId, paymentId, amount, ip, cardBin, action: 'block', score: totalScore, signals });
      return { action: 'block', score: totalScore, reason: 'Velocity threshold exceeded', signals, event_id: eventId };
    }

    // ── Layer 3: Rules engine ─────────────────────────────────────────────
    const ruleCtx = {
      amount:          String(amount),
      ip:              ip ?? '',
      card_bin:        cardBin ?? '',
      email:           email ?? '',
      hour:            String(new Date().getHours()),
      is_round_amount: amount % 100000 === 0 ? '1' : '0',
    };
    const rulesResult = runRulesEngine(ruleCtx, merchantId);
    for (const s of rulesResult.triggered) signals.push({ type: 'rule', ...s });
    totalScore = Math.min(totalScore + rulesResult.score, 100);

    // ── Final decision ────────────────────────────────────────────────────
    let action = 'allow';
    if (rulesResult.decision === 'block' || totalScore >= BLOCK_THRESHOLD) {
      action = 'block';
    } else if (rulesResult.decision === 'review' || totalScore >= REVIEW_THRESHOLD) {
      action = 'review';
    } else if (signals.length > 0) {
      action = 'flag';
    }

    const eventId = _log({ merchantId, paymentId, amount, ip, cardBin, action, score: totalScore, signals });
    return { action, score: totalScore, signals, event_id: eventId };

  } catch {
    // Fail open — never block a real payment because the fraud engine crashed
    return { action: 'allow', score: 0, signals: [], event_id: null, _engine_error: true };
  }
}

function _log({ merchantId, paymentId, amount, ip, cardBin, action, score, signals }) {
  const id  = 'fe_' + randomUUID().replace(/-/g, '').slice(0, 14);
  const now = Math.floor(Date.now() / 1000);
  try {
    getDb().prepare(`
      INSERT INTO fraud_events
        (id, payment_id, merchant_id, risk_score, action, signals, ip, card_bin, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, paymentId ?? null, merchantId ?? null, score, action,
        JSON.stringify(signals), ip ?? null, cardBin ?? null, now);
  } catch {}
  return id;
}

module.exports = { runFraudChecks };
