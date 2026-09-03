'use strict';
const { Router } = require('../lib/router');
const store = require('../db/store');
const { requireAuth } = require('../middleware');
const { normalizePhase } = require('../lib/billing');
const { isOnline } = require('../lib/liveStatus');

const router = new Router();

// Each phase type has its own safe operating voltage window - a 1-phase
// household feeder and a 3-phase feeder run at very different nominal
// voltages, so "safe" means something different for each.
const SAFE_RANGE_BY_PHASE = {
  '1-phase': { low: 190, high: 250 },
  '3-phase': { low: 350, high: 450 }
};

function safeRangeFor(phase) {
  return SAFE_RANGE_BY_PHASE[normalizePhase(phase)];
}

function annotate(panels) {
  return panels.map((panel) => {
    let panelHigh = false;
    let panelLow = false;
    const substations = panel.substations.map((sub) => {
      let subHigh = false;
      let subLow = false;
      const feeders = sub.feeders.map((f) => {
        // A feeder is created the moment a consumer registers, before any
        // physical meter has ever reported in - voltage is null until then.
        const hasReading = typeof f.voltage === 'number';

        // "Live" only counts if this feeder has reported within the
        // offline window. A meter that reported once and then lost Wi-Fi
        // (or was powered off) still has an old voltage sitting in the
        // database - without this check the dashboard would keep showing
        // that frozen number as if it were still live. Once it goes
        // quiet, the reading shown falls back to 0 instead.
        const online = hasReading && isOnline(f.lastSeen);
        const voltage = !hasReading ? null : online ? f.voltage : 0;

        const { low, high } = safeRangeFor(f.phase);
        // An offline meter reports 0V, which is a low-voltage condition -
        // so it rolls up into the same "low/underload" bucket as a live
        // reading that has sagged below the safe range. "offline" is still
        // exposed as its own status label for the feeder row (so the UI can
        // show "0V - offline" instead of a generic "low"), but for the
        // purposes of the substation/panel-level rollup it counts as low.
        const status = !hasReading ? 'nodata'
          : !online ? 'offline'
          : voltage > high ? 'high'
          : voltage < low ? 'low'
          : 'normal';
        if (status === 'high') subHigh = true;
        if (status === 'low' || status === 'offline') subLow = true;
        return { ...f, voltage, phase: normalizePhase(f.phase), safeRange: { low, high }, status, online };
      });
      if (subHigh) panelHigh = true;
      if (subLow) panelLow = true;
      return { name: sub.name, status: subHigh ? 'high' : subLow ? 'low' : 'normal', feeders };
    });
    return {
      id: panel.id,
      side: panel.side,
      name: panel.name,
      status: panelHigh ? 'OVERLOAD' : panelLow ? 'UNDERLOAD' : 'NORMAL',
      substations
    };
  });
}

// GET /api/grid  (public status board)
router.get('/', (req, res) => {
  res.json({ safeRangeByPhase: SAFE_RANGE_BY_PHASE, panels: annotate(store.all('substationPanels')) });
});

// PUT /api/grid/:panelId/:substationName/:feederId  (station/admin - live meter reading update)
router.put('/:panelId/:substationName/:feederId', requireAuth('station', 'admin'), (req, res, next) => {
  try {
    const { panelId, substationName, feederId } = req.params;
    const voltage = Number(req.body.voltage);
    if (!Number.isFinite(voltage) || voltage < 0) {
      return res.status(400).json({ error: 'voltage must be a non-negative number' });
    }
    const updated = store.mutate('substationPanels', (panels) => {
      const panel = panels.find((p) => p.id === panelId);
      const sub = panel && panel.substations.find((s) => s.name === substationName);
      const feeder = sub && sub.feeders.find((f) => f.id === feederId);
      if (!feeder) return null;
      feeder.voltage = voltage;
      // Manual station/admin entries count as a fresh reading too, same as
      // an automatic meter post - otherwise this value would immediately
      // show as "offline" (0) the moment the grid board polls again.
      feeder.lastSeen = new Date().toISOString();
      return feeder;
    });
    if (!updated) return res.status(404).json({ error: 'Feeder not found' });
    res.json({ feeder: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
