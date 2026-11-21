import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {createServer as createViteServer} from 'vite';
import {
  appendTransactionFile,
  attachEventListeners,
  calculateCityServiceBill,
  db,
  getDemoAdminUser,
  initializeDatabase,
  readStoragePreviews,
  round2,
  smartCityEvents,
  spawnBillVerificationWorker,
  spawnServiceRequestWorker,
  syncCitizensFile,
  syncTransactionsFile,
  verifyAdminLogin,
  writeSystemLog,
} from './src/server/engine.ts';

initializeDatabase();
attachEventListeners();

const app = express();
app.use(express.json({limit: '2mb'}));

// In-memory active session tokens (backed by secure server-side lookup)
const activeSessions = new Map<string, {email: string; fullName: string; role: string; issuedAt: string}>();

function createSessionToken(user: {email: string; fullName: string; role: string}): string {
  const token = crypto.randomBytes(24).toString('hex');
  activeSessions.set(token, {...user, issuedAt: new Date().toISOString()});
  return token;
}

function getSessionFromRequest(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    return activeSessions.get(token) || null;
  }
  return null;
}

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================
app.post('/api/auth/login', (req, res) => {
  const {email, password} = req.body || {};
  if (!email || !password) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Email and password are required.'});
  }
  const user = verifyAdminLogin(String(email), String(password));
  if (!user) {
    writeSystemLog('WARNING', 'AUTH_FAILED', String(email), 'Invalid administrator login attempt.');
    return res.status(401).json({error: 'AuthenticationException', message: 'Invalid email or password.'});
  }
  const token = createSessionToken(user);
  writeSystemLog('INFO', 'AUTH_LOGIN', user.email, `Administrator ${user.fullName} signed in.`);
  return res.json({token, user});
});

app.post('/api/auth/demo', (_req, res) => {
  const user = getDemoAdminUser();
  const token = createSessionToken(user);
  writeSystemLog('INFO', 'AUTH_DEMO_LOGIN', user.email, `Demo session started for ${user.fullName}.`);
  return res.json({token, user});
});

app.get('/api/auth/session', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({authenticated: false});
  }
  return res.json({authenticated: true, user: session});
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    activeSessions.delete(authHeader.slice(7).trim());
  }
  return res.json({ok: true});
});

// ============================================================================
// DASHBOARD & ANALYTICS
// ============================================================================
app.get('/api/dashboard', (_req, res) => {
  const totalCitizens = (db.prepare('SELECT COUNT(*) as cnt FROM citizens').get() as {cnt: number}).cnt;
  const totalServices = (db.prepare('SELECT COUNT(*) as cnt FROM services WHERE is_active = 1').get() as {cnt: number}).cnt;
  const totalBills = (db.prepare('SELECT COUNT(*) as cnt FROM bills').get() as {cnt: number}).cnt;
  const totalRevenue = (
    db.prepare("SELECT COALESCE(SUM(service_amount), 0) as total FROM transactions WHERE payment_status = 'SUCCESS'").get() as {
      total: number;
    }
  ).total;
  const pendingPayments = (
    db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(final_payable), 0) as amount FROM bills WHERE payment_status = 'PENDING'").get() as {
      cnt: number;
      amount: number;
    }
  );
  const completedRequests = (
    db.prepare("SELECT COUNT(*) as cnt FROM service_requests WHERE status = 'COMPLETED'").get() as {cnt: number}
  ).cnt;
  const activeRequests = (
    db.prepare("SELECT COUNT(*) as cnt FROM service_requests WHERE status IN ('PENDING', 'PROCESSING')").get() as {cnt: number}
  ).cnt;

  const revenueByService = db
    .prepare(
      `SELECT service_type as serviceType, COALESCE(SUM(service_amount), 0) as revenue, COUNT(*) as count
       FROM transactions WHERE payment_status = 'SUCCESS' GROUP BY service_type`,
    )
    .all();

  const usageByService = db
    .prepare(
      `SELECT service_type as serviceType, COALESCE(SUM(consumption), 0) as totalUnits, COUNT(*) as billCount
       FROM bills GROUP BY service_type`,
    )
    .all();

  const parkingStats = db
    .prepare(
      `SELECT COALESCE(vehicle_type, 'CAR') as vehicleType, COUNT(*) as sessions,
              COALESCE(SUM(consumption), 0) as totalHours, COALESCE(SUM(final_payable), 0) as revenue
       FROM bills WHERE service_type = 'PARKING' GROUP BY vehicle_type`,
    )
    .all();

  const monthlyRevenue = db
    .prepare(
      `SELECT substr(transaction_date, 1, 7) as month,
              COALESCE(SUM(CASE WHEN service_type = 'ELECTRICITY' THEN service_amount ELSE 0 END), 0) as electricity,
              COALESCE(SUM(CASE WHEN service_type = 'WATER' THEN service_amount ELSE 0 END), 0) as water,
              COALESCE(SUM(CASE WHEN service_type = 'PARKING' THEN service_amount ELSE 0 END), 0) as parking,
              COALESCE(SUM(service_amount), 0) as total
       FROM transactions WHERE payment_status = 'SUCCESS'
       GROUP BY substr(transaction_date, 1, 7)
       ORDER BY month ASC`,
    )
    .all();

  const recentTransactions = db.prepare('SELECT * FROM transactions ORDER BY transaction_date DESC LIMIT 6').all();
  const recentActivities = db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 8').all();
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 6').all();
  const unreadNotifications = (db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE is_read = 0').get() as {cnt: number}).cnt;

  res.json({
    kpis: {
      totalCitizens,
      totalServices,
      totalBills,
      totalRevenue: round2(totalRevenue),
      pendingPaymentsCount: pendingPayments.cnt,
      pendingPaymentsAmount: round2(pendingPayments.amount),
      completedRequests,
      activeRequests,
      unreadNotifications,
    },
    charts: {
      revenueByService,
      usageByService,
      parkingStats,
      monthlyRevenue,
    },
    recentTransactions,
    recentActivities,
    notifications,
  });
});

