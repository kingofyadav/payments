const { randomUUID } = require('crypto');
const { getDb }          = require('../db/database');
const { createContact }  = require('./contacts');
const { createFundAccount, getFundAccount } = require('./fund_accounts');
const { createPayout }   = require('./engine');

function createBatch(merchantId, { name, description, items }) {
  if (!name || !name.trim()) throw new Error('name is required');
  if (!Array.isArray(items) || items.length === 0) throw new Error('items must be a non-empty array');
  if (items.length > 1000) throw new Error('Batch cannot exceed 1000 items');

  const db          = getDb();
  const id          = 'batch_' + randomUUID().replace(/-/g, '').slice(0, 14);
  const totalAmount = items.reduce((s, i) => s + (Number.isInteger(i.amount) ? i.amount : 0), 0);

  db.prepare(`
    INSERT INTO payout_batches (id, merchant_id, name, description, total_count, total_amount, pending_count)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, merchantId, name.trim(), description ?? null, items.length, totalAmount, items.length);

  for (const item of items) {
    const itemId = 'bi_' + randomUUID().replace(/-/g, '').slice(0, 14);
    db.prepare(`
      INSERT INTO payout_batch_items
        (id, batch_id, merchant_id, name, account_number, ifsc, vpa, amount, purpose, reference_id, narration)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(itemId, id, merchantId,
      item.name ?? null, item.account_number ?? null, item.ifsc ?? null,
      item.vpa ?? null, item.amount, item.purpose ?? 'payout',
      item.reference_id ?? null, item.narration ?? null);
  }

  return getBatch(id);
}

function getBatch(id) {
  const db    = getDb();
  const batch = db.prepare('SELECT * FROM payout_batches WHERE id=?').get(id);
  if (!batch) return null;
  batch.items = db.prepare('SELECT * FROM payout_batch_items WHERE batch_id=? ORDER BY created_at ASC').all(id);
  return batch;
}

function listBatches(merchantId, { limit = 20, offset = 0 } = {}) {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM payout_batches WHERE merchant_id=?').get(merchantId);
  const items = db.prepare(
    'SELECT * FROM payout_batches WHERE merchant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(merchantId, limit, offset);
  return { total: count, items };
}

// Validate all rows → resolve/create contacts + fund accounts → queue payouts
async function processBatch(batchId, merchantId) {
  const db    = getDb();
  const batch = getBatch(batchId);
  if (!batch || batch.merchant_id !== merchantId) throw new Error('Batch not found');
  if (batch.status !== 'draft') throw new Error(`Batch is already in status: ${batch.status}`);

  db.prepare("UPDATE payout_batches SET status='validating' WHERE id=?").run(batchId);

  let successCount = 0, failedCount = 0;

  for (const item of batch.items) {
    try {
      if (!item.amount || item.amount <= 0) throw new Error('amount must be a positive integer in paise');
      if (!item.account_number && !item.vpa) throw new Error('account_number or vpa is required');
      if (item.account_number && !item.ifsc)  throw new Error('ifsc is required for bank accounts');
      if (!item.name) throw new Error('name is required');

      // Find or create contact by name (best-effort match)
      let contact = db.prepare('SELECT * FROM contacts WHERE merchant_id=? AND name=? LIMIT 1')
        .get(merchantId, item.name);
      if (!contact) contact = createContact(merchantId, { name: item.name, type: 'vendor' });

      // Find or create fund account
      let fa;
      if (item.vpa) {
        fa = db.prepare("SELECT * FROM fund_accounts WHERE merchant_id=? AND vpa=? AND active=1").get(merchantId, item.vpa);
        if (!fa) fa = createFundAccount(merchantId, { contact_id: contact.id, account_type: 'vpa', vpa: item.vpa });
      } else {
        fa = db.prepare(
          "SELECT * FROM fund_accounts WHERE merchant_id=? AND account_number=? AND ifsc=? AND active=1"
        ).get(merchantId, item.account_number, item.ifsc.toUpperCase());
        if (!fa) {
          fa = createFundAccount(merchantId, {
            contact_id: contact.id, account_type: 'bank_account',
            account_number: item.account_number, ifsc: item.ifsc,
            account_holder: item.name,
          });
          // Auto-verify for batch payouts (real system would require individual penny drop)
          db.prepare('UPDATE fund_accounts SET verified=1 WHERE id=?').run(fa.id);
          fa = getFundAccount(fa.id);
        }
      }

      const payout = createPayout(merchantId, {
        fund_account_id: fa.id, amount: item.amount, mode: 'auto',
        purpose: item.purpose ?? 'payout',
        reference_id: item.reference_id, narration: item.narration,
      });

      db.prepare(`
        UPDATE payout_batch_items SET status='queued', fund_account_id=?, contact_id=?, payout_id=? WHERE id=?
      `).run(fa.id, contact.id, payout.id, item.id);
      successCount++;
    } catch (err) {
      db.prepare("UPDATE payout_batch_items SET status='failed', error=? WHERE id=?").run(err.message, item.id);
      failedCount++;
    }
  }

  const pending  = batch.items.length - successCount - failedCount;
  const newStatus = failedCount === batch.items.length ? 'failed' : 'processing';
  db.prepare(`
    UPDATE payout_batches SET status=?, success_count=?, failed_count=?, pending_count=? WHERE id=?
  `).run(newStatus, successCount, failedCount, pending, batchId);

  return getBatch(batchId);
}

module.exports = { createBatch, getBatch, listBatches, processBatch };
