const express    = require('express');
const http       = require('http');           // needed to share server with Socket.IO
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const amqp = require('amqplib');
const crypto = require('crypto');
require('dotenv').config();

function log(emoji, category, message, meta = {}) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  const metaStr = Object.keys(meta).length
    ? '  ' + Object.entries(meta).map(([k, v]) => `${k}:${v}`).join(' | ')
    : '';
  console.log(`[${ts}] ${emoji} [${category}] ${message}${metaStr}`);
}

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
log('OK', 'BOOT', 'Firebase Admin initialized');

// ── Socket.IO handler (imported here so it can access db + admin + log) ───
const {
  initSocketHandler,
  broadcastRetrieveRequest,
  broadcastCancelled,
  broadcastDelivered,
} = require('./socket/socketHandler');

const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY   = process.env.WEBHOOK_VERIFY_TOKEN || 'my-verify-token';
const WA_BASE     = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
const WA_HEADERS  = () => ({ Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' });

const VENUE_NAME  = 'Madras Square';
const SLOT_MINUTES = { A: 2, B: 2, C: 3, D: 4, E: 5, OTHER: 6 };

const PHRASES = [
  "Wotiko's vote is with", 'Team Wotiko is crazy about', 'Wotiko was wowed by',
  'Yummm! Team Wotiko loved', 'Wotiko Team is still dreaming about',
  'The regulars here love', "This week's fave dish was", 'Tira miss it already! That and',
];
const DISHES = [
  'Truffle Garlic Fried Rice', 'Curry Butter Garlic Prawns',
  'Dragon Chicken', 'Chicken Quesadillas', 'Pan Grilled Salmon',
];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

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
    for (const q of Object.values(QUEUES)) await mqChannel.assertQueue(q, { durable: true });
    conn.on('error', e => { mqChannel = null; log('ERR', 'RABBITMQ', 'Connection error', { error: e.message }); });
    conn.on('close', () => { mqChannel = null; log('WARN', 'RABBITMQ', 'Closed, retrying in 5s'); setTimeout(connectRabbitMQ, 5000); });
    log('OK', 'RABBITMQ', 'Connected');
    startWorkers();
  } catch (e) {
    mqChannel = null;
    log('WARN', 'RABBITMQ', 'Unavailable, using direct mode', { error: e.message });
  }
}

function publish(queue, payload) {
  if (!mqChannel) return false;
  try {
    mqChannel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), { persistent: true });
    log('Q', 'QUEUE', 'Published job', { queue });
    return true;
  } catch (e) { log('ERR', 'QUEUE', 'Publish failed', { queue, error: e.message }); return false; }
}

function retryJob(queue, content, retries, delayMs) {
  if (!mqChannel) return;
  setTimeout(() => {
    try {
      mqChannel.sendToQueue(queue, content, { persistent: true, headers: { 'x-retry-count': retries + 1 } });
      log('RETRY', 'QUEUE', 'Retry queued', { queue, retry: retries + 1, delayMs });
    } catch (e) { log('ERR', 'QUEUE', 'Retry queue failed', { queue, error: e.message }); }
  }, delayMs);
}

async function saveFailed(type, job, reason) {
  try {
    await db.collection('failed_messages').add({ type, job, reason, failedAt: admin.firestore.FieldValue.serverTimestamp() });
    log('FAIL', 'QUEUE', 'Saved failed job', { type, reason });
  } catch (e) { log('ERR', 'QUEUE', 'Failed to save failed job', { type, error: e.message }); }
}

