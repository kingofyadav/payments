const { randomUUID, randomBytes } = require('crypto');
const { getDb }              = require('../db/database');
const { createContact }      = require('./contacts');
const { createFundAccount }  = require('./fund_accounts');
const { createPayout }       = require('./engine');

const LINK_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function _generateCode() {
  return Array.from(randomBytes(12))
    .map(b => LINK_CHARS[b % LINK_CHARS.length])
    .join('')
    .slice(0, 10);
}

function createPayoutLink(merchantId, opts) {
  const { amount, currency = 'INR', purpose = 'payout', description, expires_in = 3 * 86400, contact_id } = opts;
  if (!amount || !Number.isInteger(amount) || amount <= 0)
    throw new Error('amount must be a positive integer in paise');
  if (currency !== 'INR') throw new Error('Only INR is supported');

  const db        = getDb();
  const id        = 'plink_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const code      = _generateCode();
  const expiresAt = Math.floor(Date.now() / 1000) + expires_in;

  db.prepare(`
    INSERT INTO payout_links (id, merchant_id, code, amount, currency, purpose, description, contact_id, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, merchantId, code, amount, currency, purpose, description ?? null, contact_id ?? null, expiresAt);
  return getPayoutLink(id);
}

function getPayoutLink(id) {
  return getDb().prepare('SELECT * FROM payout_links WHERE id=?').get(id);
}

function getPayoutLinkByCode(code) {
  return getDb().prepare('SELECT * FROM payout_links WHERE code=?').get(code);
}

function listPayoutLinks(merchantId, { limit = 20, offset = 0 } = {}) {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM payout_links WHERE merchant_id=?').get(merchantId);
  const items = db.prepare(
    'SELECT * FROM payout_links WHERE merchant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(merchantId, limit, offset);
  return { total: count, items };
}

// Called when beneficiary submits their bank details via the link
async function claimPayoutLink(code, { name, email, phone, account_type, account_number, ifsc, vpa }) {
  const db   = getDb();
  const link = getPayoutLinkByCode(code);
  if (!link) throw new Error('Payout link not found');
  if (link.status !== 'pending') throw new Error(`Link is already ${link.status}`);

  const now = Math.floor(Date.now() / 1000);
  if (link.expires_at && link.expires_at < now) {
    db.prepare("UPDATE payout_links SET status='expired' WHERE id=?").run(link.id);
    throw new Error('Payout link has expired');
  }

  if (!name) throw new Error('name is required');
  const resolvedType = account_type ?? (vpa ? 'vpa' : 'bank_account');

  // Find or create contact
  let contact;
  if (link.contact_id) {
    contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(link.contact_id);
  }
  if (!contact) {
    contact = createContact(link.merchant_id, { name, email, phone, type: 'customer' });
  }

  const fa = createFundAccount(link.merchant_id, {
    contact_id: contact.id, account_type: resolvedType,
    account_number, ifsc, vpa, account_holder: name,
  });

  // Auto-verify for link claims
  if (resolvedType === 'bank_account') {
    db.prepare('UPDATE fund_accounts SET verified=1 WHERE id=?').run(fa.id);
  }

  const payout = createPayout(link.merchant_id, {
    fund_account_id: fa.id, amount: link.amount, currency: link.currency,
    mode: 'auto', purpose: link.purpose, narration: link.description,
  });

  db.prepare("UPDATE payout_links SET status='processing', payout_id=? WHERE id=?").run(payout.id, link.id);
  return { payout_link_id: link.id, payout_id: payout.id, amount: link.amount, status: 'processing' };
}

module.exports = { createPayoutLink, getPayoutLink, getPayoutLinkByCode, listPayoutLinks, claimPayoutLink };
