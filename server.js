/**
 * server.js — Wotiko Valet Backend + WhatsApp Bot
 *
 * Firestore fields:
 *   driver_name, guest_phone, vehicle_number, parking_area,
 *   parking_detail, status, otp
 *   Entry_time            — when driver taps Next
 *   parked_time           — when car saved to Firestore
 *   Retrieve_request_time — when guest taps Retrieve Car on WhatsApp
 *   handover_time         — when driver taps Deliver
 *   exited_time           — same as handover_time
 *   Retrieve_time         — duration: Retrieve_request → handover
 *
 * EXACT WhatsApp flow:
 *
 *   MSG 1 → welcome_parking (template)
 *     Flutter sends after driver enters guest phone + taps Next
 *
 *   MSG 2 → parked_confirmation (template) [carNumber, slot]
 *     Flutter sends after car saved to Firestore
 *     Guest sees "Retrieve Car" quick-reply button
 *
 *   MSG 3 → retrieval_progress (template) [carNumber]  ← AUTO via webhook
 *     Guest taps "Retrieve Car" on WhatsApp
 *     Webhook fires → server sends retrieval_progress to guest
 *     Firestore status → retrieve_requested
 *     Flutter Firestore listener fires → popup appears on driver phone
 *     Driver taps Accept → CarDetailsScreen shown (NO message to guest here)
 *
 *   MSG 4 → Plain text OTP (dynamic — sent via /car-ready endpoint)
 *     Driver taps Verify on CarDetailsScreen
 *     Flutter calls POST /car-ready → server generates OTP
 *     Server sends plain text OTP to guest WhatsApp
 *     Returns { otp, options:[3 circles] } to Flutter
 *     Driver sees 3 circles on OTP screen
 *
 *   MSG 5 → handover_complete (template) [venueName, carNumber]
 *     Driver selects correct circle → taps Deliver
 *     Flutter calls POST /verify-otp
 *     Server validates OTP → sends handover_complete to guest
 *     Firestore status → delivered ✅
 */

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const axios   = require('axios');
require('dotenv').config();

// ── Firebase ───────────────────────────────────────────────────
const admin = require('firebase-admin');

// Uses .env variables directly — no serviceAccount.json file needed
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
// OTP STORE — in-memory { phone → { otp, carNumber, expiresAt } }
// ─────────────────────────────────────────────────────────────
const otpStore = new Map();

function saveOTP(phone, otp, carNumber) {
  otpStore.set(phone, {
    otp,
    carNumber,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
  });
}

function validateOTP(phone, input) {
  const record = otpStore.get(phone);
  if (!record) return { valid: false, reason: 'No OTP found' };
  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return { valid: false, reason: 'OTP expired' };
  }
  if (record.otp !== String(input).trim())
    return { valid: false, reason: 'Wrong OTP' };
  const carNumber = record.carNumber;
  otpStore.delete(phone); // one-time use
  return { valid: true, carNumber };
}

function generateOTP() {
  return String(Math.floor(10 + Math.random() * 90)); // 2-digit
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function docToObj(doc) {
  const d = doc.data();
  return {
    id:                      doc.id,
    driver_name:             d.driver_name             || '',
    guest_phone:             d.guest_phone             || '',
    vehicle_number:          d.vehicle_number          || '',
    parking_area:            d.parking_area            || '',
    parking_detail:          d.parking_detail          || '',
    status:                  d.status                  || '',
    otp:                     d.otp                     || null,
    Entry_time:              fmtTime(d.Entry_time),
    parked_time:             fmtTime(d.parked_time),
    Retrieve_request_time:   fmtTime(d.Retrieve_request_time),
    handover_time:           fmtTime(d.handover_time),
    exited_time:             fmtTime(d.exited_time),
    Retrieve_time:           d.Retrieve_time           || null,
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
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'OK', service: `${VENUE_NAME} Backend + WhatsApp Bot` });
});

// ─────────────────────────────────────────────────────────────
// PARKING ROUTES
// ─────────────────────────────────────────────────────────────

