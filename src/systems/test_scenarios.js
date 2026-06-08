'use strict';

// Test card numbers → outcome mapping
const CARD_SCENARIOS = {
  '4111111111111111': { success: true,  failure_reason: null,                 description: 'Successful payment' },
  '4000000000000002': { success: false, failure_reason: 'insufficient_funds', description: 'Card declined — insufficient funds' },
  '4000000000000069': { success: false, failure_reason: 'card_declined',      description: 'Card declined by issuer' },
  '4000000000003220': { success: true,  failure_reason: null,                 description: '3DS required — auto-authenticated in test mode' },
  '4000000000009995': { success: false, failure_reason: 'network_error',      description: 'Network timeout simulation' },
  '4000000000000077': { success: true,  failure_reason: null,                 description: 'International card — FX conversion applied' },
};

// Test UPI handles → outcome mapping
const UPI_SCENARIOS = {
  'success@yourbank': { success: true,  failure_reason: null,            description: 'Instant UPI success' },
  'failure@yourbank': { success: false, failure_reason: 'upi_declined',  description: 'UPI payment declined' },
  'pending@yourbank': { success: true,  failure_reason: null,            description: 'Delayed success (simulated as immediate in test mode)' },
  'timeout@yourbank': { success: false, failure_reason: 'upi_timeout',   description: 'UPI timeout — no response from bank' },
};

// Test bank account numbers → penny drop outcome
const BANK_SCENARIOS = {
  '9999000000000001': { success: true,  description: 'Valid account — penny drop success' },
  '9999000000000002': { success: false, description: 'Invalid account — penny drop failed' },
};

/**
 * Resolve test outcome from simulate flag, card number, or UPI handle.
 * Falls back to success if no scenario matches (real test mode default).
 */
function resolveTestOutcome({ simulate, card_number, upi_id }) {
  // Explicit simulate flag takes highest priority (backward compat)
  if (simulate === 'failure') return { success: false, failure_reason: 'simulated_failure' };
  if (simulate === 'success') return { success: true,  failure_reason: null };

  if (card_number) {
    const s = CARD_SCENARIOS[card_number?.trim()];
    if (s) return { success: s.success, failure_reason: s.failure_reason };
  }

  if (upi_id) {
    const s = UPI_SCENARIOS[upi_id?.toLowerCase()?.trim()];
    if (s) return { success: s.success, failure_reason: s.failure_reason };
  }

  return { success: true, failure_reason: null };
}

function getTestCards() {
  return Object.entries(CARD_SCENARIOS).map(([number, s]) => ({
    number,
    description: s.description,
    outcome: s.success ? 'success' : 'failure',
    failure_reason: s.failure_reason,
  }));
}

function getTestUpiHandles() {
  return Object.entries(UPI_SCENARIOS).map(([handle, s]) => ({
    handle,
    description: s.description,
    outcome: s.success ? 'success' : 'failure',
    failure_reason: s.failure_reason,
  }));
}

module.exports = { resolveTestOutcome, getTestCards, getTestUpiHandles, BANK_SCENARIOS };
