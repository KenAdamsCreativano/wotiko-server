/**
 * server.js — Wotiko Valet Backend + WhatsApp Bot
 *
 * FIXES IN THIS VERSION:
 *   1. Template language code: 'en' → 'en_US'
 *      Meta requires exact locale codes. 'en' alone causes
 *      "template does not exist" even if the template name is correct.
 *
 *   2. FCM payload: data-only (no `notification` key)
 *      When app is CLOSED on Android, system intercepts messages
 *      that have a `notification` key and shows its own notification,
 *      skipping Flutter's _onBackgroundMessage entirely.
 *      Data-only messages always reach _onBackgroundMessage so Flutter
 *      can show the notification with the correct channel + sound.
 *
 *   3. carId included in FCM data so Flutter opens correct car screen.
 */

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const axios   = require('axios');
require('dotenv').config();

// ── Firebase ───────────────────────────────────────────────────
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

// ── WhatsApp config ────────────────────────────────────────────
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY   = process.env.WEBHOOK_VERIFY_TOKEN || 'my-verify-token';
const WA_BASE     = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
const WA_HEADERS  = () => ({
  Authorization:  `Bearer ${WA_TOKEN}`,
  'Content-Type': 'application/json',
});

const VENUE_NAME = 'Wotiko Valet';

// ── Express ────────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.use(morgan('dev'));
app.use(express.json({ type: '*/*' }));

// ─────────────────────────────────────────────────────────────
// OTP STORE
// ─────────────────────────────────────────────────────────────
const otpStore = new Map();

function saveOTP(phone, otp, carNumber) {
  otpStore.set(phone, { otp, carNumber, expiresAt: Date.now() + 10 * 60 * 1000 });
}

function validateOTP(phone, input) {
  const record = otpStore.get(phone);
  if (!record) return { valid: false, reason: 'No OTP found' };
  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return { valid: false, reason: 'OTP expired' };
  }
  if (record.otp !== String(input).trim()) return { valid: false, reason: 'Wrong OTP' };
  const carNumber = record.carNumber;
  otpStore.delete(phone);
  return { valid: true, carNumber };
}

function generateOTP() {
  return String(Math.floor(10 + Math.random() * 90));
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function docToObj(doc) {
  const d = doc.data();
  return {
    id:                    doc.id,
    driver_name:           d.driver_name           || '',
    guest_phone:           d.guest_phone           || '',
    vehicle_number:        d.vehicle_number        || '',
    parking_area:          d.parking_area          || '',
    parking_detail:        d.parking_detail        || '',
    status:                d.status                || '',
    otp:                   d.otp                   || null,
    Entry_time:            fmtTime(d.Entry_time),
    parked_time:           fmtTime(d.parked_time),
    Retrieve_request_time: fmtTime(d.Retrieve_request_time),
    handover_time:         fmtTime(d.handover_time),
    exited_time:           fmtTime(d.exited_time),
    Retrieve_time:         d.Retrieve_time         || null,
  };
}

function fmtTime(ts) {
  if (!ts) return null;
  try {
    const d = ts.toDate();
    return {
      iso:      d.toISOString(),
      readable: d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      }),
    };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'OK', service: `${VENUE_NAME} Backend + WhatsApp Bot` });
});

