const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const VPA_RE  = /^[a-zA-Z0-9._-]+@[a-zA-Z]{3,}$/;

function createFundAccount(merchantId, opts) {
  const { contact_id, account_type, bank_name, account_number, ifsc, account_holder, vpa } = opts;
  if (!contact_id) throw new Error('contact_id is required');
  if (!['bank_account', 'vpa'].includes(account_type))
    throw new Error('account_type must be bank_account or vpa');

  const db      = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=? AND merchant_id=?').get(contact_id, merchantId);
  if (!contact) throw new Error('Contact not found');

  if (account_type === 'bank_account') {
    if (!account_number) throw new Error('account_number is required');
    if (!ifsc) throw new Error('ifsc is required');
    if (!IFSC_RE.test(ifsc.toUpperCase())) throw new Error('Invalid IFSC format (e.g. HDFC0001234)');
  } else {
    if (!vpa) throw new Error('vpa is required');
    if (!VPA_RE.test(vpa)) throw new Error('Invalid VPA format (e.g. name@upi)');
  }

  const id = 'fa_' + randomUUID().replace(/-/g, '').slice(0, 16);
  db.prepare(`
    INSERT INTO fund_accounts
      (id, contact_id, merchant_id, account_type, bank_name, account_number, ifsc, account_holder, vpa)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, contact_id, merchantId, account_type,
    bank_name ?? null, account_number ?? null,
    ifsc ? ifsc.toUpperCase() : null,
    account_holder ?? null, vpa ?? null);
  return getFundAccount(id);
}

function getFundAccount(id) {
  return getDb().prepare(`
    SELECT fa.*, c.name AS contact_name, c.email AS contact_email, c.type AS contact_type
    FROM fund_accounts fa JOIN contacts c ON fa.contact_id=c.id
    WHERE fa.id=?
  `).get(id);
}

function listFundAccounts(merchantId, { contact_id } = {}) {
  let where = 'WHERE fa.merchant_id=?';
  const params = [merchantId];
  if (contact_id) { where += ' AND fa.contact_id=?'; params.push(contact_id); }
  return getDb().prepare(`
    SELECT fa.*, c.name AS contact_name, c.type AS contact_type
    FROM fund_accounts fa JOIN contacts c ON fa.contact_id=c.id
    ${where} ORDER BY fa.created_at DESC
  `).all(...params);
}

function pennyDrop(fundAccountId, merchantId) {
  const db = getDb();
  const fa = getFundAccount(fundAccountId);
  if (!fa || fa.merchant_id !== merchantId) throw new Error('Fund account not found');
  if (fa.account_type !== 'bank_account') throw new Error('Penny drop only applies to bank accounts');

  // 95% success rate simulation
  const success = Math.random() > 0.05;
  const dropId  = 'pd_' + randomUUID().replace(/-/g, '').slice(0, 12);
  // Never downgrade a previously verified account — only set verified=1 on success
  const newVerified = success ? 1 : fa.verified ? 1 : 0;
  db.prepare('UPDATE fund_accounts SET verified=?, penny_drop_id=? WHERE id=?').run(newVerified, dropId, fundAccountId);
  return { id: dropId, verified: !!newVerified, fund_account_id: fundAccountId };
}

module.exports = { createFundAccount, getFundAccount, listFundAccounts, pennyDrop };
