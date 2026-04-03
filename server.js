/**
 * server.js — Wotiko Valet Backend
 *
 * EXACT FLOW (from diagram):
 *
 *  Driver parks car
 *    → MSG1 confirm_parked  {{1}}=carNumber {{2}}=venueName {{3}}=driverName {{4}}=slotMins
 *    → Button: Retrieve Car
 *
 *  Guest taps Retrieve Car
 *    → Firestore: retrieve_requested
 *    → FCM push to ALL drivers
 *    → NO WhatsApp message sent here
 *
 *  Driver ACCEPTS
 *    → Flutter sends MSG2 retrieve  {{1}}=driverName {{2}}=slotMins
 *    → Button: Cancel Retrieval
 *    → Firestore: accepted
 *
 *  Driver SKIPS
 *    → Flutter sends MSG4 skip  {{1}}=totalWait (slotMins×2)
 *    → Button: Cancel Retrieval
 *    → Car stays retrieve_requested (next driver can accept)
 *
 *  Guest taps Cancel Retrieval
 *    → MSG5 cancel  no vars
 *    → Button: Retrieve Car
 *    → Firestore: cancelled → immediately back to parked
 *    → Driver app shows cancel screen
 *
 *  Driver taps Deliver Car
 *    → MSG6 end  {{1}}=carNumber {{2}}=venueName {{3}}=phrase {{4}}=dish
 *    → Firestore: delivered
 */

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

const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY   = process.env.WEBHOOK_VERIFY_TOKEN || 'my-verify-token';
const WA_BASE     = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
const WA_HEADERS  = () => ({
  Authorization:  `Bearer ${WA_TOKEN}`,
  'Content-Type': 'application/json',
});

// ── Constants ─────────────────────────────────────────────────
const VENUE_NAME   = 'Madras Square';   // ← constant venue name
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
  'Pan Grilled Salmon',
];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ── RabbitMQ ──────────────────────────────────────────────────
let mqChannel = null;
const QUEUES = {
  PARKED:   'whatsapp.parked',
  RETRIEVE: 'whatsapp.retrieve',
  SKIP:     'whatsapp.skip',
  CANCEL:   'whatsapp.cancel',
  END:      'whatsapp.end',
  FCM:      'fcm.notify',
};

async function connectRabbitMQ() {
  try {
    const conn = await amqp.connect('amqp://localhost');
    mqChannel  = await conn.createChannel();
    for (const q of Object.values(QUEUES)) {
      await mqChannel.assertQueue(q, { durable: true });
    }
    conn.on('error', e => { console.error('❌ RabbitMQ:', e.message); mqChannel = null; });
    conn.on('close', ()  => {
      console.warn('⚠️ RabbitMQ closed — retry 5s');
      mqChannel = null;
      setTimeout(connectRabbitMQ, 5000);
    });
    console.log('✅ RabbitMQ connected');
    startWorkers();
  } catch (e) {
    console.warn(`⚠️ RabbitMQ unavailable (${e.message}) — direct mode`);
    mqChannel = null;
  }
}

function publish(queue, payload) {
  if (!mqChannel) return false;
  try {
    mqChannel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true }
    );
    return true;
  } catch (e) {
    console.error(`❌ publish ${queue}:`, e.message);
    return false;
  }
}

function retryJob(queue, content, headers, retries, delayMs) {
  if (!mqChannel) return;
  setTimeout(() => {
    try {
      mqChannel.sendToQueue(queue, content, {
        persistent: true,
        headers: { 'x-retry-count': retries + 1 },
      });
    } catch (e) { console.error(`❌ retry ${queue}:`, e.message); }
  }, delayMs);
}

