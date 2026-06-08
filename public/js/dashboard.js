// ─── Auth guard ───────────────────────────────────────────────────────────────
const token = localStorage.getItem('session_token');
if (!token) { window.location.href = '/'; }

// ─── API client ───────────────────────────────────────────────────────────────
const api = {
  async get(path) {
    const res = await fetch(`/api${path}`, {
      headers: { 'X-Session-Token': token },
    });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { logout(); return null; }
    return res.json();
  },
  async patch(path, body = {}) {
    const res = await fetch(`/api${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

function logout() {
  fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Session-Token': token } });
  localStorage.clear();
  window.location.href = '/';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = {
  currency(paise) {
    return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  },
  time(unix) {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  },
  method(m) {
    return { upi: 'UPI', card: 'Card', netbanking: 'Net Banking', wallet: 'Wallet' }[m] || m || '—';
  },
  initial(name) {
    return (name || '?')[0].toUpperCase();
  },
};

function badge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function el(id) { return document.getElementById(id); }

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(section) {
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const secEl = el(`section-${section}`);
  if (secEl) secEl.classList.remove('hidden');

  const navEl = document.querySelector(`[data-section="${section}"]`);
  if (navEl) navEl.classList.add('active');

  if (section === 'overview')       loadOverview();
  if (section === 'transactions')   loadTransactions();
  if (section === 'customers')      loadCustomers();
  if (section === 'subscriptions')  loadSubscriptions();
  if (section === 'payouts')        loadPayouts();
  if (section === 'analytics')      loadAnalytics();
  if (section === 'links')          loadLinks();
  if (section === 'developers')     loadDevelopers();
}

// Wire up sidebar nav
document.querySelectorAll('[data-section]').forEach(el => {
  el.addEventListener('click', () => navigate(el.dataset.section));
});
el('logoutBtn').addEventListener('click', logout);

// ─── Chart instances ─────────────────────────────────────────────────────────
let revenueChart, methodChart;

function destroyCharts() {
  if (revenueChart) { revenueChart.destroy(); revenueChart = null; }
  if (methodChart)  { methodChart.destroy();  methodChart  = null; }
}

// ─── OVERVIEW ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  const data = await api.get('/dashboard/overview');
  if (!data) return;

  // Stats
  el('statRevenue').textContent  = fmt.currency(data.today.revenue);
  el('statTxns').textContent     = data.today.transactions;
  el('statRate').textContent     = data.today.success_rate + '%';
  el('statCaptured').textContent = data.today.captured;
  el('lastUpdated').textContent  = 'Updated ' + new Date().toLocaleTimeString('en-IN');

  // Revenue chart
  destroyCharts();

  // Fill in missing days so chart always shows 7 bars
  const today = new Date();
  const days = [], revenues = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const match = (data.chart || []).find(r => r.day === key);
    days.push(d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }));
    revenues.push(match ? match.revenue / 100 : 0);
  }

  revenueChart = new Chart(el('revenueChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'Revenue (₹)',
        data: revenues,
        backgroundColor: '#818cf8',
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: '#f3f4f6' }, ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } },
        x: { grid: { display: false } },
      },
    },
  });

  // Method doughnut chart
  const methods  = data.methods || [];
  const COLORS   = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444'];
  methodChart = new Chart(el('methodChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: methods.map(m => fmt.method(m.method)),
      datasets: [{
        data:            methods.map(m => m.count),
        backgroundColor: COLORS.slice(0, methods.length),
        borderWidth: 2,
        borderColor: '#fff',
      }],
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } },
      },
    },
  });

  // Recent transactions table
  const tbody = el('recentTableBody');
  if (!data.recent?.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No transactions yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.recent.map(p => `
    <tr>
      <td><span class="monospace">${p.id}</span></td>
      <td>${p.customer_name || p.customer_email || '—'}</td>
      <td><strong>${fmt.currency(p.amount)}</strong></td>
      <td>${fmt.method(p.method)}</td>
      <td>${badge(p.status)}</td>
      <td><span style="color:#6b7280">${fmt.time(p.created_at)}</span></td>
    </tr>
  `).join('');
}

el('refreshBtn').addEventListener('click', loadOverview);

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────
let txnState = { offset: 0, total: 0, limit: 20 };

async function loadTransactions(reset = false) {
  if (reset) txnState.offset = 0;

  const params = new URLSearchParams({
    limit:  txnState.limit,
    offset: txnState.offset,
  });

  const search = el('txnSearch').value.trim();
  const status = el('txnStatus').value;
  const method = el('txnMethod').value;
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (method) params.set('method', method);

  const data = await api.get(`/dashboard/transactions?${params}`);
  if (!data) return;

  txnState.total = data.total;
  const start = txnState.offset + 1;
  const end   = Math.min(txnState.offset + txnState.limit, data.total);
  el('txnSubtitle').textContent = `Showing ${data.total > 0 ? start + '–' + end : 0} of ${data.total} transactions`;

  const tbody = el('txnTableBody');
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No transactions found</td></tr>';
  } else {
    tbody.innerHTML = data.items.map(p => `
      <tr>
        <td><span class="monospace">${p.id}</span></td>
        <td><span class="monospace" style="font-size:10px">${p.order_id}</span></td>
        <td>
          <div style="font-weight:500">${p.customer_name || '—'}</div>
          <div style="font-size:11px;color:#9ca3af">${p.customer_email || ''}</div>
        </td>
        <td><strong>${fmt.currency(p.amount)}</strong></td>
        <td>${fmt.method(p.method)}</td>
        <td>${badge(p.status)}</td>
        <td style="font-size:11px;color:#6b7280">${p.processor || '—'}</td>
        <td style="color:#6b7280">${fmt.time(p.created_at)}</td>
      </tr>
    `).join('');
  }

  // Pagination
  const pages = Math.ceil(data.total / txnState.limit);
  const cur   = Math.floor(txnState.offset / txnState.limit) + 1;
  el('txnPagination').innerHTML = data.total > txnState.limit ? `
    <span class="page-info">${data.total} total</span>
    <button class="page-btn" id="prevPage" ${txnState.offset === 0 ? 'disabled' : ''}>← Prev</button>
    <span style="font-size:13px;color:#6b7280">Page ${cur} of ${pages}</span>
    <button class="page-btn" id="nextPage" ${end >= data.total ? 'disabled' : ''}>Next →</button>
  ` : '';

  el('prevPage')?.addEventListener('click', () => {
    txnState.offset = Math.max(0, txnState.offset - txnState.limit);
    loadTransactions();
  });
  el('nextPage')?.addEventListener('click', () => {
    txnState.offset += txnState.limit;
    loadTransactions();
  });
}

el('txnFilter').addEventListener('click', () => loadTransactions(true));
el('txnSearch').addEventListener('keydown', e => { if (e.key === 'Enter') loadTransactions(true); });

// ─── CUSTOMERS ────────────────────────────────────────────────────────────────
async function loadCustomers() {
  const data = await api.get('/dashboard/customers');
  if (!data) return;

  const tbody = el('customersBody');
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No customers yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.items.map((c, i) => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:30px;height:30px;background:#ede9fe;color:#4f46e5;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">
            ${fmt.initial(c.name)}
          </div>
          <span style="font-weight:500">${c.name || '—'}</span>
        </div>
      </td>
      <td style="color:#6b7280">${c.email}</td>
      <td style="color:#6b7280">${c.phone || '—'}</td>
      <td>${c.payment_count}</td>
      <td><strong>${fmt.currency(c.total_paid)}</strong></td>
      <td style="color:#6b7280">${fmt.time(c.last_payment)}</td>
    </tr>
  `).join('');
}

// ─── DEVELOPERS ───────────────────────────────────────────────────────────────

// Dev sub-tab switching
document.querySelectorAll('[data-devtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-devtab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['keys', 'playground', 'webhooks', 'sdk'].forEach(t => {
      const p = el(`devtab-${t}`);
      if (p) p.classList.toggle('hidden', t !== btn.dataset.devtab);
    });
    if (btn.dataset.devtab === 'webhooks') loadWebhookEndpoints();
  });
});

