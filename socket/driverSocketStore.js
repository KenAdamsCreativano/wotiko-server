/**
 * driverSocketStore.js
 *
 * In-memory store that maps driverId → socketId.
 *
 * Why in-memory and not Redis?
 *   This is a single-process Node server. If you scale to multiple processes
 *   later, swap this for a Redis adapter (socket.io-redis) and replace
 *   getSocketId() with a pub/sub emit to all processes.
 *
 * Structure:
 *   driverSockets  : Map<driverId, socketId>   — for targeted emit
 *   socketDrivers  : Map<socketId, driverId>   — for fast disconnect cleanup
 */

const driverSockets = new Map(); // driverId  → socketId
const socketDrivers = new Map(); // socketId  → driverId

/**
 * Register a driver socket.
 * Clears any previous socket entry for the same driverId (re-login / reconnect).
 */
function register(driverId, socketId) {
  // Remove stale reverse entry for old socket if driver reconnects
  const oldSocketId = driverSockets.get(driverId);
  if (oldSocketId && oldSocketId !== socketId) {
    socketDrivers.delete(oldSocketId);
  }

  driverSockets.set(driverId, socketId);
  socketDrivers.set(socketId, driverId);
}

/** Remove entries for a disconnected socket. */
function unregister(socketId) {
  const driverId = socketDrivers.get(socketId);
  if (driverId) driverSockets.delete(driverId);
  socketDrivers.delete(socketId);
  return driverId; // caller may want to log which driver disconnected
}

/** Get the current socketId for a driverId, or null if offline. */
function getSocketId(driverId) {
  return driverSockets.get(driverId) ?? null;
}

/** Get the driverId for a socketId, or null. */
function getDriverId(socketId) {
  return socketDrivers.get(socketId) ?? null;
}

/** All currently connected driverIds. */
function connectedDriverIds() {
  return [...driverSockets.keys()];
}

/** Snapshot for debugging / admin endpoint. */
function snapshot() {
  return {
    connectedCount : driverSockets.size,
    drivers        : connectedDriverIds(),
  };
}

module.exports = { register, unregister, getSocketId, getDriverId, connectedDriverIds, snapshot };
