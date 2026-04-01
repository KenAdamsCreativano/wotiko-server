/**
 * server.js — Wotiko Valet Backend + WhatsApp Bot
 *
 * EXACT MESSAGE FLOW:
 *
 *   MSG 1 → template: confirm_parked  [carNumber, location, driverName, slotMins]
 *     WHO:  Flutter → after driver taps Add Car + Firestore saved
 *     HAS:  "Retrieve Car" quick-reply button
 *
 *   MSG 2 → plain text OTP  (SERVER sends automatically)
 *     WHO:  Server → when guest taps "Retrieve Car" in WhatsApp
 *     TEXT: "On it! ...less than X mins... code: OTP"
 *     ALSO: Firestore → retrieve_requested + FCM push to driver
 *
 *   [Accept → CarDetailsScreen — NO message]
 *   [Verify → /get-otp returns circles — NO message]
 *
 *   MSG 3 → template: test_end  [carNumber]
 *     WHO:  Server → when driver taps Deliver with correct OTP
 *
 * SECURITY:
 *   - API key on all routes except /webhook and /
 *   - Rate limiting 100 req / 15 min per IP
 *   - Helmet HTTP headers
 *   - Attack path blocking
 */

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const amqp      = require('amqplib');
require('dotenv').config();

// ── Firebase ──────────────────────────────────────────────────
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

// ── WhatsApp ──────────────────────────────────────────────────
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY   = process.env.WEBHOOK_VERIFY_TOKEN || 'my-verify-token';
const WA_BASE     = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
const WA_HEADERS  = () => ({
  Authorization:  `Bearer ${WA_TOKEN}`,
  'Content-Type': 'application/json',
});

const VENUE_NAME   = 'Wotiko Valet';
const SLOT_MINUTES = { 'A': 2, 'B': 2, 'C': 3, 'D': 4, 'E': 5, 'OTHER': 6 };

// ── Farewell template ────────────────────────────────────────
// Template: test_end
// {{1}}=carNumber only

// ─────────────────────────────────────────────────────────────
// RABBITMQ
// ─────────────────────────────────────────────────────────────
let mqChannel = null;

const QUEUES = {
  PARKED:    'whatsapp.parked',
  OTP:       'whatsapp.otp',
  DELIVERED: 'whatsapp.delivered',
  WRONG_OTP: 'whatsapp.wrong_otp',
  FCM:       'fcm.notify',
};

async function connectRabbitMQ() {
  try {
    const conn = await amqp.connect('amqp://localhost');
    mqChannel  = await conn.createChannel();
    for (const q of Object.values(QUEUES)) {
      await mqChannel.assertQueue(q, { durable: true });
    }
    conn.on('error', (err) => { console.error('❌ RabbitMQ error:', err.message); mqChannel = null; });
    conn.on('close', ()    => { console.warn('⚠️ RabbitMQ closed — reconnecting in 5s'); mqChannel = null; setTimeout(connectRabbitMQ, 5000); });
    console.log('✅ RabbitMQ connected — queues ready');
    startWorkers();
  } catch (err) {
    console.warn(`⚠️ RabbitMQ unavailable (${err.message}) — running in direct mode`);
    mqChannel = null;
  }
}

function publish(queue, payload) {
  if (!mqChannel) return false;
  try {
    mqChannel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true });
    return true;
  } catch (err) {
    console.error(`❌ publish to ${queue} failed:`, err.message);
    return false;
  }
}

function retryJob(queue, content, headers, retryCount, delayMs) {
  if (!mqChannel) return;
  setTimeout(() => {
    try {
      mqChannel.sendToQueue(queue, content, {
        persistent: true,
        headers: { 'x-retry-count': retryCount + 1 },
      });
    } catch (err) {
      console.error(`❌ retry to ${queue} failed:`, err.message);
    }
  }, delayMs);
}