// ============================================================================
// CITIZEN MANAGEMENT (CRUD + Search + Filter + Pagination + History)
// ============================================================================
app.get('/api/citizens', (req, res) => {
  const search = String(req.query.search || '').trim();
  const ward = String(req.query.ward || '').trim();
  const status = String(req.query.status || '').trim();
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 8)));

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (search) {
    whereClauses.push('(lower(citizen_id) LIKE ? OR lower(name) LIKE ? OR phone_number LIKE ?)');
    const q = `%${search.toLowerCase()}%`;
    params.push(q, q, `%${search}%`);
  }
  if (ward && ward !== 'ALL') {
    whereClauses.push('ward_zone = ?');
    params.push(ward);
  }
  if (status && status !== 'ALL') {
    whereClauses.push('status = ?');
    params.push(status);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM citizens ${whereSql}`).get(...params) as {cnt: number}).cnt;
  const rows = db
    .prepare(`SELECT * FROM citizens ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);

  const wards = db.prepare('SELECT DISTINCT ward_zone FROM citizens ORDER BY ward_zone ASC').all() as Array<{ward_zone: string}>;

  res.json({
    citizens: rows,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    wards: wards.map((w) => w.ward_zone),
  });
});

app.get('/api/citizens/:id', (req, res) => {
  const citizen = db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(req.params.id);
  if (!citizen) {
    return res.status(404).json({error: 'CitizenNotFoundException', message: `Citizen record not found for ID: ${req.params.id}`});
  }
  const bills = db.prepare('SELECT * FROM bills WHERE citizen_id = ? ORDER BY invoice_date DESC').all(req.params.id);
  const transactions = db.prepare('SELECT * FROM transactions WHERE citizen_id = ? ORDER BY transaction_date DESC').all(req.params.id);
  const requests = db.prepare('SELECT * FROM service_requests WHERE citizen_id = ? ORDER BY created_at DESC').all(req.params.id);
  return res.json({citizen, bills, transactions, requests});
});