// GET all cars — no orderBy to avoid Firestore index
app.get('/api/parking/all', async (req, res) => {
  try {
    const snap = await col.get();
    const data = snap.docs
      .map(docToObj)
      .sort((a, b) => {
        const ta = a.parked_time?.iso ?? '';
        const tb = b.parked_time?.iso ?? '';
        return tb.localeCompare(ta);
      });
    res.json({ success: true, total: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single car
app.get('/api/parking/:id', async (req, res) => {
  try {
    const doc = await col.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: docToObj(doc) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST park a car
app.post('/api/parking/park', async (req, res) => {
  const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
  if (!driver_name || !guest_phone || !vehicle_number || !parking_area) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
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

// PATCH update status
app.patch('/api/parking/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['parked', 'retrieve_requested', 'accepted', 'delivered'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
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

// DELETE a car
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
// WHATSAPP — SEND MESSAGES (called by Flutter)
//
// Supported types:
//   { phone, type: 'text', message }
//   { phone, type: 'template', templateName, bodyParams: [] }
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
// CAR READY — Flutter calls this when driver taps Verify
// 1. Generates OTP
// 2. Sends OTP to guest as plain text (works within 24hr window)
// 3. Returns OTP + 2 decoys to Flutter (driver sees 3 circles)
// ─────────────────────────────────────────────────────────────
app.post('/car-ready', async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: 'phone and carNumber are required' });

  const otp = generateOTP();
  saveOTP(phone, otp, carNumber);
  console.log(`🔑 OTP for ${phone}: ${otp}`);

  // Generate 2 unique decoys
  const decoys = [];
  while (decoys.length < 2) {
    const d = String(Math.floor(10 + Math.random() * 90));
    if (d !== otp && !decoys.includes(d)) decoys.push(d);
  }

  // Shuffle OTP into random position
  const options = [...decoys, otp];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  try {
    // MSG 4: Dynamic plain text OTP — cannot be a template (OTP changes each time)
    const otpMessage =
      `Your car *${carNumber}* is now at the main entrance and ready for pickup.\n\n` +
      `Please show the code *${otp}* to the valet executive to collect your vehicle.\n\n` +
      `We hope you enjoyed your experience at ${VENUE_NAME}!`;

    await sendTextMessage(phone, otpMessage);
    console.log(`✅ MSG 4 (OTP plain text) → ${phone} | OTP: ${otp} | Car: ${carNumber}`);

    return res.json({ success: true, otp, options });
  } catch (err) {
    console.error('❌ /car-ready error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// VERIFY OTP — Flutter calls after driver selects correct circle
// 1. Validates OTP
// 2. Sends handover_complete template to guest
// 3. Updates Firestore status → delivered
// ─────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  const { phone, otp, docId } = req.body;
  if (!phone || !otp)
    return res.status(400).json({ error: 'phone and otp are required' });

  const result = validateOTP(phone, otp);

  if (!result.valid) {
    console.log(`❌ OTP wrong for ${phone}: ${result.reason}`);
    return res.json({ success: false, reason: result.reason });
  }

  console.log(`✅ OTP verified | ${phone} | Car: ${result.carNumber}`);

  try {
    // MSG 5: handover_complete template → guest gets delivery confirmation
    await sendTemplateMessage(phone, 'handover_complete', [
      VENUE_NAME,
      result.carNumber,
    ]);
    console.log(`✅ MSG 5 (handover_complete) → ${phone} | Car: ${result.carNumber}`);

    // Update Firestore status → delivered if docId provided
    if (docId) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ref = col.doc(docId);
      const doc = await ref.get();
      const update = {
        status:        'delivered',
        handover_time: now,
        exited_time:   now,
      };
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
// WHATSAPP — WEBHOOK VERIFY
// ─────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  console.log('🔍 Webhook verify:', req.query);
  if (req.query['hub.verify_token'] === WA_VERIFY) {
    console.log('✅ Webhook verified');
    return res.send(req.query['hub.challenge']);
  }
  res.status(403).send('Forbidden');
});

// ─────────────────────────────────────────────────────────────
// WHATSAPP — WEBHOOK RECEIVE
// Guest taps "Retrieve Car" → update Firestore → Flutter popup
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
      if (status) console.log(`📊 Status update: ${status.status}`);
      return;
    }

    const from = message.from;
    console.log(`💬 MSG TYPE: ${message.type} | FROM: ${from}`);

    // ── Template quick-reply button (from parked_confirmation template) ──
    if (message.type === 'button') {
      const text = message.button?.text?.toLowerCase();
      console.log(`🔘 Template button: "${text}"`);
      if (text === 'retrieve car') await handleRetrieveCar(from);
      return;
    }

    // ── Interactive button (fallback) ──
    if (message.type === 'interactive') {
      const id = message.interactive.button_reply?.id;
      console.log(`🔘 Interactive: "${id}"`);
      if (id === 'retrieve_car') await handleRetrieveCar(from);
      return;
    }

    // ── Text messages ──
    if (message.type === 'text') {
      const lower = message.text.body.trim().toLowerCase();
      if (lower === 'hi' || lower === 'hello') {
        await sendTextMessage(from,
          `👋 Welcome to *${VENUE_NAME}*!\n\nOur valet team is ready to assist you.`);
      }
    }
  } catch (err) {
    console.error('💥 Webhook error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RETRIEVE CAR HANDLER
// Guest taps "Retrieve Car" on WhatsApp →
//   1. Send retrieval_progress template
//   2. Update Firestore → retrieve_requested (Flutter listens instantly)
// ─────────────────────────────────────────────────────────────
async function handleRetrieveCar(from) {
  console.log(`🚗 Retrieve Car request from: ${from}`);

  // Build all phone variants to match any storage format
  const digits  = from.replace(/[^0-9]/g, '');
  const phone10 = digits.length > 10 ? digits.slice(-10) : digits;
  const phone12 = `91${phone10}`;
  const phoneVariants = [...new Set([digits, phone10, phone12])];
  console.log(`🔍 Checking phone variants: ${phoneVariants.join(', ')}`);

  try {
    // Try each variant — match whichever format was stored in Firestore
    let matchedDoc = null;
    for (const ph of phoneVariants) {
      const snap = await col
        .where('guest_phone', '==', ph)
        .where('status', '==', 'parked')
        .limit(1)
        .get();
      if (!snap.empty) {
        matchedDoc = snap.docs[0];
        console.log(`✅ Found car for phone variant: ${ph}`);
        break;
      }
    }

    if (!matchedDoc) {
      console.log(`⚠️ No parked car found for: ${phoneVariants.join(', ')}`);
      await sendTextMessage(from,
        'We could not find an active parking record for your number. Please contact our valet team.');
      return;
    }

    const docRef    = matchedDoc.ref;
    const carData   = matchedDoc.data();
    const carNumber = carData.vehicle_number || '';

    // MSG 3: retrieval_progress template → guest sees "car is being retrieved"
    await sendTemplateMessage(from, 'retrieval_progress', [carNumber]);
    console.log(`✅ MSG 3 (retrieval_progress) → ${from} | Car: ${carNumber}`);

    // Update Firestore → retrieve_requested (Flutter Firestore listener fires instantly)
    await docRef.update({
      status:                'retrieve_requested',
      Retrieve_request_time: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Firestore updated: retrieve_requested | Car: ${carNumber}`);

  } catch (err) {
    console.error('❌ handleRetrieveCar error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// WHATSAPP API HELPERS
// ─────────────────────────────────────────────────────────────
async function sendTextMessage(to, text) {
  const res = await axios.post(WA_BASE,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: WA_HEADERS() });
  return res.data;
}

async function sendTemplateMessage(to, templateName, bodyParams = []) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: 'en' },
      ...(bodyParams.length > 0 && {
        components: [{
          type:       'body',
          parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })),
        }],
      }),
    },
  };
  console.log(`📤 Template: ${templateName} → ${to} | params:`, bodyParams);
  const res = await axios.post(WA_BASE, payload, { headers: WA_HEADERS() });
  return res.data;
}

// ─────────────────────────────────────────────────────────────
// START SERVER
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
