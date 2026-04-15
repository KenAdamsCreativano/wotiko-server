/**
 * socketHandler.js
 *
 * Wires up all Socket.IO events for the Wotiko valet system.
 *
 * Called once from server.js:
 *   const { initSocketHandler } = require('./socket/socketHandler');
 *   initSocketHandler(io, db, admin, log);
 *
 * Events (client → server):
 *   authenticate   { driverId, apiKey }        Register / re-register driver
 *   accept_request { carId, driverId }          Driver accepted a retrieval
 *   skip_request   { carId, driverId }          Driver skipped a retrieval
 *   ping                                        Heartbeat from client
 *
 * Events (server → client):
 *   authenticated  { success, driverId }        Handshake response
 *   retrieve_request { carId, carNumber, wing, guestMasked }
 *   request_accepted { carId, driverId, driverName }
 *   request_skipped  { carId, driverId }
 *   car_delivered    { carId, carNumber }
 *   retrieve_cancelled { carId }
 *   pong             {}                         Heartbeat response
 *   error            { message }               Validation / auth failure
 */

const store = require('./driverSocketStore');

// Dedup: track the last seen carId+event pair per driver within a window
// to prevent processing the same WebSocket event twice (e.g. client retry).
const dedupCache = new Map(); // `${driverId}:${carId}:${event}` → timestamp
const DEDUP_MS   = 10_000;   // 10 s window

function isDuplicate(driverId, carId, event) {
  const key  = `${driverId}:${carId}:${event}`;
  const last = dedupCache.get(key);
  if (last && Date.now() - last < DEDUP_MS) return true;
  dedupCache.set(key, Date.now());
  // Prune old entries every 500 calls to avoid unbounded growth
  if (dedupCache.size > 500) {
    const cutoff = Date.now() - DEDUP_MS;
    for (const [k, t] of dedupCache) if (t < cutoff) dedupCache.delete(k);
  }
  return false;
}

