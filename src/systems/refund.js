const { randomUUID } = require('crypto');
const { getDb }      = require('../db/database');
const { queueWebhook } = require('./webhook');

function createRefund(merchantId, { payment_id, amount, speed = 'normal', notes } = {}) {
  if (!payment_id) throw new Error('payment_id is required');

  const db      = getDb();
  const payment = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(payment_id, merchantId);
  if (!payment) throw new Error('Payment not found');
  if (payment.status !== 'captured') throw new Error(`Cannot refund a payment with status: ${payment.status}`);

  const id  = 'rfnd_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Math.floor(Date.now() / 1000);
  let refundAmount;

  // Atomic: read remaining balance, validate, and insert in one transaction
  // to prevent concurrent refunds from exceeding the payment amount.
  db.transaction(() => {
    const { already } = db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS already FROM refunds WHERE payment_id=? AND status != 'failed'"
    ).get(payment_id);
    refundAmount = amount ?? (payment.amount - already);

    if (!Number.isInteger(refundAmount) || refundAmount <= 0)
      throw new Error('amount must be a positive integer in paise');
    if (refundAmount > payment.amount - already)
      throw new Error(`Refund amount ₹${refundAmount/100} exceeds remaining refundable ₹${(payment.amount - already)/100}`);

    db.prepare(`
      INSERT INTO refunds (id, payment_id, merchant_id, amount, speed, notes, status, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'processed', ?)
    `).run(id, payment_id, merchantId, refundAmount, speed, notes ? JSON.stringify(notes) : null, now);

    // If fully refunded, mark payment as refunded
    const { newTotal } = db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS newTotal FROM refunds WHERE payment_id=? AND status='processed'"
    ).get(payment_id);
    if (newTotal >= payment.amount) {
      db.prepare("UPDATE payments SET status='refunded' WHERE id=?").run(payment_id);
    }
  })();

  queueWebhook({
    merchantId,
    event:   'refund.created',
    payload: { event: 'refund.created', refund_id: id, payment_id, amount: refundAmount, timestamp: new Date().toISOString() },
  });

  return getRefund(id);
}

function getRefund(id) {
  return getDb().prepare('SELECT * FROM refunds WHERE id=?').get(id);
}

function listRefunds(merchantId, { payment_id, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE merchant_id=?';
  const params = [merchantId];
  if (payment_id) { where += ' AND payment_id=?'; params.push(payment_id); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM refunds ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM refunds ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 100), offset);
  return { count, items };
}

module.exports = { createRefund, getRefund, listRefunds };
