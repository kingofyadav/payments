'use strict';
/**
 * PayEngine Node.js SDK
 *
 * Usage:
 *   const PayEngine = require('./sdk/payengine');
 *   const client = new PayEngine('key_id', 'key_secret');
 *   const order = await client.orders.create({ amount: 50000, currency: 'INR' });
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const PKG_VERSION = '2.0.0';

class PayEngineError extends Error {
  constructor(message, statusCode, errorBody) {
    super(message);
    this.name        = 'PayEngineError';
    this.statusCode  = statusCode;
    this.code        = errorBody?.code;
    this.field       = errorBody?.field;
    this.description = errorBody?.description || message;
  }
}

class PayEngine {
  /**
   * @param {string} keyId      - Your API Key ID
   * @param {string} keySecret  - Your API Key Secret
   * @param {object} [opts]
   * @param {string}  [opts.baseUrl]      - Default: https://api.payengine.in
   * @param {number}  [opts.timeout]      - Request timeout ms (default: 30000)
   * @param {number}  [opts.maxRetries]   - Auto-retry on 5xx/network errors (default: 3)
   * @param {boolean} [opts.autoIdempotency] - Auto-generate idempotency keys for POST/PATCH (default: true)
   * @param {'live'|'mock'} [opts.mode]   - 'mock' returns realistic fakes without network calls
   */
  constructor(keyId, keySecret, opts = {}) {
    if (!keyId || !keySecret) throw new Error('keyId and keySecret are required');
    this._keyId           = keyId;
    this._keySecret       = keySecret;
    this._baseUrl         = opts.baseUrl         || 'https://api.payengine.in';
    this._timeout         = opts.timeout         || 30_000;
    this._maxRetries      = opts.maxRetries      ?? 3;
    this._autoIdempotency = opts.autoIdempotency ?? true;
    this._mode            = opts.mode            || 'live';

    // Resource namespaces
    this.orders       = new Orders(this);
    this.payments     = new Payments(this);
    this.refunds      = new Refunds(this);
    this.settlements  = new Settlements(this);
    this.customers    = new Customers(this);
    this.plans        = new Plans(this);
    this.subscriptions = new Subscriptions(this);
    this.payouts        = new Payouts(this);
    this.contacts       = new Contacts(this);
    this.fundAccounts   = new FundAccounts(this);
    this.webhooks       = new Webhooks(this);
    // Marketplace
    this.linkedAccounts       = new LinkedAccounts(this);
    this.transfers            = new Transfers(this);
    this.transferReversals    = new TransferReversals(this);
    this.escrows              = new Escrows(this);
    this.marketplaceAnalytics = new MarketplaceAnalytics(this);
  }

  // ── HTTP client ─────────────────────────────────────────────────────────────

  _authHeader() {
    return 'Basic ' + Buffer.from(`${this._keyId}:${this._keySecret}`).toString('base64');
  }

  // ── Low-level HTTP ──────────────────────────────────────────────────────────

  _rawRequest(method, path, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const url     = new URL(path, this._baseUrl);
      const isHttp  = url.protocol === 'http:';
      const lib     = isHttp ? http : https;
      const bodyStr = body ? JSON.stringify(body) : null;

      const headers = {
        'Authorization': this._authHeader(),
        'User-Agent':    `PayEngine-Node/${PKG_VERSION}`,
        'Accept':        'application/json',
        ...extraHeaders,
      };
      if (bodyStr) {
        headers['Content-Type']   = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = lib.request({
        hostname: url.hostname,
        port:     url.port || (isHttp ? 80 : 443),
        path:     url.pathname + url.search,
        method,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
          if (res.statusCode >= 400) {
            const err = parsed?.error || {};
            reject(Object.assign(
              new PayEngineError(err.description || `HTTP ${res.statusCode}`, res.statusCode, err),
              { _statusCode: res.statusCode }
            ));
          } else {
            resolve(parsed);
          }
        });
      });

      req.setTimeout(this._timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // Auto-retry with exponential backoff on 5xx and network errors
  async request(method, path, body = null, extraHeaders = {}) {
    if (this._mode === 'mock') return _mockResponse(method, path, body);

    let attempt = 0;
    while (true) {
      try {
        return await this._rawRequest(method, path, body, extraHeaders);
      } catch (err) {
        const retryable = !err._statusCode || err._statusCode >= 500;
        if (!retryable || attempt >= this._maxRetries - 1) throw err;
        attempt++;
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
      }
    }
  }

  get(path, params = {}) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    return this.request('GET', path + (q ? '?' + q : ''));
  }

  post(path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this._autoIdempotency && !headers['X-Idempotency-Key']) {
      headers['X-Idempotency-Key'] = crypto.randomUUID();
    }
    return this.request('POST', path, body, headers);
  }

  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path)      { return this.request('DELETE', path); }

  // ── Webhook verification helper ──────────────────────────────────────────────

  /**
   * Verify an incoming webhook signature.
   * @param {string|Buffer} body       - Raw request body (string or Buffer)
   * @param {string}        signature  - Value from X-Gateway-Signature header
   * @param {string}        secret     - Your webhook endpoint secret
   * @returns {boolean}
   */
  static verifyWebhook(body, signature, secret) {
    const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    const payload = typeof bodyStr === 'string' ? JSON.parse(bodyStr) : bodyStr;
    // Canonical string: sorted JSON keys (matches server signPayload)
    const canonical  = JSON.stringify(payload, Object.keys(payload).sort());
    const expected   = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    const sigBuf     = Buffer.from(signature,  'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  }
}

// ── Resource classes ──────────────────────────────────────────────────────────

class Orders {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/orders', params); }
  fetch(id)            { return this._c.get(`/v1/orders/${id}`); }
  list(params = {})    { return this._c.get('/v1/orders', params); }
  fetchPayments(id)    { return this._c.get(`/v1/orders/${id}/payments`); }
}

class Payments {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/payments', params); }
  fetch(id)            { return this._c.get(`/v1/payments/${id}`); }
  list(params = {})    { return this._c.get('/v1/payments', params); }
  capture(id)          { return this._c.post(`/v1/payments/${id}/capture`); }
  refund(id, params)   { return this._c.post(`/v1/payments/${id}/refund`, params); }
}

class Refunds {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/refunds', params); }
  fetch(id)            { return this._c.get(`/v1/refunds/${id}`); }
  list(params = {})    { return this._c.get('/v1/refunds', params); }
}

class Settlements {
  constructor(client) { this._c = client; }
  fetch(id)            { return this._c.get(`/v1/settlements/${id}`); }
  list(params = {})    { return this._c.get('/v1/settlements', params); }
  recons(id)           { return this._c.get(`/v1/settlements/${id}/recons`); }
}

class Customers {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/customers', params); }
  fetch(id)            { return this._c.get(`/v1/customers/${id}`); }
  list(params = {})    { return this._c.get('/v1/customers', params); }
  edit(id, params)     { return this._c.patch(`/v1/customers/${id}`, params); }
}

class Plans {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/plans', params); }
  fetch(id)            { return this._c.get(`/v1/plans/${id}`); }
  list(params = {})    { return this._c.get('/v1/plans', params); }
  archive(id)          { return this._c.delete(`/v1/plans/${id}`); }
}

class Subscriptions {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/subscriptions', params); }
  fetch(id)            { return this._c.get(`/v1/subscriptions/${id}`); }
  list(params = {})    { return this._c.get('/v1/subscriptions', params); }
  invoices(id)         { return this._c.get(`/v1/subscriptions/${id}/invoices`); }
  cancel(id)           { return this._c.post(`/v1/subscriptions/${id}/cancel`); }
  pause(id)            { return this._c.post(`/v1/subscriptions/${id}/pause`); }
  resume(id)           { return this._c.post(`/v1/subscriptions/${id}/resume`); }
}

class Payouts {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/payouts', params); }
  fetch(id)            { return this._c.get(`/v1/payouts/${id}`); }
  list(params = {})    { return this._c.get('/v1/payouts', params); }
  approve(id)          { return this._c.post(`/v1/payouts/${id}/approve`); }
  cancel(id)           { return this._c.post(`/v1/payouts/${id}/cancel`); }
}

class Contacts {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/contacts', params); }
  fetch(id)            { return this._c.get(`/v1/contacts/${id}`); }
  list(params = {})    { return this._c.get('/v1/contacts', params); }
}

class FundAccounts {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/fund_accounts', params); }
  fetch(id)            { return this._c.get(`/v1/fund_accounts/${id}`); }
  list(params = {})    { return this._c.get('/v1/fund_accounts', params); }
  pennyDrop(id)        { return this._c.post(`/v1/fund_accounts/${id}/penny_drop`); }
}

class Webhooks {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/webhooks', params); }
  fetch(id)            { return this._c.get(`/v1/webhooks/${id}`); }
  list()               { return this._c.get('/v1/webhooks'); }
  delete(id)           { return this._c.delete(`/v1/webhooks/${id}`); }
  test(id)             { return this._c.post(`/v1/webhooks/${id}/test`); }
}

class LinkedAccounts {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/linked_accounts', params); }
  fetch(id)            { return this._c.get(`/v1/linked_accounts/${id}`); }
  list(params = {})    { return this._c.get('/v1/linked_accounts', params); }
  edit(id, params)     { return this._c.patch(`/v1/linked_accounts/${id}`, params); }
  activate(id)         { return this._c.post(`/v1/linked_accounts/${id}/activate`); }
  suspend(id)          { return this._c.post(`/v1/linked_accounts/${id}/suspend`); }
}

class Transfers {
  constructor(client) { this._c = client; }
  create(params)       { return this._c.post('/v1/transfers', params); }
  fetch(id)            { return this._c.get(`/v1/transfers/${id}`); }
  list(params = {})    { return this._c.get('/v1/transfers', params); }
  release(id)          { return this._c.post(`/v1/transfers/${id}/release`); }
}

class TransferReversals {
  constructor(client) { this._c = client; }
  create(transferId, params)  { return this._c.post(`/v1/transfers/${transferId}/reversals`, params); }
  fetch(transferId, revId)    { return this._c.get(`/v1/transfers/${transferId}/reversals/${revId}`); }
  list(transferId)            { return this._c.get(`/v1/transfers/${transferId}/reversals`); }
}

class Escrows {
  constructor(client) { this._c = client; }
  fund(params)         { return this._c.post('/v1/escrows', params); }
  fetch(id)            { return this._c.get(`/v1/escrows/${id}`); }
  list(params = {})    { return this._c.get('/v1/escrows', params); }
  release(id)          { return this._c.post(`/v1/escrows/${id}/release`); }
  refund(id)           { return this._c.post(`/v1/escrows/${id}/refund`); }
  dispute(id, params)  { return this._c.post(`/v1/escrows/${id}/dispute`, params); }
}

class MarketplaceAnalytics {
  constructor(client) { this._c = client; }
  summary()                    { return this._c.get('/v1/marketplace/analytics/summary'); }
  gmvTrend(params = {})        { return this._c.get('/v1/marketplace/analytics/gmv', params); }
  topSellers(params = {})      { return this._c.get('/v1/marketplace/analytics/top_sellers', params); }
  sellerHealth()               { return this._c.get('/v1/marketplace/analytics/seller_health'); }
  commissionBreakdown(params = {}) { return this._c.get('/v1/marketplace/analytics/commission_breakdown', params); }
}

// ── Mock response engine ──────────────────────────────────────────────────────

function _mockId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 18).padEnd(16, '0').slice(0, 16);
}