async function saveFailed(type, job, reason) {
  try {
    await db.collection('failed_messages').add({
      type, job, reason,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('❌ saveFailed:', e.message); }
}

function startWorkers() {
  if (!mqChannel) return;

  const worker = (queue, fn, maxRetries = 3, delay = 30000) => {
    mqChannel.consume(queue, async msg => {
      if (!msg) return;
      const job     = JSON.parse(msg.content.toString());
      const retries = msg.properties.headers?.['x-retry-count'] || 0;
      try {
        await fn(job);
        mqChannel.ack(msg);
      } catch (e) {
        console.error(`❌ [Q] ${queue} attempt ${retries + 1}: ${e.message}`);
        if (retries < maxRetries) {
          retryJob(queue, msg.content, msg.properties.headers, retries, delay);
        } else {
          await saveFailed(queue, job, e.message);
        }
        mqChannel.ack(msg);
      }
    }, { noAck: false });
  };

  // MSG1: confirm_parked — {{1}}=carNumber {{2}}=venueName {{3}}=driverName {{4}}=slotMins
  worker(QUEUES.PARKED,   j => sendTemplate(j.phone, 'confirm_parked',
    [j.carNumber, VENUE_NAME, j.driverName, String(j.slotMins)]));

  // MSG2: retrieve — {{1}}=driverName {{2}}=slotMins
  worker(QUEUES.RETRIEVE, j => sendTemplate(j.phone, 'retrieve',
    [j.driverName, String(j.slotMins)]));

  // MSG4: skip — {{1}}=totalWait
  worker(QUEUES.SKIP,     j => sendTemplate(j.phone, 'skip',
    [String(j.totalWait)]), 3, 15000);

  // MSG5: cancel — no vars
  worker(QUEUES.CANCEL,   j => sendTemplate(j.phone, 'cancel',
    []), 3, 15000);

  // MSG6: end — {{1}}=carNumber {{2}}=venueName {{3}}=phrase {{4}}=dish
  worker(QUEUES.END,      j => sendTemplate(j.phone, 'end',
    [j.carNumber, VENUE_NAME, j.phrase, j.dish]));

  // FCM push
  worker(QUEUES.FCM,      j => sendFCMNotification(j.carNumber, j.carId), 2, 10000);

  console.log('✅ All workers started');
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE'] }));
app.use(morgan('dev'));
app.use(express.json({ type: '*/*' }));
// ── Rate limiting ────────────────────────────────────────────
// Only rate limit UNAUTHENTICATED requests (no valid API key)
// Authenticated drivers (with API key) have no limit — supports unlimited cars
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      50,   // 50 requests per 15min for unauthenticated — blocks bots
  message:  { error: 'Too many requests' },
  skip: (req) => {
    // Skip rate limit for:
    // 1. Webhook (WhatsApp callbacks)
    // 2. Health check
    // 3. Any request with valid API key (authenticated drivers)
    if (req.path === '/webhook') return true;
    if (req.path === '/')        return true;
    const key = req.headers['x-api-key'];
    if (key && key === process.env.API_SECRET_KEY) return true;
    return false;
  },
}));

// Block attack paths
app.use((req, res, next) => {
  const blocked = ['.env','passwd','wp-admin','phpmyadmin','.git','xmlrpc'];
  if (blocked.some(b => req.path.includes(b))) return res.status(404).end();
  next();
});

// API key auth
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/') return next();
  const pub = ['/favicon','/robots.txt','/security.txt','/.well-known'];
  if (pub.some(p => req.path.startsWith(p))) return res.status(404).end();
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Phone helpers ─────────────────────────────────────────────
function normalizePhone(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  // If already has country code (more than 10 digits), use as is
  // Otherwise assume India (+91) as this app is India-based
  if (d.length === 10) return `91${d}`;  // legacy Indian 10-digit only
  return d;                                 // already has country code
}

function buildPhoneVariants(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  if (d.length > 10) {
    // Has country code — search exact + last 10 digits + 91+last10
    const last10 = d.slice(-10);
    const cc     = d.slice(0, d.length - 10); // country code digits
    return [...new Set([d, last10, `91${last10}`, `${cc}${last10}`])];
  }
  // 10 digits — search with and without 91 prefix
  return [...new Set([d, `91${d}`])];
}

// ── WhatsApp helpers ──────────────────────────────────────────
const localeCache = new Map([
  ['confirm_parked', 'en'],
  ['retrieve',       'en'],
  ['skip',           'en'],
  ['cancel',         'en'],
  ['end',            'en'],
]);

async function sendTemplate(to, name, params = []) {
  const components = params.length > 0
    ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }]
    : [];
  const cached  = localeCache.get(name);
  const locales = cached ? [cached] : ['en', 'en_US', 'en_GB'];
  let lastErr   = null;
  for (const locale of locales) {
    try {
      const res = await axios.post(WA_BASE, {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name,
          language:   { code: locale },
          ...(components.length > 0 && { components }),
        },
      }, { headers: WA_HEADERS() });
      if (!cached) localeCache.set(name, locale);
      console.log(`📤 ${name} → ${to}`);
      return res.data;
    } catch (e) {
      if (e.response?.data?.error?.code === 132001) { lastErr = e; continue; }
      console.error(`❌ Template ${name}:`, JSON.stringify(e.response?.data || e.message));
      throw e;
    }
  }
  throw lastErr;
}

async function sendText(to, text) {
  const res = await axios.post(WA_BASE,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: WA_HEADERS() });
  return res.data;
}