function startWorkers() {
  if (!mqChannel) return;
  const worker = (queue, fn, maxRetries = 3, delay = 30000) => {
    mqChannel.consume(queue, async msg => {
      if (!msg) return;
      const job     = JSON.parse(msg.content.toString());
      const retries = msg.properties.headers?.['x-retry-count'] || 0;
      try {
        log('WORK', 'QUEUE', 'Processing job', { queue, retry: retries });
        await fn(job);
        mqChannel.ack(msg);
        log('OK', 'QUEUE', 'Job completed', { queue });
      } catch (e) {
        log('ERR', 'QUEUE', 'Job failed', { queue, retry: retries + 1, error: e.message });
        if (retries < maxRetries) retryJob(queue, msg.content, retries, delay);
        else await saveFailed(queue, job, e.message);
        mqChannel.ack(msg);
      }
    }, { noAck: false });
  };

  worker(QUEUES.PARKED,   j => sendTemplate(j.phone, 'confirm_parked', [j.carNumber, VENUE_NAME, j.driverName, String(j.slotMins)]));
  worker(QUEUES.RETRIEVE, j => sendTemplate(j.phone, 'retrieve',       [j.driverName, String(j.slotMins)]));
  worker(QUEUES.SKIP,     j => sendTemplate(j.phone, 'skip',           [String(j.totalWait)]), 3, 15000);
  worker(QUEUES.CANCEL,   j => sendTemplate(j.phone, 'cancel',         []), 3, 15000);
  worker(QUEUES.END,      j => sendTemplate(j.phone, 'end',            [j.carNumber, VENUE_NAME, j.phrase, j.dish]));
  worker(QUEUES.FCM,      j => sendFCMNotification(j.carNumber, j.carId, j.wing || '', j.guestMasked || 'Guest'), 2, 10000);
  log('OK', 'QUEUE', 'All workers started');
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'&]/g, '').substring(0, 200);
}

function normalizePhone(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  return d.length === 10 ? `91${d}` : d;
}

function maskPhone(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  if (d.length < 4) return 'Guest';
  return d.substring(0, 2) + 'XXXXXX' + d.slice(-2);
}

function buildPhoneVariants(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  if (d.length > 10) {
    const last10 = d.slice(-10);
    const cc     = d.slice(0, d.length - 10);
    return [...new Set([d, last10, `91${last10}`, `${cc}${last10}`])];
  }
  return [...new Set([d, `91${d}`])];
}

const localeCache = new Map([
  ['confirm_parked', 'en'], ['retrieve', 'en'], ['skip', 'en'], ['cancel', 'en'], ['end', 'en'],
]);

async function sendTemplate(to, name, params = []) {
  const components = params.length
    ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }]
    : [];
  const cached  = localeCache.get(name);
  const locales = cached ? [cached] : ['en', 'en_US', 'en_GB'];
  let lastErr   = null;
  for (const locale of locales) {
    try {
      const res = await axios.post(WA_BASE, {
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: locale }, ...(components.length ? { components } : {}) },
      }, { headers: WA_HEADERS() });
      if (!cached) localeCache.set(name, locale);
      log('WA', 'WHATSAPP', 'Template sent', { template: name, to, locale });
      return res.data;
    } catch (e) {
      if (e.response?.data?.error?.code === 132001) { lastErr = e; continue; }
      log('ERR', 'WHATSAPP', 'Template failed', { template: name, to, error: e.message });
      throw e;
    }
  }
  throw lastErr;
}

async function sendText(to, text) {
  const res = await axios.post(WA_BASE,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: WA_HEADERS() }
  );
  log('WA', 'WHATSAPP', 'Text message sent', { to });
  return res.data;
}

function fmtTime(ts) {
  if (!ts) return null;
  try {
    const d = ts.toDate();
    return {
      iso: d.toISOString(),
      readable: d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }),
    };
  } catch (_) { return null; }
}

function docToObj(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    driver_name:          d.driver_name    || '',
    guest_phone:          d.guest_phone    || '',
    vehicle_number:       d.vehicle_number || '',
    parking_area:         d.parking_area   || '',
    parking_detail:       d.parking_detail || '',
    status:               d.status         || '',
    Entry_time:           fmtTime(d.Entry_time),
    parked_time:          fmtTime(d.parked_time),
    Retrieve_request_time: fmtTime(d.Retrieve_request_time),
    handover_time:        fmtTime(d.handover_time),
    exited_time:          fmtTime(d.exited_time),
    Retrieve_time:        d.Retrieve_time  || null,
    accepted_by:          d.accepted_by    || '',
    accepted_driver_name: d.accepted_driver_name || '',
    accepted_at:          fmtTime(d.accepted_at),
  };
}

