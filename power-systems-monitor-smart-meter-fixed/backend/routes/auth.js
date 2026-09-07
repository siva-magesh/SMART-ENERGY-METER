'use strict';
const { Router } = require('../lib/router');
const store = require('../db/store');
const { verifyPassword, signToken } = require('../lib/auth');
const { rateLimit } = require('../middleware');

const router = new Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// POST /api/auth/station-login  { stationId, password }
router.post('/station-login', loginLimiter, (req, res) => {
  const stationId = String(req.body.stationId || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const station = store.all('stations').find((s) => s.code === stationId);

  if (!station || !verifyPassword(password, station.passwordHash)) {
    return res.status(401).json({ error: 'Invalid station ID or password' });
  }

  const token = signToken({ role: 'station', stationCode: station.code, name: station.name });
  res.json({ token, station: { code: station.code, name: station.name } });
});

// POST /api/auth/admin-login  { username, password }
router.post('/admin-login', loginLimiter, (req, res) => {
  const username = String(req.body.username || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const admin = store.all('admins').find((a) => a.username === username);

  if (!admin || !verifyPassword(password, admin.passwordHash)) {
    return res.status(401).json({ error: 'Invalid admin ID or password' });
  }

  const token = signToken({ role: 'admin', adminId: admin.id, name: admin.name });
  res.json({ token, admin: { username: admin.username, name: admin.name } });
});

module.exports = router;