// Webhook modal open/close
el('addWebhookBtn').addEventListener('click', () => el('addWebhookModal').classList.remove('hidden'));
el('closeWebhookModal').addEventListener('click', () => el('addWebhookModal').classList.add('hidden'));
el('addWebhookModal').addEventListener('click', e => {
  if (e.target === el('addWebhookModal')) el('addWebhookModal').classList.add('hidden');
});

// Webhook modal submit
el('submitWebhookBtn').addEventListener('click', async () => {
  const errEl = el('whErr');
  errEl.classList.add('hidden');
  const url = el('whUrl').value.trim();
  if (!url) { errEl.textContent = 'URL is required'; errEl.classList.remove('hidden'); return; }

  const selected = Array.from(el('whEvents').selectedOptions).map(o => o.value);
  const events   = selected.includes('*') ? ['*'] : selected;
  const secret   = el('whSecret').value.trim() || undefined;

  const btn = el('submitWebhookBtn');
  btn.disabled = true; btn.textContent = 'Registering…';

  const result = await api.post('/webhooks', { url, events, secret });
  btn.disabled = false; btn.textContent = 'Register';

  if (result?.error) { errEl.textContent = result.error; errEl.classList.remove('hidden'); return; }

  el('addWebhookModal').classList.add('hidden');
  el('whUrl').value = ''; el('whSecret').value = '';
  loadWebhookEndpoints();
});

