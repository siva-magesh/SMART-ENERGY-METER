'use strict';
const { Router } = require('../lib/router');
const store = require('../db/store');
const { requireAuth } = require('../middleware');

const router = new Router();
router.use(requireAuth('admin'));

function totalsFor(list) {
  let units = 0, paid = 0, balance = 0;
  list.forEach((c) => {
    units += Number(c.units) || 0;
    // "Collected" must come from the lifetime totalPaid running total, not
    // from the current `amount` field. `amount`/`status` describe only the
    // bill in progress and get reset to 0/'Not Paid' at the start of every
    // new cycle (see routes/customers.js POST /:id/pay and
    // routes/billing.js POST /pay/:meterId) - summing `amount` for
    // status === 'Paid' customers meant a bill that was JUST paid
    // contributed 0 to "Collected" (its amount was already wiped), so the
    // state dashboard's collected figure never actually grew when a
    // pending amount was paid off. Outstanding still comes from the live
    // `amount` on anything not yet paid, which is correct as-is.
    paid += Number(c.totalPaid) || 0;
    if (c.status !== 'Paid') balance += Number(c.amount) || 0;
  });
  return { units, paid, balance };
}

function groupBy(list, key) {
  const map = {};
  list.forEach((c) => {
    const val = (c[key] || 'Unknown').trim() || 'Unknown';
    if (!map[val]) map[val] = [];
    map[val].push(c);
  });
  return Object.entries(map)
    .map(([name, items]) => ({ name, ...totalsFor(items) }))
    .sort((a, b) => b.units - a.units);
}

// GET /api/state/overview
router.get('/overview', (req, res) => {
  const customers = store.all('customers');
  const stations = store.all('stations');

  res.json({
    summary: {
      totalCustomers: customers.length,
      totalStations: stations.length,
      ...totalsFor(customers)
    },
    byState: groupBy(customers, 'state'),
    byDistrict: groupBy(customers, 'district'),
    byStation: groupBy(customers, 'stationCode')
  });
});

module.exports = router;
