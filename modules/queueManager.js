/**
 * modules/queueManager.js
 *
 * Rapido-style sequential driver assignment.
 * Zero coupling to Express — only knows about Firestore, FCM, and Socket.IO.
 *
 * ── Assignment flow ──────────────────────────────────────────
 *   buildDriverQueue()  → fetch online drivers ordered by lastActive desc
 *   assignNext()        → send to currentDriver, start 22s backend timer
 *   handleSkip()        → transaction-guarded index advance → assignNext / fallback
 *   handleAccept()      → transaction lock → clear timer → notify others
 *   handleExhausted()   → all skipped → multicast everyone
 *   handleCancel()      → clear timer only (FCM handled by caller)
 *
 * ── Race-condition safety ────────────────────────────────────
 *   handleSkip()   wraps index increment in a Firestore transaction.
 *   handleAccept() wraps status write in a Firestore transaction.
 *   Two simultaneous skips → only one advances the index.
 *   Two simultaneous accepts → one gets 409, the other wins.
 *
 * ── Timer registry ───────────────────────────────────────────
 *   In-memory Map<carId, NodeJS.Timeout>.
 *   startTimer() always cancels any prior timer for the same carId first.
 *   clearTimer() is idempotent.
 */

'use strict';

const admin = require('firebase-admin');

// ── In-memory timer registry ─────────────────────────────────
const activeTimers = new Map(); // carId → NodeJS.Timeout

// 22 s = 2 s grace over Android's 20 s so the two timers don't collide
const BACKEND_TIMEOUT_MS = 22_000;

// ── Firestore shortcuts ──────────────────────────────────────
const fsdb   = () => admin.firestore();
const carCol = () => fsdb().collection('parked_cars');
const drvCol = () => fsdb().collection('drivers');

// ── Logger (same style as server.js) ─────────────────────────
function log(emoji, cat, msg, meta = {}) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  const m  = Object.keys(meta).length
    ? '  ' + Object.entries(meta).map(([k, v]) => `${k}:${v}`).join(' | ')
    : '';
  console.log(`[${ts}] ${emoji} [${cat}]  ${msg}${m}`);
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — Build driver queue
// ─────────────────────────────────────────────────────────────
/**
 * Returns [{uid, fcmToken, name}, ...] ordered by lastActive desc.
 * Excludes drivers with no FCM token or lastActive older than 10 min.
 */
async function buildDriverQueue() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);

  const snap = await drvCol()
    .where('isOnline', '==', true)
    .orderBy('lastActive', 'desc')
    .get();

  const queue = [];
  snap.forEach(doc => {
    const d          = doc.data();
    const lastActive = d.lastActive?.toDate?.() ?? new Date(0);
    if (!d.fcmToken)        return; // no token → can't push
    if (lastActive < cutoff) return; // stale → treat as offline
    queue.push({ uid: doc.id, fcmToken: d.fcmToken, name: d.name || '' });
  });

  return queue;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 + 4 — Send to current driver and start backend timer
// ─────────────────────────────────────────────────────────────
/**
 * Read current queue state from Firestore, send to the driver at
 * currentDriverIndex, start a 22 s backend timer.
 *
 * sendFn  — async (tokenOrTokens, data, opts) — injected from server.js
 * io      — Socket.IO server instance (may be null in tests)
 */
