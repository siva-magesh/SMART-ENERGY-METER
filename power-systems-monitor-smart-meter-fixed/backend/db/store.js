'use strict';
/**
 * Minimal file-backed data store.
 *
 * This replaces the original app's `localStorage` (which lived in the
 * browser, was unauthenticated, and mixed all five modules' data into one
 * shared namespace) with a single server-side JSON file that every route
 * reads/writes through this module only.
 *
 * Why a JSON file instead of SQLite/Postgres: this sandbox has no network
 * access, so native modules (better-sqlite3) and npm packages (pg) can't be
 * installed. This store keeps the same repository-style API a real DB layer
 * would have (get/insert/update/find), so swapping in Postgres or SQLite
 * later only means rewriting this one file - see backend/README section
 * "Moving to a real database" for the migration path.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DATA = {
  meta: { nextCustomerId: 1, nextFeederReadingId: 1 },
  stations: [],       // { id, code, name, passwordHash }
  admins: [],         // { id, username, passwordHash, name }
  customers: [],       // { id, stationCode, meterId, name, mobile, gender, dob, idProof, address, city,
                       //   district, state, pincode, feederId, units, amount, status, updatedAt,
                       //   liveVoltage, liveCurrent, livePower, liveFrequency, livePowerFactor, lastSeen }
                       //   the live* fields + lastSeen are written by an ESP8266+PZEM smart meter posting
                       //   to POST /api/telemetry (see routes/telemetry.js), keyed by meterId.
  tariffSlabs: [],     // { id, order, label, minUnits, maxUnits, rate }
  substationPanels: [] // { id, side, name, substations: [{ name, feeders: [{ id, name, voltage }] }] }
};

let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
    persist();
  } else {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return cache;
}

function persist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

/** Read-only snapshot access to a collection. */
function all(collection) {
  return JSON.parse(JSON.stringify(ensureLoaded()[collection] || []));
}

/** Mutate a collection via a callback that receives the live array, then persist. */
function mutate(collection, fn) {
  const data = ensureLoaded();
  if (!data[collection]) data[collection] = [];
  const result = fn(data[collection], data.meta);
  persist();
  return result;
}

function resetToDefaults() {
  cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
  persist();
  return cache;
}

module.exports = { all, mutate, resetToDefaults, DATA_FILE };
