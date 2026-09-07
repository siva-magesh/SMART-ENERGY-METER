'use strict';
const store = require('./store');
const { hashPassword } = require('../lib/auth');
const { DEFAULT_SLABS_BY_PHASE } = require('../lib/billing');

/**
 * Every EB station has exactly 10 transformers: T1 ... T10.
 * A consumer is always registered against one of these transformers, and
 * that same T1-T10 name is what shows up as a "substation" on the Power Grid
 * Monitor for that station - so the grid view always answers "which EB
 * station, which transformer" for every consumer. Feeders (the individual
 * rows under a transformer) start empty and are created automatically the
 * moment a consumer is registered - see routes/customers.js `syncFeeder`.
 *
 * This list is the single source of truth for transformer count/names.
 * routes/customers.js (registration form validation) and
 * routes/stations.js (new-station provisioning) both import TRANSFORMERS
 * from here, so bumping the count only ever needs to happen in this one
 * place.
 */
const TRANSFORMERS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];

function buildTransformers() {
  return TRANSFORMERS.map((name) => ({ name, feeders: [] }));
}

/**
 * Build a brand-new substation grid panel for one EB station code, wired up
 * exactly the way the seeded ones are (id === stationCode, same naming
 * convention, all transformers present with empty feeders). Used both by
 * `run()` below and by routes/stations.js when an admin adds a station at
 * runtime, so a new station always ends up structurally identical to a
 * seeded one - no separate/divergent code path.
 */
function buildPanel(stationCode, stationName) {
  return {
    id: stationCode,
    stationCode,
    name: `${stationCode} - ${stationName.replace(/^EB Station \d+ - /, '')}`,
    substations: buildTransformers()
  };
}

function run() {
  // Wipes any previously saved EB station / grid / consumer data and
  // rebuilds a clean starting state (station + admin logins only - no demo
  // consumers, no demo feeder readings).
  store.resetToDefaults();

  store.mutate('stations', (stations) => {
    stations.push(
      { id: 1, code: 'EB001', name: 'EB Station 001 - Ariyalur', passwordHash: hashPassword('1234') },
      { id: 2, code: 'EB002', name: 'EB Station 002 - Perambalur', passwordHash: hashPassword('5678') },
      { id: 3, code: 'EB003', name: 'EB Station 003 - Trichy North', passwordHash: hashPassword('9999') }
    );
  });

  store.mutate('admins', (admins) => {
    admins.push({ id: 1, username: 'SIVA', name: 'State EB Administrator', passwordHash: hashPassword('Siva2006@1') });
  });

  // Seed both phases' default tariff tables, each as its own slab set.
  store.mutate('tariffSlabs', (slabs) => {
    let id = 1;
    Object.entries(DEFAULT_SLABS_BY_PHASE).forEach(([phase, phaseSlabs]) => {
      phaseSlabs.forEach((s) => slabs.push({ id: id++, phase, ...s }));
    });
  });

  // One grid panel per EB station, each with transformers T1-T4 and no
  // feeders yet - feeders are added automatically as consumers register.
  store.mutate('substationPanels', (panels) => {
    const stations = store.all('stations');
    stations.forEach((s) => {
      panels.push(buildPanel(s.code, s.name));
    });
  });

  // No demo consumers - `customers` stays empty so the first record any
  // station creates is a real, fully-filled-in registration.

  console.log('Seed complete (cleared) ->', store.DATA_FILE);
}

if (require.main === module) run();
module.exports = { run, TRANSFORMERS, buildTransformers, buildPanel };