// ── Firestore helpers ─────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return null;
  try {
    const d = ts.toDate();
    return {
      iso:      d.toISOString(),
      readable: d.toLocaleString('en-IN', {
        timeZone:  'Asia/Kolkata',
        day:       '2-digit',
        month:     'short',
        year:      'numeric',
        hour:      '2-digit',
        minute:    '2-digit',
        hour12:    true,
      }),
    };
  } catch (_) { return null; }
}

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
    Entry_time:            fmtTime(d.Entry_time),
    parked_time:           fmtTime(d.parked_time),
    Retrieve_request_time: fmtTime(d.Retrieve_request_time),
    handover_time:         fmtTime(d.handover_time),
    exited_time:           fmtTime(d.exited_time),
    Retrieve_time:         d.Retrieve_time  || null,
  };
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────
app.get('/', (_, res) =>
  res.json({ status: 'OK', service: 'Wotiko Valet Backend' }));

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

app.get('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: docToObj(doc) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Check vehicle active ─────────────────────────────────────
// Fast check — only queries by vehicle number, no need to fetch all cars
app.get('/api/parking/check-vehicle', async (req, res) => {
  const vehicle = (req.query.vehicle || '').toUpperCase().trim();
  if (!vehicle) return res.json({ active: false });
  try {
    const activeStatuses = ['parked', 'retrieve_requested', 'accepted'];
    let isActive = false;
    for (const status of activeStatuses) {
      const snap = await col
        .where('vehicle_number', '==', vehicle)
        .where('status', '==', status)
        .limit(1).get();
      if (!snap.empty) { isActive = true; break; }
    }
    res.json({ active: isActive });
  } catch (e) {
    res.status(500).json({ active: false, error: e.message });
  }
});

// ── Park a car ────────────────────────────────────────────────
app.post('/api/parking/park', async (req, res) => {
  const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
  if (!driver_name || !guest_phone || !vehicle_number || !parking_area)
    return res.status(400).json({ success: false, error: 'Missing fields' });
  const now = admin.firestore.FieldValue.serverTimestamp();
  try {
    const ref = await col.add({
      driver_name,
      guest_phone,
      vehicle_number:        vehicle_number.toUpperCase(),
      parking_area:          parking_area.toUpperCase(),
      parking_detail:        parking_detail || '',
      status:                'parked',
      // NO otp field — OTP flow removed
      Entry_time:            now,
      parked_time:           now,
      Retrieve_request_time: null,
      handover_time:         null,
      exited_time:           null,
      Retrieve_time:         null,
    });
    console.log(`✅ Parked: ${vehicle_number} | ${parking_area}`);
    res.status(201).json({ success: true, docId: ref.id });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Update status ─────────────────────────────────────────────
app.patch('/api/parking/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['parked','retrieve_requested','accepted','delivered','cancelled'];
  if (!valid.includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });
  try {
    const ref = col.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    const update = { status };
    if (status === 'delivered') {
      const now = admin.firestore.FieldValue.serverTimestamp();
      update.handover_time = now;
      update.exited_time   = now;
      if (doc.data().Retrieve_request_time) {
        update.Retrieve_time = `${Math.round(
          (Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000
        )} min`;
      }
    }
    await ref.update(update);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    await col.doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Send messages (Flutter calls) ─────────────────────────────
// MSG1 confirm_parked: Flutter sends [carNumber, driverName, slotMins]
//   → Server adds VENUE_NAME as {{2}} automatically
// MSG2 retrieve: Flutter sends after driver accepts
// MSG4 skip: Flutter sends after driver skips
app.post('/send-messages', async (req, res) => {
  const { phone, type, message, templateName, bodyParams } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    if (type === 'text') {
      await sendText(phone, message);
      return res.json({ success: true });
    }
    if (type === 'template') {
      if (templateName === 'confirm_parked') {
        // Flutter sends [carNumber, driverName, slotMins]
        // Server inserts VENUE_NAME as {{2}}
        const queued = publish(QUEUES.PARKED, {
          phone,
          carNumber:  bodyParams?.[0] || '',
          driverName: bodyParams?.[1] || '',
          slotMins:   bodyParams?.[2] || 5,
        });
        if (!queued) {
          await sendTemplate(phone, 'confirm_parked', [
            bodyParams?.[0] || '',
            VENUE_NAME,
            bodyParams?.[1] || '',
            String(bodyParams?.[2] || 5),
          ]);
        }
      } else if (templateName === 'retrieve') {
        // Time-sensitive — send directly, no queue
        await sendTemplate(phone, 'retrieve', [
          bodyParams?.[0] || '',
          String(bodyParams?.[1] || 5),
        ]);
      } else if (templateName === 'skip') {
        const queued = publish(QUEUES.SKIP, {
          phone,
          totalWait: bodyParams?.[0] || 6,
        });
        if (!queued) {
          await sendTemplate(phone, 'skip', [String(bodyParams?.[0] || 6)]);
        }
      } else if (templateName === 'cancel') {
        const queued = publish(QUEUES.CANCEL, { phone });
        if (!queued) await sendTemplate(phone, 'cancel', []);
      }
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unknown type' });
  } catch (e) {
    console.error('❌ /send-messages:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Deliver Car ───────────────────────────────────────────────
// Flutter calls when driver taps Deliver Car
// Sends MSG6 (end template) + updates Firestore → delivered
app.post('/deliver-car', async (req, res) => {
  const { phone, docId } = req.body;
  if (!phone || !docId)
    return res.status(400).json({ error: 'phone and docId required' });
  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Car not found' });
    const carNumber = doc.data().vehicle_number || '';
    const phrase    = pick(PHRASES);
    const dish      = pick(DISHES);

    // Send MSG6: end template
    // {{1}}=carNumber {{2}}=venueName {{3}}=phrase {{4}}=dish
    const queued = publish(QUEUES.END, {
      phone: normalizePhone(phone), carNumber, phrase, dish,
    });
    if (!queued) {
      await sendTemplate(normalizePhone(phone), 'end', [
        carNumber, VENUE_NAME, phrase, dish,
      ]);
    }
    console.log(`✅ MSG6 end | ${carNumber} | "${phrase}" | ${dish}`);

    // Update Firestore → delivered
    const now    = admin.firestore.FieldValue.serverTimestamp();
    const update = { status: 'delivered', handover_time: now, exited_time: now };
    if (doc.data().Retrieve_request_time) {
      update.Retrieve_time = `${Math.round(
        (Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000
      )} min`;
    }
    await col.doc(docId).update(update);
    console.log(`✅ Delivered | ${docId}`);

    res.json({ success: true, carNumber });
  } catch (e) {
    console.error('❌ /deliver-car:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Skip Car ─────────────────────────────────────────────────
// Flutter calls when driver skips
// Only sends MSG4 skip ONCE even if multiple drivers skip
app.post('/skip-car', async (req, res) => {
  const { docId } = req.body;
  if (!docId) return res.status(400).json({ error: 'docId required' });
  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Car not found' });
    const data = doc.data();

    // If skip message already sent — do nothing (another driver already skipped)
    if (data.skip_notified === true) {
      console.log(`⏭️ Skip already notified | ${docId}`);
      return res.json({ success: true, alreadyNotified: true });
    }

    // Mark skip_notified immediately to prevent race condition
    await col.doc(docId).update({ skip_notified: true });

    const phone    = data.guest_phone || '';
    const area     = (data.parking_area || 'A').toUpperCase();
    const slotMins = SLOT_MINUTES[area] ?? 5;
    const totalWait = slotMins + slotMins;

    if (phone) {
      const nPhone = normalizePhone(phone);
      // Send directly — no queue for speed
      await sendTemplate(nPhone, 'skip', [String(totalWait)]);
      console.log(`✅ MSG4 skip → ${nPhone} | wait:${totalWait}min`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('❌ /skip-car:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Webhook verify ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    console.log('✅ Webhook verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

// ── Webhook receive ───────────────────────────────────────────
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => processWebhook(req.body));
});

async function processWebhook(body) {
  try {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    console.log(`💬 ${msg.type} | ${from}`);

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
      if (id === 'retrieve_car')     await handleRetrieveCar(from);
      if (id === 'cancel_retrieval') await handleCancelRetrieval(from);
    }
  } catch (e) { console.error('💥 Webhook:', e.message); }
}

// ── Handle Retrieve Car button ────────────────────────────────
// Guest taps Retrieve → FCM to all drivers, Firestore → retrieve_requested
async function handleRetrieveCar(from) {
  console.log(`🚗 Retrieve: ${from}`);
  const variants = buildPhoneVariants(from);
  try {
    let matchedDoc = null;
    // Search parked OR cancelled (guest may tap before 5s reset)
    for (const ph of variants) {
      for (const st of ['parked', 'cancelled']) {
        const snap = await col
          .where('guest_phone', '==', ph)
          .where('status', '==', st)
          .limit(1).get();
        if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
      }
      if (matchedDoc) break;
    }

    if (!matchedDoc) {
      console.log(`⚠️ No car found for: ${variants.join(', ')}`);
      await sendText(from,
        'We could not find an active parking record. Please contact our valet team.');
      return;
    }

    const data    = matchedDoc.data();
    const carId   = matchedDoc.id;

    // Firestore → retrieve_requested
    // Reset skip_notified so guest can get skip message again if needed
    await matchedDoc.ref.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
      skip_notified:         false,
    });
    console.log(`✅ retrieve_requested | ${data.vehicle_number} | ${carId}`);

    // FCM push to all drivers
    const fcmQueued = publish(QUEUES.FCM, {
      carNumber: data.vehicle_number,
      carId,
    });
    if (!fcmQueued) await sendFCMNotification(data.vehicle_number, carId);

  } catch (e) { console.error('❌ handleRetrieveCar:', e.message); }
}

// ── Handle Cancel Retrieval button ───────────────────────────
// Guest taps Cancel → MSG5 cancel → Firestore cancelled → immediately parked
// Driver app detects cancelled → shows CancelRetrieveScreen
async function handleCancelRetrieval(from) {
  console.log(`❌ Cancel: ${from}`);
  const nFrom    = normalizePhone(from);
  const variants = buildPhoneVariants(from);
  try {
    let matchedDoc = null;
    for (const ph of variants) {
      for (const status of ['retrieve_requested', 'accepted']) {
        const snap = await col
          .where('guest_phone', '==', ph)
          .where('status', '==', status)
          .limit(1).get();
        if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
      }
      if (matchedDoc) break;
    }

    if (!matchedDoc) {
      console.log(`⚠️ No active car to cancel for ${nFrom}`);
      return;
    }

    const carId = matchedDoc.id;

    // Step 1: set cancelled so Flutter detects → shows CancelRetrieveScreen
    await matchedDoc.ref.update({ status: 'cancelled' });
    console.log(`✅ cancelled | ${carId}`);

    // Step 2: immediately reset to parked (3s is enough for Flutter to detect)
    // so guest can tap Retrieve again quickly
    setTimeout(async () => {
      try {
        await matchedDoc.ref.update({ status: 'parked' });
        console.log(`✅ Reset to parked | ${carId}`);
      } catch (e) { console.error('❌ Reset parked:', e.message); }
    }, 3000); // 3 seconds — reduced from 5s for faster re-retrieve

    // Step 3: Send MSG5 cancel to guest
    const queued = publish(QUEUES.CANCEL, { phone: nFrom });
    if (!queued) await sendTemplate(nFrom, 'cancel', []);
    console.log(`✅ MSG5 cancel → ${nFrom}`);

  } catch (e) { console.error('❌ handleCancelRetrieval:', e.message); }
}

// ── FCM Notification ──────────────────────────────────────────
async function sendFCMNotification(carNumber, carId) {
  try {
    const snap   = await db.collection('drivers').get();
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) { console.log('⚠️ No FCM tokens'); return; }

    const res = await admin.messaging().sendEachForMulticast({
      // notification block — shows when app is CLOSED (system handles it)
      notification: {
        title: '🚗 Car Retrieve Request',
        body:  `Vehicle ${carNumber} — guest is waiting`,
      },
      // data block — Flutter reads in foreground + background handlers
      data: {
        type:      'retrieve_requested',
        carNumber: String(carNumber),
        carId:     String(carId),
      },
      android: {
        priority: 'high',
        ttl:      60000,
        notification: {
          channelId:             'wotiko_retrieve_v4',
          priority:              'max',
          defaultSound:          false,
          sound:                 'retrival_ringtone_wotiko',
          defaultVibrateTimings: false,
          vibrateTimingsMillis:  [0, 800, 200, 800, 200, 800],
          visibility:            'PUBLIC',
          clickAction:           'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: {
          aps: {
            alert: {
              title: '🚗 Car Retrieve Request',
              body:  `Vehicle ${carNumber} — guest is waiting`,
            },
            sound:               'retrival_ringtone_wotiko.mp3',
            'content-available': 1,
            'interruption-level': 'critical',
          },
        },
      },
      tokens,
    });

    console.log(`✅ FCM: ${res.successCount}/${tokens.length}`);
    res.responses.forEach((r, i) => {
      if (!r.success) console.warn(`  ❌ Token[${i}]: ${r.error?.code}`);
    });
  } catch (e) { console.error('❌ FCM:', e.message); }
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏨 Wotiko Valet Backend | Port ${PORT}`);
  console.log(`📲 MSG1:confirm_parked MSG2:retrieve MSG4:skip MSG5:cancel MSG6:end`);
  console.log(`🔗 Webhook: RetrieveCar→FCM+Firestore | CancelRetrieval→cancelled→parked(3s)`);
  console.log(`🚫 OTP flow: REMOVED\n`);
});

connectRabbitMQ();
