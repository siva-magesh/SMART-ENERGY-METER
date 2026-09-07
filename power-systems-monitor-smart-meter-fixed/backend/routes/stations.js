'use strict';
/**
 * State-admin endpoints for managing EB stations.
 *
 * This is the "manage EB stations" control panel: the state admin (SIVA)
 * uses it to
 *   1. add a brand-new EB station (userid/code + password), which is
 *      automatically wired into every other part of the app with zero
 *      extra steps,
 *   2. reset the userid/password of an existing ("old") station,
 *   3. add extra transformers to a single station if it ever needs more
 *      than the standard 10 (T1-T10),
 *   4. remove a transformer from a station (only allowed while it has no
 *      feeders/consumers on it, so a delete can never silently orphan a
 *      registered customer), and
 *   5. remove an EB station entirely (only allowed while it has zero
 *      registered consumers, for the same reason) - this deletes its
 *      login and its grid panel together, so it disappears from every
 *      screen in one step.
 *
 * "Automatically link with all other" means: the moment a station is
 * created here, it
 *   - can log in immediately at station-login.html (routes/auth.js reads
 *     straight from the `stations` collection this file writes to),
 *   - gets its own grid panel with all 10 transformers (T1-T10) on the
 *     Power Grid Monitor (routes/grid.js reads `substationPanels`, which
 *     buildPanel() below creates in the exact same shape seed.js uses),
 *   - is picked up by the State EB Overview totals (routes/state.js groups
 *     customers `byStation` off `stationCode`, which starts existing but
 *     empty for a new station),
 *   - shares the one global tariff table (routes/tariff.js) automatically,
 *     since tariff is not per-station,
 *   - and once its first consumer registers, that consumer's transformer
 *     choice (routes/customers.js) is validated against the very same
 *     TRANSFORMERS list a new station is built with here.
 * Deleting reverses the same links in one step, and is deliberately
 * refused whenever it would leave a registered consumer pointing at a
 * transformer/station that no longer exists.
 * No other file needs to be touched to add/remove a station or
 * transformer - that is the point of centralizing this in one route +
 * the shared seed.js helpers.
 */
const { Router } = require('../lib/router');
const store = require('../db/store');
const { hashPassword } = require('../lib/auth');
const { requireAuth } = require('../middleware');
const { TRANSFORMERS, buildPanel, buildTransformers } = require('../db/seed');

const router = new Router();
router.use(requireAuth('admin')); // every route below is state-admin only

function publicStation(s) {
  return { id: s.id, code: s.code, name: s.name };
}

// GET /api/stations  - list every EB station (old + new), no password hashes returned
router.get('/', (req, res) => {
  res.json({ stations: store.all('stations').map(publicStation), transformers: TRANSFORMERS });
});

