// Public-facing API — no auth needed, called by the checkout page
const express = require('express');
const { randomUUID } = require('crypto');
const { getDb }          = require('../db/database');
const { getLinkByCode }  = require('./manager');
const { createOrder, transitionOrder } = require('../systems/order');
const { routePayment }   = require('../systems/routing');
const { queueWebhook }   = require('../systems/webhook');

const router = express.Router();

// GET /api/pub/links/:code — fetch link details for checkout UI
router.get('/:code', (req, res) => {
  const link = getLinkByCode(req.params.code);
  if (!link) return res.status(404).json({ error: 'Payment link not found' });

  if (link.status === 'paid') {
    return res.json({ status: 'paid', message: 'This payment has already been completed.' });
  }
  if (link.status === 'expired') {
    return res.json({ status: 'expired', message: 'This payment link has expired.' });
  }
  if (link.status === 'deactivated') {
    return res.json({ status: 'deactivated', message: 'This payment link is no longer active.' });
  }

  // Fix #7 — only expose amount_paid when partial payments are enabled (customer needs to
  // see remaining balance). Never expose it otherwise — information disclosure.
  const showProgress = link.allow_partial && link.amount;
  const amountPaid = link.amount_paid ?? 0;
  const pub = {
    code:            link.code,
    type:            link.type,
    title:           link.title,
    description:     link.description,
    image_url:       link.image_url,
    amount:          link.amount,
    amount_type:     link.amount_type,
    min_amount:      link.min_amount,
    max_amount:      link.max_amount,
    allow_partial:   !!link.allow_partial,
    // Fix #8 — safe remaining calculation; only set when meaningful
    amount_paid:      showProgress ? amountPaid : undefined,
    amount_remaining: showProgress ? (link.amount - amountPaid) : null,
    status:          link.status,
    customer_name:   link.customer_name,
    customer_email:  link.customer_email,
    customer_phone:  link.customer_phone,
    custom_fields:   link.custom_fields,
    success_message: link.success_message,
    redirect_url:    link.redirect_url,
    expires_at:      link.expires_at,
  };
  res.json(pub);
});

// POST /api/pub/links/:code/pay — customer initiates payment
router.post('/:code/pay', async (req, res) => {
  const link = getLinkByCode(req.params.code);
  if (!link) return res.status(404).json({ error: 'Payment link not found' });
  if (!['active', 'partially_paid'].includes(link.status)) {
    return res.status(400).json({ error: `Link is ${link.status}` });
  }

  const now = Math.floor(Date.now() / 1000);
  if (link.expires_at && link.expires_at < now) {
    getDb().prepare("UPDATE payment_links SET status='expired' WHERE id=?").run(link.id);
    return res.status(400).json({ error: 'This link has expired' });
  }

  // Fix #2 — payment_count is NULL on first row in SQLite; coerce before comparison
  if (link.max_payments && (link.payment_count ?? 0) >= link.max_payments) {
    return res.status(400).json({ error: 'No more payments accepted for this link' });
  }

  const { amount, method, payer_name, payer_email, payer_phone, form_data, simulate } = req.body;

  if (!method) return res.status(400).json({ error: 'method is required' });

  // Determine final amount
  let payAmount;
  if (link.amount_type === 'fixed') {
    if (link.allow_partial && amount) {
      // Partial: customer specifies how much to pay now (≤ remaining)
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive integer in paise' });
      }
      payAmount = amount;
    } else {
      payAmount = link.amount;
    }
  } else if (link.amount_type === 'range') {
    if (!amount) return res.status(400).json({ error: 'amount is required' });
    if (amount < link.min_amount || amount > link.max_amount) {
      return res.status(400).json({ error: `Amount must be between ₹${link.min_amount/100} and ₹${link.max_amount/100}` });
    }
    payAmount = amount;
  } else {
    // open amount
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount is required' });
    payAmount = amount;
  }

  // Fix #1 — partial payments: cap to remaining, enforce min constraints
  if (link.allow_partial && link.amount) {
    const remaining = link.amount - (link.amount_paid ?? 0);
    if (payAmount > remaining) payAmount = remaining;
    if (payAmount <= 0) {
      return res.status(400).json({ error: 'This link has been fully paid' });
    }
    // After capping, enforce min_amount for range links
    if (link.amount_type === 'range' && payAmount < link.min_amount) {
      return res.status(400).json({
        error: `Minimum payment is ₹${link.min_amount / 100}. Remaining: ₹${remaining / 100}`,
      });
    }
  }

  try {
    const db = getDb();

    // Create Phase 1 order
    const order = createOrder({
      merchantId: link.merchant_id,
      amount:     payAmount,
      customer: { name: payer_name, email: payer_email, phone: payer_phone },
    });

    const { processor } = routePayment({ method });
    const success    = simulate !== 'failure';
    const status     = success ? 'captured' : 'failed';
    const paymentId  = 'pay_' + randomUUID().replace(/-/g, '').slice(0, 16);

    db.prepare(`
      INSERT INTO payments (id,order_id,merchant_id,amount,currency,method,status,processor,captured_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(paymentId, order.id, link.merchant_id, payAmount, 'INR', method, status, processor, success ? now : null);

    transitionOrder(order.id, 'attempted');
    transitionOrder(order.id, success ? 'paid' : 'failed');

    // Create link_payment record
    const linkPayId = 'lp_' + randomUUID().replace(/-/g, '').slice(0, 16);
    db.prepare(`
      INSERT INTO link_payments (id,link_id,payment_id,order_id,amount,status,payer_name,payer_email,payer_phone,form_data)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(linkPayId, link.id, paymentId, order.id, payAmount,
      success ? 'paid' : 'failed',
      payer_name ?? null, payer_email ?? null, payer_phone ?? null,
      form_data ? JSON.stringify(form_data) : null
    );

    // Update link aggregate state
    if (success) {
      const newPaid  = (link.amount_paid ?? 0) + payAmount;
      const newCount = (link.payment_count ?? 0) + 1;
      let newStatus  = link.status;

      if (link.amount) {
        newStatus = newPaid >= link.amount ? 'paid' : 'partially_paid';
      } else {
        // open/page type — stays active unless max_payments hit
        newStatus = (link.max_payments && newCount >= link.max_payments) ? 'paid' : 'active';
      }

      db.prepare(`
        UPDATE payment_links SET amount_paid=?, payment_count=?, status=? WHERE id=?
      `).run(newPaid, newCount, newStatus, link.id);

      queueWebhook({
        merchantId: link.merchant_id,
        event: 'payment_link.paid',
        payload: {
          event: 'payment_link.paid', link_id: link.id, link_code: link.code,
          payment_id: paymentId, order_id: order.id,
          amount: payAmount, payer_name, payer_email,
          timestamp: new Date().toISOString(),
        },
      });
    }

    res.json({
      link_payment_id: linkPayId,
      payment_id:      paymentId,
      order_id:        order.id,
      amount:          payAmount,
      status,
      redirect_url:    success ? link.redirect_url : null,
      success_message: success ? (link.success_message || 'Payment successful!') : null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/pub/links/:code/status/:linkPaymentId — poll payment result
router.get('/:code/status/:linkPaymentId', (req, res) => {
  const lp = getDb()
    .prepare('SELECT lp.*, pl.success_message, pl.redirect_url FROM link_payments lp JOIN payment_links pl ON lp.link_id=pl.id WHERE lp.id=?')
    .get(req.params.linkPaymentId);
  if (!lp) return res.status(404).json({ error: 'Not found' });
  res.json({ status: lp.status, success_message: lp.success_message, redirect_url: lp.redirect_url });
});

module.exports = router;
