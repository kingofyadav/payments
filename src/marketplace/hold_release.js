'use strict';
const { getDb }        = require('../db/database');
const { queueWebhook } = require('../systems/webhook');

let _running = false;

async function runTransferHoldRelease() {
  if (_running) return;
  _running = true;
  try {
    const now  = Math.floor(Date.now() / 1000);
    const rows = getDb().prepare(
      "SELECT * FROM transfers WHERE status='on_hold' AND hold_until IS NOT NULL AND hold_until <= ?"
    ).all(now);

    for (const t of rows) {
      try {
        getDb().prepare("UPDATE transfers SET status='processed', processed_at=?, on_hold=0, hold_until=NULL WHERE id=?")
          .run(now, t.id);
        queueWebhook({
          merchantId: t.merchant_id,
          event:      'transfer.released',
          payload:    { event: 'transfer.released', transfer_id: t.id, auto: true, timestamp: new Date().toISOString() },
        });
      } catch {}
    }
  } finally {
    _running = false;
  }
}

module.exports = { runTransferHoldRelease };
