/**
 * server.js — Wotiko Valet Backend + WhatsApp Bot
 *
 * MESSAGE FLOW:
 *   MSG 1 → template: parked  [carNumber, driverName, slotMins]
 *     Flutter sends after car saved to Firestore
 *     Has "Retrieve Car" quick-reply button
 *
 *   MSG 2 → plain text OTP  (AUTO via webhook when guest taps Retrieve Car)
 *     Server sends: "On it! ...less than X mins... code: OTP"
 *     OTP stored under NORMALIZED phone (always 12-digit: 91XXXXXXXXXX)
 *     Firestore status → retrieve_requested
 *     Flutter listener → popup shown to driver
 *
 *   MSG 3 → template: delivered  [carNumber]
 *     Driver taps Deliver after correct OTP
 *
 *   Wrong OTP:
 *     Driver sees error on OTP screen
 *     Driver goes back to CarDetailsScreen manually
 *     Driver taps Verify again → /car-ready called → NEW OTP → new MSG 2
 *     Only ONE message per /car-ready call — no duplicates
 */

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const axios   = require('axios');
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

const VENUE_NAME = 'Wotiko Valet';

// Slot → minutes — MUST match Flutter kSlotMinutes
const SLOT_MINUTES = { 'A': 5, 'B': 3, 'C': 6, 'D': 7, 'E': 8, 'OTHER': 10 };

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.use(morgan('dev'));
app.use(express.json({ type: '*/*' }));

// ─────────────────────────────────────────────────────────────
// PHONE NORMALIZER
// ALL OTP store keys use normalized form: 91XXXXXXXXXX (12 digits)
// This is the single source of truth — fixes the key mismatch bug
// ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  const digits  = String(phone).replace(/[^0-9]/g, '');
  const phone10 = digits.length > 10 ? digits.slice(-10) : digits;
  return `91${phone10}`; // always 12 digits
}

function buildPhoneVariants(phone) {
  const digits  = String(phone).replace(/[^0-9]/g, '');
  const phone10 = digits.length > 10 ? digits.slice(-10) : digits;
  const phone12 = `91${phone10}`;
  return [...new Set([digits, phone10, phone12])];
}

// ─────────────────────────────────────────────────────────────
// OTP STORE  key = normalizePhone(phone) always
// ─────────────────────────────────────────────────────────────
const otpStore = new Map();

function saveOTP(phone, otp, carNumber, slotMins) {
  const key = normalizePhone(phone); // always normalized
  otpStore.set(key, {
    otp,
    carNumber,
    slotMins,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
  });
  console.log(`💾 OTP saved | key: ${key} | otp: ${otp}`);
}

function validateOTP(phone, input) {
  const key    = normalizePhone(phone); // always normalized
  const record = otpStore.get(key);
  console.log(`🔍 Validating OTP | key: ${key} | input: ${input} | stored: ${record?.otp}`);
  if (!record) return { valid: false, reason: 'No OTP found' };
  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return { valid: false, reason: 'OTP expired' };
  }
  if (record.otp !== String(input).trim())
    return { valid: false, reason: 'Wrong OTP' };
  const { carNumber, slotMins } = record;
  otpStore.delete(key); // one-time use
  return { valid: true, carNumber, slotMins };
}

function generateOTP() {
  return String(Math.floor(10 + Math.random() * 90)); // 2-digit
}