async function saveFailed(type, job, reason) {
  try {
    await db.collection('failed_messages').add({
      type, job, reason,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.error(`💀 Saved failed job | type:${type}`);
  } catch (err) {
    console.error('❌ Could not save failed job:', err.message);
  }
}

function startWorkers() {
  if (!mqChannel) return;

  // MSG 1: confirm_parked
  mqChannel.consume(QUEUES.PARKED, async (msg) => {
    if (!msg) return;
    const job     = JSON.parse(msg.content.toString());
    const retries = msg.properties.headers?.['x-retry-count'] || 0;
    try {
      await sendTemplateMessage(job.phone, 'confirm_parked', [
        job.carNumber, 'Madras Square, Chennai', job.driverName, String(job.slotMins),
      ]);
      console.log(`✅ [Q] MSG 1 sent | ${job.phone}`);
      mqChannel.ack(msg);
    } catch (err) {
      console.error(`❌ [Q] MSG 1 failed attempt ${retries + 1} | ${err.message}`);
      if (retries < 3) retryJob(QUEUES.PARKED, msg.content, msg.properties.headers, retries, 30000);
      else await saveFailed('whatsapp.parked', job, err.message);
      mqChannel.ack(msg);
    }
  }, { noAck: false });

  // MSG 2: OTP plain text
  mqChannel.consume(QUEUES.OTP, async (msg) => {
    if (!msg) return;
    const job     = JSON.parse(msg.content.toString());
    const retries = msg.properties.headers?.['x-retry-count'] || 0;
    try {
      const text =
        `On it!
` +
        `Your car should be at the main entrance in less than ${job.slotMins} mins.

` +
        `Share this code with the driver who brings your car:
*${job.otp}*

` +
        `If your car is waiting for more than 10 minutes at the portico, ` +
        `we will repark the car closeby to keep the portico clear.`;
      await sendTextMessage(job.phone, text);
      console.log(`✅ [Q] MSG 2 OTP sent | ${job.phone} | ${job.otp}`);
      mqChannel.ack(msg);
    } catch (err) {
      console.error(`❌ [Q] MSG 2 failed attempt ${retries + 1} | ${err.message}`);
      if (retries < 5) retryJob(QUEUES.OTP, msg.content, msg.properties.headers, retries, 30000);
      else await saveFailed('whatsapp.otp', job, err.message);
      mqChannel.ack(msg);
    }
  }, { noAck: false });

  // MSG 3: test_end template
  mqChannel.consume(QUEUES.DELIVERED, async (msg) => {
    if (!msg) return;
    const job     = JSON.parse(msg.content.toString());
    const retries = msg.properties.headers?.['x-retry-count'] || 0;
    try {
      await sendTemplateMessage(job.phone, 'test_end', [job.carNumber]);
      console.log(`✅ [Q] MSG 3 delivered sent | ${job.phone}`);
      mqChannel.ack(msg);
    } catch (err) {
      console.error(`❌ [Q] MSG 3 failed attempt ${retries + 1} | ${err.message}`);
      if (retries < 3) retryJob(QUEUES.DELIVERED, msg.content, msg.properties.headers, retries, 30000);
      else await saveFailed('whatsapp.delivered', job, err.message);
      mqChannel.ack(msg);
    }
  }, { noAck: false });

  // Wrong OTP plain text
  mqChannel.consume(QUEUES.WRONG_OTP, async (msg) => {
    if (!msg) return;
    const job     = JSON.parse(msg.content.toString());
    const retries = msg.properties.headers?.['x-retry-count'] || 0;
    try {
      const text =
        `Looks like the code was entered incorrectly.

` +
        `Please share this updated code with the driver:
*${job.otp}*`;
      await sendTextMessage(job.phone, text);
      console.log(`✅ [Q] Wrong OTP sent | ${job.phone} | ${job.otp}`);
      mqChannel.ack(msg);
    } catch (err) {
      console.error(`❌ [Q] Wrong OTP failed attempt ${retries + 1} | ${err.message}`);
      if (retries < 2) retryJob(QUEUES.WRONG_OTP, msg.content, msg.properties.headers, retries, 15000);
      else await saveFailed('whatsapp.wrong_otp', job, err.message);
      mqChannel.ack(msg);
    }
  }, { noAck: false });

  // FCM push
  mqChannel.consume(QUEUES.FCM, async (msg) => {
    if (!msg) return;
    const job     = JSON.parse(msg.content.toString());
    const retries = msg.properties.headers?.['x-retry-count'] || 0;
    try {
      await sendFCMNotification(job.carNumber, job.carId);
      console.log(`✅ [Q] FCM sent | ${job.carNumber}`);
      mqChannel.ack(msg);
    } catch (err) {
      console.error(`❌ [Q] FCM failed attempt ${retries + 1} | ${err.message}`);
      if (retries < 2) retryJob(QUEUES.FCM, msg.content, msg.properties.headers, retries, 10000);
      else await saveFailed('fcm.notify', job, err.message);
      mqChannel.ack(msg);
    }
  }, { noAck: false });

  console.log('✅ All RabbitMQ workers started');
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.use(morgan('dev'));
app.use(express.json({ type: '*/*' }));

// ── Rate limiting ─────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { error: 'Too many requests — slow down' },
  skip: (req) => req.path === '/webhook',
}));

