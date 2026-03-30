/**
 * server.js — Wotiko Valet Backend + WhatsApp Bot
 */

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const axios   = require('axios');
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

const VENUE_NAME   = 'Wotiko Valet';
const SLOT_MINUTES = { 'A': 2, 'B': 2, 'C': 3, 'D': 4, 'E': 5, 'OTHER': 6 };

// ── Farewell message variable pools ──────────────────────────
const V1_OPTIONS = [
  "Next time you're here,",
  'On your next visit,',
  "Next time, don't miss this -",
  'Next time',
  'For your next experience,',
];

const V2_OPTIONS = [
  'Our team absolutely loves the',
  'A team favourite is the',
  'Our team is obsessed with the',
  'Our team recommends the',
  "Our team's top pick is the",
];

const V3_OPTIONS = [
  'Truffle Garlic Fried Rice',
  'Curry Butter Garlic Prawns',
  'Dragon Chicken',
  'Chicken Quesadillas',
  'Pan Grilled Salmon',
];

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }));
app.use(morgan('dev'));
app.use(express.json({ type: '*/*' }));

// ─────────────────────────────────────────────────────────────
// PHONE NORMALIZER
// ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  const digits  = String(phone).replace(/[^0-9]/g, '');
  const phone10 = digits.length > 10 ? digits.slice(-10) : digits;
  return `91${phone10}`;
}

function buildPhoneVariants(phone) {
  const digits  = String(phone).replace(/[^0-9]/g, '');
  const phone10 = digits.length > 10 ? digits.slice(-10) : digits;
  return [...new Set([digits, phone10, `91${phone10}`])];
}

// ─────────────────────────────────────────────────────────────
// OTP STORE — Firestore-backed (survives server restarts)
// Collection: otp_store  |  Doc ID: normalizedPhone
// ─────────────────────────────────────────────────────────────
const otpCol = () => db.collection('otp_store');