app.post('/api/citizens', (req, res) => {
  const {name, phoneNumber, email, wardZone} = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanPhone = String(phoneNumber || '').replace(/\s+/g, '');

  if (cleanName.length < 2) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Citizen name must be at least 2 characters.'});
  }
  if (!/^\+?[0-9]{10,15}$/.test(cleanPhone)) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Phone number must contain 10 to 15 digits.'});
  }

  let citizenId = '';
  for (let i = 0; i < 10; i++) {
    const candidate = `CIT-${1000 + Math.floor(Math.random() * 9000)}`;
    const exists = db.prepare('SELECT 1 FROM citizens WHERE citizen_id = ?').get(candidate);
    if (!exists) {
      citizenId = candidate;
      break;
    }
  }
  if (!citizenId) {
    citizenId = `CIT-${Date.now().toString().slice(-5)}`;
  }

  db.prepare(
    'INSERT INTO citizens (citizen_id, name, phone_number, email, ward_zone, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    citizenId,
    cleanName,
    cleanPhone,
    String(email || '').trim(),
    String(wardZone || 'Central Tech Corridor').trim() || 'Central Tech Corridor',
    'ACTIVE',
  );

  const created = db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(citizenId) as {citizen_id: string; name: string};
  syncCitizensFile();
  smartCityEvents.emit('citizen.registered', created);
  return res.status(201).json(created);
});

app.put('/api/citizens/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({error: 'CitizenNotFoundException', message: `Citizen record not found for ID: ${req.params.id}`});
  }
  const {name, phoneNumber, email, wardZone, status} = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanPhone = String(phoneNumber || '').replace(/\s+/g, '');
  if (cleanName.length < 2) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Citizen name must be at least 2 characters.'});
  }
  if (!/^\+?[0-9]{10,15}$/.test(cleanPhone)) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Phone number must contain 10 to 15 digits.'});
  }

  db.prepare('UPDATE citizens SET name = ?, phone_number = ?, email = ?, ward_zone = ?, status = ? WHERE citizen_id = ?').run(
    cleanName,
    cleanPhone,
    String(email || '').trim(),
    String(wardZone || 'Central Tech Corridor').trim(),
    String(status || 'ACTIVE').toUpperCase(),
    req.params.id,
  );
  syncCitizensFile();
  writeSystemLog('INFO', 'CITIZEN_UPDATED', 'SYSTEM_ADMIN', `Updated citizen ${req.params.id} (${cleanName})`);
  return res.json(db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(req.params.id));
});

app.delete('/api/citizens/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(req.params.id) as {name: string} | undefined;
  if (!existing) {
    return res.status(404).json({error: 'CitizenNotFoundException', message: `Citizen record not found for ID: ${req.params.id}`});
  }
  db.prepare('DELETE FROM citizens WHERE citizen_id = ?').run(req.params.id);
  syncCitizensFile();
  syncTransactionsFile();
  writeSystemLog('WARNING', 'CITIZEN_DELETED', 'SYSTEM_ADMIN', `Removed citizen ${req.params.id} (${existing.name})`);
  return res.json({deleted: true, citizenId: req.params.id});
});

// ============================================================================
// UTILITY CALCULATION & BILLING SYSTEM
// ============================================================================
app.post('/api/services/calculate', (req, res) => {
  try {
    const {serviceType, consumption, vehicleType, discountPercent} = req.body || {};
    const summary = calculateCityServiceBill(
      String(serviceType || ''),
      Number(consumption),
      vehicleType ? String(vehicleType) : null,
      Number(discountPercent || 0),
    );
    return res.json(summary);
  } catch (err: unknown) {
    const e = err as {status?: number; code?: string; message?: string};
    writeSystemLog('WARNING', 'CALCULATION_ERROR', 'BillingEngine', e.message || 'Calculation failed');
    return res.status(e.status || 400).json({error: e.code || 'InvalidInputException', message: e.message});
  }
});

app.get('/api/bills', (req, res) => {
  const status = String(req.query.status || '').trim();
  const citizenId = String(req.query.citizenId || '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (status && status !== 'ALL') {
    where.push('payment_status = ?');
    params.push(status);
  }
  if (citizenId) {
    where.push('citizen_id = ?');
    params.push(citizenId);
  }
  const sql = `SELECT * FROM bills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY invoice_date DESC`;
  return res.json(db.prepare(sql).all(...params));
});

