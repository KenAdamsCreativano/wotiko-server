/**
 * modules/fcm.js
 *
 * Thin wrapper around Firebase Admin Messaging.
 * Replaces the inline sendFCMNotification() in server.js.
 *
 * Exports:
 *   sendFCMToToken(token, data)              — single driver
 *   sendFCMToTokens(tokens, data)            — multicast (fallback / cancel / accept)
 *   sendFCMToAllExcept(data, excludeUid)     — notify others on accept
 *   sendFCMAdapter(tokenOrTokens, data, opts)— unified adapter for queueManager
 */

'use strict';

const admin = require('firebase-admin');

const ANDROID_CFG = { priority: 'high', ttl: 60_000 };
const APNS_CFG    = {
  headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
  payload: { aps: { 'content-available': 1 } },
};

function log(emoji, cat, msg, meta = {}) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  const m  = Object.keys(meta).length
    ? '  ' + Object.entries(meta).map(([k, v]) => `${k}:${v}`).join(' | ')
    : '';
  console.log(`[${ts}] ${emoji} [${cat}]  ${msg}${m}`);
}

// FCM data payloads must be string:string
function str(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
}

// ── Single driver ─────────────────────────────────────────────
async function sendFCMToToken(token, data) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      data:    str(data),
      android: ANDROID_CFG,
      apns:    APNS_CFG,
    });
    log('📲', 'FCM', `Single push`, { type: data.type, carId: data.carId });
  } catch (e) {
    log('❌', 'FCM', `Single push failed`, { error: e.message });
  }
}

// ── Multicast ─────────────────────────────────────────────────
async function sendFCMToTokens(tokens, data) {
  if (!tokens?.length) return;
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      data:    str(data),
      android: ANDROID_CFG,
      apns:    APNS_CFG,
    });
    log('📲', 'FCM', `Multicast`, {
      type: data.type,
      ok: `${res.successCount}/${tokens.length}`,
    });
    res.responses.forEach((r, i) => {
      if (!r.success) log('❌', 'FCM', `Token ${i} failed`, { code: r.error?.code });
    });
  } catch (e) {
    log('❌', 'FCM', `Multicast failed`, { error: e.message });
  }
}

// ── All drivers except one uid ────────────────────────────────
async function sendFCMToAllExcept(data, excludeUid) {
  const snap   = await admin.firestore().collection('drivers').get();
  const tokens = snap.docs
    .filter(d => d.id !== excludeUid)
    .map(d => d.data().fcmToken)
    .filter(Boolean);
  return sendFCMToTokens(tokens, data);
}

// ── Unified adapter used by queueManager ─────────────────────
async function sendFCMAdapter(tokenOrTokens, data, opts = {}) {
  if (opts.multicast || Array.isArray(tokenOrTokens)) {
    const tokens = Array.isArray(tokenOrTokens) ? tokenOrTokens : [tokenOrTokens];
    return sendFCMToTokens(tokens, data);
  }
  return sendFCMToToken(tokenOrTokens, data);
}

module.exports = { sendFCMToToken, sendFCMToTokens, sendFCMToAllExcept, sendFCMAdapter };
