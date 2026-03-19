/**
 * routes/parking.routes.js
 * Full schema stored per record:
 *   driver_name, guest_phone, phone_saved_at,
 *   vehicle_number, parking_area, parking_detail,
 *   parked_at, status, exited_at
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return false;
  }
  return true;
}

function fmtTime(ts) {
  if (!ts) return null;
  const d = ts.toDate();
  return {
    iso: d.toISOString(),
    readable: d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }),
  };
}

function docToObj(doc) {
  const d = doc.data();
  return {
    id:              doc.id,
    driver_name:     d.driver_name,
    guest_phone:     d.guest_phone,
    phone_saved_at:  fmtTime(d.phone_saved_at),   // when phone was saved
    vehicle_number:  d.vehicle_number,
    parking_area:    d.parking_area,
    parking_detail:  d.parking_detail,
    parked_at:       fmtTime(d.parked_at),         // when car was parked
    status:          d.status,
    exited_at:       fmtTime(d.exited_at),
  };
}

module.exports = function(db, admin) {
  const router = express.Router();
  const col    = db.collection('parked_cars');

  // ── GET /api/parking/all ──────────────────────────────────
  router.get('/all', async (req, res) => {
    try {
      const snap = await col.orderBy('parked_at', 'desc').get();
      const cars = snap.docs.map(docToObj);
      res.json({ success: true, total: cars.length, data: cars });
    } catch (err) {
      console.error('GET ALL ERROR:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /api/parking/:id ──────────────────────────────────
  router.get('/:id', param('id').notEmpty(), async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const doc = await col.doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, data: docToObj(doc) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /api/parking/park ────────────────────────────────
  // Full schema stored:
  //   Phase 1 (phone screen): guest_phone + phone_saved_at + driver_name
  //   Phase 2 (vehicle+slot): vehicle_number + parking_area + parking_detail + parked_at
  router.post('/park', [
    body('driver_name').trim().notEmpty().withMessage('driver_name required'),
    body('guest_phone').trim().isLength({ min: 10, max: 10 }).withMessage('guest_phone must be 10 digits'),
    body('vehicle_number').trim().notEmpty().withMessage('vehicle_number required'),
    body('parking_area').trim().notEmpty().withMessage('parking_area required'),
    body('parking_detail').trim().notEmpty().withMessage('parking_detail required'),
  ], async (req, res) => {
    if (!validate(req, res)) return;

    const { driver_name, guest_phone, vehicle_number, parking_area, parking_detail } = req.body;
    const now = admin.firestore.FieldValue.serverTimestamp();

    try {
      const ref = await col.add({
        // ── Driver info ──────────────────────────
        driver_name:    driver_name,

        // ── Phase 1: Phone saved ─────────────────
        guest_phone:    guest_phone,
        phone_saved_at: now,        // timestamp when guest phone was entered

        // ── Phase 2: Car details ─────────────────
        vehicle_number: vehicle_number.toUpperCase(),
        parking_area:   parking_area.toUpperCase(),
        parking_detail: parking_detail,

        // ── Parking timestamp ────────────────────
        parked_at:      now,        // timestamp when car was actually parked

        // ── Status ───────────────────────────────
        status:         'parked',   // parked | retrieve_requested | exited
        exited_at:      null,       // set when car exits
      });

      console.log(`✅ Parked: ${vehicle_number} → Wing ${parking_area} by ${driver_name}`);

      res.status(201).json({
        success: true,
        docId:   ref.id,
        message: `Car ${vehicle_number.toUpperCase()} parked in Wing ${parking_area.toUpperCase()} ✅`,
      });
    } catch (err) {
      console.error('PARK ERROR:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── PATCH /api/parking/:id/status ────────────────────────
  router.patch('/:id/status', [
    param('id').notEmpty(),
    body('status').isIn(['parked', 'retrieve_requested', 'exited'])
      .withMessage('status must be: parked | retrieve_requested | exited'),
  ], async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const ref = col.doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });

      const update = { status: req.body.status };
      if (req.body.status === 'exited') {
        update.exited_at = admin.firestore.FieldValue.serverTimestamp();
      }
      await ref.update(update);
      res.json({ success: true, message: `Status → ${req.body.status}` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── DELETE /api/parking/:id ───────────────────────────────
  router.delete('/:id', param('id').notEmpty(), async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const doc = await col.doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
      await col.doc(req.params.id).delete();
      res.json({ success: true, message: 'Record deleted' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