app.post('/api/bills', (req, res) => {
  try {
    const {citizenId, serviceType, vehicleType, consumption, discountPercent} = req.body || {};
    const citizen = db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(String(citizenId || '').trim()) as
      | {citizen_id: string; name: string; phone_number: string}
      | undefined;
    if (!citizen) {
      return res.status(404).json({error: 'CitizenNotFoundException', message: `Citizen record not found for ID: ${citizenId}`});
    }

    const calc = calculateCityServiceBill(
      String(serviceType || ''),
      Number(consumption),
      vehicleType ? String(vehicleType) : null,
      Number(discountPercent || 0),
    );

    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    db.prepare(`
      INSERT INTO bills (
        invoice_number, citizen_id, citizen_name, phone_number, service_type, vehicle_type,
        consumption, base_charge, tax_amount, discount_percent, discount_amount, final_payable,
        payment_status, processing_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'QUEUED')
    `).run(
      invoiceNumber,
      citizen.citizen_id,
      citizen.name,
      citizen.phone_number,
      calc.serviceType,
      calc.vehicleType,
      calc.consumption,
      calc.baseCharge,
      calc.taxAmount,
      calc.discountPercent,
      calc.discountAmount,
      calc.finalPayable,
    );

    const bill = db.prepare('SELECT * FROM bills WHERE invoice_number = ?').get(invoiceNumber) as {
      invoice_number: string;
      citizen_name: string;
      final_payable: number;
    };
    spawnBillVerificationWorker(invoiceNumber);
    smartCityEvents.emit('bill.generated', bill);

    return res.status(201).json({...bill, slabs: calc.slabs});
  } catch (err: unknown) {
    const e = err as {status?: number; code?: string; message?: string};
    return res.status(e.status || 400).json({error: e.code || 'InvalidInputException', message: e.message});
  }
});

app.patch('/api/bills/:invoiceNumber/discount', (req, res) => {
  try {
    const bill = db.prepare('SELECT * FROM bills WHERE invoice_number = ?').get(req.params.invoiceNumber) as
      | {
          invoice_number: string;
          service_type: string;
          vehicle_type: string | null;
          consumption: number;
          payment_status: string;
        }
      | undefined;
    if (!bill) {
      return res.status(404).json({error: 'InvalidInputException', message: `Invoice ${req.params.invoiceNumber} not found.`});
    }
    if (bill.payment_status === 'PAID') {
      return res.status(400).json({error: 'InvalidPaymentException', message: 'Cannot apply discount to an already paid invoice.'});
    }
    const discountPercent = Number(req.body?.discountPercent ?? 0);
    const calc = calculateCityServiceBill(bill.service_type, bill.consumption, bill.vehicle_type, discountPercent);

    db.prepare('UPDATE bills SET discount_percent = ?, discount_amount = ?, final_payable = ? WHERE invoice_number = ?').run(
      calc.discountPercent,
      calc.discountAmount,
      calc.finalPayable,
      bill.invoice_number,
    );
    writeSystemLog('INFO', 'DISCOUNT_APPLIED', 'SYSTEM_ADMIN', `Applied ${discountPercent}% discount to ${bill.invoice_number}`);
    return res.json(db.prepare('SELECT * FROM bills WHERE invoice_number = ?').get(bill.invoice_number));
  } catch (err: unknown) {
    const e = err as {status?: number; code?: string; message?: string};
    return res.status(e.status || 400).json({error: e.code || 'InvalidInputException', message: e.message});
  }
});

app.delete('/api/bills/:invoiceNumber', (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE invoice_number = ?').get(req.params.invoiceNumber);
  if (!bill) {
    return res.status(404).json({error: 'InvalidInputException', message: 'Invoice not found.'});
  }
  db.prepare('DELETE FROM bills WHERE invoice_number = ?').run(req.params.invoiceNumber);
  syncTransactionsFile();
  return res.json({deleted: true});
});

