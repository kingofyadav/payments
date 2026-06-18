const express = require('express');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const { getOrder, transitionOrder } = require('../systems/order');
const { routePayment } = require('../systems/routing');
const { queueWebhook } = require('../systems/webhook');
const { createRefund }       = require('../systems/refund');
const { applyRouteSplits }   = require('../marketplace/transfers');
const { resolveTestOutcome } = require('../systems/test_scenarios');
const { runFraudChecks }     = require('../fraud/checker');
const { checkKYCLimit }      = require('../compliance/reporter');
const { runAMLChecks }       = require('../compliance/aml');
const { apiError }           = require('../middleware/errors');

const router = express.Router();

// POST /v1/payments  — initiate + capture a payment
router.post('/', (req, res) => {
  const { order_id, method, simulate, route } = req.body;

  if (!order_id) return apiError(res, 400, 'order_id is required', { field: 'order_id' });
  if (!method)   return apiError(res, 400, 'method is required', { field: 'method' });

  const order = getOrder(order_id);
  if (!order) return apiError(res, 404, 'Order not found');
  if (order.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');

  const now = Math.floor(Date.now() / 1000);
  if (order.expires_at < now) {
    if (order.status !== 'expired') transitionOrder(order_id, 'expired');
    return apiError(res, 400, 'Order has expired', { reason: 'order_expired', step: 'payment_initiation' });
  }
  if (order.status !== 'created') {
    return apiError(res, 400, `Order is already ${order.status}`, { reason: 'invalid_order_status', step: 'payment_initiation' });
  }

  // ── Fraud pre-screening (fails open — never blocks on engine error) ──────────
  const fraudResult = runFraudChecks({
    merchantId: req.merchantId,
    amount:     order.amount,
    ip:         req.ip || req.headers['x-forwarded-for'],
    cardBin:    req.body.card_number?.replace(/\s/g, '').slice(0, 6),
    email:      req.body.email,
    deviceId:   req.body.device_id,
  });
  if (fraudResult.action === 'block') {
    return apiError(res, 403, 'Transaction blocked by fraud detection', {
      code:   'FRAUD_BLOCKED',
      step:   'fraud_screening',
      metadata: { fraud_score: fraudResult.score, reason: fraudResult.reason },
    });
  }

  // ── KYC tier limit check ──────────────────────────────────────────────────
  const kycCheck = checkKYCLimit(req.merchantId, order.amount);
  if (!kycCheck.allowed) {
    return apiError(res, 403, kycCheck.message, { code: 'KYC_LIMIT_EXCEEDED', step: 'kyc_check' });
  }

  try {
    const { processor } = routePayment({ method });
    const db        = getDb();
    const paymentId = 'pay_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const { success, failure_reason } = resolveTestOutcome({
      simulate,
      card_number: req.body.card_number,
      upi_id:      req.body.upi_id,
    });
    const status = success ? 'captured' : 'failed';

    db.prepare(`
      INSERT INTO payments (id, order_id, merchant_id, amount, currency, method, status, processor, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(paymentId, order_id, req.merchantId, order.amount, order.currency, method, status, processor, success ? now : null);

    transitionOrder(order_id, 'attempted');
    transitionOrder(order_id, success ? 'paid' : 'failed');

    const event = success ? 'payment.captured' : 'payment.failed';
    queueWebhook({
      merchantId: req.merchantId,
      event,
      payload:    { event, order_id, payment_id: paymentId, amount: order.amount, currency: order.currency, method, status, processor, failure_reason: failure_reason ?? undefined, timestamp: new Date().toISOString() },
    });

    // Apply route splits if provided and payment succeeded
    if (success && Array.isArray(route) && route.length > 0) {
      try {
        applyRouteSplits(paymentId, req.merchantId, order.amount, route);
      } catch (splitErr) {
        // Payment already captured — return success but include split error
        return res.status(200).json({
          id: paymentId, order_id, amount: order.amount, currency: order.currency,
          method, status, processor, created_at: now,
          route_error: splitErr.message,
        });
      }
    }

    // AML post-payment checks — async, never blocks response
    if (success) {
      setImmediate(() => runAMLChecks(req.merchantId, paymentId, order.amount));
    }

    const resp = { id: paymentId, order_id, amount: order.amount, currency: order.currency, method, status, processor, created_at: now };
    if (failure_reason)                    resp.failure_reason = failure_reason;
    if (fraudResult.action !== 'allow')    resp.risk_flag      = fraudResult.action;
    res.status(success ? 200 : 402).json(resp);
  } catch (err) {
    apiError(res, 400, err.message);
  }
});

// GET /v1/payments — list with filters + cursor pagination
router.get('/', (req, res) => {
  const db     = getDb();
  const mid    = req.merchantId;
  const limit  = Math.min(parseInt(req.query.count)  || parseInt(req.query.limit)  || 20, 100);
  const offset = parseInt(req.query.skip) || parseInt(req.query.offset) || 0;
  const { status, method, from, to, order_id } = req.query;

  // Base filter — used for total count (no cursor)
  let where = 'WHERE p.merchant_id=?';
  const baseParams = [mid];
  if (status)   { where += ' AND p.status=?';      baseParams.push(status); }
  if (method)   { where += ' AND p.method=?';      baseParams.push(method); }
  if (order_id) { where += ' AND p.order_id=?';    baseParams.push(order_id); }
  if (from)     { where += ' AND p.created_at>=?'; baseParams.push(parseInt(from)); }
  if (to)       { where += ' AND p.created_at<=?'; baseParams.push(parseInt(to)); }

  // Total count ignores cursor so the number is stable across pages
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM payments p ${where}`).get(...baseParams);

  // Cursor clause only added to the data query
  let dataWhere = where;
  const dataParams = [...baseParams];
  if (req.query.after) {
    const anchor = db.prepare('SELECT created_at FROM payments WHERE id=?').get(req.query.after);
    if (anchor) { dataWhere += ' AND p.created_at<?'; dataParams.push(anchor.created_at); }
  }

  const items = db.prepare(
    `SELECT p.*, o.customer_name, o.customer_email FROM payments p
     JOIN orders o ON p.order_id=o.id ${dataWhere} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
  ).all(...dataParams, limit, offset);

  res.json({
    count, items,
    next_cursor: items.length === limit ? (items[items.length - 1]?.id ?? null) : null,
  });
});

// GET /v1/payments/:id
router.get('/:id', (req, res) => {
  const payment = getDb().prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!payment) return apiError(res, 404, 'Payment not found');
  if (payment.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  res.json(payment);
});

// POST /v1/payments/:id/capture — for authorized payments (future use)
router.post('/:id/capture', (req, res) => {
  const db = getDb();
  const p  = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p) return apiError(res, 404, 'Payment not found');
  if (p.merchant_id !== req.merchantId) return apiError(res, 403, 'Forbidden');
  if (p.status !== 'authorized') return apiError(res, 400, `Payment cannot be captured — status is ${p.status}`, { reason: 'invalid_status' });

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE payments SET status='captured', captured_at=? WHERE id=?").run(now, p.id);
  queueWebhook({ merchantId: req.merchantId, event: 'payment.captured', payload: { event: 'payment.captured', payment_id: p.id, amount: p.amount, timestamp: new Date().toISOString() } });
  res.json(db.prepare('SELECT * FROM payments WHERE id=?').get(p.id));
});

// POST /v1/payments/:id/refund — shorthand (also available via POST /v1/refunds)
router.post('/:id/refund', (req, res) => {
  try {
    const refund = createRefund(req.merchantId, { payment_id: req.params.id, ...req.body });
    res.status(201).json(refund);
  } catch (err) {
    apiError(res, 400, err.message, { step: 'refund_creation' });
  }
});

module.exports = router;
