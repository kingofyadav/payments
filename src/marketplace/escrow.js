'use strict';
const { randomUUID }   = require('crypto');
const { getDb }        = require('../db/database');
const { queueWebhook } = require('../systems/webhook');

function fundEscrow(merchantId, opts) {
  const {
    payment_id, linked_account_id, amount,
    currency = 'INR', description,
    auto_release_at, notes,
  } = opts;

  if (!linked_account_id) throw new Error('linked_account_id is required');
  if (!amount || !Number.isInteger(amount) || amount <= 0)
    throw new Error('amount must be a positive integer in paise');

  const db = getDb();
  const la = db.prepare('SELECT id, status FROM linked_accounts WHERE id=? AND merchant_id=?')
    .get(linked_account_id, merchantId);
  if (!la) throw new Error('Linked account not found');
  if (la.status !== 'activated') throw new Error('Linked account is not activated');

  if (payment_id) {
    const pay = db.prepare('SELECT status FROM payments WHERE id=? AND merchant_id=?').get(payment_id, merchantId);
    if (!pay) throw new Error('Payment not found');
    if (pay.status !== 'captured') throw new Error('Escrow must be funded from a captured payment');
  }

  const id  = 'escw_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO escrows
      (id, merchant_id, payment_id, linked_account_id, amount, currency, status,
       description, auto_release_at, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, merchantId, payment_id ?? null, linked_account_id,
    amount, currency, 'funded',
    description ?? null, auto_release_at ?? null,
    notes ? JSON.stringify(notes) : null, now);

  queueWebhook({
    merchantId,
    event:   'escrow.funded',
    payload: { event: 'escrow.funded', escrow_id: id, linked_account_id, amount, timestamp: new Date().toISOString() },
  });

  return getEscrow(id);
}

function releaseEscrow(id, merchantId) {
  const db = getDb();
  const e  = db.prepare('SELECT * FROM escrows WHERE id=?').get(id);
  if (!e) throw new Error('Escrow not found');
  if (merchantId && e.merchant_id !== merchantId) throw new Error('Forbidden');
  if (e.status !== 'funded') throw new Error(`Escrow cannot be released (status: ${e.status})`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE escrows SET status='released', released_at=? WHERE id=?").run(now, id);

  queueWebhook({
    merchantId: e.merchant_id,
    event:   'escrow.released',
    payload: { event: 'escrow.released', escrow_id: id, linked_account_id: e.linked_account_id, amount: e.amount, timestamp: new Date().toISOString() },
  });

  return getEscrow(id);
}

function refundEscrow(id, merchantId) {
  const db = getDb();
  const e  = db.prepare('SELECT * FROM escrows WHERE id=?').get(id);
  if (!e) throw new Error('Escrow not found');
  if (e.merchant_id !== merchantId) throw new Error('Forbidden');
  if (!['funded','disputed'].includes(e.status)) throw new Error(`Escrow cannot be refunded (status: ${e.status})`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE escrows SET status='refunded', refunded_at=? WHERE id=?").run(now, id);

  queueWebhook({
    merchantId,
    event:   'escrow.refunded',
    payload: { event: 'escrow.refunded', escrow_id: id, amount: e.amount, timestamp: new Date().toISOString() },
  });

  return getEscrow(id);
}

function disputeEscrow(id, merchantId, reason) {
  const db = getDb();
  const e  = db.prepare('SELECT * FROM escrows WHERE id=?').get(id);
  if (!e) throw new Error('Escrow not found');
  if (e.merchant_id !== merchantId) throw new Error('Forbidden');
  if (e.status !== 'funded') throw new Error(`Only funded escrows can be disputed (status: ${e.status})`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE escrows SET status='disputed', dispute_reason=?, disputed_at=? WHERE id=?")
    .run(reason ?? 'Dispute raised', now, id);

  queueWebhook({
    merchantId,
    event:   'escrow.disputed',
    payload: { event: 'escrow.disputed', escrow_id: id, reason, timestamp: new Date().toISOString() },
  });

  return getEscrow(id);
}

function getEscrow(id) {
  const row = getDb().prepare(`
    SELECT e.*, la.name AS linked_account_name, la.business_name
    FROM escrows e JOIN linked_accounts la ON e.linked_account_id=la.id
    WHERE e.id=?
  `).get(id);
  if (row?.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

function listEscrows(merchantId, { linked_account_id, status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE e.merchant_id=?';
  const params = [merchantId];
  if (linked_account_id) { where += ' AND e.linked_account_id=?'; params.push(linked_account_id); }
  if (status)            { where += ' AND e.status=?';            params.push(status); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM escrows e ${where}`).get(...params);
  const items = db.prepare(`
    SELECT e.*, la.name AS linked_account_name
    FROM escrows e JOIN linked_accounts la ON e.linked_account_id=la.id
    ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Math.min(limit, 100), offset);
  return { count, items };
}

// Background job — auto-releases escrows whose auto_release_at has passed
let _running = false;
async function runEscrowAutoRelease() {
  if (_running) return;
  _running = true;
  try {
    const now  = Math.floor(Date.now() / 1000);
    const rows = getDb().prepare(
      "SELECT id, merchant_id FROM escrows WHERE status='funded' AND auto_release_at IS NOT NULL AND auto_release_at <= ?"
    ).all(now);
    for (const row of rows) {
      try { releaseEscrow(row.id, null); } catch {}
    }
  } finally {
    _running = false;
  }
}

module.exports = { fundEscrow, releaseEscrow, refundEscrow, disputeEscrow, getEscrow, listEscrows, runEscrowAutoRelease };
