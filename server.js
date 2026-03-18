const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || "my-verify-token",
  VENUE_NAME: "Madras Square",
};

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "ngrok-skip-browser-warning",
    ],
  })
);
app.use(express.json({ type: "*/*" }));

// ─────────────────────────────────────────────
// STORES
// carStore : { phone → { carNumber, wing } }
// otpStore : { phone → { otp, carNumber, expiresAt } }
// ─────────────────────────────────────────────
const carStore = new Map();
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
  if (!record) return { valid: false, reason: "No OTP found" };
  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return { valid: false, reason: "OTP expired" };
  }
  if (record.otp !== String(input).trim())
    return { valid: false, reason: "Wrong OTP" };
  const carNumber = record.carNumber;
  otpStore.delete(phone); // one-time use
  return { valid: true, carNumber };
}

function generateOTP() {
  return String(Math.floor(10 + Math.random() * 90)); // 2-digit
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: `${CONFIG.VENUE_NAME} Valet WhatsApp Bot`,
  });
});

// ─────────────────────────────────────────────
// WEBHOOK VERIFICATION
// ─────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  console.log("🔍 WEBHOOK VERIFY:", req.query);
  if (req.query["hub.verify_token"] === CONFIG.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED");
    return res.send(req.query["hub.challenge"]);
  }
  res.status(403).send("Forbidden");
});

// ─────────────────────────────────────────────
// MAIN WEBHOOK
// ─────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  res.status(200).send("OK");
  setImmediate(() => processIncomingMessage(req.body));
});

