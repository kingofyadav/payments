'use strict';

/**
 * Commission calculation for linked accounts.
 * Always returns integer paise — never stores fractional amounts.
 *
 * commission_type:
 *   fixed_pct  — commission_pct % of gross (e.g. 15 = 15%)
 *   flat_fee   — commission_flat paise per transaction
 *   hybrid     — commission_pct % + commission_flat paise
 */
function computeCommission(amount, account) {
  const { commission_type = 'fixed_pct', commission_pct = 0, commission_flat = 0 } = account;

  let commission = 0;
  switch (commission_type) {
    case 'fixed_pct':
      commission = Math.round(amount * commission_pct / 100);
      break;
    case 'flat_fee':
      commission = commission_flat;
      break;
    case 'hybrid':
      commission = Math.round(amount * commission_pct / 100) + commission_flat;
      break;
    default:
      commission = 0;
  }

  commission = Math.min(commission, amount); // never deduct more than the amount
  return { gross: amount, commission, net: amount - commission };
}

module.exports = { computeCommission };