function initSocketHandler(io, db, admin, log) {
  const col = db.collection('parked_cars');

  // ── Middleware: validate API key on every new connection ──────────────────
  // The client must pass apiKey in the handshake auth object.
  // This is a fast gate before any event processing.
  io.use((socket, next) => {
    const apiKey = socket.handshake.auth?.apiKey
               || socket.handshake.query?.apiKey;

    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
      log('WARN', 'SOCKET', 'Rejected connection — bad API key', { id: socket.id });
      return next(new Error('Unauthorized'));
    }
    next();
  });

  // ── Connection ─────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    log('WS', 'SOCKET', 'New connection', { socketId: socket.id });

    // ── authenticate ─────────────────────────────────────────────────────────
    // Driver sends { driverId } after connecting.
    // We validate it exists in Firestore then register the mapping.
    socket.on('authenticate', async ({ driverId } = {}) => {
      if (!driverId || typeof driverId !== 'string' || driverId.trim() === '') {
        socket.emit('error', { message: 'driverId is required' });
        return;
      }

      try {
        // Verify driver exists in Firestore
        const driverDoc = await db.collection('drivers').doc(driverId).get();
        if (!driverDoc.exists) {
          socket.emit('error', { message: 'Driver not found' });
          log('WARN', 'SOCKET', 'Auth failed — driver not found', { driverId });
          return;
        }

        store.register(driverId, socket.id);
        // Attach driverId to socket for quick lookup in other handlers
        socket.data.driverId = driverId;

        socket.emit('authenticated', { success: true, driverId });
        log('AUTH', 'SOCKET', 'Driver authenticated', {
          driverId,
          socketId: socket.id,
          total: store.snapshot().connectedCount,
        });
      } catch (e) {
        socket.emit('error', { message: 'Authentication error' });
        log('ERR', 'SOCKET', 'authenticate handler failed', { driverId, error: e.message });
      }
    });

    // ── accept_request ────────────────────────────────────────────────────────
    // Driver accepted a retrieval request.
    // 1. Dedup check
    // 2. Firestore transaction (status: retrieve_requested → accepted)
    // 3. Broadcast to all connected drivers so they remove the alert
    socket.on('accept_request', async ({ carId, driverId } = {}) => {
      if (!carId || !driverId) return;
      if (!socket.data.driverId || socket.data.driverId !== driverId) {
        socket.emit('error', { message: 'Not authenticated as this driver' });
        return;
      }
      if (isDuplicate(driverId, carId, 'accept')) {
        log('DEDUP', 'SOCKET', 'Duplicate accept_request ignored', { carId, driverId });
        return;
      }

      try {
        const ref    = col.doc(carId);
        const result = await db.runTransaction(async tx => {
          const doc = await tx.get(ref);
          if (!doc.exists) return { ok: false, reason: 'not_found' };
          if (doc.data().status !== 'retrieve_requested')
            return { ok: false, reason: `wrong_status:${doc.data().status}` };

          const driverDoc  = await db.collection('drivers').doc(driverId).get();
          const driverName = driverDoc.data()?.name || '';

          tx.update(ref, {
            status:               'accepted',
            accepted_by:          driverId,
            accepted_driver_name: driverName,
            accepted_at:          admin.firestore.FieldValue.serverTimestamp(),
          });
          return { ok: true, driverName };
        });

        if (!result.ok) {
          socket.emit('error', { message: `Accept failed: ${result.reason}` });
          log('WARN', 'SOCKET', 'accept_request rejected', { carId, driverId, reason: result.reason });
          return;
        }

        // Broadcast to ALL connected drivers — they should dismiss the alert
        io.emit('request_accepted', {
          carId,
          driverId,
          driverName: result.driverName,
        });

        log('ACC', 'SOCKET', 'accept_request processed', { carId, driverId });
      } catch (e) {
        log('ERR', 'SOCKET', 'accept_request handler failed', { carId, driverId, error: e.message });
      }
    });

    // ── skip_request ──────────────────────────────────────────────────────────
    // Driver skipped this retrieval.
    // Marks skip_notified = true and sends WhatsApp via the REST helper so
    // the guest is notified — same logic as the REST /skip-car endpoint but
    // without the HTTP round-trip from the client.
    socket.on('skip_request', async ({ carId, driverId } = {}) => {
      if (!carId || !driverId) return;
      if (!socket.data.driverId || socket.data.driverId !== driverId) {
        socket.emit('error', { message: 'Not authenticated as this driver' });
        return;
      }
      if (isDuplicate(driverId, carId, 'skip')) {
        log('DEDUP', 'SOCKET', 'Duplicate skip_request ignored', { carId, driverId });
        return;
      }

      try {
        const doc = await col.doc(carId).get();
        if (!doc.exists) { socket.emit('error', { message: 'Car not found' }); return; }

        const data = doc.data();
        if (data.skip_notified) {
          // Already skipped — just ack the driver, don't re-notify guest
          socket.emit('request_skipped', { carId, driverId, alreadyNotified: true });
          return;
        }

        await col.doc(carId).update({ skip_notified: true });

        // Notify the skipping driver only (not a broadcast — other drivers still see the request)
        socket.emit('request_skipped', { carId, driverId });

        log('SKIP', 'SOCKET', 'skip_request processed', { carId, driverId });
      } catch (e) {
        log('ERR', 'SOCKET', 'skip_request handler failed', { carId, driverId, error: e.message });
      }
    });

    // ── ping / pong ───────────────────────────────────────────────────────────
    // Lightweight heartbeat so clients can detect stale connections.
    socket.on('ping', () => socket.emit('pong', {}));

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      const driverId = store.unregister(socket.id);
      log('WS', 'SOCKET', 'Driver disconnected', {
        socketId: socket.id,
        driverId: driverId ?? 'unauthenticated',
        reason,
        remaining: store.snapshot().connectedCount,
      });
    });
  });

  log('OK', 'SOCKET', 'Socket.IO handler initialized');
}

/**
 * Emit "retrieve_request" to a specific driver by driverId.
 * Called from server.js after the FCM push, so both channels fire together.
 * Returns true if the driver had an active socket, false if offline.
 */
function emitRetrieveRequest(io, driverId, payload) {
  const socketId = store.getSocketId(driverId);
  if (!socketId) return false;
  io.to(socketId).emit('retrieve_request', payload);
  return true;
}

/**
 * Broadcast "retrieve_request" to ALL connected drivers.
 * Used when no specific driver is targeted (broadcast to all valets).
 */
function broadcastRetrieveRequest(io, payload) {
  io.emit('retrieve_request', payload);
}

/**
 * Broadcast "retrieve_cancelled" to ALL connected drivers.
 */
function broadcastCancelled(io, carId) {
  io.emit('retrieve_cancelled', { carId });
}

/**
 * Broadcast "car_delivered" to ALL connected drivers.
 */
function broadcastDelivered(io, carId, carNumber) {
  io.emit('car_delivered', { carId, carNumber });
}

module.exports = {
  initSocketHandler,
  emitRetrieveRequest,
  broadcastRetrieveRequest,
  broadcastCancelled,
  broadcastDelivered,
};