// ============================================================================
// PAYMENT GATEWAY (UPI 0% FEE / CARD 1.5% FEE / BALANCE / INSUFFICIENT CHECK)
// ============================================================================
app.post('/api/payments/process', (req, res) => {
  const {invoiceNumber, paymentMethod, paidAmount, paymentReference} = req.body || {};
  const bill = db.prepare('SELECT * FROM bills WHERE invoice_number = ?').get(String(invoiceNumber || '').trim()) as
    | {
        invoice_number: string;
        citizen_id: string;
        citizen_name: string;
        service_type: string;
        final_payable: number;
        payment_status: string;
      }
    | undefined;

  if (!bill) {
    return res.status(404).json({error: 'InvalidPaymentException', message: `Invoice ${invoiceNumber} not found.`});
  }
  if (bill.payment_status === 'PAID') {
    return res.status(400).json({error: 'InvalidPaymentException', message: `Invoice ${invoiceNumber} has already been settled.`});
  }

  const method = String(paymentMethod || '').trim().toUpperCase();
  if (method !== 'UPI' && method !== 'CARD') {
    return res.status(400).json({error: 'InvalidPaymentException', message: 'Unsupported payment method. Select UPI or CARD.'});
  }

  const ref = String(paymentReference || '').trim();
  if (method === 'UPI') {
    if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9]{2,}$/.test(ref)) {
      writeSystemLog('WARNING', 'INVALID_PAYMENT', bill.citizen_id, `Invalid UPI ID format submitted for ${bill.invoice_number}`);
      return res.status(400).json({error: 'InvalidPaymentException', message: 'Invalid UPI ID format. Expected handle@bank (e.g. citizen@okaxis).'});
    }
  } else {
    if (ref.length < 4) {
      return res.status(400).json({error: 'InvalidPaymentException', message: 'Valid sandbox card reference is required.'});
    }
  }

  const tendered = Number(paidAmount);
  if (!Number.isFinite(tendered) || tendered <= 0) {
    return res.status(400).json({error: 'InvalidPaymentException', message: 'Paid amount must be greater than zero.'});
  }

  const serviceAmount = round2(bill.final_payable);
  const paymentFee = method === 'CARD' ? round2(serviceAmount * 0.015) : 0;
  const totalRequired = round2(serviceAmount + paymentFee);

  if (tendered < totalRequired) {
    const shortfall = round2(totalRequired - tendered);
    writeSystemLog(
      'WARNING',
      'INSUFFICIENT_PAYMENT',
      bill.citizen_id,
      `Rejected ${method} payment for ${bill.invoice_number}: required Rs. ${totalRequired.toFixed(2)}, tendered Rs. ${tendered.toFixed(2)}`,
    );
    return res.status(400).json({
      error: 'InsufficientPaymentException',
      message: `Insufficient ${method} payment. Total required (incl. fee) is Rs. ${totalRequired.toFixed(2)}, received Rs. ${tendered.toFixed(2)} (short by Rs. ${shortfall.toFixed(2)}).`,
    });
  }

  const balanceReturned = round2(tendered - totalRequired);
  const paymentId = `PAY-${Date.now().toString().slice(-8)}`;
  const transactionId = `TXN-${Date.now().toString().slice(-8)}`;

  const runTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (
        payment_id, invoice_number, citizen_id, payment_method, payment_reference,
        service_amount, payment_fee, amount_tendered, balance_returned, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUCCESS')
    `).run(paymentId, bill.invoice_number, bill.citizen_id, method, ref, serviceAmount, paymentFee, tendered, balanceReturned);

    db.prepare("UPDATE bills SET payment_status = 'PAID' WHERE invoice_number = ?").run(bill.invoice_number);

    db.prepare(`
      INSERT INTO transactions (
        transaction_id, invoice_number, citizen_id, citizen_name, service_type,
        service_amount, payment_fee, total_paid, balance_returned, payment_method, payment_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUCCESS')
    `).run(
      transactionId,
      bill.invoice_number,
      bill.citizen_id,
      bill.citizen_name,
      bill.service_type,
      serviceAmount,
      paymentFee,
      tendered,
      balanceReturned,
      method,
    );
  });

  runTx();

  const savedTx = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) as {
    transaction_id: string;
    invoice_number: string;
    citizen_id: string;
    service_type: string;
    total_paid: number;
    payment_method: string;
    payment_status: string;
  };
  appendTransactionFile(savedTx);
  smartCityEvents.emit('payment.completed', savedTx);

  return res.status(201).json(savedTx);
});

// ============================================================================
// TRANSACTIONS
// ============================================================================
app.get('/api/transactions', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const service = String(req.query.service || '').trim().toUpperCase();
  const status = String(req.query.status || '').trim().toUpperCase();
  const date = String(req.query.date || '').trim();

  const where: string[] = [];
  const params: unknown[] = [];

  if (search) {
    where.push('(lower(transaction_id) LIKE ? OR lower(invoice_number) LIKE ? OR lower(citizen_id) LIKE ? OR lower(citizen_name) LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  if (service && service !== 'ALL') {
    where.push('service_type = ?');
    params.push(service);
  }
  if (status && status !== 'ALL') {
    where.push('payment_status = ?');
    params.push(status);
  }
  if (date) {
    where.push('substr(transaction_date, 1, 10) = ?');
    params.push(date);
  }

  const sql = `SELECT * FROM transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY transaction_date DESC`;
  return res.json(db.prepare(sql).all(...params));
});

// ============================================================================
// SERVICE REQUESTS (Multithreaded Status Lifecycle)
// ============================================================================
app.get('/api/requests', (_req, res) => {
  return res.json(db.prepare('SELECT * FROM service_requests ORDER BY created_at DESC').all());
});

app.post('/api/requests', (req, res) => {
  const {citizenId, serviceCategory, description, priority} = req.body || {};
  const citizen = db.prepare('SELECT * FROM citizens WHERE citizen_id = ?').get(String(citizenId || '').trim()) as
    | {citizen_id: string; name: string}
    | undefined;
  if (!citizen) {
    return res.status(404).json({error: 'CitizenNotFoundException', message: `Citizen record not found for ID: ${citizenId}`});
  }
  const cleanDesc = String(description || '').trim();
  if (cleanDesc.length < 5) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Please provide a detailed request description (min 5 chars).'});
  }

  const requestId = `REQ-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
  const category = String(serviceCategory || 'ELECTRICITY').trim().toUpperCase();
  const prio = String(priority || 'NORMAL').trim().toUpperCase();

  db.prepare(`
    INSERT INTO service_requests (
      request_id, citizen_id, citizen_name, service_category, description, priority, status, assigned_thread
    ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'Queue-Dispatch')
  `).run(requestId, citizen.citizen_id, citizen.name, category, cleanDesc, prio);

  const created = db.prepare('SELECT * FROM service_requests WHERE request_id = ?').get(requestId) as {
    request_id: string;
    service_category: string;
    citizen_id: string;
  };
  smartCityEvents.emit('request.created', created);
  spawnServiceRequestWorker(requestId);
  return res.status(201).json(created);
});

