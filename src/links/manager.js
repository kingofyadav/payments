const { randomUUID } = require('crypto');
const { getDb }       = require('../db/database');
const { generateCode } = require('./shortcode');

function createLink(merchantId, opts) {
  const {
    type = 'link', title, description, image_url,
    amount, amount_type = 'fixed', min_amount, max_amount,
    allow_partial = false, customer_name, customer_email, customer_phone,
    custom_fields, max_payments, expires_at,
    success_message, redirect_url,
  } = opts;

  if (!title) throw new Error('title is required');
  if (amount_type === 'fixed' && !amount) throw new Error('amount required for fixed type');
  if (amount_type === 'range' && (!min_amount || !max_amount)) {
    throw new Error('min_amount and max_amount required for range type');
  }
  if (amount_type === 'range' && min_amount >= max_amount) {
    throw new Error('min_amount must be less than max_amount');
  }
  // Fix #4 — reject already-expired links at creation time
  if (expires_at && expires_at <= Math.floor(Date.now() / 1000)) {
    throw new Error('expires_at must be in the future');
  }
  // Fix #6 — reject nonsensical max_payments
  if (max_payments !== undefined && max_payments !== null && max_payments < 1) {
    throw new Error('max_payments must be at least 1');
  }

  const db   = getDb();
  const id   = 'lnk_' + randomUUID().replace(/-/g, '').slice(0, 16);
  let   code = generateCode();
  // Regenerate on collision (astronomically rare but safe)
  while (db.prepare('SELECT 1 FROM payment_links WHERE code=?').get(code)) {
    code = generateCode();
  }

  db.prepare(`
    INSERT INTO payment_links
      (id, merchant_id, code, type, title, description, image_url,
       amount, amount_type, min_amount, max_amount, allow_partial,
       customer_name, customer_email, customer_phone,
       custom_fields, max_payments, expires_at, success_message, redirect_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, merchantId, code, type, title, description ?? null, image_url ?? null,
    amount ?? null, amount_type, min_amount ?? null, max_amount ?? null,
    allow_partial ? 1 : 0,
    customer_name ?? null, customer_email ?? null, customer_phone ?? null,
    custom_fields ? JSON.stringify(custom_fields) : null,
    max_payments ?? null, expires_at ?? null,
    success_message ?? null, redirect_url ?? null
  );

  return getLink(id);
}

function getLink(id) {
  const row = getDb().prepare('SELECT * FROM payment_links WHERE id=?').get(id);
  return row ? parseLink(row) : null;
}

function getLinkByCode(code) {
  const row = getDb().prepare('SELECT * FROM payment_links WHERE code=?').get(code);
  return row ? parseLink(row) : null;
}

function parseLink(row) {
  if (row.custom_fields) row.custom_fields = JSON.parse(row.custom_fields);
  return row;
}

function listLinks(merchantId, { limit = 20, offset = 0, type } = {}) {
  let q = 'SELECT * FROM payment_links WHERE merchant_id=?';
  const p = [merchantId];
  if (type) { q += ' AND type=?'; p.push(type); }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  return getDb().prepare(q).all(...p, limit, offset).map(parseLink);
}

function deactivateLink(id, merchantId) {
  const result = getDb()
    .prepare("UPDATE payment_links SET status='deactivated' WHERE id=? AND merchant_id=?")
    .run(id, merchantId);
  return result.changes > 0;
}

function getLinkPayments(linkId) {
  return getDb().prepare(
    'SELECT * FROM link_payments WHERE link_id=? ORDER BY created_at DESC'
  ).all(linkId);
}

// Called by expiry cron — marks all expired active links
function expireOverdueLinks() {
  const now = Math.floor(Date.now() / 1000);
  const result = getDb().prepare(`
    UPDATE payment_links SET status='expired'
    WHERE expires_at IS NOT NULL AND expires_at < ?
      AND status IN ('active','partially_paid')
  `).run(now);
  return result.changes;
}

module.exports = {
  createLink, getLink, getLinkByCode, listLinks,
  deactivateLink, getLinkPayments, expireOverdueLinks,
};
