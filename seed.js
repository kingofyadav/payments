// Creates a test merchant and 30 days of synthetic transaction data
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getDb }       = require('./src/db/database');
const { generateKeyPair, hashSecret } = require('./src/systems/signature');
const { hashPassword } = require('./src/systems/password');

const METHODS  = ['upi', 'upi', 'upi', 'card', 'card', 'netbanking', 'wallet'];
const AMOUNTS  = [49900, 99900, 149900, 199900, 299900, 49900, 99900, 19900, 24900, 74900];
const NAMES    = ['Priya Sharma','Rohit Gupta','Neha Singh','Amit Kumar','Sunita Patel',
                  'Vikas Yadav','Kavya Nair','Raj Malhotra','Anita Joshi','Dev Mehta'];
const EMAILS   = ['priya@gmail.com','rohit@yahoo.com','neha@hotmail.com','amit@gmail.com',
                  'sunita@outlook.com','vikas@gmail.com','kavya@yahoo.com','raj@gmail.com',
                  'anita@gmail.com','dev@gmail.com'];

async function main() {
  const db = getDb();

  // Check if already seeded
  const existing = db.prepare("SELECT * FROM merchants WHERE email='demo@royalheritage.in'").get();
  if (existing) {
    console.log('Merchant already exists:', existing.id);
    // Still seed payouts if not yet seeded (idempotent)
    const payoutExists = db.prepare("SELECT 1 FROM contacts WHERE merchant_id=? LIMIT 1").get(existing.id);
    if (!payoutExists) {
      await seedPayouts(db, existing.id);
    } else {
      console.log('Payouts already seeded.');
    }
    console.log('Login: demo@royalheritage.in / password123');
    return;
  }

  const merchantId   = 'mrc_demo00000000001';
  const passwordHash = await hashPassword('password123');

  db.prepare('INSERT INTO merchants (id, name, email, password_hash, webhook_url) VALUES (?,?,?,?,?)')
    .run(merchantId, 'Royal Heritage Resort', 'demo@royalheritage.in', passwordHash,
         'https://royalheritage.in/webhooks/payments');

  const { keyId, keySecret } = generateKeyPair();
  db.prepare('INSERT INTO api_keys (id, merchant_id, key_id, key_secret) VALUES (?,?,?,?)')
    .run('apk_demo000000001', merchantId, keyId, hashSecret(keySecret));

  // 30 days of transactions
  const now   = Math.floor(Date.now() / 1000);
  const stats = { total: 0, captured: 0, revenue: 0 };

  for (let day = 29; day >= 0; day--) {
    const txnsPerDay = 15 + Math.floor(Math.random() * 35); // 15–50 per day
    for (let i = 0; i < txnsPerDay; i++) {
      const success  = Math.random() > 0.08; // 92% success rate
      const amount   = AMOUNTS[Math.floor(Math.random() * AMOUNTS.length)];
      const method   = METHODS[Math.floor(Math.random() * METHODS.length)];
      const nameIdx  = Math.floor(Math.random() * NAMES.length);
      const offset   = day * 86400 + Math.floor(Math.random() * 86400);
      const ts       = now - offset;

      const orderId = 'order_' + randomUUID().replace(/-/g, '').slice(0, 16);
      db.prepare(`INSERT INTO orders
        (id,merchant_id,amount,currency,status,customer_name,customer_email,customer_phone,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(orderId, merchantId, amount, 'INR',
        success ? 'paid' : 'failed',
        NAMES[nameIdx], EMAILS[nameIdx],
        '98' + String(1000000000 + Math.floor(Math.random() * 999999999)).slice(1),
        ts + 900, ts);

      const payId = 'pay_' + randomUUID().replace(/-/g, '').slice(0, 16);
      const status = success ? 'captured' : 'failed';
      db.prepare(`INSERT INTO payments
        (id,order_id,merchant_id,amount,currency,method,status,processor,captured_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(payId, orderId, merchantId, amount, 'INR', method, status,
        method === 'upi' ? 'cashfree_upi' : method === 'card' ? 'axis_acquiring' : 'billdesk',
        success ? ts : null, ts);

      stats.total++;
      if (success) { stats.captured++; stats.revenue += amount; }
    }
  }

  console.log(`\nSeeded ${stats.total} transactions over 30 days`);
  console.log(`Revenue: ₹${(stats.revenue / 100).toFixed(2)}`);

  // ── Seed subscriptions ────────────────────────────────────────
  await seedSubscriptions(db, merchantId);

  // ── Seed payouts ──────────────────────────────────────────────
  await seedPayouts(db, merchantId);

  console.log(`\nDashboard login:`);
  console.log(`  Email:    demo@royalheritage.in`);
  console.log(`  Password: password123`);
  console.log(`  API Key:  ${keyId}`);
  console.log(`  Secret:   ${keySecret}`);
}

async function seedSubscriptions(db, merchantId) {
  const now = Math.floor(Date.now() / 1000);

  // Create 3 plans
  const plans = [
    { id: 'plan_basic0000000001', name: 'Basic Membership',   amount: 49900,  interval: 'monthly', interval_count: 1 },
    { id: 'plan_pro00000000001',  name: 'Pro Membership',     amount: 99900,  interval: 'monthly', interval_count: 1 },
    { id: 'plan_annual000000001', name: 'Annual Retainer',    amount: 999900, interval: 'yearly',  interval_count: 1 },
    { id: 'plan_corp0000000001',  name: 'Corporate Booking',  amount: 499900, interval: 'monthly', interval_count: 1 },
  ];

  for (const p of plans) {
    const exists = db.prepare('SELECT 1 FROM plans WHERE id=?').get(p.id);
    if (!exists) {
      db.prepare(`INSERT INTO plans (id,merchant_id,name,amount,currency,interval,interval_count,status)
        VALUES (?,?,?,?,'INR',?,?,'active')`
      ).run(p.id, merchantId, p.name, p.amount, p.interval, p.interval_count);
    }
  }

  const CUST_NAMES  = ['Arjun Reddy','Meera Shah','Rohit Bansal','Divya Nair','Kiran Joshi',
                       'Rahul Gupta','Swati Mishra','Anand Kumar','Pooja Singh','Deepak Verma',
                       'Nisha Patel','Ravi Teja','Anjali Rao','Suresh Iyer','Preethi Menon'];
  const CUST_EMAILS = CUST_NAMES.map((n,i) => n.split(' ')[0].toLowerCase() + i + '@gmail.com');

  const STATUSES = ['active','active','active','active','active','active','paused','cancelled','halted'];
  let subCount = 0, invoiceCount = 0;

  for (let i = 0; i < 60; i++) {
    const custIdx  = i % CUST_NAMES.length;
    const planIdx  = i % plans.length;
    const plan     = plans[planIdx];
    const status   = STATUSES[i % STATUSES.length];
    const startDay = 90 - Math.floor(Math.random() * 80);
    const startTs  = now - startDay * 86400;

    const custId = 'cust_seed' + String(i).padStart(8, '0');
    const subId  = 'sub_seed'  + String(i).padStart(8, '0');

    if (!db.prepare('SELECT 1 FROM customers WHERE id=?').get(custId)) {
      db.prepare('INSERT INTO customers (id,merchant_id,name,email) VALUES (?,?,?,?)')
        .run(custId, merchantId, CUST_NAMES[custIdx], CUST_EMAILS[custIdx] + '_' + i);
    }

    const nextCharge = status === 'active'
      ? now + Math.floor(Math.random() * 30) * 86400
      : null;

    if (!db.prepare('SELECT 1 FROM subscriptions WHERE id=?').get(subId)) {
      db.prepare(`INSERT INTO subscriptions
        (id,merchant_id,plan_id,customer_id,status,mandate_type,paid_count,start_at,charge_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(subId, merchantId, plan.id, custId, status, 'upi_autopay',
            Math.floor(startDay / 30), startTs, nextCharge, startTs);
    }
    subCount++;

    // Create paid invoices for historical cycles
    const cycles = Math.floor(startDay / 30);
    for (let c = 1; c <= cycles && status !== 'cancelled'; c++) {
      const invId = `inv_seed_${i}_${c}`;
      if (!db.prepare('SELECT 1 FROM subscription_invoices WHERE id=?').get(invId)) {
        const dueAt  = startTs + (c - 1) * 30 * 86400;
        const paidAt = dueAt + Math.floor(Math.random() * 3600);
        const payId  = 'pay_inv' + randomUUID().replace(/-/g, '').slice(0, 12);

        // Create a real order so the payments FK constraint is satisfied
        const ordId = 'order_' + randomUUID().replace(/-/g, '').slice(0, 16);
        db.prepare(`INSERT INTO orders (id,merchant_id,amount,currency,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(ordId, merchantId, plan.amount, 'INR', 'paid', dueAt + 900, dueAt);

        db.prepare(`INSERT INTO payments (id,order_id,merchant_id,amount,currency,method,status,processor,captured_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(payId, ordId, merchantId, plan.amount, 'INR', 'upi', 'captured', 'cashfree_upi', paidAt, dueAt);

        db.prepare(`INSERT INTO subscription_invoices
          (id,subscription_id,merchant_id,cycle_number,amount,status,payment_id,due_at,paid_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(invId, subId, merchantId, c, plan.amount, 'paid', payId, dueAt, paidAt, dueAt);
        invoiceCount++;
      }
    }
  }

  console.log(`Seeded ${subCount} subscriptions, ${invoiceCount} paid invoices`);
  const mrrRow = db.prepare(`
    SELECT SUM(p.amount) AS mrr FROM subscriptions s JOIN plans p ON s.plan_id=p.id
    WHERE s.merchant_id=? AND s.status='active'
  `).get(merchantId);
  console.log(`MRR: ₹${((mrrRow.mrr || 0) / 100).toLocaleString('en-IN')}`);
}

async function seedPayouts(db, merchantId) {
  const now = Math.floor(Date.now() / 1000);

  const VENDORS = [
    { name: 'Sharma Foods & Catering',   email: 'sharma.foods@gmail.com',    type: 'vendor' },
    { name: 'Royal Linen Supplies',      email: 'royallinen@outlook.com',    type: 'vendor' },
    { name: 'Greenscape Horticulture',   email: 'greenscape@yahoo.com',      type: 'vendor' },
    { name: 'Elite Spa Products Ltd',    email: 'elitespa@gmail.com',        type: 'vendor' },
    { name: 'Raj Electronics & Repair',  email: 'rajelectronics@gmail.com',  type: 'vendor' },
    { name: 'Heritage Housekeeping Co',  email: 'heritage.hk@gmail.com',     type: 'vendor' },
    { name: 'Vijay Plumbing Services',   email: 'vijayplumbing@gmail.com',   type: 'vendor' },
    { name: 'SafeGuard Security Pvt',    email: 'safeguard@outlook.com',     type: 'vendor' },
  ];

  const EMPLOYEES = [
    { name: 'Suresh Nair',       email: 'suresh.nair@royalheritage.in',     type: 'employee' },
    { name: 'Kavita Sharma',     email: 'kavita.sharma@royalheritage.in',   type: 'employee' },
    { name: 'Mohammed Rashid',   email: 'mo.rashid@royalheritage.in',       type: 'employee' },
    { name: 'Pooja Menon',       email: 'pooja.menon@royalheritage.in',     type: 'employee' },
    { name: 'Dinesh Kumar',      email: 'dinesh.kumar@royalheritage.in',    type: 'employee' },
  ];

  const BANKS = [
    { bank_name: 'HDFC Bank',   ifsc: 'HDFC0001234' },
    { bank_name: 'ICICI Bank',  ifsc: 'ICIC0002345' },
    { bank_name: 'SBI',         ifsc: 'SBIN0003456' },
    { bank_name: 'Axis Bank',   ifsc: 'UTIB0004567' },
    { bank_name: 'Kotak Bank',  ifsc: 'KKBK0005678' },
  ];

  const VENDOR_AMOUNTS  = [250000, 500000, 750000, 1000000, 1500000, 2000000, 3000000, 5000000];
  const EMPLOYEE_SALARY = [1500000, 2000000, 2500000, 3000000, 3500000, 4000000, 6000000, 8000000];

  const allContacts = [...VENDORS, ...EMPLOYEES];
  const contactIds  = [];
  const faMap       = {};  // contactId → array of fund account ids

  // Create contacts + fund accounts
  for (let i = 0; i < allContacts.length; i++) {
    const c   = allContacts[i];
    const cId = 'cont_seed' + String(i).padStart(8, '0');
    if (!db.prepare('SELECT 1 FROM contacts WHERE id=?').get(cId)) {
      db.prepare('INSERT INTO contacts (id,merchant_id,name,email,type) VALUES (?,?,?,?,?)')
        .run(cId, merchantId, c.name, c.email, c.type);
    }
    contactIds.push(cId);
    faMap[cId] = [];

    // Bank account
    const bank  = BANKS[i % BANKS.length];
    const faId1 = 'fa_seed' + String(i * 2).padStart(8, '0');
    if (!db.prepare('SELECT 1 FROM fund_accounts WHERE id=?').get(faId1)) {
      const accNum = '10' + String(100000000 + i * 113).slice(-8);
      db.prepare(`INSERT INTO fund_accounts
        (id,contact_id,merchant_id,account_type,bank_name,account_number,ifsc,account_holder,verified)
        VALUES (?,?,?,?,?,?,?,?,1)`)
        .run(faId1, cId, merchantId, 'bank_account', bank.bank_name, accNum, bank.ifsc, c.name);
    }
    faMap[cId].push({ id: faId1, type: 'bank_account' });

    // VPA (UPI) for vendors
    if (c.type === 'vendor') {
      const faId2 = 'fa_seed' + String(i * 2 + 1).padStart(8, '0');
      const vpa   = c.name.split(' ')[0].toLowerCase() + i + '@upi';
      if (!db.prepare('SELECT 1 FROM fund_accounts WHERE id=?').get(faId2)) {
        db.prepare(`INSERT INTO fund_accounts (id,contact_id,merchant_id,account_type,vpa,verified)
          VALUES (?,?,?,?,?,1)`)
          .run(faId2, cId, merchantId, 'vpa', vpa);
      }
      faMap[cId].push({ id: faId2, type: 'vpa' });
    }
  }

  let payoutCount = 0, payoutTotal = 0;

  // Historical payouts — last 30 days
  for (let day = 29; day >= 0; day--) {
    const dayTs = now - day * 86400;

    // Vendor payments (3-5 per day)
    const vendorCount = 3 + Math.floor(Math.random() * 3);
    for (let v = 0; v < vendorCount; v++) {
      const cIdx   = Math.floor(Math.random() * VENDORS.length);
      const cId    = contactIds[cIdx];
      const fa     = faMap[cId][Math.floor(Math.random() * faMap[cId].length)];
      const amount = VENDOR_AMOUNTS[Math.floor(Math.random() * VENDOR_AMOUNTS.length)];
      const status = Math.random() > 0.03 ? 'processed' : 'failed';
      const mode   = fa.type === 'vpa' && amount <= 10_000_000 ? 'UPI' : 'IMPS';
      const pId    = 'pout_seed_v_' + day + '_' + v;
      const utr    = status === 'processed' ? ('UTR' + (dayTs * 1000 + v)) : null;

      if (!db.prepare('SELECT 1 FROM payouts WHERE id=?').get(pId)) {
        db.prepare(`INSERT INTO payouts
          (id,merchant_id,fund_account_id,contact_id,amount,currency,mode,purpose,status,
           utr,requires_approval,queued_at,processed_at,failed_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(pId, merchantId, fa.id, cId, amount, 'INR', mode, 'vendor_payment', status,
            utr, amount >= 1_000_000 ? 1 : 0, dayTs,
            status === 'processed' ? dayTs + 120 : null,
            status === 'failed'    ? dayTs + 60  : null,
            dayTs);
      }
      if (status === 'processed') { payoutCount++; payoutTotal += amount; }
    }

    // Salary (1st of month simulation — seed a few for each employee)
    if (day % 30 === 0 || day === 0) {
      for (let e = 0; e < EMPLOYEES.length; e++) {
        const cId    = contactIds[VENDORS.length + e];
        const fa     = faMap[cId][0];
        const salary = EMPLOYEE_SALARY[e % EMPLOYEE_SALARY.length];
        const pId    = 'pout_seed_s_' + day + '_' + e;
        const utr    = 'UTR' + (dayTs * 100 + e + 900);

        if (!db.prepare('SELECT 1 FROM payouts WHERE id=?').get(pId)) {
          db.prepare(`INSERT INTO payouts
            (id,merchant_id,fund_account_id,contact_id,amount,currency,mode,purpose,status,
             utr,requires_approval,approved_by,approved_at,queued_at,processed_at,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(pId, merchantId, fa.id, cId, salary, 'INR', 'NEFT', 'salary', 'processed',
              utr, 1, 'dashboard', dayTs - 300, dayTs, dayTs + 300, dayTs - 300);
        }
        payoutCount++; payoutTotal += salary;
      }
    }
  }

  // 3 pending_approval payouts (to demo maker-checker)
  for (let i = 0; i < 3; i++) {
    const cId    = contactIds[i % VENDORS.length];
    const fa     = faMap[cId][0];
    const amount = 2_000_000 + i * 500_000;
    const pId    = 'pout_pending_' + i;
    if (!db.prepare('SELECT 1 FROM payouts WHERE id=?').get(pId)) {
      db.prepare(`INSERT INTO payouts
        (id,merchant_id,fund_account_id,contact_id,amount,currency,mode,purpose,
         status,requires_approval,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(pId, merchantId, fa.id, cId, amount, 'INR', 'IMPS', 'vendor_payment',
          'pending_approval', 1, now - i * 3600);
    }
  }

  console.log(`Seeded ${contactIds.length} contacts, ${payoutCount} payouts`);
  console.log(`Total paid out: ₹${(payoutTotal / 100).toLocaleString('en-IN')}`);
}

main().catch(console.error);