async function saveOTP(phone, otp, carNumber, slotMins, options) {
  const key = normalizePhone(phone);
  await otpCol().doc(key).set({
    otp, carNumber, slotMins, options,
    expiresAt: Date.now() + 15 * 60 * 1000,
    savedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`💾 OTP saved (Firestore) | ${key} | ${otp}`);
}

async function getStoredOTP(phone) {
  const key  = normalizePhone(phone);
  const snap = await otpCol().doc(key).get();
  if (!snap.exists) return null;
  const record = snap.data();
  if (Date.now() > record.expiresAt) {
    await otpCol().doc(key).delete();
    return null;
  }
  return record;
}

async function validateAndConsumeOTP(phone, input) {
  const key  = normalizePhone(phone);
  const snap = await otpCol().doc(key).get();
  console.log(`🔍 OTP validate | ${key} | input:${input} stored:${snap.data()?.otp}`);
  if (!snap.exists) return { valid: false, reason: 'No OTP found' };
  const record = snap.data();
  if (Date.now() > record.expiresAt) {
    await otpCol().doc(key).delete();
    return { valid: false, reason: 'OTP expired' };
  }
  if (record.otp !== String(input).trim())
    return { valid: false, reason: 'Wrong OTP' };
  const { carNumber } = record;
  await otpCol().doc(key).delete();
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
// TEMPLATE LOCALE AUTO-DETECT
// ─────────────────────────────────────────────────────────────
const templateLocaleCache = new Map();
// Pre-seed known template locales — skips trial-and-error on every call
templateLocaleCache.set('wrong_otp', 'en_US');
templateLocaleCache.set('parked',    'en_US');
templateLocaleCache.set('delivered', 'en_US');
const LOCALE_CANDIDATES   = ['en_US', 'en', 'en_GB'];

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
    driver_name:           d.driver_name  || '',
    guest_phone:           d.guest_phone  || '',
    vehicle_number:        d.vehicle_number || '',
    parking_area:          d.parking_area || '',
    parking_detail:        d.parking_detail || '',
    status:                d.status || '',
    otp:                   d.otp || null,
    Entry_time:            fmtTime(d.Entry_time),
    parked_time:           fmtTime(d.parked_time),
    Retrieve_request_time: fmtTime(d.Retrieve_request_time),
    handover_time:         fmtTime(d.handover_time),
    exited_time:           fmtTime(d.exited_time),
    Retrieve_time:         d.Retrieve_time || null,
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
// SEND MESSAGES — Flutter calls for MSG 1 (parked template)
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
// GET OTP — Flutter calls when driver taps Verify
// ─────────────────────────────────────────────────────────────
app.post('/get-otp', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber required' });

  const record = await getStoredOTP(phone);
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
// 1. Generate fresh OTP + options
// 2. Send wrong_otp template to guest with new code
// 3. Save new OTP — replaces old one
// ─────────────────────────────────────────────────────────────
app.post('/wrong-otp', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber required' });

  const normalizedPhone = normalizePhone(phone);
  const newOtp          = generateOTP();
  const newOptions      = makeOptions(newOtp);

  // Save new OTP — overwrites old one
  await saveOTP(normalizedPhone, newOtp, carNumber, 5, newOptions);

  try {
    // Hardcoded en_US — bypass locale detection for wrong_otp
    const wrongOtpPayload = {
      messaging_product: 'whatsapp',
      to:   normalizedPhone,
      type: 'template',
      template: {
        name:     'wrong_otp',
        language: { code: 'en_US' },
        components: [{
          type:       'body',
          parameters: [{ type: 'text', text: String(newOtp) }],
        }],
      },
    };
    await axios.post(WA_BASE, wrongOtpPayload, { headers: WA_HEADERS() });
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
// Variables picked randomly from pools — Flutter values ignored
// ─────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, docId } = req.body;
  if (!phone || !otp)
    return res.status(400).json({ error: 'phone and otp required' });

  const result = await validateAndConsumeOTP(phone, otp);
  if (!result.valid) {
    console.log(`❌ OTP invalid: ${result.reason}`);
    return res.json({ success: false, reason: result.reason });
  }

  console.log(`✅ OTP verified | Car: ${result.carNumber}`);

  // Pick variables randomly from pools
  const phrase   = randomPick(V1_OPTIONS);
  const teamLine = randomPick(V2_OPTIONS);
  const dish     = randomPick(V3_OPTIONS);

  console.log(`🎲 Farewell vars → v1:"${phrase}" v2:"${teamLine}" v3:"${dish}"`);

  try {
    // MSG 3: delivered template
    // {{1}}=carNumber, {{2}}=phrase, {{3}}=teamLine, {{4}}=dish
    await sendTemplateMessage(normalizePhone(phone), 'delivered', [
      result.carNumber,
      phrase,
      teamLine,
      dish,
    ]);
    console.log(`✅ MSG 3 (delivered) → ${normalizePhone(phone)} | Car: ${result.carNumber}`);

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
// WEBHOOK RECEIVE
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
    await saveOTP(normalizedFrom, otp, carNumber, slotMins, options);

    const msg =
      `On it!\n` +
      `Your car should be at the main entrance in less than ${slotMins} mins.\n\n` +
      `Share this code with the driver who brings your car:\n*${otp}*\n\n` +
      `If your car is waiting for more than 10 minutes at the portico, ` +
      `we will repark the car closeby to keep the portico clear.`;

    await sendTextMessage(normalizedFrom, msg);
    console.log(`✅ MSG 2 → ${normalizedFrom} | OTP:${otp} | ${slotMins}min`);

    await matchedDoc.ref.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Firestore: retrieve_requested | ${carNumber} | ${carId}`);

    await sendFCMNotification(carNumber, carId);

  } catch (err) {
    console.error('❌ handleRetrieveCar:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// FCM
// ─────────────────────────────────────────────────────────────
async function sendFCMNotification(carNumber, carId) {
  try {
    const snap = await db.collection('fcm_tokens').get();
    if (snap.empty) { console.log('⚠️ No FCM tokens'); return; }
    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return;

    const response = await admin.messaging().sendEachForMulticast({
      data: {
        type: 'retrieve_requested',
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
  console.log(`📲 /send-messages → MSG 1 parked template`);
  console.log(`🔑 /get-otp       → get circles, no WA msg`);
  console.log(`⚠️  /wrong-otp    → new OTP + wrong_otp template`);
  console.log(`✅ /verify-otp    → MSG 3 delivered (random vars) + Firestore`);
  console.log(`🔗 /webhook       → MSG 2 auto on Retrieve Car\n`);
});