// ── Block common attack paths ─────────────────────────────────
app.use((req, res, next) => {
  const blocked = ['.env', 'passwd', 'wp-admin', 'phpmyadmin', '.git', 'xmlrpc'];
  if (blocked.some(b => req.path.includes(b))) return res.status(404).end();
  next();
});

// ── API key authentication ────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  if (req.path === '/')        return next();

  // Harmless public paths — return 404 silently
  const publicPaths = ['/favicon', '/robots.txt', '/security.txt', '/.well-known', '/sitemap', '/ads.txt'];
  if (publicPaths.some(p => req.path.startsWith(p))) return res.status(404).end();

  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─────────────────────────────────────────────────────────────
// PHONE NORMALIZER
// ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length > 10) return digits;
  return `91${digits}`;
}

function buildPhoneVariants(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length > 10) {
    const last10 = digits.slice(-10);
    return [...new Set([digits, last10, `91${last10}`])];
  }
  return [...new Set([digits, `91${digits}`])];
}

// ─────────────────────────────────────────────────────────────
// OTP STORE — in-memory (original)
// ─────────────────────────────────────────────────────────────
const otpStore = new Map();

function saveOTP(phone, otp, carNumber, slotMins, options) {
  const key = normalizePhone(phone);
  otpStore.set(key, {
    otp, carNumber, slotMins, options,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  console.log(`💾 OTP saved | ${key} | ${otp}`);
}

function getStoredOTP(phone) {
  const key    = normalizePhone(phone);
  const record = otpStore.get(key);
  if (!record) return null;
  if (Date.now() > record.expiresAt) { otpStore.delete(key); return null; }
  return record;
}

function validateAndConsumeOTP(phone, input) {
  const key    = normalizePhone(phone);
  const record = otpStore.get(key);
  console.log(`🔍 OTP validate | ${key} | input:${input} stored:${record?.otp}`);
  if (!record) return { valid: false, reason: 'No OTP found' };
  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return { valid: false, reason: 'OTP expired' };
  }
  if (record.otp !== String(input).trim())
    return { valid: false, reason: 'Wrong OTP' };
  const { carNumber } = record;
  otpStore.delete(key);
  return { valid: true, carNumber };
}

function generateOTP() {
  return String(Math.floor(10 + Math.random() * 90));
}

function makeOptions(otp) {
  const decoys = [];
  while (decoys.length < 2) {
    const d = String(Math.floor(10 + Math.random() * 90));
    if (d !== otp && !decoys.includes(d)) decoys.push(d);
  }
  const options = [...decoys, otp];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return options;
}

// ─────────────────────────────────────────────────────────────
// TEMPLATE LOCALE CACHE
// ─────────────────────────────────────────────────────────────
const templateLocaleCache = new Map();
templateLocaleCache.set('confirm_parked', 'en');
templateLocaleCache.set('test_end', 'en');
const LOCALE_CANDIDATES = ['en', 'en_US', 'en_GB'];

async function sendTemplateMessage(to, templateName, bodyParams = []) {
  const components = bodyParams.length > 0
    ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
    : [];
  const cached  = templateLocaleCache.get(templateName);
  const locales = cached ? [cached] : LOCALE_CANDIDATES;
  let lastError = null;
  for (const locale of locales) {
    try {
      const payload = {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: templateName, language: { code: locale },
          ...(components.length > 0 && { components }),
        },
      };
      console.log(`📤 ${templateName} → ${to} | ${locale} | params:`, bodyParams);
      const res = await axios.post(WA_BASE, payload, { headers: WA_HEADERS() });
      if (!cached) {
        templateLocaleCache.set(templateName, locale);
        console.log(`✅ Locale cached: "${locale}" for "${templateName}"`);
      }
      return res.data;
    } catch (err) {
      if (err.response?.data?.error?.code === 132001) {
        console.warn(`⚠️ "${templateName}" not in "${locale}", trying next...`);
        lastError = err; continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function sendTextMessage(to, text) {
  const res = await axios.post(WA_BASE,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: WA_HEADERS() });
  return res.data;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function docToObj(doc) {
  const d = doc.data();
  return {
    id:                    doc.id,
    driver_name:           d.driver_name    || '',
    guest_phone:           d.guest_phone    || '',
    vehicle_number:        d.vehicle_number || '',
    parking_area:          d.parking_area   || '',
    parking_detail:        d.parking_detail || '',
    status:                d.status         || '',
    otp:                   d.otp            || null,
    Entry_time:            fmtTime(d.Entry_time),
    parked_time:           fmtTime(d.parked_time),
    Retrieve_request_time: fmtTime(d.Retrieve_request_time),
    handover_time:         fmtTime(d.handover_time),
    exited_time:           fmtTime(d.exited_time),
    Retrieve_time:         d.Retrieve_time  || null,
  };
}

function fmtTime(ts) {
  if (!ts) return null;
  try {
    const d = ts.toDate();
    return {
      iso:      d.toISOString(),
      readable: d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
      }),
    };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.json({ status: 'OK', service: `${VENUE_NAME} Backend` }));

// ─────────────────────────────────────────────────────────────
// PARKING ROUTES
// ─────────────────────────────────────────────────────────────
app.get('/api/parking/all', async (req, res) => {
  try {
    const snap = await col.get();
    const data = snap.docs.map(docToObj).sort((a, b) =>
      (b.parked_time?.iso ?? '').localeCompare(a.parked_time?.iso ?? ''));
    res.json({ success: true, total: data.length, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: docToObj(doc) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/parking/park', async (req, res) => {
  const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
  if (!driver_name || !guest_phone || !vehicle_number || !parking_area)
    return res.status(400).json({ success: false, error: 'Missing fields' });
  const now = admin.firestore.FieldValue.serverTimestamp();
  try {
    const ref = await col.add({
      driver_name, guest_phone,
      vehicle_number:        vehicle_number.toUpperCase(),
      parking_area:          parking_area.toUpperCase(),
      parking_detail:        parking_detail || '',
      status:                'parked', otp: null,
      Entry_time:            now, parked_time: now,
      Retrieve_request_time: null, handover_time: null,
      exited_time:           null, Retrieve_time: null,
    });
    console.log(`✅ Parked: ${vehicle_number} | ${parking_area}`);
    res.status(201).json({ success: true, docId: ref.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.patch('/api/parking/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['parked','retrieve_requested','accepted','delivered'].includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });
  try {
    const ref = col.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    const update = { status };
    if (status === 'delivered') {
      const now = admin.firestore.FieldValue.serverTimestamp();
      update.handover_time = now; update.exited_time = now;
      if (doc.data().Retrieve_request_time) {
        update.Retrieve_time = `${Math.round(
          (Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000
        )} min`;
      }
    }
    await ref.update(update);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    await col.doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// SEND MESSAGES — Flutter calls for MSG 1 (confirm_parked)
// ─────────────────────────────────────────────────────────────
app.post('/send-messages', async (req, res) => {
  const { phone, type, message, templateName, bodyParams } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    if (type === 'text') {
      await sendTextMessage(phone, message);
      return res.json({ success: true });
    }
    if (type === 'template') {
      const queued = publish(QUEUES.PARKED, {
        phone, carNumber: bodyParams?.[0] || '', driverName: bodyParams?.[2] || '', slotMins: bodyParams?.[3] || 5,
      });
      if (!queued) await sendTemplateMessage(phone, templateName, bodyParams || []);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unknown type' });
  } catch (err) {
    console.error('❌ /send-messages:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET OTP — Flutter calls when driver taps Verify
// Returns stored OTP + options — NO WhatsApp message sent
// ─────────────────────────────────────────────────────────────
app.post('/get-otp', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber required' });

  const record = getStoredOTP(phone);
  if (!record) {
    console.log(`⚠️ No OTP for ${normalizePhone(phone)} — expired or not set`);
    return res.status(404).json({
      error: 'OTP not found. Guest must tap Retrieve Car again.'
    });
  }

  console.log(`✅ /get-otp → ${normalizePhone(phone)} | ${record.otp}`);
  return res.json({ success: true, otp: record.otp, options: record.options });
});

// ─────────────────────────────────────────────────────────────
// WRONG OTP — driver tapped wrong circle
// Generates new OTP, sends plain text to guest
// ─────────────────────────────────────────────────────────────
app.post('/wrong-otp', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber required' });

  const normalizedPhone = normalizePhone(phone);
  const newOtp          = generateOTP();
  const newOptions      = makeOptions(newOtp);

  saveOTP(normalizedPhone, newOtp, carNumber, 5, newOptions);

  try {
    const queued = publish(QUEUES.WRONG_OTP, { phone: normalizedPhone, otp: newOtp });
    if (!queued) {
      const msg =
        `Looks like the code was entered incorrectly.\n\n` +
        `Please share this updated code with the driver:\n*${newOtp}*`;
      await sendTextMessage(normalizedPhone, msg);
    }
    console.log(`✅ Wrong OTP → new: ${newOtp} | ${normalizedPhone}`);
    return res.json({ success: true, otp: newOtp, options: newOptions });
  } catch (err) {
    console.error('❌ /wrong-otp:', err.response?.data || err.message);
    return res.status(500).json({
      error: err.response?.data?.error?.message || err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────
// VERIFY OTP — driver taps Deliver
// Variables picked randomly, MSG 3 sent, Firestore → delivered
// ─────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, docId } = req.body;
  if (!phone || !otp)
    return res.status(400).json({ error: 'phone and otp required' });

  const result = validateAndConsumeOTP(phone, otp);
  if (!result.valid) {
    console.log(`❌ OTP invalid: ${result.reason}`);
    return res.json({ success: false, reason: result.reason });
  }

  console.log(`✅ OTP verified | Car: ${result.carNumber}`);

  try {
    // MSG 3: test_end template — queue with direct fallback
    const queued = publish(QUEUES.DELIVERED, {
      phone: normalizePhone(phone), carNumber: result.carNumber,
    });
    if (!queued) {
      await sendTemplateMessage(normalizePhone(phone), 'test_end', [result.carNumber]);
    }
    console.log(`✅ MSG 3 queued/sent | ${normalizePhone(phone)} | Car: ${result.carNumber}`);

    // Update Firestore → delivered
    if (docId) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ref = col.doc(docId);
      const doc = await ref.get();
      const update = { status: 'delivered', handover_time: now, exited_time: now };
      if (doc.exists && doc.data().Retrieve_request_time) {
        update.Retrieve_time = `${Math.round(
          (Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000
        )} min`;
      }
      await ref.update(update);
      console.log(`✅ Firestore: delivered | ${docId}`);
    }

    return res.json({ success: true, carNumber: result.carNumber });
  } catch (err) {
    console.error('❌ /verify-otp:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK VERIFY
// ─────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    console.log('✅ Webhook verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK RECEIVE — guest taps Retrieve Car → MSG 2 auto
// ─────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => processIncomingMessage(req.body));
});

async function processIncomingMessage(body) {
  try {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      const status = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
      if (status) console.log(`📊 WA: ${status.status}`);
      return;
    }
    const from = message.from;
    console.log(`💬 ${message.type} | ${from}`);

    if (message.type === 'button') {
      const text = (message.button?.text || '').toLowerCase().trim();
      if (text.includes('retrieve')) await handleRetrieveCar(from);
      return;
    }
    if (message.type === 'interactive') {
      const id = message.interactive?.button_reply?.id;
      if (id === 'retrieve_car') await handleRetrieveCar(from);
      return;
    }
    if (message.type === 'text') {
      const lower = message.text.body.trim().toLowerCase();
      if (lower === 'hi' || lower === 'hello') {
        await sendTextMessage(from,
          `👋 Welcome to *${VENUE_NAME}*! Our valet team is ready to assist you.`);
      }
    }
  } catch (err) {
    console.error('💥 Webhook:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RETRIEVE CAR HANDLER
// ─────────────────────────────────────────────────────────────
async function handleRetrieveCar(from) {
  console.log(`🚗 Retrieve from: ${from}`);
  const normalizedFrom = normalizePhone(from);
  const variants       = buildPhoneVariants(from);

  try {
    let matchedDoc = null;
    for (const ph of variants) {
      const snap = await col
        .where('guest_phone', '==', ph)
        .where('status', '==', 'parked')
        .limit(1).get();
      if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
    }

    if (!matchedDoc) {
      console.log(`⚠️ No parked car: ${variants.join(', ')}`);
      await sendTextMessage(from,
        'We could not find an active parking record. Please contact our valet team.');
      return;
    }

    const data      = matchedDoc.data();
    const carNumber = data.vehicle_number || '';
    const carId     = matchedDoc.id;
    const area      = (data.parking_area || 'A').toUpperCase();
    const slotMins  = SLOT_MINUTES[area] ?? 5;

    const otp     = generateOTP();
    const options = makeOptions(otp);
    saveOTP(normalizedFrom, otp, carNumber, slotMins, options);

    // MSG 2 — queue with direct fallback
    const msgQueued = publish(QUEUES.OTP, { phone: normalizedFrom, otp, slotMins, carNumber, carId });
    if (!msgQueued) {
      const msg =
        `On it!\n` +
        `Your car should be at the main entrance in less than ${slotMins} mins.\n\n` +
        `Share this code with the driver who brings your car:\n*${otp}*\n\n` +
        `If your car is waiting for more than 10 minutes at the portico, ` +
        `we will repark the car closeby to keep the portico clear.`;
      await sendTextMessage(normalizedFrom, msg);
      console.log(`✅ MSG 2 direct → ${normalizedFrom} | OTP:${otp} | ${slotMins}min`);
    } else {
      console.log(`✅ MSG 2 queued → ${normalizedFrom} | OTP:${otp} | ${slotMins}min`);
    }

    // Firestore → retrieve_requested
    await matchedDoc.ref.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Firestore: retrieve_requested | ${carNumber} | ${carId}`);

    // FCM — queue with direct fallback
    const fcmQueued = publish(QUEUES.FCM, { carNumber, carId });
    if (!fcmQueued) await sendFCMNotification(carNumber, carId);

  } catch (err) {
    console.error('❌ handleRetrieveCar:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// FCM
// ─────────────────────────────────────────────────────────────
async function sendFCMNotification(carNumber, carId) {
  try {
    // FCM tokens stored in drivers collection — no separate fcm_tokens collection
    const snap = await db.collection('drivers').get();
    if (snap.empty) { console.log('⚠️ No drivers found'); return; }
    const tokens = snap.docs
      .map(d => d.data().fcmToken)
      .filter(Boolean);
    if (!tokens.length) { console.log('⚠️ No FCM tokens in drivers collection'); return; }

    const response = await admin.messaging().sendEachForMulticast({
      // notification block — FCM shows this directly when app is CLOSED
      // This is what makes notifications work when app is killed
      notification: {
        title: '🚗 Car Retrieve Request',
        body:  `Vehicle ${carNumber} — guest is waiting. Tap to respond.`,
      },
      // data block — Flutter reads this in foreground + background handlers
      data: {
        type:      'retrieve_requested',
        carNumber: String(carNumber),
        carId:     String(carId),
        title:     'Car Retrieve Request',
        body:      `Vehicle ${carNumber} — guest is waiting`,
      },
      android: {
        priority: 'high',
        ttl:      60000,
        notification: {
          channelId:   'wotiko_retrieve_v3',  // must match Flutter channel
          priority:    'max',
          defaultSound: false,
          sound:       'retrival_ringtone_wotiko',
          defaultVibrateTimings: false,
          vibrateTimingsMillis:  [0, 800, 200, 800, 200, 800, 200, 800],
          notificationPriority:  'PRIORITY_MAX',
          visibility:  'PUBLIC',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        headers: {
          'apns-priority':  '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert: {
              title: '🚗 Car Retrieve Request',
              body:  `Vehicle ${carNumber} — guest is waiting. Tap to respond.`,
            },
            sound:             'retrival_ringtone_wotiko.mp3',
            'content-available': 1,
            'interruption-level': 'critical',
          },
        },
      },
      tokens,
    });
    console.log(`✅ FCM: ${response.successCount}/${tokens.length}`);
    response.responses.forEach((r, i) => {
      if (!r.success) console.warn(`  ❌ Token[${i}]: ${r.error?.code}`);
    });
  } catch (err) {
    console.error('❌ FCM:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏨 ${VENUE_NAME} Backend`);
  console.log(`🚀 http://139.59.75.67:${PORT}`);
  console.log(`🔐 API key auth active on all routes except /webhook`);
  console.log(`🚦 Rate limit: 100 req / 15 min per IP`);
  console.log(`📲 /send-messages → MSG 1 confirm_parked template`);
  console.log(`🔑 /get-otp       → get circles, no WA msg`);
  console.log(`⚠️  /wrong-otp    → new OTP + plain text to guest`);
  console.log(`✅ /verify-otp    → MSG 3 end template + Firestore`);
  console.log(`🔗 /webhook       → MSG 2 auto on Retrieve Car\n`);
});

connectRabbitMQ();
