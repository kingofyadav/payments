/**
 * PayEngine Browser Checkout SDK  v1.0.0
 *
 * Usage:
 *   <script src="/v1/checkout.js"></script>
 *   <script>
 *     const pe = new PayEngine({ key: 'key_xxx' });
 *     pe.open({
 *       order_id: 'order_yyy',
 *       amount: 50000,
 *       currency: 'INR',
 *       name: 'Acme Store',
 *       description: 'Order #1234',
 *       prefill: { name: 'Priya Sharma', email: 'priya@example.com' },
 *       handler: function(response) { ... },
 *       modal: { ondismiss: function() { ... } },
 *     });
 *   </script>
 */
(function (global) {
  'use strict';

  // ── Styles injected once ──────────────────────────────────────────────────
  const CSS = `
  .__pe-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .__pe-modal{background:#fff;border-radius:16px;width:420px;max-width:calc(100vw - 32px);max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.2);animation:__peSlideUp .22s ease}
  @keyframes __peSlideUp{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
  .__pe-header{background:#4f46e5;color:#fff;border-radius:16px 16px 0 0;padding:20px 24px;display:flex;align-items:center;justify-content:space-between}
  .__pe-header h3{margin:0;font-size:16px;font-weight:700}
  .__pe-header .sub{font-size:12px;opacity:.8;margin-top:2px}
  .__pe-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0;line-height:1;opacity:.8}
  .__pe-close:hover{opacity:1}
  .__pe-body{padding:24px}
  .__pe-tabs{display:flex;gap:4px;background:#f3f4f6;border-radius:10px;padding:4px;margin-bottom:20px}
  .__pe-tab{flex:1;border:none;background:none;padding:8px 4px;font-size:13px;font-weight:500;cursor:pointer;border-radius:8px;color:#6b7280;transition:.15s}
  .__pe-tab.active{background:#fff;color:#4f46e5;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .__pe-field{margin-bottom:14px}
  .__pe-field label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:5px}
  .__pe-field input,.__pe-field select{width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;transition:.15s}
  .__pe-field input:focus,.__pe-field select:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.12)}
  .__pe-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .__pe-btn{width:100%;padding:13px;background:#4f46e5;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:.15s;margin-top:6px}
  .__pe-btn:hover{background:#4338ca}
  .__pe-btn:disabled{background:#a5b4fc;cursor:default}
  .__pe-amount-badge{text-align:center;font-size:22px;font-weight:800;color:#111827;margin-bottom:20px}
  .__pe-amount-badge small{font-size:13px;font-weight:400;color:#6b7280;display:block}
  .__pe-error{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
  .__pe-success{text-align:center;padding:32px 24px}
  .__pe-success svg{display:block;margin:0 auto 16px}
  .__pe-success h4{font-size:18px;font-weight:700;color:#059669;margin:0 0 8px}
  .__pe-success p{color:#6b7280;font-size:14px;margin:0}
  .__pe-spinner{display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:__peSpin .7s linear infinite;vertical-align:middle;margin-right:8px}
  @keyframes __peSpin{to{transform:rotate(360deg)}}
  `;

  let styleEl;
  function injectStyles() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  // ── UPI icon ──────────────────────────────────────────────────────────────
  const UPI_SVG = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="6" fill="#fff"/><text x="16" y="22" text-anchor="middle" font-size="11" font-weight="bold" fill="#4f46e5">UPI</text></svg>`;

  // ── Main class ───────────────────────────────────────────────────────────
  function PayEngine(initOpts) {
    this._key     = (initOpts || {}).key || '';
    this._baseUrl = (initOpts || {}).baseUrl || '';
    this._overlay = null;
  }

  PayEngine.prototype.open = function (opts) {
    injectStyles();
    if (this._overlay) this.close();

    const self   = this;
    const amount = opts.amount || 0;
    const fmt    = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

    // ── Build DOM ───────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = '__pe-overlay';
    overlay.innerHTML = `
      <div class="__pe-modal">
        <div class="__pe-header">
          <div>
            <h3>${escHtml(opts.name || 'Checkout')}</h3>
            <div class="sub">${escHtml(opts.description || '')}</div>
          </div>
          <button class="__pe-close" id="__peClose">✕</button>
        </div>
        <div class="__pe-body">
          <div class="__pe-amount-badge">
            ${fmt(amount)}
            <small>${opts.currency || 'INR'} — secure checkout</small>
          </div>

          <div class="__pe-tabs">
            <button class="__pe-tab active" data-tab="upi">UPI</button>
            <button class="__pe-tab" data-tab="card">Card</button>
            <button class="__pe-tab" data-tab="netbanking">Net Banking</button>
          </div>

          <!-- UPI tab -->
          <div id="__peTab-upi">
            <div class="__pe-field">
              <label>UPI ID</label>
              <input id="__peUpi" type="text" placeholder="yourname@upi" value="${escHtml((opts.prefill || {}).vpa || '')}" autocomplete="off"/>
            </div>
            <div class="__pe-error" id="__peUpiErr" style="display:none"></div>
            <button class="__pe-btn" id="__pePayUpi">Pay ${fmt(amount)}</button>
          </div>

          <!-- Card tab -->
          <div id="__peTab-card" style="display:none">
            <div class="__pe-field">
              <label>Card Number</label>
              <input id="__peCardNum" type="text" placeholder="4111 1111 1111 1111" maxlength="19" autocomplete="cc-number"/>
            </div>
            <div class="__pe-grid2">
              <div class="__pe-field">
                <label>Expiry (MM/YY)</label>
                <input id="__peCardExp" type="text" placeholder="12/28" maxlength="5" autocomplete="cc-exp"/>
              </div>
              <div class="__pe-field">
                <label>CVV</label>
                <input id="__peCardCvv" type="password" placeholder="•••" maxlength="4" autocomplete="cc-csc"/>
              </div>
            </div>
            <div class="__pe-field">
              <label>Name on Card</label>
              <input id="__peCardName" type="text" placeholder="Priya Sharma" value="${escHtml((opts.prefill || {}).name || '')}" autocomplete="cc-name"/>
            </div>
            <div class="__pe-error" id="__peCardErr" style="display:none"></div>
            <button class="__pe-btn" id="__pePayCard">Pay ${fmt(amount)}</button>
          </div>

          <!-- Net Banking tab -->
          <div id="__peTab-netbanking" style="display:none">
            <div class="__pe-field">
              <label>Select Bank</label>
              <select id="__peBank">
                <option value="">— Choose your bank —</option>
                <option value="HDFC">HDFC Bank</option>
                <option value="ICICI">ICICI Bank</option>
                <option value="SBI">State Bank of India</option>
                <option value="AXIS">Axis Bank</option>
                <option value="KOTAK">Kotak Mahindra Bank</option>
                <option value="YES">Yes Bank</option>
                <option value="BOB">Bank of Baroda</option>
                <option value="PNB">Punjab National Bank</option>
              </select>
            </div>
            <div class="__pe-error" id="__peNbErr" style="display:none"></div>
            <button class="__pe-btn" id="__pePayNb">Pay ${fmt(amount)}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._overlay = overlay;
    document.body.style.overflow = 'hidden';

    // ── Tab switching ───────────────────────────────────────────────────────
    overlay.querySelectorAll('.__pe-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        overlay.querySelectorAll('.__pe-tab').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        ['upi', 'card', 'netbanking'].forEach(function (t) {
          var p = overlay.querySelector('#__peTab-' + t);
          if (p) p.style.display = t === btn.dataset.tab ? '' : 'none';
        });
      });
    });

    // ── Close ───────────────────────────────────────────────────────────────
    function doClose() {
      self.close();
      if (opts.modal && opts.modal.ondismiss) opts.modal.ondismiss();
    }
    overlay.querySelector('#__peClose').addEventListener('click', doClose);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) doClose(); });

    // ── Payment submission ──────────────────────────────────────────────────
    function setLoading(btnId, loading) {
      var btn = overlay.querySelector('#' + btnId);
      if (!btn) return;
      btn.disabled = loading;
      btn.innerHTML = loading
        ? '<span class="__pe-spinner"></span>Processing…'
        : btn.getAttribute('data-label') || btn.textContent;
      if (!loading && !btn.getAttribute('data-label')) btn.setAttribute('data-label', btn.textContent);
    }

    function showErr(id, msg) {
      var el = overlay.querySelector('#' + id);
      if (!el) return;
      el.textContent = msg;
      el.style.display = msg ? '' : 'none';
    }

    function showSuccess(paymentId) {
      var body = overlay.querySelector('.__pe-body');
      body.innerHTML = `
        <div class="__pe-success">
          <svg width="56" height="56" fill="none" viewBox="0 0 56 56">
            <circle cx="28" cy="28" r="28" fill="#d1fae5"/>
            <path d="M18 28l7 7 13-14" stroke="#059669" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <h4>Payment Successful!</h4>
          <p>Payment ID: <strong>${paymentId}</strong></p>
        </div>
      `;
      setTimeout(function () { self.close(); }, 2500);
    }

    function submitPayment(method, extraBody) {
      var errId = { upi: '__peUpiErr', card: '__peCardErr', netbanking: '__peNbErr' }[method] || '__peUpiErr';
      var btnId = { upi: '__pePayUpi', card: '__pePayCard', netbanking: '__pePayNb' }[method];
      showErr(errId, '');
      setLoading(btnId, true);

      var body = Object.assign({
        order_id: opts.order_id,
        method:   method,
        key_id:   self._key,
      }, extraBody);

      fetch((self._baseUrl || '') + '/v1/payments', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Basic ' + btoa(self._key + ':'),
        },
        body: JSON.stringify(body),
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setLoading(btnId, false);
        if (data.status === 'captured') {
          showSuccess(data.id || data.payment_id);
          if (opts.handler) opts.handler({ razorpay_payment_id: data.id || data.payment_id, razorpay_order_id: opts.order_id, payment: data });
        } else {
          showErr(errId, data.error?.description || data.error || 'Payment failed. Please try again.');
        }
      })
      .catch(function (err) {
        setLoading(btnId, false);
        showErr(errId, 'Network error. Please try again.');
      });
    }

    // UPI
    overlay.querySelector('#__pePayUpi').addEventListener('click', function () {
      var vpa = overlay.querySelector('#__peUpi').value.trim();
      if (!vpa || !vpa.includes('@')) { showErr('__peUpiErr', 'Enter a valid UPI ID (e.g. name@upi)'); return; }
      submitPayment('upi', { vpa: vpa });
    });

    // Card
    overlay.querySelector('#__pePayCard').addEventListener('click', function () {
      var num  = overlay.querySelector('#__peCardNum').value.replace(/\s/g, '');
      var exp  = overlay.querySelector('#__peCardExp').value;
      var cvv  = overlay.querySelector('#__peCardCvv').value;
      var name = overlay.querySelector('#__peCardName').value.trim();
      if (num.length < 15) { showErr('__peCardErr', 'Enter a valid card number'); return; }
      if (!exp.match(/^\d{2}\/\d{2}$/)) { showErr('__peCardErr', 'Enter expiry as MM/YY'); return; }
      if (cvv.length < 3) { showErr('__peCardErr', 'Enter CVV'); return; }
      submitPayment('card', { card: { number: num, expiry: exp, cvv: cvv, name: name } });
    });

    // Net Banking
    overlay.querySelector('#__pePayNb').addEventListener('click', function () {
      var bank = overlay.querySelector('#__peBank').value;
      if (!bank) { showErr('__peNbErr', 'Please select a bank'); return; }
      submitPayment('netbanking', { bank: bank });
    });

    // Format card number with spaces
    overlay.querySelector('#__peCardNum').addEventListener('input', function (e) {
      var v = e.target.value.replace(/\D/g, '').slice(0, 16);
      e.target.value = v.replace(/(.{4})/g, '$1 ').trim();
    });
  };

  PayEngine.prototype.close = function () {
    if (this._overlay) {
      document.body.removeChild(this._overlay);
      this._overlay = null;
      document.body.style.overflow = '';
    }
  };

  // ── Static: webhook verification ─────────────────────────────────────────
  PayEngine.verifyWebhook = function (body, signature, secret) {
    // Browser environment — use SubtleCrypto
    console.warn('PayEngine.verifyWebhook should be called server-side, not in the browser.');
    return false;
  };

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Expose globally
  global.PayEngine = PayEngine;

}(typeof window !== 'undefined' ? window : global));
