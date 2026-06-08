'use strict';
const { randomUUID }      = require('crypto');
const { getDb }           = require('../db/database');
const { queueWebhook }    = require('../systems/webhook');

const VALID_TYPES     = ['individual', 'company', 'partnership', 'llp'];
const VALID_COM_TYPES = ['fixed_pct', 'flat_fee', 'hybrid'];

function createLinkedAccount(merchantId, opts) {
  const {
    name, email, phone,
    business_name, business_type = 'individual',
    commission_type = 'fixed_pct',
    commission_pct  = 0,
    commission_flat = 0,
    notes,
  } = opts;

  if (!name?.trim()) throw new Error('name is required');
  if (!VALID_TYPES.includes(business_type))
    throw new Error(`business_type must be one of: ${VALID_TYPES.join(', ')}`);
  if (!VALID_COM_TYPES.includes(commission_type))
    throw new Error(`commission_type must be one of: ${VALID_COM_TYPES.join(', ')}`);
  if (commission_type !== 'flat_fee' && (commission_pct < 0 || commission_pct > 100))
    throw new Error('commission_pct must be between 0 and 100');
  if (commission_type !== 'fixed_pct' && commission_flat < 0)
    throw new Error('commission_flat must be non-negative');

  const db = getDb();
  const id = 'la_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO linked_accounts
      (id, merchant_id, name, email, phone, business_name, business_type,
       commission_type, commission_pct, commission_flat, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, merchantId, name.trim(), email ?? null, phone ?? null,
    business_name ?? null, business_type,
    commission_type, commission_pct, commission_flat,
    notes ? JSON.stringify(notes) : null, now, now);

  return getLinkedAccount(id);
}

function getLinkedAccount(id) {
  const row = getDb().prepare('SELECT * FROM linked_accounts WHERE id=?').get(id);
  if (row?.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

function listLinkedAccounts(merchantId, { status, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE merchant_id=?';
  const params = [merchantId];
  if (status) { where += ' AND status=?'; params.push(status); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM linked_accounts ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM linked_accounts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 100), offset).map(_parse);
  return { count, items };
}

function updateLinkedAccount(id, merchantId, updates) {
  const db = getDb();
  const la = db.prepare('SELECT * FROM linked_accounts WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!la) return null;

  const sets = [], vals = [];
  const allowed = ['name','email','phone','business_name','commission_type','commission_pct','commission_flat','notes'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key}=?`);
      vals.push(key === 'notes' && updates[key] ? JSON.stringify(updates[key]) : updates[key] ?? null);
    }
  }
  if (!sets.length) throw new Error('Nothing to update');
  sets.push('updated_at=?');
  vals.push(Math.floor(Date.now() / 1000));
  db.prepare(`UPDATE linked_accounts SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  return getLinkedAccount(id);
}

function activateLinkedAccount(id, merchantId) {
  const db = getDb();
  const la = db.prepare('SELECT * FROM linked_accounts WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!la) return null;
  if (la.status === 'activated') throw new Error('Linked account is already activated');
  if (la.status === 'rejected')  throw new Error('Rejected accounts cannot be activated');
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE linked_accounts SET status=?, kyc_status=?, updated_at=? WHERE id=?')
    .run('activated', 'verified', now, id);

  queueWebhook({
    merchantId,
    event:   'linked_account.activated',
    payload: { event: 'linked_account.activated', linked_account_id: id, timestamp: new Date().toISOString() },
  });

  return getLinkedAccount(id);
}

function suspendLinkedAccount(id, merchantId) {
  const db = getDb();
  const la = db.prepare('SELECT * FROM linked_accounts WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!la) return null;
  if (!['created','activated'].includes(la.status)) throw new Error(`Cannot suspend: status is ${la.status}`);
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE linked_accounts SET status=?, updated_at=? WHERE id=?').run('suspended', now, id);

  queueWebhook({
    merchantId,
    event:   'linked_account.suspended',
    payload: { event: 'linked_account.suspended', linked_account_id: id, timestamp: new Date().toISOString() },
  });

  return getLinkedAccount(id);
}

function _parse(row) {
  if (!row) return null;
  if (row.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

module.exports = {
  createLinkedAccount, getLinkedAccount, listLinkedAccounts,
  updateLinkedAccount, activateLinkedAccount, suspendLinkedAccount,
};
