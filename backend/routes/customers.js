'use strict';
const { Router } = require('../lib/router');
const store = require('../db/store');
const { requireAuth } = require('../middleware');
const { getBreakdown, PHASES, normalizePhase } = require('../lib/billing');
const { TRANSFORMERS } = require('../db/seed');

const router = new Router();
router.use(requireAuth('station'));

// Every field a consumer record needs before it's considered complete.
// (idProof is intentionally included - "mandatory of all data".)
const REQUIRED_FIELDS = [
  ['meterId', 'Meter ID'],
  ['name', 'Full name'],
  ['mobile', 'Mobile number'],
  ['gender', 'Gender'],
  ['dob', 'Date of birth'],
  ['idProof', 'ID proof number'],
  ['address', 'Address'],
  ['city', 'City'],
  ['district', 'District'],
  ['state', 'State'],
  ['pincode', 'Pincode'],
  ['transformer', 'Transformer (T1-T10)'],
  ['phase', 'Connection type (1-phase or 3-phase)']
];

function validateBody(b) {
  for (const [field, label] of REQUIRED_FIELDS) {
    if (!String(b[field] ?? '').trim()) return `${label} is required`;
  }
  const transformer = String(b.transformer || '').trim().toUpperCase();
  if (!TRANSFORMERS.includes(transformer)) {
    return `Transformer must be one of ${TRANSFORMERS.join(', ')}`;
  }
  const phase = String(b.phase || '').trim().toLowerCase();
  if (!PHASES.includes(phase)) {
    return `Connection type must be one of ${PHASES.join(', ')}`;
  }
  return null;
}

function ownCustomers(req) {
  return store.all('customers').filter((c) => c.stationCode === req.user.stationCode);
}

/**
 * Make sure a feeder exists for this consumer under the right EB station /
 * transformer in the grid data, and that it doesn't linger under some other
 * transformer if the consumer was moved. This is what makes a newly
 * registered (or re-assigned) consumer show up on the Power Grid Monitor
 * automatically, with no manual grid entry required.
 */
function syncFeeder(stationCode, transformer, meterId, name, phase, previousTransformer) {
  store.mutate('substationPanels', (panels) => {
    const panel = panels.find((p) => p.stationCode === stationCode);
    if (!panel) return null;

    // Remove any stale feeder for this meter (e.g. transformer changed on edit).
    panel.substations.forEach((sub) => {
      if (previousTransformer && sub.name === previousTransformer && sub.name !== transformer) {
        sub.feeders = sub.feeders.filter((f) => f.id !== meterId);
      }
    });

    const sub = panel.substations.find((s) => s.name === transformer);
    if (!sub) return null;

    let feeder = sub.feeders.find((f) => f.id === meterId);
    if (!feeder) {
      feeder = { id: meterId, name: name || meterId, phase: normalizePhase(phase), voltage: null };
      sub.feeders.push(feeder);
    } else {
      feeder.name = name || meterId;
      if (phase) feeder.phase = normalizePhase(phase);
    }
    return feeder;
  });
}

// GET /api/customers?search=xxx
router.get('/', (req, res) => {
  const search = String(req.query.search || '').toUpperCase();
  let list = ownCustomers(req);
  if (search) list = list.filter((c) => c.meterId.toUpperCase().includes(search));
  res.json({ customers: list });
});

// GET /api/customers/meta  (transformer + phase list for the registration form)
router.get('/meta', (req, res) => {
  res.json({ transformers: TRANSFORMERS, phases: PHASES });
});

// POST /api/customers
router.post('/', (req, res, next) => {
  try {
    const b = req.body;

    const validationError = validateBody(b);
    if (validationError) return res.status(400).json({ error: validationError });

    const meterId = String(b.meterId || '').trim().toUpperCase();
    const transformer = String(b.transformer || '').trim().toUpperCase();
    const phase = normalizePhase(b.phase);

    const allCustomers = store.all('customers');
    if (allCustomers.some((c) => c.meterId.toUpperCase() === meterId)) {
      return res.status(409).json({ error: 'This Meter ID is already registered' });
    }

    const units = Number(b.units) || 0;
    const record = store.mutate('customers', (customers, meta) => {
      const c = {
        id: meta.nextCustomerId++,
        stationCode: req.user.stationCode,
        meterId,
        name: String(b.name || '').trim(),
        mobile: String(b.mobile || '').trim(),
        gender: b.gender || '',
        dob: b.dob || '',
        idProof: String(b.idProof || '').trim(),
        address: String(b.address || '').trim(),
        city: String(b.city || '').trim(),
        district: String(b.district || '').trim(),
        state: String(b.state || '').trim(),
        pincode: String(b.pincode || '').trim(),
        // Which EB station and which transformer (T1-T10) this consumer
        // belongs to. feederId mirrors meterId - it's how the grid /
        // telemetry routes find this exact consumer's feeder row.
        transformer,
        // 1-phase or 3-phase connection - drives which tariff slab table
        // and which grid safe-voltage window this consumer is billed/checked against.
        phase,
        feederId: meterId,
        units,
        amount: getBreakdown(units, phase).totalCost,
        status: 'Not Paid',
        // Lifetime total of everything this consumer has actually paid.
        // `amount`/`status` only describe the CURRENT bill and get reset to
        // 0/'Not Paid' at the start of each new cycle, so state-level
        // "Collected" totals must be built from this running total instead
        // - otherwise a bill that was just paid (amount now 0) would vanish
        // from the collected figure the instant it's settled.
        totalPaid: 0,
        // Populated by ESP8266 smart-meter readings (see routes/telemetry.js);
        // null until the first reading arrives.
        liveVoltage: null,
        liveCurrent: null,
        livePower: null,
        liveFrequency: null,
        livePowerFactor: null,
        lastSeen: null,
        // Anchors the current billing cycle against the PZEM's cumulative
        // counter; null means "anchor on whatever the next reading is".
        energyBaseline: null,
        updatedAt: new Date().toISOString()
      };
      customers.push(c);
      return c;
    });

    // Immediately create the grid feeder for this consumer's station +
    // transformer, so the Power Grid Monitor shows it without any extra step.
    syncFeeder(req.user.stationCode, transformer, meterId, record.name, phase);

    res.status(201).json({ customer: record });
  } catch (err) {
    next(err);
  }
});

