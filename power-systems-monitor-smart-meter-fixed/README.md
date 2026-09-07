# Power Systems Monitor

A professional rebuild of the original single-file `Power_System_Monitor.html`
app into a real separated frontend + backend, with the same five modules:

| Module | What it does |
|---|---|
| **EB Station** | Station staff log in (per-station credentials) to register meters, bill customers by unit slab, and record payments. |
| **State EB Overview** | State admin dashboard - aggregated units, collections, and dues by state, district, and station. Includes an editable tariff table. |
| **Power Grid Monitor** | Public live feeder-voltage board, grouped by EB station and then by transformer (T1-T10). Every consumer is registered against a specific station + transformer, and appears here automatically the moment they're registered - flagging over/under-voltage once their meter starts reporting. |
| **Manage EB Stations** (`frontend/station-admin.html`, state admin only) | Add a brand-new EB station (sets its userid/code + password) or reset the login of an existing one. A new station is automatically wired into the grid (10 transformers, T1-T10), the login system, and the State EB Overview totals - no other file needs to be edited. Backed by `backend/routes/stations.js`. |
| **EB Bill Payment** | Public portal - look up a meter ID, see the amount due, pay via UPI QR code. |
| **Consumption Predictor** | Public tool - enter a meter ID for a slab-by-slab cost breakdown, a simulated daily-usage chart, and savings tips. |
| **Smart Meter Telemetry** | Ingests live readings from field ESP8266 + PZEM-004T meters (see `firmware/`) over Wi-Fi and matches them to the right customer by Meter ID, automatically updating that meter's row in the EB Station dashboard and, if linked, its feeder on the Power Grid Monitor. |

## What changed from the original file

The original was one 1.5MB HTML file: five mini-apps stuffed into `<iframe srcdoc>`
blocks, sharing data through the browser's `localStorage`, with station and
admin passwords sitting in plaintext inside client-side JavaScript (anyone
could open dev tools and read `STATIONS["EB001"] = "1234"`).

This version:
- Moves all data and business logic to a real backend API. The browser never
  sees anyone else's password, and billing math lives in exactly one place
  (`backend/lib/billing.js`) instead of being copy-pasted across three pages.
- Hashes passwords (scrypt) and issues short-lived signed session tokens
  instead of a plaintext string comparison in the browser.
- Splits the frontend into real, separate pages with a shared design system,
  instead of one giant file with duplicated CSS per module.
- Makes the tariff table admin-editable data instead of a number hardcoded
  into JavaScript in three different places.

## Why there's no `npm install` step

This was built in a sandbox with no access to the npm registry, so the
backend and frontend are **zero-dependency**: plain Node.js `http`, `crypto`,
and `fs` only. No native modules to compile, no version drift, runs the same
everywhere `node` runs. See "Moving to a real database / Express" below if
you'd rather build on those instead.

## Running it

Requires Node.js 18+.

```bash
# Terminal 1 - backend API (port 4000)
cd backend
node server.js
# First run auto-seeds demo data into backend/db/data/db.json

# Terminal 2 - frontend (port 5500)
cd frontend
node server.js
```

Then open **http://localhost:5500**.

Demo credentials:
- Stations: `EB001` / `1234`, `EB002` / `5678`, `EB003` / `9999`
- State admin: `SIVA` / `Siva2006@1`

To reset all data back to the seed state, stop the backend and delete
`backend/db/data/db.json`, then start it again.

## Project structure

```
backend/
  server.js            entry point, wires routes together
  lib/
    router.js           tiny Express-like router (no deps available)
    auth.js              password hashing + signed session tokens
    billing.js            single source of truth for tariff math
  middleware/index.js    CORS/security headers, auth guard, rate limiter
  routes/                 auth, customers, billing, tariff, grid, state
  db/
    store.js              JSON file data store (repository-style API)
    seed.js                demo data
    data/db.json           generated on first run (gitignored)

frontend/
  index.html               landing page with module cards
  station-login.html / station-dashboard.html
  state-login.html / state-dashboard.html
  grid-monitor.html
  bill-payment.html
  consumption-calculator.html
  css/styles.css            shared design system
  js/api.js                  fetch wrapper + session helpers used by every page
  server.js                   static file server

firmware/
  esp8266_pzem_meter/
    esp8266_pzem_meter.ino    ESP8266 sketch: PZEM-004T -> LCD -> Wi-Fi -> /api/telemetry
    README.md                  wiring table + library list
```

