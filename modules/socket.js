/**
 * modules/socket.js
 *
 * Socket.IO server — real-time sub-millisecond delivery when driver app is open.
 * FCM is used as fallback when no live socket exists.
 *
 * ── Rooms ────────────────────────────────────────────────────
 *   "drivers"       — all connected drivers (broadcasts)
 *   "driver:{uid}"  — per-driver room (targeted delivery by queueManager)
 *
 * ── Server → Client events ───────────────────────────────────
 *   new_request       { carId, carNumber, wing, guestMasked [, exhausted] }
 *   request_taken     { carId, driverUid }
 *   request_cancelled { carId }
 *
 * ── Client → Server events ───────────────────────────────────
 *   join             { uid }   — driver identifies after connect
 *   heartbeat        { uid }   — every 30 s; keeps lastActive fresh
 *   leave            { uid }   — app backgrounded / driver logs out
 */

'use strict';

const admin = require('firebase-admin');

function log(emoji, cat, msg, meta = {}) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  const m  = Object.keys(meta).length
    ? '  ' + Object.entries(meta).map(([k, v]) => `${k}:${v}`).join(' | ')
    : '';
  console.log(`[${ts}] ${emoji} [${cat}]  ${msg}${m}`);
}

async function _setOnline(uid, online) {
  if (!uid) return;
  try {
    await admin.firestore().collection('drivers').doc(uid).update({
      isOnline:   online,
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (_) { /* non-fatal */ }
}

/**
 * Attach Socket.IO to an existing http.Server.
 * Returns the `io` instance so server.js can pass it to route handlers.
 */
function initSocket(httpServer) {
  const { Server } = require('socket.io');

  const io = new Server(httpServer, {
    cors:       { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', socket => {
    let connectedUid = null;
    log('🔌', 'SOCKET', `Connected`, { id: socket.id });

    // Driver identifies themselves after connect
    socket.on('join', async ({ uid } = {}) => {
      if (!uid) return;
      connectedUid = uid;
      socket.join('drivers');
      socket.join(`driver:${uid}`);
      await _setOnline(uid, true);
      log('👤', 'SOCKET', `Driver online`, { uid });
    });

    // Fix 6: driver ACKs receipt of new_request immediately.
    // Cancels the 8s ack-failure timer so the driver gets the full 22s to respond.
    socket.on('request_ack', ({ carId } = {}) => {
      if (!carId) return;
      const { handleAck } = require('./queueManager');
      handleAck(carId);
    });

    // Periodic heartbeat keeps isOnline + lastActive fresh
    socket.on('heartbeat', async ({ uid } = {}) => {
      const id = uid || connectedUid;
      if (!id) return;
      try {
        await admin.firestore().collection('drivers').doc(id).update({
          isOnline:   true,
          lastActive: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (_) {}
    });

    // Explicit leave (app goes to background or driver signs out)
    socket.on('leave', async ({ uid } = {}) => {
      const id = uid || connectedUid;
      socket.leave('drivers');
      if (id) socket.leave(`driver:${id}`);
      await _setOnline(id, false);
      log('👋', 'SOCKET', `Driver offline (leave)`, { uid: id });
    });

    socket.on('disconnect', async () => {
      await _setOnline(connectedUid, false);
      log('🔌', 'SOCKET', `Disconnected`, { uid: connectedUid || socket.id });
    });
  });

  return io;
}

module.exports = { initSocket };
