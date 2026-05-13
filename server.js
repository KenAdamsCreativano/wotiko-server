/**
 * server.js — Wotiko Valet Backend  (v2 — Queue Edition)
 * ...
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const amqp      = require('amqplib');
const http      = require('http');
require('dotenv').config();

const { initSocket }                               = require('./modules/socket');
const { sendFCMToTokens, sendFCMToAllExcept,
        sendFCMAdapter }                            = require('./modules/fcm');
const { buildDriverQueue, assignNext, handleSkip,
        handleAccept, handleCancel }                = require('./modules/queueManager');

function log(emoji, category, message, meta = {}) {
  const ts   = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  const metaStr = Object.keys(meta).length
    ? '  ' + Object.entries(meta).map(([k,v]) => `${k}:${v}`).join(' | ')
    : '';
  console.log(`[${ts}] ${emoji} [${category}]  ${message}${metaStr}`);
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
console.log('✅ Firebase Admin initialized');

const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY   = process.env.WEBHOOK_VERIFY_TOKEN || 'my-verify-token';
const WA_BASE     = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
const WA_HEADERS  = () => ({
  Authorization:  `Bearer ${WA_TOKEN}`,
  'Content-Type': 'application/json',
});

const VENUE_NAME   = 'Creativano';
const SLOT_MINUTES = { 'A': 5, 'B': 5, 'C': 5, 'D': 5, 'E': 5, 'OTHER': 5 };

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
    conn.on('close', () => {
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

  worker(QUEUES.PARKED,   j => sendTemplate(j.phone, 'confirm_parked',
    [j.carNumber, VENUE_NAME, j.driverName, String(j.slotMins)]));
  worker(QUEUES.RETRIEVE, j => sendTemplate(j.phone, 'retrieve',
    [j.driverName, String(j.slotMins)]));
  worker(QUEUES.SKIP,     j => sendTemplate(j.phone, 'skip',
    [String(j.totalWait)]), 3, 15000);
  worker(QUEUES.CANCEL,   j => sendTemplate(j.phone, 'cancel', []), 3, 15000);
  worker(QUEUES.END,      j => sendTemplate(j.phone, 'test_end', []));
  worker(QUEUES.FCM,      j => sendFCMNotification(j.carNumber, j.carId, j.wing || '', j.guestMasked || 'Guest'), 2, 10000);

  console.log('✅ All workers started');
}

const app        = express();
const httpServer = http.createServer(app);
const io         = initSocket(httpServer);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = ['https://server.wotiko.com', 'http://localhost'];
    if (!origin || allowed.some(a => origin.startsWith(a))) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  methods: ['GET','POST','PATCH','DELETE'],
}));
app.use(morgan('dev'));
app.use(express.json({ type: '*/*', limit: '10kb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      50,
  message:  { error: 'Too many requests' },
  skip: (req) => {
    if (req.path === '/webhook') return true;
    if (req.path === '/')        return true;
    const key = req.headers['x-api-key'];
    if (key && key === process.env.API_SECRET_KEY) return true;
    return false;
  },
}));

app.use((req, res, next) => {
  const blocked = ['.env','passwd','wp-admin','phpmyadmin','.git','xmlrpc'];
  if (blocked.some(b => req.path.includes(b))) return res.status(404).end();
  next();
});

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

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'&]/g, '').substring(0, 200);
}