async function loadWebhookEndpoints() {
  const data = await api.get('/webhooks');
  if (!data) return;

  const tbody = el('webhookEndpointsBody');
  if (!data.items?.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No webhook endpoints registered</td></tr>';
  } else {
    tbody.innerHTML = data.items.map(w => `
      <tr>
        <td style="font-size:12px;font-family:monospace;max-width:200px;overflow:hidden;text-overflow:ellipsis">${w.url}</td>
        <td style="font-size:11px">${(w.events || []).join(', ')}</td>
        <td>${badge(w.active ? 'active' : 'inactive')}</td>
        <td>${fmt.time(w.created_at)}</td>
        <td>
          <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px" onclick="testWebhook('${w.id}')">Test</button>
          <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px;color:#ef4444" onclick="deleteWebhook('${w.id}')">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  const logsData = await api.get('/developer/webhook_logs');
  if (!logsData) return;
  const logsTbody = el('webhookLogsBody');
  if (!logsData.items?.length) {
    logsTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No webhook events yet</td></tr>';
  } else {
    logsTbody.innerHTML = logsData.items.map(l => `
      <tr>
        <td style="font-size:12px">${l.event}</td>
        <td>${badge(l.status === 'delivered' ? 'captured' : 'failed')}</td>
        <td>${l.attempts}</td>
        <td>${fmt.time(l.delivered_at)}</td>
        <td>${fmt.time(l.created_at)}</td>
      </tr>
    `).join('');
  }
}

async function testWebhook(id) {
  const result = await api.post(`/webhooks/${id}/test`, {});
  if (result?.error) { alert('Test failed: ' + result.error); return; }
  alert('Test event sent!');
}

async function deleteWebhook(id) {
  if (!confirm('Delete this webhook endpoint?')) return;
  const res = await fetch(`/api/webhooks/${id}`, { method: 'DELETE', headers: { 'X-Session-Token': token } });
  if (res.ok) loadWebhookEndpoints();
}

async function loadDevelopers() {
  const data = await api.get('/dashboard/api-keys');
  if (!data) return;

  const container = el('apiKeysList');
  if (!data.items.length) {
    container.innerHTML = '<p style="color:#9ca3af">No API keys found</p>';
    return;
  }

  container.innerHTML = data.items.map(k => `
    <div class="api-key-row">
      <div style="flex:1">
        <div class="api-key-label">Key ID (public)</div>
        <div class="api-key-value">${k.key_id}</div>
      </div>
      <span class="badge ${k.is_active ? 'badge-captured' : 'badge-failed'}">
        ${k.is_active ? 'Active' : 'Revoked'}
      </span>
    </div>
  `).join('');

  // Show curl example with first key
  const keyId = data.items[0]?.key_id || 'YOUR_KEY_ID';
  el('curlExample').textContent = `# Create an order
curl -X POST http://localhost:3000/v1/orders \\
  -H "Authorization: Basic $(echo -n '${keyId}:YOUR_SECRET' | base64)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 150000,
    "currency": "INR",
    "customer": {
      "name": "Priya Sharma",
      "email": "priya@example.com"
    }
  }'`;
}

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────
let mrrChart, subStatusChart;
let subsState = { offset: 0, total: 0, limit: 20 };

async function loadSubscriptions() {
  const [overview, plans, subs, chart] = await Promise.all([
    api.get('/dashboard/subscriptions/overview'),
    api.get('/dashboard/subscriptions/plans'),
    api.get('/dashboard/subscriptions/list?limit=20&offset=0'),
    api.get('/dashboard/subscriptions/mrr-chart'),
  ]);
  if (!overview) return;

  // Stats
  el('subMRR').textContent   = fmt.currency(overview.mrr);
  el('subARR').textContent   = fmt.currency(overview.arr);
  el('subActive').textContent = overview.active_count;
  el('subChurn').textContent  = overview.churn_rate + '%';

  // MRR chart
  if (mrrChart)     { mrrChart.destroy();     mrrChart     = null; }
  if (subStatusChart) { subStatusChart.destroy(); subStatusChart = null; }

  if (chart?.items?.length) {
    mrrChart = new Chart(el('mrrChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: chart.items.map(r => r.month),
        datasets: [{
          label: 'Revenue',
          data:  chart.items.map(r => r.revenue / 100),
          borderColor: '#4f46e5',
          backgroundColor: 'rgba(79,70,229,.08)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#f3f4f6' }, ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } },
          x: { grid: { display: false } },
        },
      },
    });
  } else {
    el('mrrChart').parentElement.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:40px">No subscription revenue yet</div>';
  }

  // Status doughnut
  if (overview.status_breakdown?.length) {
    const STATUS_COLORS = {
      active: '#10b981', authenticated: '#6366f1', paused: '#f59e0b',
      halted: '#ef4444', cancelled: '#9ca3af', completed: '#3b82f6',
    };
    subStatusChart = new Chart(el('subStatusChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels:   overview.status_breakdown.map(s => s.status),
        datasets: [{
          data:            overview.status_breakdown.map(s => s.count),
          backgroundColor: overview.status_breakdown.map(s => STATUS_COLORS[s.status] || '#e5e7eb'),
          borderWidth: 2, borderColor: '#fff',
        }],
      },
      options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } } } },
    });
  }

  // Plans table
  const plansTbody = el('plansTableBody');
  if (!plans?.items?.length) {
    plansTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No plans yet</td></tr>';
  } else {
    const intervalLabel = (interval, count) =>
      count === 1 ? interval.charAt(0).toUpperCase() + interval.slice(1)
                  : `Every ${count} ${interval}s`;
    plansTbody.innerHTML = plans.items.map(p => `
      <tr>
        <td><strong>${p.name}</strong>${p.description ? `<div style="font-size:11px;color:#9ca3af">${p.description}</div>` : ''}</td>
        <td>${fmt.currency(p.amount)}</td>
        <td>${intervalLabel(p.interval, p.interval_count)}</td>
        <td><strong>${p.active_subscribers}</strong><span style="color:#9ca3af"> / ${p.total_subscribers} total</span></td>
        <td>${badge(p.status === 'active' ? 'paid' : 'failed')}</td>
      </tr>
    `).join('');
  }

  // Subscriptions table
  subsState = { offset: 0, total: subs?.total || 0, limit: 20 };
  renderSubsTable(subs);
}

function renderSubsTable(data) {
  if (!data) return;
  subsState.total = data.total;
  const tbody = el('subsTableBody');
  if (!data.items?.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No subscriptions found</td></tr>';
    el('subsPagination').innerHTML = '';
    return;
  }

  const intervalShort = { daily: 'd', weekly: 'wk', monthly: 'mo', yearly: 'yr' };
  tbody.innerHTML = data.items.map(s => `
    <tr>
      <td>
        <div style="font-weight:500">${s.customer_name || '—'}</div>
        <div style="font-size:11px;color:#9ca3af">${s.customer_email || ''}</div>
      </td>
      <td>
        <div>${s.plan_name}</div>
        <div style="font-size:11px;color:#9ca3af">${fmt.currency(s.plan_amount)}/${intervalShort[s.interval] || s.interval}</div>
      </td>
      <td>${badge(s.status === 'active' ? 'paid' : s.status === 'halted' || s.status === 'cancelled' ? 'failed' : 'created')}<span style="margin-left:4px;font-size:11px;color:#6b7280">${s.status}</span></td>
      <td style="text-align:center">${s.paid_count ?? 0}${s.total_count ? '/' + s.total_count : ''}</td>
      <td style="color:#6b7280">${s.charge_at ? fmt.time(s.charge_at) : '—'}</td>
      <td style="color:#6b7280">${fmt.time(s.start_at)}</td>
    </tr>
  `).join('');

  const end = subsState.offset + subsState.limit;
  const pages = Math.ceil(data.total / subsState.limit);
  const cur   = Math.floor(subsState.offset / subsState.limit) + 1;
  el('subsPagination').innerHTML = data.total > subsState.limit ? `
    <span class="page-info">${data.total} total</span>
    <button class="page-btn" id="subPrev" ${subsState.offset === 0 ? 'disabled' : ''}>← Prev</button>
    <span style="font-size:13px;color:#6b7280">Page ${cur} of ${pages}</span>
    <button class="page-btn" id="subNext" ${end >= data.total ? 'disabled' : ''}>Next →</button>
  ` : '';

  el('subPrev')?.addEventListener('click', async () => {
    subsState.offset = Math.max(0, subsState.offset - subsState.limit);
    const d = await api.get(`/dashboard/subscriptions/list?limit=${subsState.limit}&offset=${subsState.offset}`);
    renderSubsTable(d);
  });
  el('subNext')?.addEventListener('click', async () => {
    subsState.offset += subsState.limit;
    const d = await api.get(`/dashboard/subscriptions/list?limit=${subsState.limit}&offset=${subsState.offset}`);
    renderSubsTable(d);
  });
}

el('subStatusFilter').addEventListener('change', async () => {
  const status = el('subStatusFilter').value;
  const d = await api.get(`/dashboard/subscriptions/list?limit=20&offset=0${status ? '&status=' + status : ''}`);
  subsState.offset = 0;
  renderSubsTable(d);
});

