'use strict';
/**
 * Password hashing + signed tokens using only Node's built-in `crypto`.
 *
 * The original app checked `STATIONS["EB001"] === "1234"` directly in
 * client-side JavaScript - anyone could read every station's and the state
 * admin's password by opening dev tools. Here:
 *   - passwords are salted + hashed with scrypt, never stored or sent in
 *     plaintext after seeding
 *   - logins return a signed, expiring session token (same shape/purpose as
 *     a JWT) that routes verify on every request via requireAuth()
 */
const crypto = require('crypto');

const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-only-secret-change-in-production-6c9f2a';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const json = Buffer.from(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(json).digest();
  return `${base64url(json)}.${base64url(sig)}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [bodyPart, sigPart] = token.split('.');
  const json = Buffer.from(bodyPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const expectedSig = base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(json).digest());
  if (expectedSig !== sigPart) return null;
  let payload;
  try {
    payload = JSON.parse(json.toString());
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