// PUT /api/customers/:id
router.put('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body;
    let previousTransformer = null;
    const updated = store.mutate('customers', (customers) => {
      const c = customers.find((x) => x.id === id && x.stationCode === req.user.stationCode);
      if (!c) return null;

      ['name', 'mobile', 'gender', 'dob', 'idProof', 'address', 'city', 'district', 'state', 'pincode'].forEach((f) => {
        if (b[f] !== undefined) {
          const val = String(b[f]).trim();
          // These fields are mandatory - don't allow clearing them out via edit.
          if (!val) throw Object.assign(new Error(`${f} cannot be blank`), { status: 400 });
          c[f] = val;
        }
      });

      if (b.transformer !== undefined) {
        const transformer = String(b.transformer).trim().toUpperCase();
        if (!TRANSFORMERS.includes(transformer)) {
          throw Object.assign(new Error(`Transformer must be one of ${TRANSFORMERS.join(', ')}`), { status: 400 });
        }
        if (transformer !== c.transformer) {
          previousTransformer = c.transformer;
          c.transformer = transformer;
        }
      }

      if (b.phase !== undefined) {
        const phase = String(b.phase).trim().toLowerCase();
        if (!PHASES.includes(phase)) {
          throw Object.assign(new Error(`Connection type must be one of ${PHASES.join(', ')}`), { status: 400 });
        }
        if (phase !== c.phase) {
          c.phase = phase;
          // Phase change switches the tariff table this consumer is billed
          // against - re-price the current unit count immediately so the
          // displayed amount never reflects the wrong phase's rates.
          c.amount = getBreakdown(c.units, phase).totalCost;
          // Re-derive status from the new amount: 0 due = Paid, otherwise
          // Not Paid. Same rule as the units branch below and telemetry.js.
          c.status = c.amount === 0 ? 'Paid' : 'Not Paid';
        }
      }

      if (b.units !== undefined) {
        const newUnits = Number(b.units) || 0;
        if (newUnits !== c.units) {
          c.units = newUnits;
          c.amount = getBreakdown(newUnits, c.phase).totalCost;
          // Status always reflects the freshly-calculated amount rather
          // than only flipping Paid -> Not Paid: 0 due (e.g. edited back
          // into the free slab) shows Paid, anything owed shows Not Paid.
          c.status = c.amount === 0 ? 'Paid' : 'Not Paid';
        }
      }
      c.updatedAt = new Date().toISOString();
      return c;
    });

    if (!updated) return res.status(404).json({ error: 'Customer not found' });

    // Keep the grid feeder in sync with any name/transformer/phase change.
    syncFeeder(updated.stationCode, updated.transformer, updated.meterId, updated.name, updated.phase, previousTransformer);

    res.json({ customer: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/pay
router.post('/:id/pay', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const updated = store.mutate('customers', (customers) => {
      const c = customers.find((x) => x.id === id && x.stationCode === req.user.stationCode);
      if (!c) return null;
      if (c.amount <= 0) throw Object.assign(new Error('No amount due to pay'), { status: 400 });
      c.status = 'Paid';
      // Bank the amount being settled into the lifetime collected total
      // BEFORE it gets zeroed out below - this is what state.js sums up as
      // "Collected", so it has to happen here, not be derived from `amount`
      // after the fact (amount is about to become 0).
      c.totalPaid = (Number(c.totalPaid) || 0) + c.amount;
      // Start a fresh billing cycle: once paid, the old consumed-units figure
      // is settled and shouldn't linger or get added to by the next smart
      // meter reading. Units/amount go back to 0, and clearing
      // energyBaseline tells telemetry.js to re-anchor on whatever the
      // meter's cumulative counter reads at its very next post - so the new
      // cycle starts counting from 0 instead of the meter's lifetime total.
      c.units = 0;
      c.amount = 0;
      c.energyBaseline = null;
      c.updatedAt = new Date().toISOString();
      return c;
    });
    if (!updated) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customer: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;