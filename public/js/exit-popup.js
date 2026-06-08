/**
 * Shared exit-confirmation popup.
 * Uses .modal-overlay / .modal-card / .modal-close classes from style.css.
 *
 * Usage:
 *   ExitPopup.setMessage('Your payment is not complete.');
 *   ExitPopup.markDirty();    // user has started filling the form
 *   ExitPopup.markDone();     // action completed — never warn again
 */
(function () {
  // Inject popup HTML using the global modal CSS classes
  const el = document.createElement('div');
  el.innerHTML = `
    <div id="exitPopupOverlay" class="modal-overlay" style="display:none;z-index:9999">
      <div class="modal-card" style="max-width:400px;text-align:center">
        <div class="modal-header" style="justify-content:flex-end;border-bottom:none;padding-bottom:0">
          <button class="modal-close" id="exitPopupClose" aria-label="Close">✕</button>
        </div>
        <div class="modal-body" style="padding-top:4px">
          <div style="width:56px;height:56px;background:#fef3c7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:26px">⚠️</div>
          <h3 style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px">Leave this page?</h3>
          <p id="exitPopupMsg" style="color:#6b7280;font-size:14px;line-height:1.6;margin-bottom:24px">
            Your progress will be lost if you leave.
          </p>
          <div style="display:flex;gap:12px">
            <button id="exitPopupStay"  class="btn btn-secondary btn-full">Stay</button>
            <button id="exitPopupLeave" class="btn btn-full" style="background:#ef4444;color:#fff;border:none">Leave</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el.firstElementChild);

  let _dirty     = false;
  let _done      = false;
  let _leaving   = false;

  const overlay  = document.getElementById('exitPopupOverlay');

  function _shouldWarn() { return _dirty && !_done; }
  function _show()       { overlay.style.display = 'flex'; }
  function _hide()       { overlay.style.display = 'none'; }

  function _dismiss() {
    _hide();
    // Re-push so the next back-press is interceptable again
    history.pushState(null, '', location.href);
  }

  function _leave() {
    _leaving = true;
    _hide();
    // Go back 2: skip our fake pushState entry AND the current page entry,
    // landing on the actual previous page.
    history.go(-2);
    // Fallback: if there is no real previous page (direct navigation),
    // history.go(-2) silently fails — redirect after a short wait.
    setTimeout(() => {
      window.location.href = document.referrer || '/';
    }, 400);
  }

  document.getElementById('exitPopupClose').addEventListener('click', _dismiss);
  document.getElementById('exitPopupStay').addEventListener('click', _dismiss);
  document.getElementById('exitPopupLeave').addEventListener('click', _leave);

  // Push a fake history entry so the Back button fires popstate instead of navigating away
  history.pushState(null, '', location.href);

  window.addEventListener('popstate', () => {
    if (_leaving) return;
    if (_shouldWarn()) {
      history.pushState(null, '', location.href); // stay in place
      _show();
    }
    // If not dirty or already done, let normal back navigation proceed
  });

  window.addEventListener('beforeunload', (e) => {
    if (_shouldWarn()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.ExitPopup = {
    markDirty()    { _dirty = true; },
    markDone()     { _done  = true; },
    setMessage(m)  { document.getElementById('exitPopupMsg').textContent = m; },
  };
})();