// ─── PAYMENT LINKS ────────────────────────────────────────────────────────────
async function loadLinks() {
  const data = await api.get('/dashboard/links');
  if (!data) return;

  const tbody = el('linksTableBody');
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No links yet — create your first one above</td></tr>';
    return;
  }

  tbody.innerHTML = data.items.map(lnk => {
    const amountText = lnk.amount_type === 'fixed'
      ? fmt.currency(lnk.amount)
      : lnk.amount_type === 'range'
        ? `₹${lnk.min_amount/100}–₹${lnk.max_amount/100}`
        : 'Open';

    return `
    <tr>
      <td>
        <div style="font-weight:500">${lnk.title}</div>
        <div style="font-size:11px;color:#9ca3af">${lnk.description || ''}</div>
      </td>
      <td><span class="badge badge-created">${lnk.type}</span></td>
      <td>${amountText}</td>
      <td>${badge(lnk.status)}</td>
      <td style="font-weight:500">${lnk.payment_count}</td>
      <td><strong>${fmt.currency(lnk.amount_paid)}</strong></td>
      <td style="color:#6b7280">${fmt.time(lnk.created_at)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="copy-btn" onclick="copyLink('${lnk.url}')">Copy</button>
          <a class="copy-btn" href="${lnk.url}" target="_blank">Open</a>
          ${lnk.status === 'active' || lnk.status === 'partially_paid'
            ? `<button class="copy-btn" style="color:#dc2626" onclick="deactivateLink('${lnk.id}')">Disable</button>`
            : ''}
        </div>
      </td>
    </tr>
  `}).join('');
}

async function deactivateLink(id) {
  if (!confirm('Disable this link? Customers will no longer be able to pay.')) return;
  await api.patch(`/dashboard/links/${id}/deactivate`);
  loadLinks();
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(() => alert('Link copied!\n\n' + url));
}

// Modal controls
el('createLinkBtn').addEventListener('click', () => {
  el('createLinkModal').classList.remove('hidden');
});
el('closeModal').addEventListener('click', () => {
  el('createLinkModal').classList.add('hidden');
  el('customFieldsList').innerHTML = '';
  el('customFieldsSection').style.display = 'none';
  document.querySelectorAll('.modal-tab').forEach((b, i) => b.classList.toggle('active', i === 0));
  el('modalTitle').textContent = 'Create Payment Link';
});
el('createLinkModal').addEventListener('click', (e) => {
  if (e.target === el('createLinkModal')) el('createLinkModal').classList.add('hidden');
});

// Amount type toggle
el('linkAmountType').addEventListener('change', () => {
  const t = el('linkAmountType').value;
  el('fixedAmountField').style.display  = t === 'fixed' ? '' : 'none';
  el('rangeFields').classList.toggle('hidden', t !== 'range');
});

// Modal tabs — also toggle custom fields section for page type
document.querySelectorAll('.modal-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isPage = btn.dataset.tab === 'page';
    el('modalTitle').textContent = isPage ? 'Create Payment Page' : 'Create Payment Link';
    el('customFieldsSection').style.display = isPage ? '' : 'none';
  });
});

// Fix #5 — custom fields builder
el('addFieldBtn').addEventListener('click', () => {
  const row = document.createElement('div');
  row.className = 'custom-field-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;margin-bottom:8px';
  row.innerHTML = `
    <input class="cf-label filter-input" placeholder="Field label (e.g. T-shirt size)" style="padding:7px 10px" />
    <select class="cf-type filter-select">
      <option value="text">Text</option>
      <option value="tel">Phone</option>
      <option value="email">Email</option>
      <option value="number">Number</option>
    </select>
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;cursor:pointer">
      <input type="checkbox" class="cf-required" /> Required
    </label>
    <button type="button" style="background:none;border:none;color:#9ca3af;font-size:16px;cursor:pointer;padding:0 4px" onclick="this.closest('.custom-field-row').remove()">✕</button>
  `;
  el('customFieldsList').appendChild(row);
});

el('submitLinkBtn').addEventListener('click', async () => {
  const errEl = el('formError2');
  errEl.classList.add('hidden');

  const title = el('linkTitle').value.trim();
  if (!title) { errEl.textContent = 'Title is required'; errEl.classList.remove('hidden'); return; }

  const amountType = el('linkAmountType').value;
  // Fix #10 — validate tab value instead of silently defaulting
  const activeTab = document.querySelector('.modal-tab.active')?.dataset.tab;
  const type = activeTab === 'page' ? 'page' : 'link';

  const body = {
    type, title,
    description:     el('linkDesc').value.trim() || undefined,
    amount_type:     amountType,
    allow_partial:   el('linkPartial').checked === true, // Fix #9 — explicit boolean
    customer_email:  el('linkCustEmail').value.trim() || undefined,
    success_message: el('linkSuccessMsg').value.trim() || undefined,
  };

  if (amountType === 'fixed') {
    const a = parseFloat(el('linkAmount').value);
    if (!a || a <= 0) { errEl.textContent = 'Enter a valid amount'; errEl.classList.remove('hidden'); return; }
    body.amount = Math.round(a * 100);
  } else if (amountType === 'range') {
    const mn = parseFloat(el('linkMinAmount').value);
    const mx = parseFloat(el('linkMaxAmount').value);
    if (!mn || !mx || mn <= 0 || mx <= 0) { errEl.textContent = 'Enter valid min and max amounts'; errEl.classList.remove('hidden'); return; }
    if (mn >= mx) { errEl.textContent = 'Min amount must be less than max'; errEl.classList.remove('hidden'); return; }
    body.min_amount = Math.round(mn * 100);
    body.max_amount = Math.round(mx * 100);
  }

  // Fix #5 — collect custom fields for page type
  const customFieldRows = document.querySelectorAll('.custom-field-row');
  if (type === 'page' && customFieldRows.length) {
    body.custom_fields = Array.from(customFieldRows).map((row, i) => ({
      id:       'field_' + i,
      label:    row.querySelector('.cf-label').value.trim(),
      type:     row.querySelector('.cf-type').value,
      required: row.querySelector('.cf-required').checked,
    })).filter(f => f.label);
  }

  const expirySeconds = parseInt(el('linkExpiry').value);
  if (expirySeconds) {
    body.expires_at = Math.floor(Date.now() / 1000) + expirySeconds;
  }

  const btn = el('submitLinkBtn');
  btn.disabled = true; btn.textContent = 'Creating…';

  const link = await api.post('/dashboard/links', body);
  btn.disabled = false; btn.textContent = 'Create Link';

  if (link?.error) {
    errEl.textContent = link.error; errEl.classList.remove('hidden');
    return;
  }

  el('createLinkModal').classList.add('hidden');
  // Reset form
  ['linkTitle','linkDesc','linkAmount','linkCustEmail','linkSuccessMsg','linkMinAmount','linkMaxAmount']
    .forEach(id => { if (el(id)) el(id).value = ''; });
  el('linkPartial').checked = false;
  el('linkExpiry').value    = '';
  el('linkAmountType').value = 'fixed';
  el('fixedAmountField').style.display = '';
  el('rangeFields').classList.add('hidden');

  loadLinks();

  // Show the created link URL
  if (link?.url) {
    setTimeout(() => {
      if (confirm(`Link created!\n\n${link.url}\n\nCopy to clipboard?`)) {
        navigator.clipboard.writeText(link.url);
      }
    }, 100);
  }
});

