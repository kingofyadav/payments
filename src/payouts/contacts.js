const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const CONTACT_TYPES = ['vendor', 'employee', 'customer', 'self'];

function createContact(merchantId, opts) {
  const { name, email, phone, type = 'vendor', gstin, notes } = opts;
  if (!name || !name.trim()) throw new Error('name is required');
  if (!CONTACT_TYPES.includes(type)) throw new Error(`type must be one of: ${CONTACT_TYPES.join(', ')}`);

  const db = getDb();
  const id = 'cont_' + randomUUID().replace(/-/g, '').slice(0, 16);
  db.prepare(`
    INSERT INTO contacts (id, merchant_id, name, email, phone, type, gstin, notes)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, merchantId, name.trim(), email ?? null, phone ?? null, type,
    gstin ?? null, notes ? JSON.stringify(notes) : null);
  return getContact(id);
}

function getContact(id) {
  const row = getDb().prepare('SELECT * FROM contacts WHERE id=?').get(id);
  if (row?.notes) { try { row.notes = JSON.parse(row.notes); } catch {} }
  return row;
}

function listContacts(merchantId, { type, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let where = 'WHERE merchant_id=?';
  const params = [merchantId];
  if (type) { where += ' AND type=?'; params.push(type); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM contacts ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM contacts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  return { total: count, items };
}

function updateContact(id, merchantId, updates) {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=? AND merchant_id=?').get(id, merchantId);
  if (!contact) return null;
  const allowed = ['name', 'email', 'phone', 'type', 'gstin'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (updates[k] !== undefined) { sets.push(`${k}=?`); vals.push(updates[k]); }
  }
  if (!sets.length) return getContact(id);
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  return getContact(id);
}

module.exports = { createContact, getContact, listContacts, updateContact };