app.patch('/api/requests/:id/status', (req, res) => {
  const {status} = req.body || {};
  const nextStatus = String(status || '').trim().toUpperCase();
  if (!['PENDING', 'PROCESSING', 'COMPLETED'].includes(nextStatus)) {
    return res.status(400).json({error: 'InvalidInputException', message: 'Status must be PENDING, PROCESSING, or COMPLETED.'});
  }
  const existing = db.prepare('SELECT * FROM service_requests WHERE request_id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({error: 'InvalidInputException', message: 'Service request not found.'});
  }
  db.prepare("UPDATE service_requests SET status = ?, updated_at = datetime('now') WHERE request_id = ?").run(nextStatus, req.params.id);
  writeSystemLog('INFO', 'REQUEST_STATUS_UPDATE', 'SYSTEM_ADMIN', `Updated ${req.params.id} status to ${nextStatus}`);
  return res.json(db.prepare('SELECT * FROM service_requests WHERE request_id = ?').get(req.params.id));
});

// ============================================================================
// NOTIFICATIONS
// ============================================================================
app.get('/api/notifications', (_req, res) => {
  return res.json(db.prepare('SELECT * FROM notifications ORDER BY id DESC').all());
});

app.patch('/api/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(Number(req.params.id));
  return res.json({ok: true});
});

app.patch('/api/notifications/read-all', (_req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1').run();
  return res.json({ok: true});
});

// ============================================================================
// REPORTS & CSV EXPORT
// ============================================================================
app.get('/api/reports/analytics', (_req, res) => {
  const monthlyRevenue = db
    .prepare(
      `SELECT substr(transaction_date, 1, 7) as month,
              COALESCE(SUM(CASE WHEN service_type = 'ELECTRICITY' THEN service_amount ELSE 0 END), 0) as electricity,
              COALESCE(SUM(CASE WHEN service_type = 'WATER' THEN service_amount ELSE 0 END), 0) as water,
              COALESCE(SUM(CASE WHEN service_type = 'PARKING' THEN service_amount ELSE 0 END), 0) as parking,
              COALESCE(SUM(service_amount), 0) as total
       FROM transactions WHERE payment_status = 'SUCCESS'
       GROUP BY substr(transaction_date, 1, 7)
       ORDER BY month ASC`,
    )
    .all();

  const serviceBreakdown = db
    .prepare(
      `SELECT service_type as serviceType,
              COUNT(*) as billCount,
              COALESCE(SUM(consumption), 0) as totalConsumption,
              COALESCE(SUM(final_payable), 0) as totalBilled,
              COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN final_payable ELSE 0 END), 0) as collectedRevenue
       FROM bills GROUP BY service_type`,
    )
    .all();

  const paymentMethods = db
    .prepare(
      `SELECT payment_method as method,
              COUNT(*) as count,
              COALESCE(SUM(service_amount), 0) as volume,
              COALESCE(SUM(payment_fee), 0) as feesCollected
       FROM transactions WHERE payment_status = 'SUCCESS' GROUP BY payment_method`,
    )
    .all();

  const citizenRegistrations = db
    .prepare(
      `SELECT ward_zone as wardZone, COUNT(*) as citizenCount
       FROM citizens GROUP BY ward_zone ORDER BY citizenCount DESC`,
    )
    .all();

  res.json({monthlyRevenue, serviceBreakdown, paymentMethods, citizenRegistrations});
});

