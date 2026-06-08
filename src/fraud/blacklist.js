'use strict';
const { randomUUID } = require('crypto');
const { getDb }      = require('../db/database');

const VALID_TYPES = ['ip', 'card_bin', 'email', 'phone', 'device_id', 'merchant_id'];

function isBlacklisted(type, value) {
  if (!value) return false;
  const now = Math.floor(Date.now() / 1000);
  const row = getDb().prepare(`
    SELECT id FROM blacklists
    WHERE type=? AND value=? AND (expires_at IS NULL OR expires_at > ?)
  `).get(type, String(value).toLowerCase().trim(), now);
  return !!row;
}

// Check multiple fields simultaneously — returns first hit or null
function checkBlacklists({ ip, card_bin, email, phone, device_id } = {}) {
  const checks = [
    ip        ? ['ip',        ip]        : null,
    card_bin  ? ['card_bin',  card_bin]  : null,
    email     ? ['email',     email]     : null,
    phone     ? ['phone',     phone]     : null,
    device_id ? ['device_id', device_id] : null,
  ].filter(Boolean);

  for (const [type, value] of checks) {
    if (isBlacklisted(type, value)) return { blocked: true, type, value };
  }
  return { blocked: false };
}

function addToBlacklist(type, value, { reason, added_by = 'system', expires_at = null } = {}) {
  if (!VALID_TYPES.includes(type)) throw new Error(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (!value?.toString().trim()) throw new Error('value is required');

  const db  = getDb();
  const id  = 'bl_' + randomUUID().replace(/-/g, '').slice(0, 14);
  const now = Math.floor(Date.now() / 1000);
  const v   = String(value).toLowerCase().trim();

  db.prepare(`
    INSERT INTO blacklists (id, type, value, reason, added_by, expires_at, created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(type, value) DO UPDATE SET
      reason=excluded.reason,
      added_by=excluded.added_by,
      expires_at=excluded.expires_at
  `).run(id, type, v, reason ?? null, added_by, expires_at ?? null, now);

  return db.prepare('SELECT * FROM blacklists WHERE type=? AND value=?').get(type, v);
}

function removeFromBlacklist(type, value) {
  const v = String(value).toLowerCase().trim();
  return getDb().prepare('DELETE FROM blacklists WHERE type=? AND value=?').run(type, v).changes > 0;
}

function listBlacklist({ type, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  let where = '';
  const params = [];
  if (type) { where = 'WHERE type=?'; params.push(type); }
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM blacklists ${where}`).get(...params);
  const items = db.prepare(
    `SELECT * FROM blacklists ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 200), offset);
  return { count, items };
}

module.exports = { isBlacklisted, checkBlacklists, addToBlacklist, removeFromBlacklist, listBlacklist, VALID_TYPES };