// ─────────────────────────────────────────────────────────────
// PARKING ROUTES
// ─────────────────────────────────────────────────────────────
app.get('/api/parking/all', async (req, res) => {
  try {
    const snap = await col.get();
    const data = snap.docs.map(docToObj).sort((a, b) => {
      const ta = a.parked_time?.iso ?? '';
      const tb = b.parked_time?.iso ?? '';
      return tb.localeCompare(ta);
    });
    res.json({ success: true, total: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: docToObj(doc) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/parking/park', async (req, res) => {
  const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
  if (!driver_name || !guest_phone || !vehicle_number || !parking_area)
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  const now = admin.firestore.FieldValue.serverTimestamp();
  try {
    const ref = await col.add({
      driver_name,
      guest_phone,
      vehicle_number:        vehicle_number.toUpperCase(),
      parking_area:          parking_area.toUpperCase(),
      parking_detail:        parking_detail || '',
      status:                'parked',
      otp:                   null,
      Entry_time:            now,
      parked_time:           now,
      Retrieve_request_time: null,
      handover_time:         null,
      exited_time:           null,
      Retrieve_time:         null,
    });
    console.log(`✅ Parked: ${vehicle_number} | Wing: ${parking_area} | Phone: ${guest_phone}`);
    res.status(201).json({
      success: true,
      docId:   ref.id,
      message: `Car ${vehicle_number.toUpperCase()} parked in Wing ${parking_area} ✅`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/parking/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['parked', 'retrieve_requested', 'accepted', 'delivered'];
  if (!allowed.includes(status))
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
      const data = doc.data();
      if (data.Retrieve_request_time) {
        const diffMins = Math.round(
          (Date.now() - data.Retrieve_request_time.toDate().getTime()) / 60000
        );
        update.Retrieve_time = `${diffMins} min`;
      }
    }
    await ref.update(update);
    res.json({ success: true, message: `Status → ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    await col.doc(req.params.id).delete();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SEND MESSAGES
// ─────────────────────────────────────────────────────────────
app.post('/send-messages', async (req, res) => {
  const { phone, type, message, templateName, bodyParams } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  try {
    if (type === 'text') {
      if (!message) return res.status(400).json({ error: 'message is required' });
      await sendTextMessage(phone, message);
      return res.json({ success: true, type: 'text' });
    }
    if (type === 'template') {
      if (!templateName) return res.status(400).json({ error: 'templateName is required' });
      await sendTemplateMessage(phone, templateName, bodyParams || []);
      console.log(`✅ Template "${templateName}" → ${phone}`);
      return res.json({ success: true, type: 'template' });
    }
    return res.status(400).json({ error: `Unknown type: ${type}` });
  } catch (err) {
    console.error('❌ /send-messages error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CAR READY
// ─────────────────────────────────────────────────────────────
app.post('/car-ready', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber are required' });
  const otp = generateOTP();
  saveOTP(phone, otp, carNumber);
  console.log(`🔑 OTP for ${phone}: ${otp}`);
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
  try {
    const otpMessage =
      `Your car *${carNumber}* is now at the main entrance and ready for pickup.\n\n` +
      `Please show the code *${otp}* to the valet executive to collect your vehicle.\n\n` +
      `We hope you enjoyed your experience at ${VENUE_NAME}!`;
    await sendTextMessage(phone, otpMessage);
    console.log(`✅ MSG 4 (OTP text) → ${phone} | OTP: ${otp} | Car: ${carNumber}`);
    return res.json({ success: true, otp, options });
  } catch (err) {
    console.error('❌ /car-ready error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// VERIFY OTP
// ─────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, docId } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'phone and otp are required' });
  const result = validateOTP(phone, otp);
  if (!result.valid) {
    console.log(`❌ OTP wrong for ${phone}: ${result.reason}`);
    return res.json({ success: false, reason: result.reason });
  }
  console.log(`✅ OTP verified | ${phone} | Car: ${result.carNumber}`);
  try {
    await sendTemplateMessage(phone, 'handover_complete', [VENUE_NAME, result.carNumber]);
    console.log(`✅ MSG 5 (handover_complete) → ${phone}`);
    if (docId) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ref = col.doc(docId);
      const doc = await ref.get();
      const update = { status: 'delivered', handover_time: now, exited_time: now };
      if (doc.exists && doc.data().Retrieve_request_time) {
        const diffMins = Math.round(
          (Date.now() - doc.data().Retrieve_request_time.toDate().getTime()) / 60000
        );
        update.Retrieve_time = `${diffMins} min`;
      }
      await ref.update(update);
      console.log(`✅ Firestore delivered | docId: ${docId}`);
    }
    return res.json({ success: true, carNumber: result.carNumber });
  } catch (err) {
    console.error('❌ /verify-otp error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    console.log('✅ Webhook verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  setImmediate(() => processIncomingMessage(req.body));
});

async function processIncomingMessage(body) {
  try {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      const status = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
      if (status) console.log(`📊 Status: ${status.status}`);
      return;
    }
    const from = message.from;
    console.log(`💬 MSG TYPE: ${message.type} | FROM: ${from}`);
    if (message.type === 'button') {
      const text = (message.button?.text || '').toLowerCase().trim();
      if (text.includes('retrieve') || text === 'retrieve car') await handleRetrieveCar(from);
      return;
    }
    if (message.type === 'interactive') {
      const id = message.interactive.button_reply?.id;
      if (id === 'retrieve_car') await handleRetrieveCar(from);
      return;
    }
    if (message.type === 'text') {
      const lower = message.text.body.trim().toLowerCase();
      if (lower === 'hi' || lower === 'hello') {
        await sendTextMessage(from, `👋 Welcome to *${VENUE_NAME}*!\n\nOur valet team is ready to assist you.`);
      }
    }
  } catch (err) {
    console.error('💥 Webhook error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RETRIEVE CAR HANDLER
// ─────────────────────────────────────────────────────────────
async function handleRetrieveCar(from) {
  console.log(`🚗 Retrieve Car from: ${from}`);
  const digits        = from.replace(/[^0-9]/g, '');
  const phone10       = digits.length > 10 ? digits.slice(-10) : digits;
  const phone12       = `91${phone10}`;
  const phoneVariants = [...new Set([digits, phone10, phone12])];
  try {
    let matchedDoc = null;
    for (const ph of phoneVariants) {
      const snap = await col.where('guest_phone', '==', ph).where('status', '==', 'parked').limit(1).get();
      if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
    }
    if (!matchedDoc) {
      await sendTextMessage(from, 'We could not find an active parking record. Please contact our valet team.');
      return;
    }
    const carData   = matchedDoc.data();
    const carNumber = carData.vehicle_number || '';
    const carId     = matchedDoc.id;

    await sendTemplateMessage(from, 'retrieval_progress', [carNumber]);
    console.log(`✅ MSG 3 (retrieval_progress) → ${from} | Car: ${carNumber}`);

    await matchedDoc.ref.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Firestore: retrieve_requested | Car: ${carNumber} | ID: ${carId}`);

    await sendFCMNotification(carNumber, carId);
  } catch (err) {
    console.error('❌ handleRetrieveCar error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// TEMPLATE LANGUAGE CACHE
// Remembers which locale worked for each template so we don't
// retry every time. Persists for the lifetime of the process.
// ─────────────────────────────────────────────────────────────
const templateLocaleCache = new Map();

// All locales to try in order — covers every WhatsApp template
// language option available in Meta Business Manager
const LOCALE_CANDIDATES = ['en', 'en_US', 'en_GB'];

// ─────────────────────────────────────────────────────────────
// WHATSAPP HELPERS
// ─────────────────────────────────────────────────────────────
async function sendTextMessage(to, text) {
  const res = await axios.post(WA_BASE,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: WA_HEADERS() });
  return res.data;
}

// Tries each locale candidate until one works, then caches it.
// This means regardless of which language you picked in Meta,
// it will find it automatically and remember it forever.
async function sendTemplateMessage(to, templateName, bodyParams = []) {
  const components = bodyParams.length > 0
    ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
    : [];

  // Use cached locale if we already found it for this template
  const cached = templateLocaleCache.get(templateName);
  const locales = cached ? [cached] : LOCALE_CANDIDATES;

  let lastError = null;

  for (const locale of locales) {
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name:     templateName,
        language: { code: locale },
        ...(components.length > 0 && { components }),
      },
    };

    try {
      console.log(`📤 Template: ${templateName} → ${to} | locale: ${locale} | params:`, bodyParams);
      const res = await axios.post(WA_BASE, payload, { headers: WA_HEADERS() });
      // Success — cache this locale for next time
      if (!cached) {
        templateLocaleCache.set(templateName, locale);
        console.log(`✅ Cached locale "${locale}" for template "${templateName}"`);
      }
      return res.data;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      // 132001 = template not found in this locale — try next locale
      if (code === 132001) {
        console.warn(`⚠️  Template "${templateName}" not found in locale "${locale}", trying next...`);
        lastError = err;
        continue;
      }
      // Any other error (bad token, rate limit etc) — throw immediately
      throw err;
    }
  }

  // All locales exhausted — throw the last error
  console.error(`❌ Template "${templateName}" not found in any locale: ${LOCALE_CANDIDATES.join(', ')}`);
  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// FCM — DATA-ONLY push notification
//
// FIX: Removed `notification` key entirely — data-only payload.
//
// REASON: When app is CLOSED on Android, FCM delivers any message
// that has a `notification` key directly to the system tray.
// Flutter's _onBackgroundMessage handler is NEVER called.
// Your custom channel (wotiko_retrieve_v3) and ringtone are skipped.
//
// With DATA-ONLY messages, FCM always calls _onBackgroundMessage
// in main.dart regardless of app state. Flutter then calls
// showRetrieveNotification() which uses wotiko_retrieve_v3 channel
// with your custom retrieval ringtone — exactly as intended.
//
// All data values must be strings (FCM requirement).
// ─────────────────────────────────────────────────────────────
async function sendFCMNotification(carNumber, carId) {
  try {
    const tokensSnap = await db.collection('fcm_tokens').get();
    if (tokensSnap.empty) { console.log('⚠️ No FCM tokens'); return; }
    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return;

    console.log(`📲 FCM → ${tokens.length} device(s) | Car: ${carNumber} | ID: ${carId}`);

    const message = {
      // NO `notification` key — data-only so Flutter handles it
      data: {
        type:      'retrieve_requested',
        carNumber: String(carNumber),
        carId:     String(carId),
        title:     'Car Retrieve Request',
        body:      `Vehicle ${carNumber} — guest is waiting`,
      },
      android: {
        priority: 'high', // wakes device even when app is closed
        ttl:      60000,  // drop after 60s if undelivered
      },
      apns: {
        headers: {
          'apns-priority':  '10',
          'apns-push-type': 'background',
        },
        payload: {
          aps: { 'content-available': 1 }, // wakes iOS in background
        },
      },
      tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ FCM — success: ${response.successCount} / ${tokens.length}`);
    if (response.failureCount > 0) {
      response.responses.forEach((r, i) => {
        if (!r.success) console.warn(`  ❌ Token[${i}]: ${r.error?.code} — ${r.error?.message}`);
      });
    }
  } catch (err) {
    console.error('❌ FCM error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏨 ${VENUE_NAME} Backend + WhatsApp Bot`);
  console.log(`🚀 Running on http://139.59.75.67:${PORT}`);
  console.log(`📲 POST /send-messages → send WhatsApp msg`);
  console.log(`🚗 POST /car-ready     → generate OTP + send to guest`);
  console.log(`✅ POST /verify-otp    → validate OTP + mark delivered`);
  console.log(`🔗 POST /webhook       → receive WhatsApp events\n`);
});