// ─── PAYOUTS ──────────────────────────────────────────────────────────────────
let payoutChart, payoutModeChart;
let poutState = { offset: 0, total: 0, limit: 20 };

async function loadPayouts() {
  const [overview, chart, modes, contacts, list] = await Promise.all([
    api.get('/dashboard/payouts/overview'),
    api.get('/dashboard/payouts/chart'),
    api.get('/dashboard/payouts/mode-breakdown'),
    api.get('/dashboard/payouts/by-contact'),
    api.get('/dashboard/payouts/list?limit=20&offset=0'),
  ]);
  if (!overview) return;

  // Stats
  el('poutPaidToday').textContent = fmt.currency(overview.paid_today);
  el('poutPending').textContent   = overview.pending_count;
  el('poutApproval').textContent  = overview.pending_approval.count;
  el('poutBalance').textContent   = fmt.currency(overview.nodal_balance);

  // Charts
  if (payoutChart)     { payoutChart.destroy();     payoutChart     = null; }
  if (payoutModeChart) { payoutModeChart.destroy(); payoutModeChart = null; }

  if (chart?.items?.length) {
    payoutChart = new Chart(el('payoutChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: chart.items.map(r => r.day.slice(5)),
        datasets: [{
          label: 'Paid Out (₹)',
          data:  chart.items.map(r => r.amount / 100),
          backgroundColor: '#10b981', borderRadius: 4, borderSkipped: false,
        }],
      },
      options: {
        responsive: true, plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#f3f4f6' }, ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } },
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        },
      },
    });
  }

  if (modes?.items?.length) {
    const MODE_COLORS = { IMPS: '#4f46e5', NEFT: '#10b981', RTGS: '#f59e0b', UPI: '#06b6d4' };
    payoutModeChart = new Chart(el('payoutModeChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels:   modes.items.map(m => m.mode),
        datasets: [{ data: modes.items.map(m => m.count), backgroundColor: modes.items.map(m => MODE_COLORS[m.mode] || '#e5e7eb'), borderWidth: 2, borderColor: '#fff' }],
      },
      options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } } } },
    });
  }

  // Pending approval table
  renderApprovalTable(list?.items?.filter(p => p.status === 'pending_approval') || []);

  // Main payouts table
  poutState = { offset: 0, total: list?.total || 0, limit: 20 };
  renderPayoutsTable(list);

  // Contacts table
  const ctbody = el('contactsTableBody');
  if (!contacts?.items?.length) {
    ctbody.innerHTML = '<tr><td colspan="5" class="table-empty">No contacts yet</td></tr>';
  } else {
    ctbody.innerHTML = contacts.items.map(c => `
      <tr>
        <td>
          <div style="font-weight:500">${c.name}</div>
          <div style="font-size:11px;color:#9ca3af">${c.email || ''}</div>
        </td>
        <td><span class="badge badge-created">${c.type}</span></td>
        <td><strong>${fmt.currency(c.total_paid)}</strong></td>
        <td>${c.total_payouts}</td>
        <td style="color:#6b7280">${fmt.time(c.last_payout_at)}</td>
      </tr>
    `).join('');
  }
}

