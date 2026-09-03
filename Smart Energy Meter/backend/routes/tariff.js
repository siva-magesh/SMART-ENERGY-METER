'use strict';
const { Router } = require('../lib/router');
const store = require('../db/store');
const { requireAuth } = require('../middleware');
const { getSlabs, PHASES, normalizePhase } = require('../lib/billing');

const router = new Router();

// GET /api/tariff?phase=1-phase  (public - used by bill payment + consumption
// pages). Defaults to 1-phase when no phase is given, for back-compat.
router.get('/', (req, res) => {
  const phase = normalizePhase(req.query.phase);
  res.json({ phase, slabs: getSlabs(phase) });
});

// PUT /api/tariff  (state admin only)
// body: { phase: '1-phase' | '3-phase', slabs: [{ order, label, minUnits, maxUnits, rate }, ...] }
// Only the slab table for the given phase is replaced - the other phase's
// tariff is left untouched.
router.put('/', requireAuth('admin'), (req, res, next) => {
  try {
    const phase = normalizePhase(req.body.phase);
    const incoming = req.body.slabs;
    if (!Array.isArray(incoming) || !incoming.length) {
      return res.status(400).json({ error: 'slabs array is required' });
    }
    const cleaned = incoming.map((s, i) => ({
      id: i + 1,
      phase,
      order: i + 1,
      label: String(s.label || `Slab ${i + 1}`),
      minUnits: Number(s.minUnits) || 0,
      maxUnits: s.maxUnits === null || s.maxUnits === '' || s.maxUnits === undefined ? null : Number(s.maxUnits),
      rate: Number(s.rate) || 0
    }));
    store.mutate('tariffSlabs', (slabs) => {
      const otherPhase = slabs.filter((s) => normalizePhase(s.phase) !== phase);
      slabs.length = 0;
      slabs.push(...otherPhase, ...cleaned);
    });
    res.json({ phase, slabs: cleaned });
  } catch (err) {
    next(err);
  }
});

// GET /api/tariff/phases  (public - lets forms populate the phase dropdown)
router.get('/meta/phases', (req, res) => {
  res.json({ phases: PHASES });
});

module.exports = router;