// POST /api/stations
// body: { code, name, password }
// Creates a new EB station and immediately gives it:
//   - a login (station-login.html, same as every existing station)
//   - a grid panel with T1-T10 (Power Grid Monitor)
// so it behaves identically to a station that was seeded on day one.
router.post('/', (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');

    if (!/^[A-Z0-9]{3,20}$/.test(code)) {
      return res.status(400).json({ error: 'Station ID must be 3-20 letters/numbers, e.g. EB004' });
    }
    if (!name) return res.status(400).json({ error: 'Station name is required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const existing = store.all('stations');
    if (existing.some((s) => s.code === code)) {
      return res.status(409).json({ error: `Station ${code} already exists` });
    }

    const station = store.mutate('stations', (stations) => {
      const nextId = stations.reduce((max, s) => Math.max(max, s.id), 0) + 1;
      const s = { id: nextId, code, name, passwordHash: hashPassword(password) };
      stations.push(s);
      return s;
    });

    // Automatic link #1: grid panel, same shape/id convention as seed.js,
    // with all 10 transformers ready and zero feeders (feeders appear the
    // moment this station registers its first consumer).
    store.mutate('substationPanels', (panels) => {
      panels.push(buildPanel(station.code, station.name));
    });

    // Automatic link #2 & #3 (login + state totals) need no extra write:
    // routes/auth.js and routes/state.js both read live off `stations` /
    // `customers` by stationCode, which already reflects this station.

    res.status(201).json({ station: publicStation(station) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/stations/:code/credentials
// body: { name?, password? }  - reset login for an existing ("old") station.
// Works for any station already in the system, seeded or added later.
router.put('/:code/credentials', (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const name = req.body.name !== undefined ? String(req.body.name).trim() : undefined;
    const password = req.body.password !== undefined ? String(req.body.password) : undefined;

    if (password !== undefined && password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    if (name !== undefined && !name) {
      return res.status(400).json({ error: 'Station name cannot be blank' });
    }

    const updated = store.mutate('stations', (stations) => {
      const s = stations.find((x) => x.code === code);
      if (!s) return null;
      if (name !== undefined) s.name = name;
      if (password !== undefined) s.passwordHash = hashPassword(password);
      return s;
    });

    if (!updated) return res.status(404).json({ error: `Station ${code} not found` });

    // Keep the grid panel's display name in sync if the station was renamed.
    if (name !== undefined) {
      store.mutate('substationPanels', (panels) => {
        const panel = panels.find((p) => p.stationCode === code);
        if (panel) panel.name = `${code} - ${name.replace(/^EB Station \d+ - /, '')}`;
      });
    }

    res.json({ station: publicStation(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/stations/:code/transformers
// body: { name }  - add one extra transformer (e.g. "T11") to a single
// station, for the rare case a station needs more than the standard 10.
// This only affects that station's grid panel; it does NOT change the
// TRANSFORMERS list customers.js validates against for every other
// station, since T1-T10 remains the standard everywhere else.
router.post('/:code/transformers', (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const name = String(req.body.name || '').trim().toUpperCase();
    if (!/^T[0-9]+$/.test(name)) {
      return res.status(400).json({ error: 'Transformer name must look like T11, T12, ...' });
    }

    const panel = store.mutate('substationPanels', (panels) => {
      const p = panels.find((x) => x.stationCode === code);
      if (!p) return null;
      if (p.substations.some((s) => s.name === name)) {
        throw Object.assign(new Error(`${name} already exists for ${code}`), { status: 409 });
      }
      p.substations.push({ name, feeders: [] });
      return p;
    });

    if (!panel) return res.status(404).json({ error: `Station ${code} not found` });
    res.status(201).json({ panel });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/stations/:code/transformers/:name
// Removes one transformer from a station's grid panel. Refused if any
// consumer is currently registered against it (registering a consumer is
// what creates a feeder under a transformer - see routes/customers.js
// `syncFeeder` - so "has feeders" and "has consumers" are the same check).
// The base T1 is always kept so a station never ends up with zero
// transformers to register against.
router.delete('/:code/transformers/:name', (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const name = String(req.params.name || '').trim().toUpperCase();

    if (name === 'T1') {
      return res.status(400).json({ error: 'T1 cannot be removed - every station needs at least one transformer' });
    }

    const result = store.mutate('substationPanels', (panels) => {
      const p = panels.find((x) => x.stationCode === code);
      if (!p) return { notFound: true };
      const sub = p.substations.find((s) => s.name === name);
      if (!sub) return { notFoundTransformer: true };
      if (sub.feeders.length > 0) {
        return { inUse: true, count: sub.feeders.length };
      }
      p.substations = p.substations.filter((s) => s.name !== name);
      return { ok: true };
    });

    if (result.notFound) return res.status(404).json({ error: `Station ${code} not found` });
    if (result.notFoundTransformer) return res.status(404).json({ error: `${name} not found on ${code}` });
    if (result.inUse) {
      return res.status(409).json({
        error: `Cannot remove ${name} - ${result.count} consumer(s) are still registered on it. Move or remove them first.`
      });
    }

    res.json({ removed: name, code });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/stations/:code
// Removes an EB station's login and its grid panel together. Refused if
// the station still has any registered consumers, so a delete can never
// silently strand real customer/billing records.
router.delete('/:code', (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();

    const consumerCount = store.all('customers').filter((c) => c.stationCode === code).length;
    if (consumerCount > 0) {
      return res.status(409).json({
        error: `Cannot remove ${code} - it still has ${consumerCount} registered consumer(s). Move or remove them first.`
      });
    }

    const removed = store.mutate('stations', (stations) => {
      const idx = stations.findIndex((s) => s.code === code);
      if (idx === -1) return null;
      return stations.splice(idx, 1)[0];
    });

    if (!removed) return res.status(404).json({ error: `Station ${code} not found` });

    // Automatic unlink: drop its grid panel too, so it disappears from the
    // Power Grid Monitor in the same step it disappears from station login.
    store.mutate('substationPanels', (panels) => {
      const idx = panels.findIndex((p) => p.stationCode === code);
      if (idx !== -1) panels.splice(idx, 1);
    });

    res.json({ removed: code });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
