'use strict';
/**
 * Shared billing math. The original app duplicated the same slab formula
 * three times (EB Station's calculateAmount, the bill-payment page, and the
 * consumption predictor's getSlabBreakdown) - if the tariff ever changed,
 * only some copies would get updated. Here every route calls this module,
 * and the slabs themselves are configurable data (see routes/tariff.js)
 * instead of numbers hardcoded into JavaScript.
 */
const store = require('../db/store');

/**
 * Consumers are either single-phase (household-style) or three-phase
 * (higher-load/industrial-style) connections. Each phase type is billed on
 * its own tariff slab table, since 3-phase consumption and pricing differ
 * from 1-phase. `PHASES` is the single source of truth for which phase
 * values are valid anywhere in the app (registration form, admin tariff
 * editor, grid safe-range lookup).
 */
const PHASES = ['1-phase', '3-phase'];
const DEFAULT_PHASE = '1-phase';

function normalizePhase(phase) {
  const p = String(phase || '').trim().toLowerCase();
  return PHASES.includes(p) ? p : DEFAULT_PHASE;
}

/** Default slabs per phase, seeded once; 3-phase rates are higher to reflect heavier load. */
const DEFAULT_SLABS_BY_PHASE = {
  '1-phase': [
    { order: 1, label: '0-100 (Free slab)', minUnits: 0, maxUnits: 100, rate: 0 },
    { order: 2, label: '101-200', minUnits: 100, maxUnits: 200, rate: 2.5 },
    { order: 3, label: '201-300', minUnits: 200, maxUnits: 300, rate: 4.0 },
    { order: 4, label: '300+', minUnits: 300, maxUnits: null, rate: 6.0 }
  ],
  '3-phase': [
    { order: 1, label: '0-100', minUnits: 0, maxUnits: 100, rate: 3.0 },
    { order: 2, label: '101-300', minUnits: 100, maxUnits: 300, rate: 6.0 },
    { order: 3, label: '301-500', minUnits: 300, maxUnits: 500, rate: 8.5 },
    { order: 4, label: '500+', minUnits: 500, maxUnits: null, rate: 10.0 }
  ]
};
// Flat list kept for back-compat with any old data shape (no phase field).
const DEFAULT_SLABS = DEFAULT_SLABS_BY_PHASE['1-phase'];

function getSlabs(phase) {
  phase = normalizePhase(phase);
  const all = store.all('tariffSlabs');
  const forPhase = all.filter((s) => normalizePhase(s.phase) === phase);
  return forPhase.length ? forPhase.sort((a, b) => a.order - b.order) : DEFAULT_SLABS_BY_PHASE[phase];
}

/** Calculate total amount due for a given unit count against current slabs for that phase. */
function calculateAmount(units, phase) {
  return getBreakdown(units, phase).totalCost;
}

/** Full per-slab breakdown, used by the customer view and consumption analyzer. */
function getBreakdown(units, phase) {
  units = Number(units) || 0;
  const slabs = getSlabs(phase);
  let remaining = units;
  const breakdown = slabs.map((slab) => {
    const span = slab.maxUnits === null ? Infinity : slab.maxUnits - slab.minUnits;
    const used = Math.max(0, Math.min(remaining, span));
    remaining -= used;
    return {
      label: slab.label,
      minUnits: slab.minUnits,
      maxUnits: slab.maxUnits,
      rate: slab.rate,
      units: used,
      cost: Number((used * slab.rate).toFixed(2))
    };
  });
  const totalCost = Number(breakdown.reduce((sum, s) => sum + s.cost, 0).toFixed(2));
  return { slabs: breakdown, totalCost, phase: normalizePhase(phase) };
}

module.exports = {
  getSlabs,
  calculateAmount,
  getBreakdown,
  DEFAULT_SLABS,
  DEFAULT_SLABS_BY_PHASE,
  PHASES,
  DEFAULT_PHASE,
  normalizePhase
};
