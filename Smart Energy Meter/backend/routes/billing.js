'use strict';
const { Router } = require('../lib/router');
const store = require('../db/store');
const { getBreakdown } = require('../lib/billing');

const router = new Router();

function findCustomer(meterId) {
  const target = String(meterId || '').trim().toUpperCase();
  return store.all('customers').find((c) => c.meterId.toUpperCase() === target);
}

// GET /api/billing/lookup/:meterId  (public bill payment portal)
router.get('/lookup/:meterId', (req, res) => {
  const customer = findCustomer(req.params.meterId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json({
    customer: {
      meterId: customer.meterId,
      name: customer.name,
      mobile: customer.mobile,
      phase: customer.phase,
      amount: customer.amount,
      status: customer.status
    }
  });
});

// POST /api/billing/pay/:meterId  (simulated payment confirmation from UPI redirect)
router.post('/pay/:meterId', (req, res) => {
  const updated = store.mutate('customers', (customers) => {
    const c = customers.find((x) => x.meterId.toUpperCase() === String(req.params.meterId).toUpperCase());
    if (!c) return null;
    if (c.amount > 0) {
      c.status = 'Paid';
      // Same lifetime running total as the station-side pay route
      // (routes/customers.js POST /:id/pay) - must be credited BEFORE
      // amount is zeroed out just below, or the payment disappears from
      // state.js's "Collected" total the instant it's settled.
      c.totalPaid = (Number(c.totalPaid) || 0) + c.amount;
      c.units = 0;
      c.amount = 0;
      // Anchor the next telemetry reading as the start of a new billing
      // cycle, so the meter's ever-increasing lifetime counter doesn't
      // make units jump back up right after payment.
      c.energyBaseline = null;
    }
    c.updatedAt = new Date().toISOString();
    return c;
  });
  if (!updated) return res.status(404).json({ error: 'Customer not found' });
  res.json({ customer: { meterId: updated.meterId, status: updated.status } });
});

// GET /api/billing/analyze/:meterId  (consumption predictor)
router.get('/analyze/:meterId', (req, res) => {
  const customer = findCustomer(req.params.meterId);
  if (!customer) return res.status(404).json({ error: 'Meter ID not found. Please check and try again.' });

  const totalUnits = Number(customer.units) || 0;
  const { slabs, totalCost } = getBreakdown(totalUnits, customer.phase);

  // Deterministic simulated daily curve (seeded by meter id) instead of raw Math.random()
  // so repeated lookups for the same meter return a stable chart.
  const seed = [...customer.meterId].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  let rngState = seed;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  const days = 30;
  const baseDaily = Math.floor(totalUnits / days);
  const dailyData = Array.from({ length: days }, () => {
    const r = rng();
    const variation = r > 0.7 ? baseDaily * 1.2 : r > 0.3 ? baseDaily : baseDaily * 0.9;
    return Math.max(0, Math.floor(variation));
  });
  const avgDaily = Math.round(totalUnits / days);
  const peakDays = dailyData.filter((u) => u > avgDaily * 1.1).length;

  // Tip thresholds are relative to this customer's own phase slab table
  // (1-phase and 3-phase have very different unit ranges per slab), so pick
  // them from the actual slab ceilings just resolved above rather than
  // hardcoded numbers that only made sense for 1-phase.
  const ceilings = slabs.map((s) => s.maxUnits).filter((v) => v !== null);
  const [tier1, tier2, tier3] = ceilings.length >= 3 ? ceilings : [100, 300, 500];
  const tips = totalUnits <= tier1
    ? ['Consumption is in the free/lowest slab - keep using energy-efficient appliances.', 'Switching to LED bulbs helps maintain this level.']
    : totalUnits <= tier2
      ? ['Consumption is in the low-cost slab.', 'Avoid running the AC during peak hours (6-10 PM) to save further.']
      : totalUnits <= tier3
        ? ['Moderate consumption - watch for the next slab threshold.', 'Ceiling fans instead of AC can meaningfully cut usage.']
        : ['High consumption - this is the most expensive slab.', 'Consider solar panels or a sub-meter to track high-draw appliances.'];

  res.json({
    customer: { name: customer.name, mobile: customer.mobile, address: customer.address, state: customer.state, meterId: customer.meterId, phase: customer.phase },
    totalUnits,
    amount: totalCost,
    avgDaily,
    peakDays,
    dailyData,
    slabs,
    tips
  });
});

module.exports = router;