function renderApprovalTable(items) {
  const tbody = el('approvalTableBody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No pending approvals</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(p => `
    <tr>
      <td><span class="monospace" style="font-size:11px">${p.id}</span></td>
      <td>${p.contact_name || '—'}</td>
      <td><strong>${fmt.currency(p.amount)}</strong></td>
      <td><span class="badge badge-created">${p.mode}</span></td>
      <td style="color:#6b7280">${fmt.time(p.created_at)}</td>
      <td>
        <button class="copy-btn" style="color:#059669" onclick="approvePayout('${p.id}')">Approve</button>
        <button class="copy-btn" style="color:#dc2626;margin-left:4px" onclick="cancelPayout('${p.id}')">Cancel</button>
      </td>
    </tr>
  `).join('');
}

function renderPayoutsTable(data) {
  if (!data) return;
  poutState.total = data.total;
  const tbody = el('payoutsTableBody');
  if (!data.items?.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No payouts found</td></tr>';
    el('poutPagination').innerHTML = '';
    return;
  }
  tbody.innerHTML = data.items.map(p => `
    <tr>
      <td><span class="monospace" style="font-size:10px">${p.id}</span></td>
      <td>
        <div style="font-weight:500">${p.contact_name || '—'}</div>
        <div style="font-size:11px;color:#9ca3af">${p.account_type === 'vpa' ? p.vpa : (p.bank_name || '')}</div>
      </td>
      <td><strong>${fmt.currency(p.amount)}</strong></td>
      <td><span class="badge badge-created">${p.mode}</span></td>
      <td style="font-size:11px;color:#6b7280">${p.purpose || '—'}</td>
      <td>${badge(p.status === 'processed' ? 'captured' : p.status === 'failed' ? 'failed' : p.status === 'pending_approval' ? 'created' : 'created')}<span style="margin-left:4px;font-size:11px;color:#6b7280">${p.status.replace('_', ' ')}</span></td>
      <td style="font-size:11px;color:#6b7280;font-family:monospace">${p.utr || '—'}</td>
      <td style="color:#6b7280">${fmt.time(p.created_at)}</td>
    </tr>
  `).join('');

  const end   = poutState.offset + poutState.limit;
  const pages = Math.ceil(data.total / poutState.limit);
  const cur   = Math.floor(poutState.offset / poutState.limit) + 1;
  el('poutPagination').innerHTML = data.total > poutState.limit ? `
    <span class="page-info">${data.total} total</span>
    <button class="page-btn" id="poutPrev" ${poutState.offset === 0 ? 'disabled' : ''}>← Prev</button>
    <span style="font-size:13px;color:#6b7280">Page ${cur} of ${pages}</span>
    <button class="page-btn" id="poutNext" ${end >= data.total ? 'disabled' : ''}>Next →</button>
  ` : '';

  el('poutPrev')?.addEventListener('click', async () => {
    poutState.offset = Math.max(0, poutState.offset - poutState.limit);
    const d = await api.get(`/dashboard/payouts/list?limit=${poutState.limit}&offset=${poutState.offset}`);
    renderPayoutsTable(d);
  });
  el('poutNext')?.addEventListener('click', async () => {
    poutState.offset += poutState.limit;
    const d = await api.get(`/dashboard/payouts/list?limit=${poutState.limit}&offset=${poutState.offset}`);
    renderPayoutsTable(d);
  });
}

el('poutStatusFilter').addEventListener('change', async () => {
  const status = el('poutStatusFilter').value;
  const d = await api.get(`/dashboard/payouts/list?limit=20&offset=0${status ? '&status=' + status : ''}`);
  poutState.offset = 0;
  renderPayoutsTable(d);
});

async function approvePayout(id) {
  if (!confirm('Approve this payout? The funds will be queued for transfer.')) return;
  const r = await api.post(`/dashboard/payouts/${id}/approve`, {});
  if (r?.error) { alert('Error: ' + r.error); return; }
  loadPayouts();
}

async function cancelPayout(id) {
  if (!confirm('Cancel this payout?')) return;
  const r = await api.post(`/dashboard/payouts/${id}/cancel`, {});
  if (r?.error) { alert('Error: ' + r.error); return; }
  loadPayouts();
}

// Payout modal
el('createPayoutBtn').addEventListener('click', () => el('createPayoutModal').classList.remove('hidden'));
el('closePayoutModal').addEventListener('click', () => el('createPayoutModal').classList.add('hidden'));
el('createPayoutModal').addEventListener('click', e => { if (e.target === el('createPayoutModal')) el('createPayoutModal').classList.add('hidden'); });

el('submitPayoutBtn').addEventListener('click', async () => {
  const errEl = el('poutFormError');
  errEl.classList.add('hidden');
  const faId = el('poutFaId').value.trim();
  const amt  = parseFloat(el('poutAmount').value);
  if (!faId) { errEl.textContent = 'Fund Account ID is required'; errEl.classList.remove('hidden'); return; }
  if (!amt || amt <= 0) { errEl.textContent = 'Enter a valid amount'; errEl.classList.remove('hidden'); return; }

  const btn = el('submitPayoutBtn');
  btn.disabled = true; btn.textContent = 'Creating…';

  const result = await api.post('/dashboard/payouts/create', {
    fund_account_id: faId,
    amount:  Math.round(amt * 100),
    mode:    el('poutMode').value,
    purpose: el('poutPurpose').value,
    narration: el('poutNarration').value.trim() || undefined,
  });

  btn.disabled = false; btn.textContent = 'Create Payout';
  if (result?.error) { errEl.textContent = result.error; errEl.classList.remove('hidden'); return; }
  el('createPayoutModal').classList.add('hidden');
  loadPayouts();
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
let aRevTrendChart, aRevMethodChart, aRevHourChart;
let aPayRateChart, aPayMethodChart;
let aCustCohortChart, aCustRevCohortChart;
let aBenchSubChart, aBenchPayoutModeChart;

const CHART_COLORS = ['#4f46e5','#10b981','#f59e0b','#ef4444','#06b6d4','#8b5cf6','#ec4899'];

function destroyAnalyticsCharts() {
  [aRevTrendChart, aRevMethodChart, aRevHourChart,
   aPayRateChart, aPayMethodChart,
   aCustCohortChart, aCustRevCohortChart,
   aBenchSubChart, aBenchPayoutModeChart].forEach(c => { if (c) c.destroy(); });
  aRevTrendChart = aRevMethodChart = aRevHourChart = null;
  aPayRateChart  = aPayMethodChart = null;
  aCustCohortChart = aCustRevCohortChart = null;
  aBenchSubChart = aBenchPayoutModeChart = null;
}

function fillDays(rows, days, dayKey = 'day') {
  const today = new Date();
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push(rows.find(r => r[dayKey] === key) || { [dayKey]: key });
  }
  return result;
}

function dayLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

async function loadAnalytics() {
  const days = parseInt(el('analyticsDays').value) || 30;
  destroyAnalyticsCharts();

  const [revData, payData, custData, benchData] = await Promise.all([
    api.get(`/dashboard/analytics/revenue?days=${days}`),
    api.get(`/dashboard/analytics/payments?days=${days}`),
    api.get(`/dashboard/analytics/customers`),
    api.get(`/dashboard/analytics/benchmarks`),
  ]);
  if (!revData) return;

  renderAnalyticsRevenue(revData, days);
  renderAnalyticsPayments(payData, days);
  renderAnalyticsCustomers(custData);
  renderAnalyticsBenchmarks(benchData);
}

function renderAnalyticsRevenue(data, days) {
  const s = data.summary;
  el('aRevL30').textContent     = fmt.currency(s.last_30d);
  el('aRevMTD').textContent     = fmt.currency(s.mtd_revenue);
  el('aRevYTD').textContent     = fmt.currency(s.ytd_revenue);
  el('aRevGrowth').textContent  = s.growth_mom !== null
    ? (s.growth_mom >= 0 ? '+' : '') + s.growth_mom + '%'
    : '—';

  const trend = fillDays(data.trend || [], days);
  el('aRevTrendTitle').textContent = `Daily Revenue — Last ${days} Days`;

  aRevTrendChart = new Chart(el('aRevTrendChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: trend.map(r => dayLabel(r.day)),
      datasets: [{
        label: 'Revenue (₹)',
        data:  trend.map(r => (r.revenue || 0) / 100),
        borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,.08)',
        fill: true, tension: 0.4, pointRadius: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: '#f3f4f6' }, ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 11 } } },
      },
    },
  });

  const methods = data.by_method || [];
  aRevMethodChart = new Chart(el('aRevMethodChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels:   methods.map(m => fmt.method(m.method)),
      datasets: [{ data: methods.map(m => m.revenue), backgroundColor: CHART_COLORS.slice(0, methods.length), borderWidth: 2, borderColor: '#fff' }],
    },
    options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } } } },
  });

  // Hourly bar chart
  const hourly = data.by_hour || [];
  const hourArr = Array.from({ length: 24 }, (_, h) => {
    const r = hourly.find(x => x.hour === h);
    return r ? r.revenue / 100 : 0;
  });
  aRevHourChart = new Chart(el('aRevHourChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: Array.from({ length: 24 }, (_, h) => h + ':00'),
      datasets: [{
        label: 'Revenue (₹)',
        data: hourArr,
        backgroundColor: hourArr.map(v => v > 0 ? '#818cf8' : '#e5e7eb'),
        borderRadius: 3, borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: '#f3f4f6' }, ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } },
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } },
      },
    },
  });

  // Method table
  const mtbody = el('aRevMethodTable');
  mtbody.innerHTML = methods.length
    ? methods.map(m => `
        <tr>
          <td>${fmt.method(m.method)}</td>
          <td>${m.txns.toLocaleString('en-IN')}</td>
          <td><strong>${fmt.currency(m.revenue)}</strong></td>
        </tr>`).join('')
    : '<tr><td colspan="3" class="table-empty">No data</td></tr>';
}

function renderAnalyticsPayments(data, days) {
  if (!data) return;
  const s = data.summary;
  el('aPayRate').textContent  = s.success_rate + '%';
  el('aPayTotal').textContent = s.total.toLocaleString('en-IN');
  el('aPayAvg').textContent   = fmt.currency(s.avg_ticket);
  el('aPayP90').textContent   = fmt.currency(s.p90_ticket);

  const rates = fillDays(data.daily_rates || [], days);
  aPayRateChart = new Chart(el('aPayRateChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: rates.map(r => dayLabel(r.day)),
      datasets: [{
        label: 'Success Rate (%)',
        data:  rates.map(r => r.success_rate || 0),
        borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.08)',
        fill: true, tension: 0.4, pointRadius: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, grid: { color: '#f3f4f6' }, ticks: { callback: v => v + '%' } },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 11 } } },
      },
    },
  });

  const methods = data.by_method || [];
  aPayMethodChart = new Chart(el('aPayMethodChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels:   methods.map(m => fmt.method(m.method)),
      datasets: [{ data: methods.map(m => m.total), backgroundColor: CHART_COLORS.slice(0, methods.length), borderWidth: 2, borderColor: '#fff' }],
    },
    options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } } } },
  });

  const ptbody = el('aPayMethodTable');
  ptbody.innerHTML = methods.length
    ? methods.map(m => `
        <tr>
          <td>${fmt.method(m.method)}</td>
          <td>${m.total.toLocaleString('en-IN')}</td>
          <td>${m.captured.toLocaleString('en-IN')}</td>
          <td style="color:#ef4444">${m.failed.toLocaleString('en-IN')}</td>
          <td>
            <span style="color:${m.success_rate >= 80 ? '#059669' : m.success_rate >= 60 ? '#d97706' : '#dc2626'};font-weight:600">
              ${m.success_rate}%
            </span>
          </td>
          <td><strong>${fmt.currency(m.revenue)}</strong></td>
          <td>${fmt.currency(m.avg_ticket)}</td>
        </tr>`).join('')
    : '<tr><td colspan="7" class="table-empty">No data</td></tr>';
}

function renderAnalyticsCustomers(data) {
  if (!data) return;
  const s = data.summary;
  el('aCustTotal').textContent   = (s.total_unique || 0).toLocaleString('en-IN');
  el('aCustNew').textContent     = (s.new_this_month || 0).toLocaleString('en-IN');
  el('aCustRetain').textContent  = (s.retention_rate || 0) + '%';
  el('aCustLTV').textContent     = fmt.currency(s.avg_ltv || 0);

  const cohorts = data.cohorts || [];
  aCustCohortChart = new Chart(el('aCustCohortChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: cohorts.map(c => c.month),
      datasets: [{
        label: 'New Customers',
        data:  cohorts.map(c => c.new_customers),
        backgroundColor: '#818cf8', borderRadius: 4, borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: '#f3f4f6' }, ticks: { precision: 0 } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });

  aCustRevCohortChart = new Chart(el('aCustRevCohortChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: cohorts.map(c => c.month),
      datasets: [{
        label: 'Revenue (₹)',
        data:  cohorts.map(c => c.revenue / 100),
        backgroundColor: '#10b981', borderRadius: 4, borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: '#f3f4f6' }, ticks: { callback: v => '₹' + v.toLocaleString('en-IN') } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });

  const tbody = el('aCustTopTable');
  const top = data.top || [];
  tbody.innerHTML = top.length
    ? top.map(c => `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:28px;height:28px;background:#ede9fe;color:#4f46e5;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${fmt.initial(c.name)}</div>
              <span style="font-weight:500">${c.name || '—'}</span>
            </div>
          </td>
          <td style="color:#6b7280;font-size:12px">${c.email}</td>
          <td style="text-align:center">${c.payment_count}</td>
          <td style="text-align:center;color:${c.payments_30d > 0 ? '#059669' : '#9ca3af'}">${c.payments_30d}</td>
          <td><strong>${fmt.currency(c.total_paid)}</strong></td>
          <td style="color:#6b7280">${fmt.time(c.last_payment_at)}</td>
        </tr>`).join('')
    : '<tr><td colspan="6" class="table-empty">No customers yet</td></tr>';
}

function renderAnalyticsBenchmarks(data) {
  if (!data) return;
  const { benchmarks: bk, subscriptions: sub, payouts: pay } = data;

  el('aBenchMRR').textContent    = fmt.currency(sub.mrr || 0);
  el('aBenchChurn').textContent  = (sub.churn_rate || 0) + '%';
  el('aBenchPayouts').textContent = fmt.currency(pay.total_paid || 0);
  el('aBenchSLA').textContent    = pay.avg_processing_mins !== null
    ? (pay.avg_processing_mins || 0) + ' min'
    : '—';

  // Benchmark gauges
  const gauges = [
    { label: 'Payment Success Rate', yours: bk.merchant.success_rate, industry: bk.industry.success_rate, unit: '%', score: bk.scores.success_rate, higherBetter: true },
    { label: 'UPI Adoption', yours: bk.merchant.upi_adoption, industry: bk.industry.upi_adoption, unit: '%', score: bk.scores.upi_adoption, higherBetter: true },
    { label: 'Avg Ticket Size', yours: (bk.merchant.avg_ticket / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 }), industry: (bk.industry.avg_ticket_inr / 100).toLocaleString('en-IN'), unit: '₹', score: null, higherBetter: null },
    { label: 'Repeat Customer Rate', yours: bk.merchant.repeat_rate, industry: bk.industry.repeat_rate, unit: '%', score: bk.scores.repeat_rate, higherBetter: true },
  ];

  el('aBenchGauges').innerHTML = gauges.map(g => {
    const pct   = g.score !== null ? Math.min(g.score, 100) : 50;
    const color = pct >= 90 ? '#10b981' : pct >= 65 ? '#4f46e5' : pct >= 40 ? '#f59e0b' : '#ef4444';
    const label = g.score !== null
      ? (pct >= 90 ? 'Excellent' : pct >= 65 ? 'Good' : pct >= 40 ? 'Average' : 'Below average')
      : '';
    return `
      <div style="margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:13px;font-weight:600;color:#374151">${g.label}</span>
          <span style="font-size:12px;color:#6b7280">
            You: <strong style="color:#111827">${g.unit === '₹' ? '₹' : ''}${g.yours}${g.unit !== '₹' ? g.unit : ''}</strong>
            &nbsp;·&nbsp; Industry: ${g.unit === '₹' ? '₹' : ''}${g.industry}${g.unit !== '₹' ? g.unit : ''}
            ${label ? `&nbsp;·&nbsp;<span style="color:${color};font-weight:600">${label}</span>` : ''}
          </span>
        </div>
        <div style="background:#f3f4f6;border-radius:99px;height:8px;overflow:hidden">
          <div style="width:${Math.max(4, pct)}%;height:100%;background:${color};border-radius:99px;transition:width .6s ease"></div>
        </div>
      </div>
    `;
  }).join('');

  // Subscription status chart
  const subStatuses = [
    { label: 'Active', count: sub.active_subs,    color: '#10b981' },
    { label: 'Paused', count: sub.paused_subs,    color: '#f59e0b' },
    { label: 'Halted', count: sub.halted_subs,    color: '#ef4444' },
    { label: 'Cancelled', count: sub.cancelled_subs, color: '#9ca3af' },
    { label: 'Completed', count: sub.completed_subs, color: '#3b82f6' },
  ].filter(s => s.count > 0);

  if (subStatuses.length) {
    aBenchSubChart = new Chart(el('aBenchSubChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels:   subStatuses.map(s => s.label),
        datasets: [{ data: subStatuses.map(s => s.count), backgroundColor: subStatuses.map(s => s.color), borderWidth: 2, borderColor: '#fff' }],
      },
      options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } } } },
    });
  } else {
    el('aBenchSubChart').parentElement.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:40px;font-size:13px">No subscriptions yet</div>';
  }

  // Payout mode breakdown
  const modes = pay.mode_breakdown || [];
  if (modes.length) {
    const MODE_COLORS = { IMPS: '#4f46e5', NEFT: '#10b981', RTGS: '#f59e0b', UPI: '#06b6d4' };
    aBenchPayoutModeChart = new Chart(el('aBenchPayoutModeChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels:   modes.map(m => m.mode),
        datasets: [{ data: modes.map(m => m.count), backgroundColor: modes.map(m => MODE_COLORS[m.mode] || '#e5e7eb'), borderWidth: 2, borderColor: '#fff' }],
      },
      options: { responsive: true, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, boxWidth: 12 } } } },
    });
  } else {
    el('aBenchPayoutModeChart').parentElement.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:40px;font-size:13px">No payouts yet</div>';
  }

  // Subscription metrics grid
  el('aBenchSubMetrics').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
      ${[
        ['MRR', fmt.currency(sub.mrr)],
        ['ARR', fmt.currency(sub.arr)],
        ['ARPU', fmt.currency(sub.arpu)],
        ['Active', sub.active_subs],
        ['Churn (30d)', sub.churn_rate + '%'],
        ['Total Collected', fmt.currency(sub.total_collected)],
      ].map(([label, value]) => `
        <div style="background:#f9fafb;border-radius:8px;padding:12px 14px">
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${label}</div>
          <div style="font-size:16px;font-weight:700;color:#111827">${value}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// Analytics tab switching
document.querySelectorAll('[data-atab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-atab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['revenue', 'payments', 'customers', 'benchmarks'].forEach(t => {
      const panel = el(`atab-${t}`);
      if (panel) panel.classList.toggle('hidden', t !== btn.dataset.atab);
    });
  });
});

el('analyticsDays').addEventListener('change', () => {
  const activeTab = document.querySelector('[data-atab].active')?.dataset.atab;
  loadAnalytics().then(() => {
    if (activeTab) {
      document.querySelectorAll('[data-atab]').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(`[data-atab="${activeTab}"]`);
      if (btn) {
        btn.classList.add('active');
        ['revenue', 'payments', 'customers', 'benchmarks'].forEach(t => {
          const panel = el(`atab-${t}`);
          if (panel) panel.classList.toggle('hidden', t !== activeTab);
        });
      }
    }
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const me = await api.get('/auth/me');
  if (!me) return;

  el('merchantName').textContent  = me.name;
  el('merchantAvatar').textContent = fmt.initial(me.name);

  navigate('overview');
}

init();
