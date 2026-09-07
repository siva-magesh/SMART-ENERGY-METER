'use strict';
/**
 * Telemetry ingestion for physical smart meters (ESP8266 + PZEM-004T).
 *
 * Each meter in the field is identified by the same `meterId` already used
 * everywhere else in this app (e.g. "AR1001"). The device posts a JSON
 * reading here on a timer; this route finds the matching customer record
 * (regardless of which station registered them) and overwrites its live
 * fields in place - so the EB Station dashboard and, if the meter is linked
 * to a feeder, the Power Grid Monitor both update automatically without any
 * human re-entering numbers.
 *
 * Auth: devices can't do an interactive station login, so they authenticate
 * with a shared secret in the `X-Device-Key` header (see middleware/index.js
 * requireDeviceKey). This is separate from the station/admin session tokens
 * used by the browser dashboards.
 */
const { Router } = require('../lib/router');
const store = require('../db/store');
const { requireDeviceKey } = require('../middleware');
const { getBreakdown } = require('../lib/billing');
const { isOnline } = require('../lib/liveStatus');

const router = new Router();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Find a feeder by id across every substation panel, wherever it lives. */
function findFeeder(panels, feederId) {
  for (const panel of panels) {
    for (const sub of panel.substations) {
      const feeder = sub.feeders.find((f) => f.id === feederId);
      if (feeder) return feeder;
    }
  }
  return null;
}

// POST /api/telemetry  (device key - ESP8266 posts a live reading)
// Body: { meterId, voltage, current, power, energy, frequency, powerFactor }
//   - voltage (V), current (A), power (W), frequency (Hz), powerFactor (0-1)
//     come straight from PZEM-004T registers.
//   - energy is the PZEM's cumulative kWh counter for that meter; it becomes
//     this customer's billed "units" so billing math never needs a manual
//     meter-reading entry again.
router.post('/', requireDeviceKey, (req, res, next) => {
  try {
    const b = req.body;
    const meterId = String(b.meterId || '').trim().toUpperCase();
    if (!meterId) return res.status(400).json({ error: 'meterId is required' });

    const voltage = num(b.voltage);
    const current = num(b.current);
    const power = num(b.power);
    const energy = num(b.energy);
    const frequency = num(b.frequency);
    const powerFactor = num(b.powerFactor);

    const now = new Date().toISOString();

    const result = store.mutate('customers', (customers) => {
      const c = customers.find((x) => x.meterId.toUpperCase() === meterId);
      if (!c) return null;

      c.liveVoltage = voltage;
      c.liveCurrent = current;
      c.livePower = power;
      c.liveFrequency = frequency;
      c.livePowerFactor = powerFactor;
      c.lastSeen = now;

      // The PZEM's `energy` field is a cumulative, ever-increasing counter
      // that never resets on the hardware itself. To let a payment "zero
      // out" a customer's billed units without needing to physically reset
      // the meter, we store a per-cycle baseline (energyBaseline) the first
      // time we see a reading after a reset, and always bill on
      // (rawCounter - baseline) rather than the raw counter directly.
      if (energy !== null) {
        if (c.energyBaseline == null) {
          // First reading ever, or first reading since the last payment
          // reset units to 0 - anchor the cycle here so billed units start
          // at 0 instead of jumping to the meter's lifetime total.
          c.energyBaseline = energy;
        }
        const cycleUnits = Math.max(0, energy - c.energyBaseline);
        if (cycleUnits !== c.units) {
          c.units = cycleUnits;
          // Bill against this consumer's own connection type (1-phase vs
          // 3-phase) so the auto-calculated amount always uses the right
          // tariff table.
          c.amount = getBreakdown(cycleUnits, c.phase).totalCost;
          // Status always reflects the freshly-calculated amount, not the
          // previous status string: 0 due (e.g. still inside the free
          // slab) means Paid, anything owed means Not Paid. This keeps the
          // EB Station dashboard correct even when multiple meters post
          // updates back-to-back, instead of only ever flipping
          // Paid -> Not Paid and leaving stale "Not Paid" rows once the
          // bill is actually cleared or a low reading comes back in.
          c.status = c.amount === 0 ? 'Paid' : 'Not Paid';
        }
      }
      c.updatedAt = now;
      return c;
    });

    if (!result) {
      return res.status(404).json({
        error: `Meter ID ${meterId} is not registered at any station yet. Register it in the EB Station dashboard first.`
      });
    }

    // If this meter is also wired into the Power Grid Monitor (customer has
    // a feederId), push the same voltage reading onto that feeder so the
    // public grid board reflects the real sensor, not a manual entry.
    let updatedFeeder = null;
    if (result.feederId && voltage !== null) {
      updatedFeeder = store.mutate('substationPanels', (panels) => {
        const feeder = findFeeder(panels, result.feederId);
        if (feeder) {
          feeder.voltage = voltage;
          // Stamp the moment this feeder actually heard from its meter, so
          // the Power Grid Monitor can tell a fresh reading apart from one
          // that stopped updating because the device lost Wi-Fi.
          feeder.lastSeen = now;
        }
        return feeder || null;
      });
    }

    res.json({ ok: true, customer: result, feeder: updatedFeeder });
  } catch (err) {
    next(err);
  }
});

// GET /api/telemetry/:meterId  (public - lets the LCD firmware or any
// dashboard confirm the last reading the server actually stored)
router.get('/:meterId', (req, res) => {
  const meterId = String(req.params.meterId || '').trim().toUpperCase();
  const c = store.all('customers').find((x) => x.meterId.toUpperCase() === meterId);
  if (!c) return res.status(404).json({ error: 'Meter not found' });

  const online = isOnline(c.lastSeen);

  // If the meter hasn't reported inside the offline window, don't hand
  // back the frozen last reading - report 0 so callers can't mistake a
  // stale value (Wi-Fi dropped, meter powered off, etc.) for a live one.
  res.json({
    meterId: c.meterId,
    online,
    lastSeen: c.lastSeen || null,
    voltage: online ? c.liveVoltage ?? null : 0,
    current: online ? c.liveCurrent ?? null : 0,
    power: online ? c.livePower ?? null : 0,
    frequency: online ? c.liveFrequency ?? null : 0,
    powerFactor: online ? c.livePowerFactor ?? null : 0,
    phase: c.phase,
    units: c.units,
    amount: c.amount,
    status: c.status
  });
});

module.exports = router;