// ─────────────────────────────────────────────
// DRIVER APP — SEND MESSAGES
//
// Supported types:
//   { phone, type: "template", templateName, bodyParams: [] }
//   { phone, type: "text", message }
// ─────────────────────────────────────────────
app.post("/send-messages", async (req, res) => {
  const { phone, type, message, templateName, bodyParams } = req.body;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  try {
    if (type === "text") {
      if (!message)
        return res.status(400).json({ error: "message is required" });
      await sendTextMessage(phone, message);
      return res.json({ success: true, type: "text" });
    } else if (type === "template") {
      if (!templateName)
        return res.status(400).json({ error: "templateName is required" });
      await sendTemplateMessage(phone, templateName, bodyParams || []);
      console.log(`✅ Template "${templateName}" → ${phone}`);

      // Save car details when parked_confirmation is sent
      // so retrieval_progress can use the car number later
      if (templateName === "parked_confirmation" && bodyParams?.length >= 1) {
        carStore.set(phone, {
          carNumber: bodyParams[0],
          wing: bodyParams[1] || "",
        });
        console.log(`🚗 Car stored for ${phone}: ${bodyParams[0]}`);
      }

      return res.json({ success: true, type: "template" });
    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error(
      "❌ /send-messages error:",
      err.response?.data || err.message
    );
    return res
      .status(500)
      .json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────
// DRIVER APP — CAR READY (Step 4)
// 1. Generates OTP
// 2. Sends car_ready_otp template to guest (guest sees OTP on their phone)
// 3. Returns OTP + 2 decoys to driver app (driver sees 3 circles)
// ─────────────────────────────────────────────
app.post("/car-ready", async (req, res) => {
  const { phone, carNumber } = req.body;
  if (!phone || !carNumber)
    return res.status(400).json({ error: "phone and carNumber are required" });

  const otp = generateOTP();
  saveOTP(phone, otp, carNumber);
  console.log(`🔑 OTP for ${phone}: ${otp}`);

  // Generate 2 unique decoy numbers
  const decoys = [];
  while (decoys.length < 2) {
    const d = String(Math.floor(10 + Math.random() * 90));
    if (d !== otp && !decoys.includes(d)) decoys.push(d);
  }

  // Shuffle OTP into random position among decoys
  const options = [...decoys, otp];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  try {
    // Send car_ready_otp template to guest — guest sees OTP on their WhatsApp
    await sendTemplateMessage(phone, "car_ready_otp", [carNumber, otp]);
    console.log(`✅ car_ready_otp sent to ${phone}`);

    // Return options to driver app — driver sees 3 circles
    return res.json({ success: true, otp, options });
  } catch (err) {
    console.error("❌ /car-ready error:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────
// DRIVER APP — VERIFY OTP (Step 5)
// Driver taps correct number → sends handover_complete to guest
// ─────────────────────────────────────────────
app.post("/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp)
    return res.status(400).json({ error: "phone and otp are required" });

  const result = validateOTP(phone, otp);

  if (!result.valid) {
    console.log(`❌ OTP wrong for ${phone}: ${result.reason}`);
    return res.json({ success: false, reason: result.reason });
  }

  console.log(`✅ OTP verified | ${phone} | Car: ${result.carNumber}`);

  try {
    await sendTemplateMessage(phone, "handover_complete", [
      CONFIG.VENUE_NAME,
      result.carNumber,
    ]);
    console.log(`✅ handover_complete → ${phone}`);
    return res.json({ success: true, carNumber: result.carNumber });
  } catch (err) {
    console.error("❌ /verify-otp error:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────
// PROCESS INCOMING WHATSAPP MESSAGES
// ─────────────────────────────────────────────
async function processIncomingMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("📊 Status update:", value?.statuses?.[0]?.status);
      return;
    }

    const from = message.from;
    console.log(`💬 MSG TYPE: ${message.type} | FROM: ${from}`);

    // ── Template quick-reply button (Retrieve Car) ──
    if (message.type === "button") {
      const text = message.button?.text?.toLowerCase();
      console.log(`🔘 Template button: "${text}"`);
      if (text === "retrieve car") await handleRetrieveCar(from);
      return;
    }

    // ── Interactive button (fallback) ──
    if (message.type === "interactive") {
      const id = message.interactive.button_reply?.id;
      console.log(`🔘 Interactive button: "${id}"`);
      if (id === "retrieve_car") await handleRetrieveCar(from);
      return;
    }

    // ── Text messages ──
    if (message.type === "text") {
      const lower = message.text.body.trim().toLowerCase();
      if (lower === "hi" || lower === "hello") {
        await sendTextMessage(
          from,
          `👋 Welcome to *${CONFIG.VENUE_NAME}* Valet Service!\n\nOur team is ready to assist you.`
        );
      } else {
        await sendTextMessage(
          from,
          "Thank you for reaching out. Our valet team will assist you shortly."
        );
      }
    }
  } catch (error) {
    console.error("💥 PROCESS ERROR:", error.message);
  }
}

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────

// Step 3: retrieval_progress — guest tapped Retrieve Car
// Uses carStore to get car number saved at parking time
async function handleRetrieveCar(from) {
  const record = carStore.get(from);
  const carNumber = record?.carNumber || "";
  await sendTemplateMessage(from, "retrieval_progress", [carNumber]);
  console.log(`✅ retrieval_progress → ${from} | Car: ${carNumber}`);
}

// ─────────────────────────────────────────────
// WHATSAPP API HELPERS
// ─────────────────────────────────────────────
const WA_BASE = `https://graph.facebook.com/v19.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WA_HEADERS = () => ({
  Authorization: `Bearer ${CONFIG.WHATSAPP_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
});

async function sendTextMessage(to, text) {
  const res = await axios.post(
    WA_BASE,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: WA_HEADERS() }
  );
  return res.data;
}

async function sendTemplateMessage(to, templateName, bodyParams = []) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      ...(bodyParams.length > 0 && {
        components: [
          {
            type: "body",
            parameters: bodyParams.map((text) => ({
              type: "text",
              text: String(text),
            })),
          },
        ],
      }),
    },
  };
  console.log(`📤 Template: ${templateName} → ${to} | params:`, bodyParams);
  const res = await axios.post(WA_BASE, payload, { headers: WA_HEADERS() });
  return res.data;
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🏨 ${CONFIG.VENUE_NAME} Valet Bot`);
  console.log(`🚀 Server:      http://localhost:${CONFIG.PORT}`);
  console.log(`📲 Messages     → POST /send-messages`);
  console.log(`🚗 Car ready    → POST /car-ready`);
  console.log(`✅ Verify OTP   → POST /verify-otp`);
  console.log(`🔗 Webhook      → POST /webhook\n`);
});