## Smart energy meter (ESP8266 + PZEM-004T) integration

A physical meter in `firmware/esp8266_pzem_meter/` reads live voltage,
current, power, frequency, power factor and cumulative energy from a
**PZEM-004T v3.0** module and posts them over Wi-Fi to this backend. Each
meter is identified by the same `meterId` (e.g. `AR1001`) already used
everywhere else in the app, so a reading:

1. Arrives at `POST /api/telemetry` with `X-Device-Key: <shared secret>`.
2. Is matched to that meter's customer record (`backend/routes/telemetry.js`),
   overwriting its live voltage/current/power/frequency/PF and `lastSeen`,
   and re-billing it using the PZEM's cumulative energy counter as the
   authoritative "units" reading — no manual meter reading needed.
3. If that customer was registered with a `feederId` (linking it to a
   Power Grid Monitor feeder), the same voltage reading is pushed onto that
   feeder too, so the public grid board reflects the real sensor.

Both the **EB Station dashboard** (a new "Live reading" column, polling
every 5s) and the **Power Grid Monitor** update automatically — nobody
re-types a number.

### Hardware

| Part | Role |
|---|---|
| **HI-LINK HLK-PM01** | AC-DC module: 220V mains in -> isolated 5V/3W out. Powers the ESP8266, LCD, and the PZEM's logic side only — never wire it into the PZEM's mains sensing terminals. |
| **PZEM-004T v3.0** | Non-invasive AC meter: mains L/N pass-through for voltage, external CT clamp (100A) around the live wire to the load for current. Talks TTL UART (9600 baud, Modbus-RTU) to the ESP8266. |
| **ESP8266 (NodeMCU/D1 Mini)** | Polls the PZEM over `SoftwareSerial`, drives the LCD, posts JSON to the backend over Wi-Fi. |
| **16x2 I2C LCD (PCF8574 backpack)** | Shows voltage/current/power and Wi-Fi/upload status on-site. |

See `firmware/esp8266_pzem_meter/README.md` for the full wiring table and
`firmware/esp8266_pzem_meter/esp8266_pzem_meter.ino` for the sketch.

### Backend setup for real devices

Set a real shared secret before deploying (the sketch and the server must
match):

```bash
export DEVICE_API_KEY="a-long-random-string"
```

The meter must already exist as a customer (register it once from the EB
Station dashboard with its Meter ID, and optionally a Grid Feeder ID) —
`POST /api/telemetry` updates existing meters, it doesn't create new
customers automatically, so a reading for an unregistered meter ID is
rejected with a 404 telling you to register it first.

## Moving to a real database / Express

The route files are written against a small Express-like `(req, res, next)`
shape and a repository-style store (`store.all()`, `store.mutate()`), so:
- Swapping `lib/router.js` for real Express is a matter of replacing
  `app.get/post/put` calls 1:1 - the route handlers don't need to change.
- Swapping `db/store.js` for Postgres/SQLite means rewriting `all()` and
  `mutate()` to run real queries; every route file calls only those two
  functions, never touches the JSON file directly.

## Security notes for production use

- Set `TOKEN_SECRET` via environment variable before deploying (a default
  dev-only value is used otherwise).
- Set `DEVICE_API_KEY` via environment variable before deploying real ESP8266
  meters (a default dev-only value is used otherwise) — flash the same value
  into the firmware's `DEVICE_KEY` constant.
- The customer record includes an optional "ID proof number" field mirroring
  the original app's Aadhaar field - treat this as sensitive PII: encrypt at
  rest, restrict access, and check applicable data-protection requirements
  (e.g. India's DPDP Act) before collecting real government ID numbers.
- The bill-payment page uses a placeholder UPI VPA (`demo-eb-office@upi`) and
  confirms payment client-side after redirect - wire a real payment
  gateway's server-to-server webhook before handling real money.
- `CORS_ORIGIN` defaults to `*`; lock it to your real frontend origin in
  production.
