/**
 * server.js — Wotiko Valet Backend
 * Production-grade with retry, pending check, and full reliability layer.
 *
 * FLOW:
 *  Guest parks  → MSG1 confirm_parked → button: Retrieve Car
 *  Guest taps   → FCM to all drivers → AlarmManager → fullscreen alert
 *  Driver accept→ MSG2 retrieve → button: Cancel
 *  Driver skip  → MSG4 skip (once only, skip_notified flag)
 *  Guest cancel → MSG5 cancel → Firestore: cancelled → parked after 3s
 *  Driver deliver→ MSG6 end
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const amqp      = require('amqplib');
require('dotenv').config();

const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db  = admin.firestore();
const col = db.collection('parked_cars');
console.log('✅ Firebase Admin initialized');

// ── WhatsApp ─────────────────────────────────────────────────
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY   = process.env.WEBHOOK_VERIFY_TOKEN || 'my-verify-token';
const WA_BASE     = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
const WA_HEADERS  = () => ({
  Authorization:  `Bearer ${WA_TOKEN}`,
  'Content-Type': 'application/json',
});

// ── Constants ─────────────────────────────────────────────────
const VENUE_NAME   = 'Madras Square';
const SLOT_MINUTES = { 'A': 2, 'B': 2, 'C': 3, 'D': 4, 'E': 5, 'OTHER': 6 };
const PHRASES = [
  "Wotiko's vote is with",
  'Team Wotiko is crazy about',
  'Wotiko was wowed by',
  'Yummm! Team Wotiko loved',
  'Wotiko Team is still dreaming about',
  'The regulars here love',
  "This week's fave dish was",
  'Tira miss it already! That and',
];
const DISHES = [
  'Truffle Garlic Fried Rice',
  'Curry Butter Garlic Prawns',
  'Dragon Chicken',
  'Chicken Quesadillas',
  'Pan Seared Salmon',
  'Burrata Bruschetta',
  'Chocolate Lava Cake',
  'Smoked BBQ Ribs',
];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ── Retry system — Firestore-backed (survives server restart) ────
// FIX 1: in-memory Map was lost on server restart → driver never gets alert.
// All job state now written to Firestore 'activeJobs' collection.
// On startup we re-hydrate any pending jobs and restart their retry loops.

const JOBS_COL     = 'activeJobs';       // Firestore collection
const JOB_TIMEOUT  = 60_000;             // 60s matches Android alarm timeout
const RETRY_DELAY  = 7_000;             // resend every 7s if no ack
const MAX_RETRIES  = 3;                  // max 3 FCM sends

// In-memory set tracks which carIds have active retry timers THIS process.
// Firestore is the source of truth; this just prevents double-scheduling.
const scheduledRetries = new Set();

async function jobGet(carId) {
  const doc = await db.collection(JOBS_COL).doc(carId).get();
  return doc.exists ? doc.data() : null;
}

async function jobSet(carId, data) {
  await db.collection(JOBS_COL).doc(carId).set(data, { merge: true });
}

async function jobDelete(carId) {
  await db.collection(JOBS_COL).doc(carId).delete().catch(() => {});
  scheduledRetries.delete(carId);
}

// Re-hydrate: on startup, resume retry loops for any jobs still pending.
// WHY: server restart must not abandon in-flight jobs.
async function rehydrateJobs() {
  try {
    const snap = await db.collection(JOBS_COL)
      .where('status', '==', 'pending').get();
    if (snap.empty) { log('ℹ️', 'Jobs', 'No pending jobs to rehydrate'); return; }
    snap.docs.forEach(doc => {
      const job = doc.data();
      const age = Date.now() - (job.sentAt || 0);
      if (age < JOB_TIMEOUT) {
        log('🔄', 'Jobs', \`Rehydrating carId=\${doc.id} age=\${Math.round(age/1000)}s\`);
        scheduleRetry(doc.id);
      } else {
        // Too old — clean up
        jobDelete(doc.id).catch(() => {});
      }
    });
  } catch (e) { log('❌', 'Jobs', \`rehydrateJobs: \${e.message}\`); }
}

// ── Logging ───────────────────────────────────────────────────
function log(icon, tag, msg, meta = {}) {
  const ts   = new Date().toISOString().slice(11, 23);
  const extra = Object.keys(meta).length
    ? ' | ' + Object.entries(meta).map(([k,v]) => `${k}:${v}`).join(' ')
    : '';
  console.log(`[${ts}] ${icon} [${tag}] ${msg}${extra}`);
}

// ── Phone normalisation ───────────────────────────────────────
function normalizePhone(raw = '') {
  let p = raw.replace(/\D/g, '');
  if (p.startsWith('0'))  p = '91' + p.slice(1);
  if (p.length === 10)    p = '91' + p;
  return p;
}

// ── Firestore doc → JS object ─────────────────────────────────
function docToObj(doc) {
  const d = doc.data();
  const ts = t => t?.toDate?.()?.toISOString() ?? null;
  return {
    id:              doc.id,
    driver_name:     d.driver_name     || '',
    guest_phone:     d.guest_phone     || '',
    vehicle_number:  d.vehicle_number  || '',
    parking_area:    d.parking_area    || '',
    parking_detail:  d.parking_detail  || '',
    status:          d.status          || '',
    otp:             d.otp             ?? null,
    skip_notified:   d.skip_notified   || false,
    Entry_time:      ts(d.Entry_time),
    parked_time:     ts(d.parked_time),
    Retrieve_request_time: ts(d.Retrieve_request_time),
    handover_time:   ts(d.handover_time),
    exited_time:     ts(d.exited_time),
    parked_time:     d.parked_time
      ? { iso: ts(d.parked_time), human: d.parked_time.toDate().toLocaleString('en-IN') }
      : null,
  };
}

// ── RabbitMQ ──────────────────────────────────────────────────
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const QUEUES = { CONFIRM: 'confirm_parked', RETRIEVE: 'retrieve', SKIP: 'skip', CANCEL: 'cancel', END: 'end' };
let channel = null;

async function connectRabbitMQ() {
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    channel    = await conn.createChannel();
    for (const q of Object.values(QUEUES)) await channel.assertQueue(q, { durable: true });
    log('🐇', 'RabbitMQ', 'Connected', { queues: Object.values(QUEUES).join(',') });
    setupConsumers();
  } catch (e) {
    log('❌', 'RabbitMQ', `Connect failed — retry in 5s: ${e.message}`);
    setTimeout(connectRabbitMQ, 5000);
  }
}

function publish(queue, payload) {
  if (!channel) { log('⚠️', 'RabbitMQ', 'No channel — skipping publish', { queue }); return false; }
  try {
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true });
    return true;
  } catch (e) {
    log('❌', 'RabbitMQ', `Publish failed: ${e.message}`, { queue });
    return false;
  }
}

function setupConsumers() {
  if (!channel) return;

  // CONFIRM: MSG1 — park confirmed
  channel.consume(QUEUES.CONFIRM, async (msg) => {
    if (!msg) return;
    const j = JSON.parse(msg.content.toString());
    channel.ack(msg);
    try {
      await sendTemplate(j.phone, 'confirm_parked', [
        j.carNumber, VENUE_NAME, j.driverName, String(j.slotMins),
      ]);
      log('✅', 'MSG1', `confirm_parked → ${j.phone}`, { car: j.carNumber });
    } catch (e) { log('❌', 'MSG1', e.message); }
  });

  // RETRIEVE: MSG2 — retrieve coming
  channel.consume(QUEUES.RETRIEVE, async (msg) => {
    if (!msg) return;
    const j = JSON.parse(msg.content.toString());
    channel.ack(msg);
    try {
      await sendTemplate(j.phone, 'retrieve', [j.driverName, String(j.slotMins)]);
      log('✅', 'MSG2', `retrieve → ${j.phone}`, { driver: j.driverName });
    } catch (e) { log('❌', 'MSG2', e.message); }
  });

  // SKIP: MSG4
  channel.consume(QUEUES.SKIP, async (msg) => {
    if (!msg) return;
    const j = JSON.parse(msg.content.toString());
    channel.ack(msg);
    try {
      await sendTemplate(j.phone, 'skip', [String(j.slotMins)]);
      log('✅', 'MSG4', `skip → ${j.phone}`);
    } catch (e) { log('❌', 'MSG4', e.message); }
  });

  // CANCEL: MSG5
  channel.consume(QUEUES.CANCEL, async (msg) => {
    if (!msg) return;
    const j = JSON.parse(msg.content.toString());
    channel.ack(msg);
    try {
      await sendTemplate(j.phone, 'cancel', [j.carNumber]);
      log('✅', 'MSG5', `cancel → ${j.phone}`, { car: j.carNumber });
    } catch (e) { log('❌', 'MSG5', e.message); }
  });

  // END: MSG6
  channel.consume(QUEUES.END, async (msg) => {
    if (!msg) return;
    const j = JSON.parse(msg.content.toString());
    channel.ack(msg);
    try {
      await sendTemplate(j.phone, 'end', [j.carNumber, VENUE_NAME, j.phrase, j.dish]);
      log('✅', 'MSG6', `end → ${j.phone}`, { car: j.carNumber });
    } catch (e) { log('❌', 'MSG6', e.message); }
  });
}

// ── WhatsApp template sender ──────────────────────────────────
async function sendTemplate(phone, templateName, bodyParams = []) {
  const body = {
    messaging_product: 'whatsapp',
    to:                phone,
    type:              'template',
    template: {
      name:     templateName,
      language: { code: 'en' },
      components: bodyParams.length ? [{
        type:       'body',
        parameters: bodyParams.map(p => ({ type: 'text', text: String(p) })),
      }] : [],
    },
  };
  const res = await axios.post(WA_BASE, body, { headers: WA_HEADERS() });
  return res.data;
}

// ── FCM send (data-only, high priority) ──────────────────────
async function sendFCMNotification(carNumber, carId, wing = '') {
  try {
    // PROBLEM 8: Send only to ONLINE drivers — skip offline/absent ones.
    // Drivers offline > 5min: likely asleep, FCM wakes but alarm won't show well.
    // This prevents wasting retry budget on dead devices.
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const snap = await db.collection('drivers').get();
    const tokens = snap.docs
      .filter(d => {
        const data = d.data();
        if (!data.fcmToken) return false;
        // Include if: online=true OR lastSeen within 5 min OR no presence data (older drivers)
        if (data.online === true) return true;
        const lastSeen = data.lastSeen?.toMillis?.() || 0;
        if (lastSeen > fiveMinAgo) return true;
        if (!data.lastSeen && data.online === undefined) return true; // no presence = include
        log('⏭️', 'FCM', `Skipping offline driver ${d.id}`);
        return false;
      })
      .map(d => d.data().fcmToken);

    if (!tokens.length) { log('⚠️', 'FCM', 'No online driver tokens'); return; }

    const res = await admin.messaging().sendEachForMulticast({
      // DATA-ONLY payload — ensures onMessageReceived() fires even when app killed
      // notification block intentionally omitted — native Kotlin service owns the UI
      data: {
        type:      'retrieve_requested',
        carNumber: String(carNumber),
        carId:     String(carId),
        wing:      String(wing || ''),
      },
      android: {
        priority:    'high',      // CRITICAL — wakes device from Doze/Idle
        ttl:         60000,       // 60s TTL — matches our job timeout
        // GAP 8 FIX: collapseKey = only latest FCM for same car reaches device
        // Without this: 3 retries → 3 alarm rings simultaneously on device
        // With this: Android coalesces to 1 delivery, device sees latest only
        collapseKey: `retrieve_${carId}`,
        restrictedPackageName: 'com.example.frontend',
      },
      apns: {
        headers: {
          'apns-priority':  '10',
          'apns-push-type': 'background',
          'apns-collapse-id': `retrieve_${carId}`,  // iOS equivalent of collapseKey
        },
        payload: { aps: { 'content-available': 1 } },
      },
      tokens,
    });

    log('📲', 'FCM', 'Push sent', {
      success: `${res.successCount}/${tokens.length}`,
      vehicle: carNumber,
      wing: wing || 'none',
    });

    // Auto-delete invalid tokens
    const batch = db.batch();
    let hadInvalid = false;
    const allDrivers = await db.collection('drivers').get();
    res.responses.forEach((r, i) => {
      if (!r.success) {
        log('❌', 'FCM', 'Token failed', { error: r.error?.code });
        if (r.error?.code === 'messaging/registration-token-not-registered' ||
            r.error?.code === 'messaging/invalid-registration-token') {
          allDrivers.docs.forEach(doc => {
            if (doc.data().fcmToken === tokens[i]) {
              batch.update(doc.ref, { fcmToken: admin.firestore.FieldValue.delete() });
              hadInvalid = true;
            }
          });
        }
      }
    });
    if (hadInvalid) await batch.commit();

  } catch (e) {
    log('❌', 'FCM', `sendFCMNotification failed: ${e.message}`);
  }
}

// ── FCM cancel (retrieve done) ────────────────────────────────
async function sendFCMCancel(carId, type = 'retrieve_cancelled') {
  try {
    const snap   = await db.collection('drivers').get();
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) return;

    await admin.messaging().sendEachForMulticast({
      data:    { type, carId: String(carId) },
      android: { priority: 'high', ttl: 30000 },
      tokens,
    });
    log('📲', 'FCM', `Cancel sent type=${type}`, { carId });
  } catch (e) {
    log('❌', 'FCM', `sendFCMCancel failed: ${e.message}`);
  }
}

// ── Retry scheduler (Firestore-backed) ───────────────────────
function scheduleRetry(carId) {
  // Prevent double-scheduling in same process
  if (scheduledRetries.has(carId)) return;
  scheduledRetries.add(carId);

  setTimeout(async () => {
    scheduledRetries.delete(carId);
    const job = await jobGet(carId);
    if (!job || job.status !== 'pending') {
      await jobDelete(carId);
      return;
    }
    // PROBLEM 2: Do NOT stop retries on ACK.
    // ACK = device received message. Retries stop ONLY on accept/skip.
    // Log acked drivers count for monitoring.
    if (job.ackedCount > 0) {
      log('ℹ️', 'Retry', `carId=${carId} acked by ${job.ackedCount} device(s) — still retrying until action`);
    }
    if (job.retryCount >= MAX_RETRIES || Date.now() - job.sentAt > JOB_TIMEOUT) {
      log('⏰', 'Retry', `Expired carId=${carId} retries=${job.retryCount}`);
      await jobDelete(carId);
      await db.collection('parked_cars').doc(carId)
        .update({ status: 'timed_out' }).catch(() => {});
      await sendFCMCancel(carId, 'retrieve_cancelled');
      return;
    }
    const newCount = (job.retryCount || 0) + 1;
    await jobSet(carId, { retryCount: newCount });
    // PROBLEM 3: Fallback retry — if FCM delivery was uncertain,
    // retrying ensures at least one delivery reaches the device.
    log('🔄', 'Retry', `FCM fallback retry carId=${carId} attempt=${newCount}/${MAX_RETRIES}`);
    await sendFCMNotification(job.carNumber, carId, job.wing);
    scheduleRetry(carId);
  }, RETRY_DELAY);
}

// ── WhatsApp webhook handlers ─────────────────────────────────
async function handleRetrieveCar(guestPhone) {
  try {
    const snap = await col
      .where('guest_phone', 'in', [guestPhone, '0' + guestPhone.slice(2)])
      .where('status', 'in', ['parked', 'cancelled'])
      .orderBy('parked_time', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      log('⚠️', 'Retrieve', 'No parked car found', { phone: guestPhone });
      return;
    }
    const doc  = snap.docs[0];
    const data = doc.data();
    const carId     = doc.id;
    const carNumber = data.vehicle_number || '';
    const wing      = data.parking_detail || '';

    await col.doc(carId).update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
      skip_notified:         false,
    });

    // Persist job to Firestore (survives server restart)
    const job = { carNumber, wing, sentAt: Date.now(), retryCount: 0, status: 'pending' };
    await jobSet(carId, job);

    await sendFCMNotification(carNumber, carId, wing);
    scheduleRetry(carId);

    log('✅', 'Retrieve', `retrieve_requested carId=${carId}`, { car: carNumber, wing });
  } catch (e) {
    log('❌', 'Retrieve', e.message);
  }
}

async function handleCancelRetrieval(guestPhone) {
  try {
    const snap = await col
      .where('guest_phone', 'in', [guestPhone, '0' + guestPhone.slice(2)])
      .where('status', 'in', ['retrieve_requested', 'accepted'])
      .orderBy('Retrieve_request_time', 'desc')
      .limit(1)
      .get();

    if (snap.empty) { log('⚠️', 'Cancel', 'No active retrieve', { phone: guestPhone }); return; }

    const doc     = snap.docs[0];
    const carId   = doc.id;
    const carData = doc.data();

    // Clear job from Firestore — stops retry on any server instance
    await jobDelete(carId);

    await col.doc(carId).update({ status: 'cancelled' });

    // Send cancel FCM to all drivers → phones stop ringing
    await sendFCMCancel(carId, 'retrieve_cancelled');

    // Send MSG5 cancel WhatsApp
    const phone = normalizePhone(carData.guest_phone || guestPhone);
    const queued = publish(QUEUES.CANCEL, { phone, carNumber: carData.vehicle_number });
    if (!queued) await sendTemplate(phone, 'cancel', [carData.vehicle_number || '']);

    // Reset to parked after 3s
    setTimeout(async () => {
      try {
        const current = await col.doc(carId).get();
        if (current.data()?.status === 'cancelled') {
          await col.doc(carId).update({ status: 'parked' });
          log('🔄', 'Cancel', `Reset to parked carId=${carId}`);
        }
      } catch (_) {}
    }, 3000);

    log('✅', 'Cancel', `Cancelled carId=${carId}`, { car: carData.vehicle_number });
  } catch (e) {
    log('❌', 'Cancel', e.message);
  }
}

// ── Express setup ─────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev', {
  skip: req => req.path === '/health',
}));

// Block common attack paths
app.use((req, res, next) => {
  const blocked = ['.env', 'wp-admin', '.git', 'phpMyAdmin', 'config.php'];
  if (blocked.some(b => req.path.includes(b))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// API key auth
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'wotiko_xK9mP3qR7vL2';
app.use((req, res, next) => {
  // Whitelist webhook (Meta doesn't send our key)
  if (req.path === '/webhook' || req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (key !== API_SECRET_KEY) {
    log('🚫', 'Auth', `Invalid key path=${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true });
app.use('/api/', apiLimiter);

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ status: 'OK', service: 'Wotiko Valet Backend', ts: new Date().toISOString() }));

// ── Driver login / token save ─────────────────────────────────
app.post('/api/driver/login', async (req, res) => {
  const { uid, name, phone, fcmToken } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  try {
    await db.collection('drivers').doc(uid).set(
      { uid, name: name || '', phone: phone || '', fcmToken: fcmToken || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    log('✅', 'Driver', `Login uid=${uid}`, { name });
    res.json({ success: true });
  } catch (e) {
    log('❌', 'Driver', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Parking: get all ─────────────────────────────────────────
app.get('/api/parking/all', async (req, res) => {
  try {
    const snap = await col.get();
    const data = snap.docs
      .map(docToObj)
      .sort((a, b) =>
        (b.parked_time?.iso ?? '').localeCompare(a.parked_time?.iso ?? ''));
    res.json({ success: true, total: data.length, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Parking: pending (failsafe recovery endpoint) ────────────
// Called by Flutter on app open via PendingRequestsChecker.kt
// FIX 6: returns LIST of pending jobs not just 1 — multiple jobs possible
app.get('/api/parking/pending', async (req, res) => {
  const driverUid = req.query.driverUid;
  if (!driverUid) return res.status(400).json({ error: 'driverUid required' });

  try {
    const snap = await col
      .where('status', '==', 'retrieve_requested')
      .orderBy('Retrieve_request_time', 'desc')
      .limit(5)   // FIX 6: up to 5 pending jobs, not just 1
      .get();

    if (snap.empty) return res.json({ hasPending: false, jobs: [] });

    const now  = Date.now();
    const jobs = snap.docs
      .map(doc => {
        const d    = doc.data();
        const reqT = d.Retrieve_request_time?.toMillis?.() || 0;
        return { carId: doc.id, carNumber: d.vehicle_number || '', wing: d.parking_detail || '', ageMs: now - reqT };
      })
      .filter(j => j.ageMs < 60_000);  // only surface jobs < 60s old

    if (!jobs.length) return res.json({ hasPending: false, jobs: [] });

    log('📋', 'Pending', `Found ${jobs.length} pending job(s) for driverUid=${driverUid}`);
    // Return first job as primary (app handles one at a time)
    res.json({
      hasPending: true,
      carId:      jobs[0].carId,
      carNumber:  jobs[0].carNumber,
      wing:       jobs[0].wing,
      jobs,       // full list — client can handle multiple if needed
    });
  } catch (e) {
    log('❌', 'Pending', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Parking: get by id ────────────────────────────────────────
app.get('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: docToObj(doc) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Parking: park a car ───────────────────────────────────────
app.post('/api/parking/park', async (req, res) => {
  const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
  if (!driver_name || !guest_phone || !vehicle_number || !parking_area)
    return res.status(400).json({ success: false, error: 'Missing required fields' });

  try {
    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = await col.add({
      driver_name,
      guest_phone,
      vehicle_number:        vehicle_number.toUpperCase(),
      parking_area:          parking_area.toUpperCase(),
      parking_detail:        parking_detail || '',
      status:                'parked',
      skip_notified:         false,
      Entry_time:            now,
      parked_time:           now,
      Retrieve_request_time: null,
      handover_time:         null,
    });

    const phone      = normalizePhone(guest_phone);
    const area       = parking_area.toUpperCase();
    const slotMins   = SLOT_MINUTES[area] ?? 5;

    // MSG1: confirm_parked via RabbitMQ (or direct fallback)
    const queued = publish(QUEUES.CONFIRM, {
      phone, carNumber: vehicle_number.toUpperCase(),
      driverName: driver_name, slotMins,
    });
    if (!queued) {
      await sendTemplate(phone, 'confirm_parked', [
        vehicle_number.toUpperCase(), VENUE_NAME, driver_name, String(slotMins),
      ]);
    }

    log('✅', 'Park', `Parked docId=${ref.id}`, { car: vehicle_number, area });
    res.json({ success: true, docId: ref.id });
  } catch (e) {
    log('❌', 'Park', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Parking: update status ────────────────────────────────────
app.patch('/api/parking/:id/status', async (req, res) => {
  const { status } = req.body;
  const carId = req.params.id;
  const valid  = ['parked', 'retrieve_requested', 'accepted', 'delivered', 'cancelled'];
  if (!valid.includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });

  try {
    const ref = col.doc(carId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });

    // Clear Firestore job → stops retry loop on all server instances
    if (['accepted', 'delivered', 'cancelled'].includes(status)) {
      await jobDelete(carId);
      log('🛑', 'Retry', `Loop stopped carId=${carId} status=${status}`);
    }

    // GAP 9 FIX: idempotent status update — prevent duplicate accept
    // If status is already accepted/delivered, return 409 so client treats it as success
    const currentStatus = doc.data().status;
    if (status === 'accepted' && currentStatus === 'accepted') {
      log('ℹ️', 'Status', `carId=${carId} already accepted — idempotent 409`);
      return res.status(409).json({ success: false, error: 'Already accepted', idempotent: true });
    }
    if (status === 'delivered' && currentStatus === 'delivered') {
      return res.status(409).json({ success: false, error: 'Already delivered', idempotent: true });
    }

    const update = { status };
    if (status === 'accepted') {
      update.accepted_time = admin.firestore.FieldValue.serverTimestamp();
    }
    if (status === 'delivered') {
      const now = admin.firestore.FieldValue.serverTimestamp();
      update.handover_time = now;
      update.exited_time   = now;
      const rtMs = doc.data().Retrieve_request_time?.toMillis?.();
      if (rtMs) {
        update.Retrieve_time = `${Math.round((Date.now() - rtMs) / 1000)}s`;
      }
    }

    await ref.update(update);
    log('✅', 'Status', `carId=${carId} → ${status}`);

    // FIX MSG6: Flutter calls PATCH delivered — send WhatsApp end message here too
    // /deliver-car also sends MSG6, but Flutter may call PATCH instead
    // Both paths now send MSG6 so guest always receives final message
    if (status === 'delivered') {
      const guestPhone = doc.data().guest_phone || '';
      const carNumber  = doc.data().vehicle_number || '';
      if (guestPhone) {
        const nPhone = normalizePhone(guestPhone);
        const phrase = pick(PHRASES);
        const dish   = pick(DISHES);
        const queued = publish(QUEUES.END, { phone: nPhone, carNumber, phrase, dish });
        if (!queued) {
          sendTemplate(nPhone, 'end', [carNumber, VENUE_NAME, phrase, dish])
            .catch(e => log('❌', 'MSG6', `PATCH deliver MSG6 failed: ${e.message}`));
        }
        log('✅', 'MSG6', `Sent via PATCH delivered → ${nPhone}`, { car: carNumber });
      }
    }

    // PROBLEM 5: On accept — cancel all other drivers immediately
    // Send retrieve_accepted FCM to ALL drivers so their alarms stop ringing
    if (status === 'accepted') {
      sendFCMCancel(carId, 'retrieve_accepted').catch(e =>
        log('⚠️', 'Cancel', `FCM cancel failed: ${e.message}`)
      );
      // Clear Firestore job — no more retries
      await jobDelete(carId).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) {
    log('❌', 'Status', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Skip car ──────────────────────────────────────────────────
// Only sends MSG4 ONCE per car (skip_notified flag prevents duplicates)
app.post('/skip-car', async (req, res) => {
  const { docId } = req.body;
  if (!docId) return res.status(400).json({ error: 'docId required' });

  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Car not found' });
    const data = doc.data();

    if (data.skip_notified === true) {
      log('ℹ️', 'Skip', `Already notified docId=${docId}`);
      return res.json({ success: true, alreadyNotified: true });
    }

    // Clear Firestore job — stops retry loop
    await jobDelete(docId);

    // Mark immediately (prevents race condition with multiple drivers)
    await col.doc(docId).update({ skip_notified: true });

    const phone    = normalizePhone(data.guest_phone || '');
    const area     = (data.parking_area || 'A').toUpperCase();
    const slotMins = SLOT_MINUTES[area] ?? 5;
    const waitMins = slotMins + slotMins;

    if (phone) {
      // Send directly — no queue for time-sensitive skip message
      await sendTemplate(phone, 'skip', [String(waitMins)]);
      log('✅', 'Skip', `MSG4 → ${phone} wait=${waitMins}min`);
    }

    res.json({ success: true });
  } catch (e) {
    log('❌', 'Skip', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Deliver car ───────────────────────────────────────────────
app.post('/deliver-car', async (req, res) => {
  const { phone, docId } = req.body;
  if (!phone || !docId) return res.status(400).json({ error: 'phone and docId required' });

  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Car not found' });
    const carNumber = doc.data().vehicle_number || '';
    const phrase    = pick(PHRASES);
    const dish      = pick(DISHES);

    const nPhone = normalizePhone(phone);
    const queued  = publish(QUEUES.END, { phone: nPhone, carNumber, phrase, dish });
    if (!queued) {
      await sendTemplate(nPhone, 'end', [carNumber, VENUE_NAME, phrase, dish]);
    }

    await col.doc(docId).update({
      status:       'delivered',
      handover_time: admin.firestore.FieldValue.serverTimestamp(),
      exited_time:  admin.firestore.FieldValue.serverTimestamp(),
    });

    log('✅', 'Deliver', `MSG6 → ${nPhone}`, { car: carNumber });
    res.json({ success: true });
  } catch (e) {
    log('❌', 'Deliver', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Check vehicle (for retrieve flow validation) ──────────────
app.post('/check-vehicle', async (req, res) => {
  const { vehicle_number } = req.body;
  if (!vehicle_number) return res.status(400).json({ error: 'vehicle_number required' });

  try {
    const snap = await col
      .where('vehicle_number', '==', vehicle_number.toUpperCase())
      .where('status', 'in', ['parked', 'retrieve_requested', 'accepted'])
      .limit(1)
      .get();

    if (snap.empty) return res.json({ found: false });

    const doc  = snap.docs[0];
    const data = doc.data();
    res.json({
      found:          true,
      docId:          doc.id,
      vehicle_number: data.vehicle_number,
      parking_area:   data.parking_area,
      parking_detail: data.parking_detail,
      status:         data.status,
      driver_name:    data.driver_name,
    });
  } catch (e) {
    log('❌', 'CheckVehicle', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FIX 2: Device acknowledgement ────────────────────────────
// Android calls this immediately on FCM receipt to tell server
// "I got the message, stop retrying". This cuts unnecessary retries.
// GAP 7 FIX: rate-limited — prevents retry cancellation abuse.
const ackLimiter = rateLimit({ windowMs: 10_000, max: 20, standardHeaders: true });
app.post('/api/ack', ackLimiter, async (req, res) => {
  const { carId, driverUid } = req.body;
  if (!carId) return res.status(400).json({ error: 'carId required' });

  try {
    const job = await jobGet(carId);
    if (job && job.status === 'pending') {
      // PROBLEM 1+2: Log ACK for delivery verification but DO NOT stop retry loop.
      // ACK = device received FCM. Retry stops ONLY on accept/skip.
      // If we stopped retries on ACK: only 1 driver gets FCM, others never ring.
      await jobSet(carId, {
        ackedCount: (job.ackedCount || 0) + 1,
        lastAckedAt: Date.now(),
        lastAckedBy: driverUid || 'unknown',
      });
      log('📬', 'Ack', `carId=${carId} acked by ${driverUid} — retries CONTINUE until accept/skip`);
    }
    res.json({ success: true });
  } catch (e) {
    log('❌', 'Ack', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── WhatsApp webhook ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    log('✅', 'Webhook', 'Verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => processWebhook(req.body));
});

async function processWebhook(body) {
  try {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    log('📨', 'Webhook', `${msg.type} from ${from}`);

    if (msg.type === 'button') {
      const text = (msg.button?.text || '').toLowerCase();
      if (text.includes('retrieve') && !text.includes('cancel')) {
        await handleRetrieveCar(from);
      } else if (text.includes('cancel')) {
        await handleCancelRetrieval(from);
      }
      return;
    }

    if (msg.type === 'interactive') {
      const id = msg.interactive?.button_reply?.id || '';
      if (id === 'retrieve_car')    await handleRetrieveCar(from);
      else if (id === 'cancel_car') await handleCancelRetrieval(from);
    }
  } catch (e) {
    log('❌', 'Webhook', e.message);
  }
}

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  log('❌', 'UnhandledError', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
  log('🏨', 'Server', `Wotiko Valet Backend running on port ${PORT}`);
  log('📋', 'Routes', 'GET /health | POST /api/driver/login | GET /api/parking/all');
  log('📋', 'Routes', 'GET /api/parking/pending | POST /api/parking/park | PATCH /api/parking/:id/status');
  log('📋', 'Routes', 'POST /skip-car | POST /deliver-car | POST /check-vehicle');
  log('📋', 'Routes', 'GET+POST /webhook');
});

connectRabbitMQ();

// FIX 1: Rehydrate Firestore jobs on startup
// Any pending jobs from before server restart get their retry loops resumed
rehydrateJobs().catch(e => log('❌', 'Startup', `rehydrateJobs failed: ${e.message}`));