app.get('/api/reports/export', (_req, res) => {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY transaction_date DESC').all() as Array<Record<string, unknown>>;
  const headers = [
    'transaction_id',
    'invoice_number',
    'citizen_id',
    'citizen_name',
    'service_type',
    'service_amount',
    'payment_fee',
    'total_paid',
    'balance_returned',
    'payment_method',
    'payment_status',
    'transaction_date',
  ];
  const csvLines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="smartcity_transactions_report.csv"');
  res.send(csvLines.join('\n'));
});

// ============================================================================
// JAVA OOP SOURCE INSPECTOR & COMPLETE PROJECT ZIP DOWNLOAD
// ============================================================================
function walkFiles(dir: string, baseDir: string, out: Array<{path: string; content: string}>): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, baseDir, out);
    } else {
      out.push({
        path: path.relative(baseDir, full).replace(/\\/g, '/'),
        content: fs.readFileSync(full, 'utf8'),
      });
    }
  }
}

app.get('/api/oop/files', (_req, res) => {
  const root = process.cwd();
  const javaFiles: Array<{path: string; content: string}> = [];
  walkFiles(path.join(root, 'java-backend'), root, javaFiles);

  const sqlPath = path.join(root, 'database', 'smart_city_schema.sql');
  const docsPath = path.join(root, 'docs', 'PROJECT_DOCUMENTATION.md');

  const collectionsSnapshot = {
    arrayListCitizensCount: (db.prepare('SELECT COUNT(*) as cnt FROM citizens').get() as {cnt: number}).cnt,
    hashMapServiceKeys: ['ELECTRICITY', 'WATER', 'PARKING_BIKE', 'PARKING_CAR', 'PARKING_BUS'],
    linkedListTransactionsCount: (db.prepare('SELECT COUNT(*) as cnt FROM transactions').get() as {cnt: number}).cnt,
  };

  res.json({
    javaFiles,
    sqlSchema: fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : '',
    documentation: fs.existsSync(docsPath) ? fs.readFileSync(docsPath, 'utf8') : '',
    storagePreviews: readStoragePreviews(),
    collectionsSnapshot,
  });
});

app.get('/api/export/project-zip', async (_req, res) => {
  const zip = new JSZip();
  const root = process.cwd();
  const includeDirs = ['java-backend', 'database', 'docs', 'src'];
  const includeFiles = ['README.md', 'package.json', 'server.ts', 'index.html', 'tsconfig.json', 'vite.config.ts'];

  for (const dirName of includeDirs) {
    const list: Array<{path: string; content: string}> = [];
    const targetDir = path.join(root, dirName);
    if (fs.existsSync(targetDir)) {
      const addDir = (cur: string) => {
        for (const entry of fs.readdirSync(cur, {withFileTypes: true})) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) {
            addDir(full);
          } else if (!entry.name.endsWith('.jpg') && !entry.name.endsWith('.png')) {
            list.push({path: path.relative(root, full).replace(/\\/g, '/'), content: fs.readFileSync(full, 'utf8')});
          }
        }
      };
      addDir(targetDir);
      for (const item of list) {
        zip.file(item.path, item.content);
      }
    }
  }

  for (const f of includeFiles) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      zip.file(f, fs.readFileSync(p, 'utf8'));
    }
  }

  const buffer = await zip.generateAsync({type: 'nodebuffer'});
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="SmartCityServiceManagementSystem.zip"');
  res.send(buffer);
});

// ============================================================================
// VITE MIDDLEWARE & STATIC SERVING
// ============================================================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Smart City Service Management System listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