const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: (_, cb) => cb(null, true), methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.use(morgan('dev'));
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json({ type: '*/*', limit: '10kb' })(req, res, next);
});
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 50,
  message: { error: 'Too many requests' },
  skip: req => req.path === '/webhook' || req.path === '/' || req.headers['x-api-key'] === process.env.API_SECRET_KEY,
}));
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/') return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_SECRET_KEY) {
    log('AUTH', 'SECURITY', 'Unauthorized request', { path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/', (_, res) => res.json({ status: 'OK', service: 'Wotiko Valet Backend' }));

app.get('/api/parking/all', async (_, res) => {
  try {
    const snap = await col.get();
    const data = snap.docs.map(docToObj).sort((a, b) => (b.parked_time?.iso ?? '').localeCompare(a.parked_time?.iso ?? ''));
    log('API', 'PARKING', 'Fetched all parking records', { total: data.length });
    res.json({ success: true, total: data.length, data });
  } catch (e) { log('ERR', 'PARKING', 'Failed to fetch all', { error: e.message }); res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: docToObj(doc) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/parking/check-vehicle', async (req, res) => {
  const vehicle = (req.query.vehicle || '').toUpperCase().trim();
  if (!vehicle) return res.json({ active: false });
  try {
    let isActive = false;
    for (const status of ['parked', 'retrieve_requested', 'accepted']) {
      const snap = await col.where('vehicle_number', '==', vehicle).where('status', '==', status).limit(1).get();
      if (!snap.empty) { isActive = true; break; }
    }
    res.json({ active: isActive });
  } catch (e) { res.status(500).json({ active: false, error: e.message }); }
});

app.post('/api/driver/login', async (req, res) => {
  const { uid, name, phone, fcmToken } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  try {
    await db.collection('drivers').doc(uid).set({
      name: name || '', phone: phone || '', fcmToken: fcmToken || '',
      lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/parking/park', async (req, res) => {
  const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
  if (!driver_name || !guest_phone || !vehicle_number || !parking_area)
    return res.status(400).json({ success: false, error: 'Missing fields' });
  const now = admin.firestore.FieldValue.serverTimestamp();
  try {
    const ref = await col.add({
      driver_name:    sanitize(driver_name),
      guest_phone:    sanitize(guest_phone),
      vehicle_number: sanitize(vehicle_number).toUpperCase(),
      parking_area:   sanitize(parking_area).toUpperCase(),
      parking_detail: sanitize(parking_detail || ''),
      status: 'parked', Entry_time: now, parked_time: now,
      Retrieve_request_time: null, handover_time: null, exited_time: null,
      Retrieve_time: null, skip_notified: false,
      accepted_by: '', accepted_driver_name: '', accepted_at: null,
    });
    log('PARK', 'PARKING', 'Car parked', { docId: ref.id, vehicle: vehicle_number, area: parking_area });
    res.status(201).json({ success: true, docId: ref.id });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/parking/:id/status', async (req, res) => {
  const id = req.params.id;
  const { status, driverUid = '', driverName = '' } = req.body;
  const valid = ['parked', 'retrieve_requested', 'accepted', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });

  try {
    const ref = col.doc(id);
    if (status === 'accepted') {
      const result = await db.runTransaction(async tx => {
        const doc     = await tx.get(ref);
        if (!doc.exists) return { code: 404, body: { success: false, error: 'Not found' } };
        const current = doc.data()?.status;
        if (current !== 'retrieve_requested')
          return { code: 409, body: { success: false, error: `Cannot accept from status ${current}` } };
        tx.update(ref, { status: 'accepted', accepted_by: driverUid, accepted_driver_name: driverName, accepted_at: admin.firestore.FieldValue.serverTimestamp() });
        return { code: 200, body: { success: true } };
      });
      return res.status(result.code).json(result.body);
    }

    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });

    const update = { status };
    if (status === 'retrieve_requested') {
      update.Retrieve_request_time = admin.firestore.FieldValue.serverTimestamp();
      update.skip_notified = false; update.accepted_by = ''; update.accepted_driver_name = ''; update.accepted_at = null;
    }
    if (status === 'cancelled' || status === 'parked') {
      update.accepted_by = ''; update.accepted_driver_name = ''; update.accepted_at = null; update.skip_notified = false;
    }
    if (status === 'delivered') {
      const now = admin.firestore.FieldValue.serverTimestamp();
      update.handover_time = now; update.exited_time = now;
      if (doc.data().Retrieve_request_time) {
        update.Retrieve_time = `${Math.round((Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000)} min`;
      }
    }

    await ref.update(update);
    log('STATUS', 'PARKING', 'Status updated', { carId: id, status });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/send-messages', async (req, res) => {
  const { phone, type, message, templateName, bodyParams } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    if (type === 'text') { await sendText(phone, message); return res.json({ success: true }); }
    if (type === 'template') {
      if (templateName === 'confirm_parked') {
        const queued = publish(QUEUES.PARKED, { phone, carNumber: bodyParams?.[0] || '', driverName: bodyParams?.[1] || '', slotMins: bodyParams?.[2] || 5 });
        if (!queued) await sendTemplate(phone, 'confirm_parked', [bodyParams?.[0] || '', VENUE_NAME, bodyParams?.[1] || '', String(bodyParams?.[2] || 5)]);
      } else if (templateName === 'retrieve') {
        const queued = publish(QUEUES.RETRIEVE, { phone, driverName: bodyParams?.[0] || '', slotMins: bodyParams?.[1] || 5 });
        if (!queued) await sendTemplate(phone, 'retrieve', [bodyParams?.[0] || '', String(bodyParams?.[1] || 5)]);
      } else if (templateName === 'skip') {
        const queued = publish(QUEUES.SKIP, { phone, totalWait: bodyParams?.[0] || 6 });
        if (!queued) await sendTemplate(phone, 'skip', [String(bodyParams?.[0] || 6)]);
      } else if (templateName === 'cancel') {
        const queued = publish(QUEUES.CANCEL, { phone });
        if (!queued) await sendTemplate(phone, 'cancel', []);
      }
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unknown type' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /deliver-car — FIXED ───────────────────────────────────────────────────
// Fix 1: normalizePhone called once and reused everywhere
// Fix 2: WhatsApp message sent FIRST, Firestore updated after — so if WA fails
//         the driver can retry and guest still gets the message
// Fix 3: FCM payload now includes carNumber so Flutter can match the job

app.post('/deliver-car', async (req, res) => {
  const { phone, docId } = req.body;
  if (!phone || !docId) return res.status(400).json({ error: 'phone and docId required' });

  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) {
      log('WARN', 'DELIVER', 'Car not found', { docId });
      return res.status(404).json({ error: 'Car not found' });
    }

    const data      = doc.data();
    const carNumber = data.vehicle_number || '';
    const phrase    = pick(PHRASES);
    const dish      = pick(DISHES);
    const normPhone = normalizePhone(phone);  // normalize once, use everywhere

    // Step 1: Send WhatsApp end message FIRST
    // If this fails we return 500 so Flutter app can retry — guest always gets message
    const queued = publish(QUEUES.END, { phone: normPhone, carNumber, phrase, dish });
    if (!queued) {
      await sendTemplate(normPhone, 'end', [carNumber, VENUE_NAME, phrase, dish]);
    }
    log('WA', 'DELIVER', 'End message sent/queued', { docId, carNumber, to: normPhone });

    // Step 2: Update Firestore after WhatsApp succeeds
    const now    = admin.firestore.FieldValue.serverTimestamp();
    const update = { status: 'delivered', handover_time: now, exited_time: now };
    if (data.Retrieve_request_time) {
      update.Retrieve_time = `${Math.round((Date.now() - data.Retrieve_request_time.toDate().getTime()) / 60000)} min`;
    }
    await col.doc(docId).update(update);
    log('DONE', 'DELIVER', 'Car delivered + Firestore updated', { docId, carNumber });

    // WebSocket: instant delivery signal to active drivers
    broadcastDelivered(io, docId, carNumber);
    log('WS', 'DELIVER', 'WebSocket car_delivered broadcast', { docId, carNumber });

    // Step 3: Push FCM to all drivers — includes carNumber so Flutter can match job
    const snap   = await db.collection('drivers').get();
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (tokens.length) {
      await admin.messaging().sendEachForMulticast({
        data: {
          type:      'retrieve_delivered',
          carId:     String(docId),
          carNumber: String(carNumber),  // Flutter needs this to identify which job is done
        },
        android: { priority: 'high', ttl: 30000 },
        tokens,
      }).catch(e => log('ERR', 'FCM', 'Deliver multicast failed', { error: e.message }));
      log('FCM', 'PUSH', 'Delivered push sent', { docId, carNumber, tokenCount: tokens.length });
    }

    res.json({ success: true, carNumber });
  } catch (e) {
    log('ERR', 'DELIVER', 'deliver-car failed', { docId, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post('/skip-car', async (req, res) => {
  const { docId } = req.body;
  if (!docId) return res.status(400).json({ error: 'docId required' });
  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Car not found' });
    const data = doc.data();
    if (data.skip_notified === true) return res.json({ success: true, alreadyNotified: true });

    await col.doc(docId).update({ skip_notified: true });

    const phone    = data.guest_phone || '';
    const area     = (data.parking_area || 'A').toUpperCase();
    const totalWait = (SLOT_MINUTES[area] ?? 5) * 2;

    if (phone) {
      const nPhone = normalizePhone(phone);
      const queued = publish(QUEUES.SKIP, { phone: nPhone, totalWait });
      if (!queued) await sendTemplate(nPhone, 'skip', [String(totalWait)]);
    }

    log('SKIP', 'STATUS', 'Skip processed', { docId, vehicle: data.vehicle_number || '', totalWait });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    log('OK', 'WEBHOOK', 'Webhook verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook', (req, res) => {
  const sig  = req.headers['x-hub-signature-256'] || '';
  const body = req.body;
  if (sig && process.env.WA_APP_SECRET) {
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(body).digest('hex');
    if (sig !== expected) { log('WARN', 'WEBHOOK', 'Invalid signature'); return res.status(403).end(); }
  }
  res.status(200).send('OK');
  try {
    const parsed = Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
    setImmediate(() => processWebhook(parsed));
  } catch (e) { log('ERR', 'WEBHOOK', 'Parse failed', { error: e.message }); }
});

async function processWebhook(body) {
  try {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    log('IN', 'WEBHOOK', 'Incoming WhatsApp event', { type: msg.type, from });
    if (msg.type === 'button') {
      const text = (msg.button?.text || '').toLowerCase();
      if (text.includes('retrieve') && !text.includes('cancel')) await handleRetrieveCar(from);
      else if (text.includes('cancel')) await handleCancelRetrieval(from);
      return;
    }
    if (msg.type === 'interactive') {
      const id = msg.interactive?.button_reply?.id || '';
      if (id === 'retrieve_car')    await handleRetrieveCar(from);
      if (id === 'cancel_retrieval') await handleCancelRetrieval(from);
    }
  } catch (e) { log('ERR', 'WEBHOOK', 'processWebhook failed', { error: e.message }); }
}

async function handleRetrieveCar(from) {
  const variants = buildPhoneVariants(from);
  try {
    let matchedDoc = null;
    for (const ph of variants) {
      for (const st of ['parked', 'cancelled']) {
        const snap = await col.where('guest_phone', '==', ph).where('status', '==', st).limit(1).get();
        if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
      }
      if (matchedDoc) break;
    }
    if (!matchedDoc) {
      await sendText(from, 'We could not find an active parking record. Please contact our valet team.');
      return;
    }
    const data   = matchedDoc.data();
    const carId  = matchedDoc.id;
    await matchedDoc.ref.update({ status: 'retrieve_requested', Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(), skip_notified: false, accepted_by: '', accepted_driver_name: '', accepted_at: null });

    const wing        = (data.parking_area || '').toUpperCase();
    const guestMasked = maskPhone(data.guest_phone || '');
    log('REQ', 'RETRIEVE', 'Guest requested retrieval', { from, carId, vehicle: data.vehicle_number || '', wing });

    // ── Dual-channel notify: WebSocket (instant) + FCM (wake from killed) ──
    // WebSocket reaches drivers that are active/foreground instantly.
    // FCM reaches drivers whose app is killed or backgrounded.
    // Both carry the same payload so the dedup logic on the client suppresses
    // any duplicate that arrives within the 60-second window.
    const wsPayload = {
      carId,
      carNumber : data.vehicle_number || '',
      wing,
      guestMasked,
    };
    broadcastRetrieveRequest(io, wsPayload);
    log('WS', 'RETRIEVE', 'WebSocket retrieve_request broadcast', { carId });

    const fcmQueued = publish(QUEUES.FCM, { carNumber: data.vehicle_number, carId, wing, guestMasked });
    if (!fcmQueued) await sendFCMNotification(data.vehicle_number, carId, wing, guestMasked);
  } catch (e) { log('ERR', 'RETRIEVE', 'handleRetrieveCar failed', { from, error: e.message }); }
}

async function handleCancelRetrieval(from) {
  const nFrom    = normalizePhone(from);
  const variants = buildPhoneVariants(from);
  try {
    let matchedDoc = null;
    for (const ph of variants) {
      for (const status of ['retrieve_requested', 'accepted']) {
        const snap = await col.where('guest_phone', '==', ph).where('status', '==', status).limit(1).get();
        if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
      }
      if (matchedDoc) break;
    }
    if (!matchedDoc) return;

    const carId = matchedDoc.id;
    await matchedDoc.ref.update({ status: 'cancelled', accepted_by: '', accepted_driver_name: '', accepted_at: null });
    log('CANCEL', 'STATUS', 'Guest cancelled retrieval', { from: nFrom, carId });

    // WebSocket: instant cancel signal to active drivers
    broadcastCancelled(io, carId);
    log('WS', 'CANCEL', 'WebSocket retrieve_cancelled broadcast', { carId });

    const snap   = await db.collection('drivers').get();
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (tokens.length) {
      await admin.messaging().sendEachForMulticast({ data: { type: 'retrieve_cancelled', carId: String(carId) }, android: { priority: 'high', ttl: 30000 }, tokens })
        .catch(e => log('ERR', 'FCM', 'Cancel multicast failed', { error: e.message }));
    }

    setTimeout(async () => {
      try {
        await matchedDoc.ref.update({ status: 'parked', accepted_by: '', accepted_driver_name: '', accepted_at: null, skip_notified: false });
        log('RESET', 'STATUS', 'Reset to parked', { carId });
      } catch (e) { log('ERR', 'STATUS', 'Failed to reset to parked', { carId, error: e.message }); }
    }, 3000);

    const queued = publish(QUEUES.CANCEL, { phone: nFrom });
    if (!queued) await sendTemplate(nFrom, 'cancel', []);
  } catch (e) { log('ERR', 'CANCEL', 'handleCancelRetrieval failed', { from: nFrom, error: e.message }); }
}

async function sendFCMNotification(carNumber, carId, wing = '', guestMasked = 'Guest') {
  try {
    const snap   = await db.collection('drivers').get();
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) { log('WARN', 'FCM', 'No FCM tokens', { carId }); return; }

    const res = await admin.messaging().sendEachForMulticast({
      data: { type: 'retrieve_requested', carNumber: String(carNumber), carId: String(carId), wing: String(wing || ''), guestMasked: String(guestMasked || 'Guest') },
      android: { priority: 'high', ttl: 60000 },
      apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'background' }, payload: { aps: { 'content-available': 1 } } },
      tokens,
    });

    log('FCM', 'PUSH', 'Retrieve push sent', { carId, carNumber, wing, success: `${res.successCount}/${tokens.length}` });

    const invalid = [];
    res.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === 'messaging/registration-token-not-registered' || r.error?.code === 'messaging/invalid-registration-token')) invalid.push(tokens[i]);
    });

    if (invalid.length) {
      const allDrivers = await db.collection('drivers').get();
      const batch      = db.batch();
      allDrivers.docs.forEach(doc => { if (invalid.includes(doc.data().fcmToken)) batch.update(doc.ref, { fcmToken: '' }); });
      await batch.commit();
      log('CLEAN', 'FCM', 'Invalid tokens removed', { count: invalid.length });
    }
  } catch (e) { log('ERR', 'FCM', 'sendFCMNotification failed', { carId, carNumber, error: e.message }); }
}

const PORT = process.env.PORT || 8000;

// ── Create HTTP server so Express and Socket.IO share one port ─────────────
const httpServer = http.createServer(app);

// ── Socket.IO server ───────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin            : '*',          // tighten to your domain in production
    methods           : ['GET', 'POST'],
    allowedHeaders    : ['x-api-key'],
  },
  // Prefer WebSocket, fall back to long-polling for restricted networks
  transports          : ['websocket', 'polling'],
  pingTimeout         : 20_000,       // 20 s — time before declaring client gone
  pingInterval        : 10_000,       // 10 s — how often to send keep-alive ping
  connectTimeout      : 10_000,
});

// Wire all Socket.IO event handlers
initSocketHandler(io, db, admin, log);

// ── Admin: socket connection status ───────────────────────────────────────
// Secured by the existing x-api-key middleware above.
const { snapshot: socketSnapshot } = require('./socket/driverSocketStore');
app.get('/socket/status', (_, res) => res.json(socketSnapshot()));

httpServer.listen(PORT, '0.0.0.0', () =>
  log('OK', 'SERVER', 'Wotiko backend running', { port: PORT })
);
connectRabbitMQ();
