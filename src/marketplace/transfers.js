'use strict';
const { randomUUID }      = require('crypto');
const { getDb }           = require('../db/database');
const { queueWebhook }    = require('../systems/webhook');
const { computeCommission } = require('./commission');

function createTransfer(merchantId, opts) {
  const {
    payment_id, linked_account_id,
    amount, currency = 'INR',
    on_hold = false, hold_until,
    notes, source = 'transfer',
  } = opts;

  if (!linked_account_id) throw new Error('linked_account_id is required');
  if (!amount || !Number.isInteger(amount) || amount <= 0)
    throw new Error('amount must be a positive integer in paise');

  const db = getDb();
  const la = db.prepare('SELECT * FROM linked_accounts WHERE id=? AND merchant_id=?')
    .get(linked_account_id, merchantId);
  if (!la) throw new Error('Linked account not found');
  if (la.status !== 'activated') throw new Error(`Linked account is not activated (status: ${la.status})`);

  // Validate source payment belongs to this merchant if provided
  if (payment_id) {
    const pay = db.prepare('SELECT id, status FROM payments WHERE id=? AND merchant_id=?')
      .get(payment_id, merchantId);
    if (!pay) throw new Error('Payment not found');
    if (pay.status !== 'captured') throw new Error('Transfers can only be made from captured payments');
  }

  const { commission, net } = computeCommission(amount, la);
  const id     = 'trf_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const now    = Math.floor(Date.now() / 1000);
  const status = on_hold ? 'on_hold' : 'processed';

  db.prepare(`
    INSERT INTO transfers
      (id, merchant_id, payment_id, linked_account_id, amount, commission, net_amount,
       currency, on_hold, hold_until, status, source, notes, created_at, processed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, merchantId, payment_id ?? null, linked_account_id,
    amount, commission, net, currency,
    on_hold ? 1 : 0, hold_until ?? null,
    status, source,
    notes ? JSON.stringify(notes) : null, now,
    on_hold ? null : now);

  const event = on_hold ? 'transfer.created' : 'transfer.processed';
  queueWebhook({
    merchantId,
    event,
    payload: { event, transfer_id: id, linked_account_id, payment_id, amount, net, timestamp: new Date().toISOString() },
  });

  return getTransfer(id);
}

function getTransfer(id) {
  const row = getDb().prepare(`
    SELECT t.*, la.name AS linked_account_name, la.business_name, la.commission_type
    FROM transfers t
    JOIN linked_accounts la ON t.linked_account_id = la.id
    WHERE t.id=?
  `).get(id);
  if (row?.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

function listTransfers(merchantId, { linked_account_id, payment_id, status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE t.merchant_id=?';
  const params = [merchantId];
  if (linked_account_id) { where += ' AND t.linked_account_id=?'; params.push(linked_account_id); }
  if (payment_id)        { where += ' AND t.payment_id=?';        params.push(payment_id); }
  if (status)            { where += ' AND t.status=?';            params.push(status); }

  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM transfers t ${where}`).get(...params);
  const items = db.prepare(`
    SELECT t.*, la.name AS linked_account_name
    FROM transfers t JOIN linked_accounts la ON t.linked_account_id=la.id
    ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Math.min(limit, 100), offset);
  return { count, items };
}

function releaseTransfer(id, merchantId) {
  const db = getDb();
  const t  = db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
  if (!t) throw new Error('Transfer not found');
  if (t.merchant_id !== merchantId) throw new Error('Forbidden');
  if (t.status !== 'on_hold') throw new Error(`Transfer is not on hold (status: ${t.status})`);

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE transfers SET status=?, processed_at=?, on_hold=0, hold_until=NULL WHERE id=?')
    .run('processed', now, id);

  queueWebhook({
    merchantId,
    event:   'transfer.released',
    payload: { event: 'transfer.released', transfer_id: id, timestamp: new Date().toISOString() },
  });

  return getTransfer(id);
}

function createReversal(transferId, merchantId, { amount, reason, notes } = {}) {
  const db = getDb();
  const t  = db.prepare('SELECT * FROM transfers WHERE id=?').get(transferId);
  if (!t) throw new Error('Transfer not found');
  if (t.merchant_id !== merchantId) throw new Error('Forbidden');
  if (t.status !== 'processed') throw new Error('Only processed transfers can be reversed');

  // Check no active reversal already exists
  const existing = db.prepare(
    "SELECT id FROM transfer_reversals WHERE transfer_id=? AND status != 'failed'"
  ).get(transferId);
  if (existing) throw new Error('A reversal already exists for this transfer');

  const reversalAmount = amount ?? t.amount;
  if (!Number.isInteger(reversalAmount) || reversalAmount <= 0)
    throw new Error('amount must be a positive integer in paise');
  if (reversalAmount > t.amount)
    throw new Error(`Reversal amount cannot exceed transfer amount of ₹${t.amount / 100}`);

  const id  = 'trev_' + randomUUID().replace(/-/g, '').slice(0, 14);
  const now = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO transfer_reversals (id, transfer_id, merchant_id, amount, reason, notes, status, created_at, processed_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, transferId, merchantId, reversalAmount, reason ?? null,
        notes ? JSON.stringify(notes) : null, 'processed', now, now);
    db.prepare("UPDATE transfers SET status='reversed' WHERE id=?").run(transferId);
  })();

  queueWebhook({
    merchantId,
    event:   'transfer.reversed',
    payload: { event: 'transfer.reversed', transfer_id: transferId, reversal_id: id, amount: reversalAmount, timestamp: new Date().toISOString() },
  });

  return getReversal(id);
}

function getReversal(id) {
  const row = getDb().prepare('SELECT * FROM transfer_reversals WHERE id=?').get(id);
  if (row?.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

function listReversals(transferId, merchantId) {
  const t = getDb().prepare('SELECT id, merchant_id FROM transfers WHERE id=?').get(transferId);
  if (!t || t.merchant_id !== merchantId) return null;
  return getDb().prepare('SELECT * FROM transfer_reversals WHERE transfer_id=? ORDER BY created_at DESC').all(transferId);
}

// Called from POST /v1/payments when route[] is present
function applyRouteSplits(paymentId, merchantId, paymentAmount, routeInstructions) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  const splits = routeInstructions.map(r => {
    const la = db.prepare('SELECT * FROM linked_accounts WHERE id=? AND merchant_id=?')
      .get(r.linked_account_id, merchantId);
    if (!la) throw new Error(`Linked account not found: ${r.linked_account_id}`);
    if (la.status !== 'activated') throw new Error(`Linked account ${r.linked_account_id} is not activated`);
    if (!Number.isInteger(r.amount) || r.amount <= 0)
      throw new Error(`Route amount must be a positive integer for ${r.linked_account_id}`);
    const { commission, net } = computeCommission(r.amount, la);
    return { ...r, la, commission, net };
  });

  const totalRouted = splits.reduce((s, r) => s + r.amount, 0);
  if (totalRouted > paymentAmount)
    throw new Error(`Route total (₹${totalRouted/100}) exceeds payment amount (₹${paymentAmount/100})`);

  db.transaction(() => {
    for (const split of splits) {
      const splitId = 'rs_' + randomUUID().replace(/-/g, '').slice(0, 14);
      db.prepare(`
        INSERT INTO route_splits
          (id, payment_id, merchant_id, linked_account_id, amount, commission, net_amount,
           on_hold, hold_until, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(splitId, paymentId, merchantId, split.linked_account_id,
          split.amount, split.commission, split.net,
          split.on_hold ? 1 : 0, split.hold_until ?? null, 'created', now);
    }
  })();

  // Create transfers for each split
  for (const split of splits) {
    const trf = createTransfer(merchantId, {
      payment_id: paymentId,
      linked_account_id: split.linked_account_id,
      amount: split.amount,
      on_hold: !!split.on_hold,
      hold_until: split.hold_until,
      source: 'route',
      notes: split.notes,
    });
    // Link transfer back to route_split
    db.prepare('UPDATE route_splits SET transfer_id=? WHERE payment_id=? AND linked_account_id=?')
      .run(trf.id, paymentId, split.linked_account_id);
  }
}

module.exports = {
  createTransfer, getTransfer, listTransfers,
  releaseTransfer, createReversal, getReversal, listReversals,
  applyRouteSplits,
};
