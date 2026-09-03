'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Router } = require('./lib/router');
const { security } = require('./middleware');
const store = require('./db/store');

const PORT = process.env.PORT || 4000;

const app = new Router();
app.use(security);

app.mount('/api/auth', require('./routes/auth'));
app.mount('/api/customers', require('./routes/customers'));
app.mount('/api/billing', require('./routes/billing'));
app.mount('/api/tariff', require('./routes/tariff'));
app.mount('/api/grid', require('./routes/grid'));
app.mount('/api/state', require('./routes/state'));
app.mount('/api/stations', require('./routes/stations'));
app.mount('/api/telemetry', require('./routes/telemetry'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Auto-seed on first boot if the data file doesn't exist yet
if (!fs.existsSync(path.join(__dirname, 'db', 'data', 'db.json'))) {
  console.log('No data file found - seeding demo data...');
  require('./db/seed').run();
} else {
  store.all('stations'); // warm the cache
}

const server = http.createServer((req, res) => app.handle(req, res));
server.listen(PORT, () => {
  console.log(`Power Systems Monitor API listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
