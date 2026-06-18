const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { signPayload } = require('./signature');
const { logger, captureException } = require('./logger');

// Exponential backoff: 10s → 30s → 5m → 30m → 2h → give up
const RETRY_DELAYS = [10, 30, 300, 1800, 7200];

function queueWebhook({ merchantId, event, payload }) {
  const db = getDb();
  const id = 'wh_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO webhook_events (id, merchant_id, event, payload, status, next_retry_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, merchantId, event, JSON.stringify(payload), now);

  return id;
}

async function deliverWebhook(webhookId, webhookUrl, secret) {
  const db = getDb();
  const ev = db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(webhookId);
  if (!ev) throw new Error('Webhook not found');

  const payload = JSON.parse(ev.payload);
  const signature = signPayload(payload, secret);

  let delivered = false;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Signature': signature,
        'X-Gateway-Event': ev.event,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    delivered = res.ok;
  } catch {
    // Network error — fall through to retry logic
  }

  const now = Math.floor(Date.now() / 1000);
  if (delivered) {
    db.prepare(`UPDATE webhook_events SET status='delivered', delivered_at=?, attempts=attempts+1 WHERE id=?`)
      .run(now, webhookId);
    return true;
  }

  const nextAttempt = ev.attempts + 1;
  const delay = RETRY_DELAYS[nextAttempt];

  if (delay === undefined) {
    db.prepare(`UPDATE webhook_events SET status='failed', attempts=? WHERE id=?`)
      .run(nextAttempt, webhookId);
  } else {
    db.prepare(`UPDATE webhook_events SET attempts=?, next_retry_at=? WHERE id=?`)
      .run(nextAttempt, now + delay, webhookId);
  }
  return false;
}

function getPendingWebhooks() {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT * FROM webhook_events
    WHERE status = 'pending' AND next_retry_at <= ?
    ORDER BY next_retry_at ASC LIMIT 50
  `).all(now);
}

let _deliveryRunning = false;

async function runWebhookDelivery() {
  if (_deliveryRunning) return;
  _deliveryRunning = true;
  try {
    const pending = getPendingWebhooks();
    for (const ev of pending) {
      const db = getDb();
      // Find all active endpoints for this merchant that subscribe to this event
      const endpoints = db.prepare(`
        SELECT * FROM webhook_endpoints
        WHERE merchant_id=? AND is_active=1
          AND (events='*' OR events LIKE '%"*"%' OR events LIKE ?)
      `).all(ev.merchant_id, `%"${ev.event}"%`);

      if (endpoints.length === 0) {
        // No endpoints — mark delivered so it doesn't retry indefinitely
        db.prepare(`UPDATE webhook_events SET status='delivered', delivered_at=? WHERE id=?`)
          .run(Math.floor(Date.now() / 1000), ev.id);
        continue;
      }

      // Deliver to first matching endpoint (primary). Others are fire-and-forget.
      const [primary, ...rest] = endpoints;
      await deliverWebhook(ev.id, primary.url, primary.secret);
      for (const ep of rest) {
        deliverWebhook(ev.id, ep.url, ep.secret).catch((err) => {
          logger.warn({ err, webhookId: ev.id, url: ep.url }, 'secondary webhook delivery failed');
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'webhook delivery cycle error');
    captureException(err);
  } finally {
    _deliveryRunning = false;
  }
}

module.exports = { queueWebhook, deliverWebhook, getPendingWebhooks, runWebhookDelivery };