// ─────────────────────────────────────────────────────────────
// TEMPLATE LOCALE AUTO-DETECT
// Tries en → en_US → en_GB, caches the working one
// ─────────────────────────────────────────────────────────────
const templateLocaleCache = new Map();
const LOCALE_CANDIDATES   = ['en', 'en_US', 'en_GB'];

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
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name:     templateName,
          language: { code: locale },
          ...(components.length > 0 && { components }),
        },
      };
      console.log(`📤 Template: ${templateName} → ${to} | locale: ${locale} | params:`, bodyParams);
      const res = await axios.post(WA_BASE, payload, { headers: WA_HEADERS() });
      if (!cached) {
        templateLocaleCache.set(templateName, locale);
        console.log(`✅ Cached locale "${locale}" for "${templateName}"`);
      }
      return res.data;
    } catch (err) {
      if (err.response?.data?.error?.code === 132001) {
        console.warn(`⚠️ "${templateName}" not in locale "${locale}", trying next...`);
        lastError = err;
        continue;
      }
      throw err; // non-locale error — throw immediately
    }
  }
  console.error(`❌ Template "${templateName}" not found in any locale`);
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
app.get('/', (req, res) =>
  res.json({ status: 'OK', service: `${VENUE_NAME} Backend` }));

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
    console.log(`✅ Parked: ${vehicle_number} | Wing: ${parking_area}`);
    res.status(201).json({ success: true, docId: ref.id });
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
// SEND MESSAGES — called by Flutter for template messages only
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
      await sendTemplateMessage(phone, templateName, bodyParams || []);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Unknown type' });
  } catch (err) {
    console.error('❌ /send-messages:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CAR READY — Flutter calls when driver taps Verify
//
// IMPORTANT: This sends MSG 2 to the guest.
// It is called:
//   (a) First time: driver taps Verify on CarDetailsScreen
//   (b) After wrong OTP: driver goes back to CarDetailsScreen
//       and taps Verify again — this generates a NEW OTP
//
// The wrong OTP retry is handled by the driver going BACK
// to CarDetailsScreen and tapping Verify again — NOT by
// Flutter calling this endpoint automatically on wrong tap.
// This prevents duplicate messages from rapid taps.
// ─────────────────────────────────────────────────────────────
app.post('/car-ready', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber required' });

  // Normalize phone for consistent OTP store key
  const normalizedPhone = normalizePhone(phone);

  // Get slot from Firestore for correct time
  let slotMins = 5; // default
  try {
    const phoneVariants = buildPhoneVariants(phone);
    for (const ph of phoneVariants) {
      const snap = await col
        .where('guest_phone', '==', ph)
        .where('vehicle_number', '==', carNumber.toUpperCase())
        .limit(1).get();
      if (!snap.empty) {
        const area = (snap.docs[0].data().parking_area || 'A').toUpperCase();
        slotMins   = SLOT_MINUTES[area] ?? 5;
        break;
      }
    }
  } catch (_) {}

  const otp = generateOTP();
  saveOTP(normalizedPhone, otp, carNumber, slotMins); // uses normalized key

  // Generate 2 decoys
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
    // MSG 2: plain text OTP — sent ONCE per Verify tap
    const msg =
      `On it!\n` +
      `Your car should be at the main entrance in less than ${slotMins} mins.\n\n` +
      `Share this code with the driver who brings your car:\n*${otp}*\n\n` +
      `If your car is waiting for more than 10 minutes at the portico, ` +
      `we will repark the car closeby to keep the portico clear.`;

    await sendTextMessage(normalizedPhone, msg);
    console.log(`✅ MSG 2 → ${normalizedPhone} | OTP: ${otp} | ${slotMins} mins`);

    return res.json({ success: true, otp, options });
  } catch (err) {
    console.error('❌ /car-ready:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// VERIFY OTP — Flutter calls after driver taps Deliver
// ─────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, docId } = req.body;
  if (!phone || !otp)
    return res.status(400).json({ error: 'phone and otp required' });

  const result = validateOTP(phone, otp); // normalizes internally
  if (!result.valid) {
    console.log(`❌ OTP invalid for ${normalizePhone(phone)}: ${result.reason}`);
    return res.json({ success: false, reason: result.reason });
  }

  console.log(`✅ OTP verified | ${normalizePhone(phone)} | Car: ${result.carNumber}`);

  try {
    // MSG 3: delivered template — {{1}} = carNumber
    await sendTemplateMessage(normalizePhone(phone), 'delivered', [result.carNumber]);
    console.log(`✅ MSG 3 (delivered) → ${normalizePhone(phone)}`);

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
    console.error('❌ /verify-otp:', err.response?.data || err.message);
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
    console.log(`💬 TYPE: ${message.type} | FROM: ${from}`);

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
    console.error('💥 Webhook error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RETRIEVE CAR HANDLER
// Guest taps "Retrieve Car" button in WhatsApp →
//   1. Find car in Firestore
//   2. Generate OTP, store under normalized phone key
//   3. Send MSG 2 plain text to guest — EXACTLY ONCE
//   4. Update Firestore → retrieve_requested
//   5. FCM push to driver
// ─────────────────────────────────────────────────────────────
async function handleRetrieveCar(from) {
  console.log(`🚗 Retrieve from: ${from}`);
  const normalizedFrom = normalizePhone(from);
  const phoneVariants  = buildPhoneVariants(from);

  try {
    let matchedDoc = null;
    for (const ph of phoneVariants) {
      const snap = await col
        .where('guest_phone', '==', ph)
        .where('status', '==', 'parked')
        .limit(1).get();
      if (!snap.empty) { matchedDoc = snap.docs[0]; break; }
    }

    if (!matchedDoc) {
      console.log(`⚠️ No parked car for: ${phoneVariants.join(', ')}`);
      await sendTextMessage(from,
        'We could not find an active parking record. Please contact our valet team.');
      return;
    }

    const carData   = matchedDoc.data();
    const carNumber = carData.vehicle_number || '';
    const carId     = matchedDoc.id;
    const area      = (carData.parking_area || 'A').toUpperCase();
    const slotMins  = SLOT_MINUTES[area] ?? 5;

    // Generate OTP — stored under normalized phone key
    const otp = generateOTP();
    saveOTP(normalizedFrom, otp, carNumber, slotMins);

    // MSG 2 — send ONCE
    const msg =
      `On it!\n` +
      `Your car should be at the main entrance in less than ${slotMins} mins.\n\n` +
      `Share this code with the driver who brings your car:\n*${otp}*\n\n` +
      `If your car is waiting for more than 10 minutes at the portico, ` +
      `we will repark the car closeby to keep the portico clear.`;

    await sendTextMessage(normalizedFrom, msg);
    console.log(`✅ MSG 2 → ${normalizedFrom} | OTP: ${otp} | ${slotMins} mins`);

    // Update Firestore
    await matchedDoc.ref.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Firestore: retrieve_requested | Car: ${carNumber} | ID: ${carId}`);

    // FCM push
    await sendFCMNotification(carNumber, carId);

  } catch (err) {
    console.error('❌ handleRetrieveCar:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// FCM — data-only push
// ─────────────────────────────────────────────────────────────
async function sendFCMNotification(carNumber, carId) {
  try {
    const tokensSnap = await db.collection('fcm_tokens').get();
    if (tokensSnap.empty) { console.log('⚠️ No FCM tokens'); return; }
    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return;

    const response = await admin.messaging().sendEachForMulticast({
      data: {
        type:      'retrieve_requested',
        carNumber: String(carNumber),
        carId:     String(carId),
        title:     'Car Retrieve Request',
        body:      `Vehicle ${carNumber} — guest is waiting`,
      },
      android: { priority: 'high', ttl: 60000 },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } },
      },
      tokens,
    });
    console.log(`✅ FCM — success: ${response.successCount}/${tokens.length}`);
    response.responses.forEach((r, i) => {
      if (!r.success) console.warn(`  ❌ Token[${i}]: ${r.error?.code}`);
    });
  } catch (err) {
    console.error('❌ FCM error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = 8000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏨 ${VENUE_NAME} Backend`);
  console.log(`🚀 http://139.59.75.67:${PORT}`);
  console.log(`📲 POST /send-messages → template messages`);
  console.log(`🚗 POST /car-ready     → OTP + MSG 2`);
  console.log(`✅ POST /verify-otp    → validate + MSG 3`);
  console.log(`🔗 POST /webhook       → WhatsApp events\n`);
});
