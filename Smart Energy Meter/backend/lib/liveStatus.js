'use strict';
/**
 * Shared "is this live reading actually fresh?" rule.
 *
 * A smart meter (ESP8266 + PZEM) only ever pushes a reading when it has a
 * working Wi-Fi link. If Wi-Fi drops, the device simply stops posting -
 * nothing tells the server "I'm offline". Without this check, the last
 * good reading would sit in the database forever and dashboards would
 * keep showing a live-looking number that may be minutes or hours stale.
 *
 * So instead of trusting whatever value is stored, every place that
 * displays a live reading first asks "has this meter reported inside the
 * last OFFLINE_AFTER_MS window?". If not, it's treated as offline and the
 * reading shown is forced to 0 rather than the frozen last value.
 */
const OFFLINE_AFTER_MS = 60 * 1000; // no reading for 60s = treat the meter as offline

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  const lastSeenMs = Date.parse(lastSeen);
  return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < OFFLINE_AFTER_MS;
}

module.exports = { OFFLINE_AFTER_MS, isOnline };