async function assignNext(carId, sendFn, io) {
  const docRef = carCol().doc(carId);
  const snap   = await docRef.get();
  if (!snap.exists) return;

  const data  = snap.data();
  const queue = data.driverQueue        || [];
  const idx   = data.currentDriverIndex ?? 0;

  if (idx >= queue.length) {
    await handleExhausted(carId, data, sendFn, io);
    return;
  }

  const driver = queue[idx];
  log('🎯', 'QUEUE', `Assigning driver ${idx + 1}/${queue.length}`,
    { carId, driver: driver.name || driver.uid });

  await docRef.update({
    assignedDriverUid:  driver.uid,
    currentDriverIndex: idx,           // explicit — already correct but keep in sync
  });

  // Socket.IO fast path — sub-millisecond when app is open
  const socketDelivered = _emitToDriver(io, driver.uid, 'new_request', {
    carId,
    carNumber:   data.vehicle_number || '',
    wing:        data.parking_area   || '',
    guestMasked: data.guestMasked    || '',
  });

  // FCM fallback — only if driver has no live socket
  if (!socketDelivered) {
    await sendFn(driver.fcmToken, {
      type:      'retrieve_requested',
      carNumber: String(data.vehicle_number || ''),
      carId:     String(carId),
      wing:      String(data.parking_area   || ''),
      guestMasked: String(data.guestMasked  || ''),
    });
  }

  // Backend timer — fires if driver ignores for 22 s
  _startTimer(carId, async () => {
    log('⏰', 'QUEUE', `Backend timeout`, { carId, driver: driver.uid });
    await handleSkip(carId, sendFn, io, { fromTimeout: true });
  });

  // Fix 6: ACK timer — fires in 8 s if driver never sends 'request_ack'.
  // Distinguishes silent delivery failure from deliberate ignore.
  _startAckTimer(carId, sendFn, io);
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — Skip / timeout  (transaction-guarded)
// ─────────────────────────────────────────────────────────────
/**
 * Advance currentDriverIndex by 1 inside a transaction so two concurrent
 * skip/timeout calls can't both increment it.
 *
 * opts.fromTimeout = true  → called by backend timer (not driver tap)
 */
async function handleSkip(carId, sendFn, io, opts = {}) {
  let nextIdx, queueLen;

  try {
    await fsdb().runTransaction(async tx => {
      const snap = await tx.get(carCol().doc(carId));
      if (!snap.exists) throw Object.assign(new Error('missing'), { code: 'missing' });

      const d = snap.data();
      if (d.status === 'accepted' || d.status === 'delivered') {
        throw Object.assign(new Error('done'), { code: 'done' });
      }

      nextIdx  = (d.currentDriverIndex ?? 0) + 1;
      queueLen = (d.driverQueue || []).length;
      tx.update(carCol().doc(carId), { currentDriverIndex: nextIdx });
    });
  } catch (e) {
    if (e.code === 'missing' || e.code === 'done') return;
    throw e;
  }

  _clearTimer(carId);

  if (nextIdx >= queueLen) {
    const snap = await carCol().doc(carId).get();
    await handleExhausted(carId, snap.data(), sendFn, io);
  } else {
    log('⏭️', 'QUEUE', `Next driver (${nextIdx + 1}/${queueLen})`, { carId });
    await assignNext(carId, sendFn, io);
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 5 — Accept lock  (transaction-guarded)
// ─────────────────────────────────────────────────────────────
/**
 * Atomically write status = 'accepted'.
 * Returns { success: true } or { success: false, conflict: true }.
 *
 * sendAllExceptFn — async (data, excludeUid) — multicast to others
 */
async function handleAccept(carId, acceptingUid, sendAllExceptFn, io) {
  try {
    await fsdb().runTransaction(async tx => {
      const snap = await tx.get(carCol().doc(carId));
      if (!snap.exists) throw Object.assign(new Error('missing'),  { code: 'missing' });

      const d = snap.data();
      if (d.status === 'accepted')          throw Object.assign(new Error('conflict'), { code: 'conflict' });
      if (d.status !== 'retrieve_requested') throw Object.assign(new Error('bad_status'), { code: 'bad_status' });

      tx.update(carCol().doc(carId), {
        status:             'accepted',
        assignedDriverUid:  acceptingUid,
        // Remove queue fields — no longer needed
        driverQueue:        admin.firestore.FieldValue.delete(),
        currentDriverIndex: admin.firestore.FieldValue.delete(),
      });
    });
  } catch (e) {
    if (e.code === 'conflict')    return { success: false, conflict: true };
    if (e.code === 'missing')     return { success: false, conflict: false };
    if (e.code === 'bad_status')  return { success: false, conflict: false };
    throw e;
  }

  _clearTimer(carId);
  _clearAckTimer(carId);      // Fix 6: cancel ack timer on accept
  log('✅', 'QUEUE', `Accept locked`, { carId, driver: acceptingUid });

  // Notify all OTHER drivers to dismiss their UI
  await sendAllExceptFn(
    { type: 'retrieve_accepted', carId: String(carId) },
    acceptingUid
  );

  // Socket.IO broadcast
  if (io) io.to('drivers').emit('request_taken', { carId, driverUid: acceptingUid });

  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// Fallback — all drivers exhausted → broadcast to everyone
// ─────────────────────────────────────────────────────────────
async function handleExhausted(carId, data, sendFn, io) {
  log('🔄', 'QUEUE', `Queue exhausted — broadcasting to all`, { carId });

  const snap   = await drvCol().where('fcmToken', '!=', '').get();
  const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);

  if (tokens.length) {
    await sendFn(tokens, {
      type:        'retrieve_requested',
      carNumber:   String(data?.vehicle_number || ''),
      carId:       String(carId),
      wing:        String(data?.parking_area   || ''),
      guestMasked: String(data?.guestMasked    || ''),
    }, { multicast: true });
  }

  if (io) {
    io.to('drivers').emit('new_request', {
      carId,
      carNumber:   data?.vehicle_number || '',
      wing:        data?.parking_area   || '',
      guestMasked: data?.guestMasked    || '',
      exhausted:   true,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Cancel — clear timer; FCM handled by the caller
// ─────────────────────────────────────────────────────────────
function handleCancel(carId) {
  _clearTimer(carId);
  _clearAckTimer(carId);      // Fix 6
}

// ─────────────────────────────────────────────────────────────
// Timer helpers (private)
// ─────────────────────────────────────────────────────────────
function _startTimer(carId, fn) {
  _clearTimer(carId);                                   // always cancel prior first
  activeTimers.set(carId, setTimeout(fn, BACKEND_TIMEOUT_MS));
}

function _clearTimer(carId) {
  const t = activeTimers.get(carId);
  if (t !== undefined) { clearTimeout(t); activeTimers.delete(carId); }
}

// ─────────────────────────────────────────────────────────────
// Socket.IO helper (private)
// ─────────────────────────────────────────────────────────────
/**
 * Emit to a driver's personal room `driver:{uid}`.
 * Returns true if at least one socket was present.
 */
function _emitToDriver(io, uid, event, payload) {
  if (!io) return false;
  const room    = `driver:${uid}`;
  const sockets = io.sockets.adapter.rooms?.get(room);
  if (!sockets || sockets.size === 0) return false;
  io.to(room).emit(event, payload);
  return true;
}

// ─────────────────────────────────────────────────────────────
// ACK system (Fix 6)
// ─────────────────────────────────────────────────────────────
/**
 * ACK flow:
 *   Server → driver: new_request
 *   Driver → server: request_ack  { carId }   (emitted by Flutter immediately on receipt)
 *   Server: clears ack timer, keeps the 22s accept timer running normally.
 *
 * If NO ack within ACK_TIMEOUT_MS (8 s):
 *   Server treats it as silent delivery failure (app killed, token stale)
 *   and advances to the next driver immediately — without waiting 22 s.
 *
 * If ack received: the normal 22s timer continues unchanged.
 * This way:
 *   Delivery failure  → next driver in 8 s
 *   Driver ignoring   → next driver in 22 s
 */
const ACK_TIMEOUT_MS = 8_000;
const ackTimers      = new Map(); // carId → NodeJS.Timeout  (separate from activeTimers)

function _startAckTimer(carId, sendFn, io) {
  _clearAckTimer(carId);
  ackTimers.set(carId, setTimeout(async () => {
    log('📭', 'ACK', `No ACK received — advancing queue`, { carId });
    // Don't cancel the main timer here; handleSkip will do it.
    await handleSkip(carId, sendFn, io, { fromAckTimeout: true });
  }, ACK_TIMEOUT_MS));
}

function _clearAckTimer(carId) {
  const t = ackTimers.get(carId);
  if (t !== undefined) { clearTimeout(t); ackTimers.delete(carId); }
}

/**
 * Called by socket.js when driver emits 'request_ack'.
 * Cancels the ack-failure timer; the normal 22s accept timer continues.
 */
function handleAck(carId) {
  _clearAckTimer(carId);
  log('✅', 'ACK', `ACK received`, { carId });
}

module.exports = {
  buildDriverQueue,
  assignNext,
  handleSkip,
  handleAccept,
  handleCancel,
  handleExhausted,
  handleAck,           // Fix 6
};
