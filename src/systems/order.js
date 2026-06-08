const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { assertOrderTransition } = require('./state-machine');

const ORDER_TTL = 15 * 60; // 15 minutes in seconds

function createOrder({ merchantId, amount, currency = 'INR', customer = {}, notes }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer in paise (₹1 = 100)');
  }

  const db = getDb();
  const id = 'order_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const expiresAt = Math.floor(Date.now() / 1000) + ORDER_TTL;

  db.prepare(`
    INSERT INTO orders
      (id, merchant_id, amount, currency, customer_name, customer_email, customer_phone, notes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, merchantId, amount, currency,
    customer.name  ?? null,
    customer.email ?? null,
    customer.phone ?? null,
    notes ? JSON.stringify(notes) : null,
    expiresAt
  );

  return getOrder(id);
}

function getOrder(orderId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!row) return null;
  if (row.notes) row.notes = JSON.parse(row.notes);
  return row;
}

function transitionOrder(orderId, newStatus) {
  const order = getOrder(orderId);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  assertOrderTransition(order.status, newStatus);
  getDb().prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, orderId);
  return getOrder(orderId);
}

function listOrders(merchantId, { limit = 20, offset = 0 } = {}) {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE merchant_id = ?').get(merchantId);
  const items = db.prepare('SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(merchantId, Math.min(limit, 100), offset);
  return { count, items };
}

module.exports = { createOrder, getOrder, transitionOrder, listOrders };
