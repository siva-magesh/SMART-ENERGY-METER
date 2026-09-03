'use strict';
const { verifyToken } = require('../lib/auth');

/** CORS + baseline security headers (a hand-rolled stand-in for cors()/helmet()). */
function security(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  next();
}

/** Require a valid bearer token; attaches req.user = { role, id/code, name }. */
function requireAuth(...allowedRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token && verifyToken(token);
    if (!payload) {
      return next(Object.assign(new Error('Missing or invalid session token'), { status: 401 }));
    }
    if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
      return next(Object.assign(new Error('Not authorized for this resource'), { status: 403 }));
    }
    req.user = payload;
    next();
  };
}

/**
 * Require a valid device API key for IoT ingestion endpoints (ESP8266 smart
 * meters). Devices can't do an interactive station login, so instead of a
 * signed session token they send a long-lived shared secret in a header.
 * Set DEVICE_API_KEY in the environment before deploying - the value below
 * is a dev-only default, same pattern as TOKEN_SECRET in lib/auth.js.
 */
function requireDeviceKey(req, res, next) {
  const key = req.headers['x-device-key'];
  const expected = process.env.DEVICE_API_KEY || 'dev-only-device-key-change-me';
  if (!key || key !== expected) {
    return next(Object.assign(new Error('Missing or invalid device key'), { status: 401 }));
  }
  next();
}

/** Basic fixed-window rate limiter, keyed by IP, for auth endpoints. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) {
      return next(Object.assign(new Error('Too many attempts. Please wait and try again.'), { status: 429 }));
    }
    next();
  };
}

module.exports = { security, requireAuth, requireDeviceKey, rateLimit };