function normalizePhone(p) {
  const d = String(p).replace(/[^0-9]/g, '');
  if (d.length === 10) return `91${d}`;
  return d;
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
  ['confirm_parked','en'],['retrieve','en'],['skip','en'],['cancel','en'],['test_end','en'],
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
      log('💬', 'WHATSAPP', `Template sent`, { template: name, to });
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

function fmtTime(ts) {
  if (!ts) return null;
  try {
    const d = ts.toDate();
    return {
      iso:      d.toISOString(),
      readable: d.toLocaleString('en-IN', {
        timeZone:'Asia/Kolkata', day:'2-digit', month:'short',
        year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true,
      }),
    };
  } catch (_) { return null; }
}

function docToObj(doc) {
  const d = doc.data();
  return {
    id:                    doc.id,
    driver_name:           d.driver_name       || '',
    guest_phone:           d.guest_phone        || '',
    vehicle_number:        d.vehicle_number     || '',
    parking_area:          d.parking_area       || '',
    parking_detail:        d.parking_detail     || '',
    status:                d.status             || '',
    assignedDriverUid:     d.assignedDriverUid  || null,
    Entry_time:            fmtTime(d.Entry_time),
    parked_time:           fmtTime(d.parked_time),
    Retrieve_request_time: fmtTime(d.Retrieve_request_time),
    handover_time:         fmtTime(d.handover_time),
    exited_time:           fmtTime(d.exited_time),
    Retrieve_time:         d.Retrieve_time      || null,
  };
}

app.get('/', (_, res) =>
  res.json({ status: 'OK', service: 'Wotiko Valet Backend v2' }));

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

app.post('/api/driver/login', async (req, res) => {
  const { uid, name, phone, fcmToken } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  try {
    await db.collection('drivers').doc(uid).set({
      name:       name     || '',
      phone:      phone    || '',
      fcmToken:   fcmToken || '',
      isOnline:   true,
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
      lastLogin:  admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    log('👤', 'LOGIN', `Driver logged in`, { name: name || uid, phone: phone || 'N/A' });
    res.json({ success: true });
  } catch (e) {
    log('❌', 'LOGIN', `Driver login failed`, { uid, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/driver/heartbeat', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });
  try {
    await db.collection('drivers').doc(uid).update({
      isOnline:   true,
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
    });
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
      driver_name:           sanitize(driver_name),
      guest_phone:           sanitize(guest_phone),
      vehicle_number:        sanitize(vehicle_number).toUpperCase(),
      parking_area:          sanitize(parking_area).toUpperCase(),
      parking_detail:        sanitize(parking_detail || ''),
      status:                'parked',
      Entry_time:            now,
      parked_time:           now,
      Retrieve_request_time: null,
      handover_time:         null,
      exited_time:           null,
      Retrieve_time:         null,
    });
    log('🚗', 'PARK', `Car parked`, {
      driver: driver_name, vehicle: vehicle_number,
      wing: parking_area, guest: guest_phone, docId: ref.id,
    });
    res.status(201).json({ success: true, docId: ref.id });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/parking/:id/status', async (req, res) => {
  const { status, driverUid } = req.body;
  const carId = req.params.id;
  const valid = ['parked','retrieve_requested','accepted','delivered','cancelled'];
  if (!valid.includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });

  try {
    if (status === 'accepted') {
      const uid    = driverUid || '';
      const result = await handleAccept(
        carId,
        uid,
        (data, excludeUid) => sendFCMToAllExcept(data, excludeUid),
        io
      );
      if (result.conflict) {
        return res.status(409).json({
          success:  false,
          conflict: true,
          error:    'Another driver accepted first',
        });
      }
      if (!result.success) return res.status(404).json({ success: false, error: 'Not found' });
      log('👤', 'ACCEPT', `Driver accepted`, { carId, driver: uid });
      return res.json({ success: true });
    }

    const ref = col.doc(carId);
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
        const queued = publish(QUEUES.PARKED, {
          phone, carNumber: bodyParams?.[0] || '',
          driverName: bodyParams?.[1] || '', slotMins: bodyParams?.[2] || 5,
        });
        if (!queued) {
          await sendTemplate(phone, 'confirm_parked', [
            bodyParams?.[0] || '', VENUE_NAME,
            bodyParams?.[1] || '', String(bodyParams?.[2] || 5),
          ]);
        }
      } else if (templateName === 'retrieve') {
        await sendTemplate(phone, 'retrieve', [
          bodyParams?.[0] || '', String(bodyParams?.[1] || 5),
        ]);
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
  } catch (e) {
    console.error('❌ /send-messages:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/deliver-car', async (req, res) => {
  const { phone, docId } = req.body;
  if (!phone || !docId)
    return res.status(400).json({ error: 'phone and docId required' });
  try {
    const doc = await col.doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Car not found' });
    const carNumber = doc.data().vehicle_number || '';

    const queued = publish(QUEUES.END, { phone: normalizePhone(phone) });
    if (!queued) {
      await sendTemplate(normalizePhone(phone), 'test_end', []);
    }
    log('✅', 'DELIVER', `Car delivered`, { vehicle: carNumber });

    const now    = admin.firestore.FieldValue.serverTimestamp();
    const update = { status: 'delivered', handover_time: now, exited_time: now };
    if (doc.data().Retrieve_request_time) {
      update.Retrieve_time = `${Math.round(
        (Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000
      )} min`;
    }
    await col.doc(docId).update(update);
    console.log(`✅ Delivered | ${docId}`);

    const deliverSnap   = await db.collection('drivers').get();
    const deliverTokens = deliverSnap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (deliverTokens.length) {
      await sendFCMToTokens(deliverTokens,
        { type: 'retrieve_delivered', carId: String(docId) });
    }
    io.to('drivers').emit('request_taken', { carId: docId, delivered: true });

    res.json({ success: true, carNumber });
  } catch (e) {
    console.error('❌ /deliver-car:', e.message);
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

    if (data.skip_notified === true) {
      console.log(`⏭️ Skip already notified | ${docId}`);
    } else {
      await col.doc(docId).update({ skip_notified: true });
      const phone     = data.guest_phone || '';
      const area      = (data.parking_area || 'A').toUpperCase();
      const slotMins  = SLOT_MINUTES[area] ?? 5;
      const totalWait = slotMins + slotMins;
      if (phone) {
        const nPhone = normalizePhone(phone);
        await sendTemplate(nPhone, 'skip', [String(totalWait)]);
        log('⏭️', 'SKIP', `Skip message sent`,
          { vehicle: data.vehicle_number, wait: `${totalWait}min`, docId });
      }
    }

    await handleSkip(docId, sendFCMAdapter, io);

    res.json({ success: true });
  } catch (e) {
    console.error('❌ /skip-car:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    console.log('✅ Webhook verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig  = req.headers['x-hub-signature-256'] || '';
  const body = req.body;
  if (sig && process.env.WA_APP_SECRET) {
    const crypto   = require('crypto');
    const expected = 'sha256=' + crypto
      .createHmac('sha256', process.env.WA_APP_SECRET)
      .update(body)
      .digest('hex');
    if (sig !== expected) {
      console.warn('⚠️ Invalid webhook signature — rejected');
      return res.status(403).end();
    }
  }
  res.status(200).send('OK');
  const parsed = typeof body === 'string' ? JSON.parse(body)
    : (Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body);
  setImmediate(() => processWebhook(parsed));
});

async function processWebhook(body) {
  try {
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    console.log(`💬 ${msg.type} | ${from}`);
    if (msg.type === 'button') {
      const text = (msg.button?.text || '').toLowerCase();
      if (text.includes('retrieve') && !text.includes('cancel')) await handleRetrieveCar(from);
      else if (text.includes('cancel')) await handleCancelRetrieval(from);
      return;
    }
    if (msg.type === 'interactive') {
      const id = msg.interactive?.button_reply?.id || '';
      if (id === 'retrieve_car')     await handleRetrieveCar(from);
      if (id === 'cancel_retrieval') await handleCancelRetrieval(from);
    }
  } catch (e) { console.error('💥 Webhook:', e.message); }
}

async function handleRetrieveCar(from) {
  console.log(`🚗 Retrieve: ${from}`);
  const variants = buildPhoneVariants(from);
  try {
    let matchedDoc = null;
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

    const data        = matchedDoc.data();
    const carId       = matchedDoc.id;
    const wing        = (data.parking_area || '').toUpperCase();
    const guestMasked = maskPhone(data.guest_phone || '');

    const queue = await buildDriverQueue();

    log('🔔', 'RETRIEVE', `Guest requesting car`, {
      vehicle: data.vehicle_number, wing,
      driver: data.driver_name || 'unknown',
      queueLen: queue.length, docId: carId,
    });

    await matchedDoc.ref.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
      skip_notified:         false,
      isExhausted:           false,
      guestMasked,
      driverQueue:           queue,
      currentDriverIndex:    0,
      assignedDriverUid:     queue[0]?.uid || null,
    });

    if (queue.length === 0) {
      log('⚠️', 'QUEUE', `No online drivers — broadcasting to all`, { carId });
      const fcmQueued = publish(QUEUES.FCM, {
        carNumber: data.vehicle_number, carId, wing, guestMasked,
      });
      if (!fcmQueued) await sendFCMNotification(data.vehicle_number, carId, wing, guestMasked);
      return;
    }

    await assignNext(carId, sendFCMAdapter, io);

  } catch (e) { console.error('❌ handleRetrieveCar:', e.message); }
}

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

    handleCancel(carId);

    await matchedDoc.ref.update({ status: 'cancelled' });
    log('❌', 'CANCEL', `Guest cancelled retrieval`, { docId: carId });

    const cancelDriverSnap   = await db.collection('drivers').get();
    const cancelDriverTokens = cancelDriverSnap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (cancelDriverTokens.length) {
      await sendFCMToTokens(cancelDriverTokens,
        { type: 'retrieve_cancelled', carId: String(carId) });
      console.log(`✅ Cancel FCM → ${cancelDriverTokens.length} drivers`);
    }

    io.to('drivers').emit('request_cancelled', { carId });

    setTimeout(async () => {
      try {
        await matchedDoc.ref.update({ status: 'parked' });
        log('🔄', 'STATUS', `Reset to parked after cancel`, { docId: carId });
      } catch (e) { console.error('❌ Reset parked:', e.message); }
    }, 3000);

    const queued = publish(QUEUES.CANCEL, { phone: nFrom });
    if (!queued) await sendTemplate(nFrom, 'cancel', []);
    console.log(`✅ MSG5 cancel → ${nFrom}`);

  } catch (e) { console.error('❌ handleCancelRetrieval:', e.message); }
}

async function sendFCMNotification(carNumber, carId, wing = '', guestMasked = 'Guest') {
  try {
    const snap   = await db.collection('drivers').get();
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) { console.log('⚠️ No FCM tokens'); return; }

    const res = await admin.messaging().sendEachForMulticast({
      data: {
        type:        'retrieve_requested',
        carNumber:   String(carNumber),
        carId:       String(carId),
        wing:        String(wing     || ''),
        guestMasked: String(guestMasked || 'Guest'),
        requestId:   String(carId),
      },
      android: { priority: 'high', ttl: 60000 },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } },
      },
      tokens,
    });

    log('📲', 'FCM', `Push sent to drivers`, {
      success: `${res.successCount}/${tokens.length}`, vehicle: carNumber, wing,
    });
    res.responses.forEach((r, i) => {
      if (!r.success) log('❌', 'FCM', `Token failed`, { index: i, error: r.error?.code });
    });
  } catch (e) { console.error('❌ FCM:', e.message); }
}

const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏨 Wotiko Valet Backend v2 | Port ${PORT}`);
  console.log(`🚦 Queue: sequential assignment → skip/timeout → next → broadcast fallback`);
  console.log(`🔌 Socket.IO: real-time delivery when app is open`);
  console.log(`📲 MSG1:confirm_parked MSG2:retrieve MSG4:skip MSG5:cancel MSG6:test_end`);
  console.log(`🔗 Webhook: RetrieveCar→Queue | CancelRetrieval→cancelled→parked(3s)\n`);
});

connectRabbitMQ();
