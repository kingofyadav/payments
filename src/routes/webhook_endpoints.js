const express    = require('express');
const { randomUUID, randomBytes } = require('crypto');
const { getDb }  = require('../db/database');
const { apiError } = require('../middleware/errors');

const router = express.Router();

const ALL_EVENTS = [
  'payment.created', 'payment.captured', 'payment.failed', 'payment.refunded',
  'order.created', 'order.paid',
  'refund.created',
  'subscription.activated', 'subscription.charged', 'subscription.halted', 'subscription.cancelled',
  'settlement.processed',
  'payout.processed', 'payout.failed',
];

// POST /v1/webhooks — register a webhook endpoint
router.post('/', (req, res) => {
  const { url, events = ['*'], secret } = req.body;
  if (!url) return apiError(res, 400, 'url is required', { field: 'url' });
  if (!url.startsWith('http')) return apiError(res, 400, 'url must be a valid HTTP/HTTPS URL', { field: 'url' });

  const validEvents = events === '*' || (Array.isArray(events) && events.every(e => e === '*' || ALL_EVENTS.includes(e)));
  if (!validEvents) return apiError(res, 400, `Invalid event types. Valid events: ${ALL_EVENTS.join(', ')}`);

  const db  = getDb();
  const id  = 'whe_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const sec = secret || randomBytes(20).toString('hex');
  const eventsStr = Array.isArray(events) ? JSON.stringify(events) : '*';

  db.prepare(`
    INSERT INTO webhook_endpoints (id, merchant_id, url, secret, events)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.merchantId, url, sec, eventsStr);

  const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id);
  res.status(201).json({ ...row, events: row.events === '*' ? ['*'] : JSON.parse(row.events), secret: sec });
});

// GET /v1/webhooks — list active endpoints
router.get('/', (req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM webhook_endpoints WHERE merchant_id=? AND is_active=1 ORDER BY created_at DESC'
  ).all(req.merchantId);
  res.json({
    count: rows.length,
    items: rows.map(r => ({
      ...r,
      events: r.events === '*' ? ['*'] : JSON.parse(r.events),
      secret: r.secret.slice(0, 6) + '••••••••••',  // mask secret in list
    })),
  });
});

// GET /v1/webhooks/:id
router.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(req.params.id);
  if (!row) return apiError(res, 404, 'Webhook endpoint not found');
  if (row.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json({ ...row, events: row.events === '*' ? ['*'] : JSON.parse(row.events) });
});

// DELETE /v1/webhooks/:id
router.delete('/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(req.params.id);
  if (!row) return apiError(res, 404, 'Webhook endpoint not found');
  if (row.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  db.prepare('UPDATE webhook_endpoints SET is_active=0 WHERE id=?').run(req.params.id);
  res.json({ id: req.params.id, deleted: true });
});

// POST /v1/webhooks/:id/test — send a test event
router.post('/:id/test', async (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id=? AND is_active=1').get(req.params.id);
  if (!row) return apiError(res, 404, 'Webhook endpoint not found');
  if (row.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');

  const { signPayload } = require('../systems/signature');
  const payload = {
    event: 'webhook.test',
    merchant_id: req.merchantId,
    timestamp: new Date().toISOString(),
    message: 'This is a test webhook from PayEngine',
  };
  const sig = signPayload(payload, row.secret);

  try {
    const r = await fetch(row.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Signature': sig, 'X-Gateway-Event': 'webhook.test' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10_000),
    });
    res.json({ ok: r.ok, status: r.status });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = { router, ALL_EVENTS };