function _now() { return Math.floor(Date.now() / 1000); }

function _mockResponse(method, path, body) {
  const now = _now();
  const ts  = new Date().toISOString();

  // Strip query string for matching
  const route = path.split('?')[0].replace(/\/$/, '');
  const seg   = route.split('/').filter(Boolean); // ['v1', 'orders', 'ord_xxx']

  // ── Orders ──────────────────────────────────────────────────────────────────
  if (seg[1] === 'orders') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('ord'), amount: body?.amount ?? 10000, currency: body?.currency ?? 'INR',
               status: 'created', expires_at: now + 900, created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], amount: 10000, currency: 'INR', status: 'created', created_at: now };
    }
    if (method === 'GET' && seg.length === 2) {
      return { count: 0, items: [], next_cursor: null };
    }
    if (method === 'GET' && seg[3] === 'payments') {
      return { items: [] };
    }
  }

  // ── Payments ─────────────────────────────────────────────────────────────────
  if (seg[1] === 'payments') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('pay'), order_id: body?.order_id ?? _mockId('ord'),
               amount: 10000, currency: 'INR', method: body?.method ?? 'upi',
               status: 'captured', processor: 'mock', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], amount: 10000, currency: 'INR', method: 'upi', status: 'captured', created_at: now };
    }
    if (method === 'GET' && seg.length === 2) {
      return { count: 0, items: [], next_cursor: null };
    }
    if (method === 'POST' && seg[3] === 'capture') {
      return { id: seg[2], status: 'captured', captured_at: now };
    }
    if (method === 'POST' && seg[3] === 'refund') {
      return { id: _mockId('rfnd'), payment_id: seg[2], amount: body?.amount ?? 10000,
               status: 'processed', created_at: now };
    }
  }

  // ── Refunds ───────────────────────────────────────────────────────────────────
  if (seg[1] === 'refunds') {
    if (method === 'POST') {
      return { id: _mockId('rfnd'), payment_id: body?.payment_id, amount: body?.amount ?? 10000,
               status: 'processed', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], status: 'processed', amount: 10000, created_at: now };
    }
    if (method === 'GET') return { count: 0, items: [], next_cursor: null };
  }

  // ── Settlements ───────────────────────────────────────────────────────────────
  if (seg[1] === 'settlements') {
    if (method === 'GET' && seg.length === 3 && seg[3] !== 'recons') {
      return { id: seg[2], amount: 9800, fees: 200, tax: 36, status: 'processed', created_at: now };
    }
    if (method === 'GET' && seg[3] === 'recons') return { items: [] };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Customers ─────────────────────────────────────────────────────────────────
  if (seg[1] === 'customers') {
    if (method === 'POST') {
      return { id: _mockId('cust'), name: body?.name, email: body?.email, created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], name: 'Test Customer', email: 'test@example.com', created_at: now };
    }
    if (method === 'PATCH') {
      return { id: seg[2], ...body, updated_at: now };
    }
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Plans ─────────────────────────────────────────────────────────────────────
  if (seg[1] === 'plans') {
    if (method === 'POST') {
      return { id: _mockId('plan'), name: body?.name, amount: body?.amount ?? 9900,
               interval: body?.interval ?? 'monthly', status: 'active', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], name: 'Mock Plan', amount: 9900, interval: 'monthly', status: 'active', created_at: now };
    }
    if (method === 'DELETE') return { id: seg[2], status: 'archived' };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────────
  if (seg[1] === 'subscriptions') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('sub'), plan_id: body?.plan_id, customer_id: body?.customer_id,
               status: 'active', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], status: 'active', created_at: now };
    }
    if (method === 'GET' && seg[3] === 'invoices') return { items: [] };
    if (method === 'POST' && ['cancel','pause','resume'].includes(seg[3])) {
      return { id: seg[2], status: seg[3] === 'cancel' ? 'cancelled' : seg[3] === 'pause' ? 'paused' : 'active' };
    }
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Payouts ───────────────────────────────────────────────────────────────────
  if (seg[1] === 'payouts') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('pout'), amount: body?.amount ?? 10000, status: 'queued', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], status: 'processed', amount: 10000, created_at: now };
    }
    if (method === 'POST' && seg[3] === 'approve') return { id: seg[2], status: 'approved' };
    if (method === 'POST' && seg[3] === 'cancel')  return { id: seg[2], status: 'cancelled' };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Contacts ──────────────────────────────────────────────────────────────────
  if (seg[1] === 'contacts') {
    if (method === 'POST') {
      return { id: _mockId('cont'), name: body?.name, email: body?.email, type: body?.type ?? 'vendor', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], name: 'Mock Vendor', type: 'vendor', created_at: now };
    }
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Fund Accounts ──────────────────────────────────────────────────────────────
  if (seg[1] === 'fund_accounts') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('fa'), contact_id: body?.contact_id, account_type: body?.account_type ?? 'bank_account',
               status: 'active', created_at: now };
    }
    if (method === 'POST' && seg[3] === 'penny_drop') {
      return { id: seg[2], penny_drop: { status: 'success', name_match: true } };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], status: 'active', created_at: now };
    }
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────────
  if (seg[1] === 'webhooks') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('wh'), url: body?.url, events: body?.events ?? [], active: true, created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], url: 'https://mock.example.com/wh', active: true, created_at: now };
    }
    if (method === 'POST' && seg[3] === 'test') {
      return { id: seg[2], test_delivery: { status: 'delivered', response_code: 200 } };
    }
    if (method === 'DELETE') return { id: seg[2], deleted: true };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Linked Accounts ───────────────────────────────────────────────────────────
  if (seg[1] === 'linked_accounts') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('lacc'), name: body?.name, email: body?.email, status: 'pending', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], name: 'Mock Seller', status: 'active', created_at: now };
    }
    if (method === 'PATCH') return { id: seg[2], ...body, updated_at: now };
    if (method === 'POST' && seg[3] === 'activate')  return { id: seg[2], status: 'active' };
    if (method === 'POST' && seg[3] === 'suspend')   return { id: seg[2], status: 'suspended' };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Transfers ─────────────────────────────────────────────────────────────────
  if (seg[1] === 'transfers') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('trf'), payment_id: body?.payment_id, to_account_id: body?.to_account_id,
               amount: body?.amount ?? 10000, status: body?.on_hold ? 'on_hold' : 'processed', created_at: now };
    }
    if (method === 'GET' && seg.length === 3 && !seg[3]) {
      return { id: seg[2], status: 'processed', amount: 10000, created_at: now };
    }
    if (method === 'POST' && seg[3] === 'release') return { id: seg[2], status: 'processed' };
    if (method === 'POST' && seg[3] === 'reversals') {
      return { id: _mockId('trev'), transfer_id: seg[2], amount: body?.amount, status: 'processed', created_at: now };
    }
    if (method === 'GET' && seg[3] === 'reversals') return { items: [] };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Escrows ───────────────────────────────────────────────────────────────────
  if (seg[1] === 'escrows') {
    if (method === 'POST' && seg.length === 2) {
      return { id: _mockId('esc'), payment_id: body?.payment_id, buyer_id: body?.buyer_id,
               amount: body?.amount ?? 10000, status: 'funded', created_at: now };
    }
    if (method === 'GET' && seg.length === 3) {
      return { id: seg[2], status: 'funded', amount: 10000, created_at: now };
    }
    if (method === 'POST' && seg[3] === 'release')  return { id: seg[2], status: 'released', released_at: now };
    if (method === 'POST' && seg[3] === 'refund')   return { id: seg[2], status: 'refunded', refunded_at: now };
    if (method === 'POST' && seg[3] === 'dispute')  return { id: seg[2], status: 'disputed', dispute_reason: body?.reason };
    if (method === 'GET') return { count: 0, items: [] };
  }

  // ── Marketplace Analytics ──────────────────────────────────────────────────────
  if (seg[1] === 'marketplace') {
    return {
      summary: { total_sellers: 0, active_sellers: 0, gmv_30d: 0, commission_30d: 0 },
      _mock: true,
    };
  }

  // ── Fallback ──────────────────────────────────────────────────────────────────
  return { _mock: true, method, path, body };
}

module.exports = PayEngine;
