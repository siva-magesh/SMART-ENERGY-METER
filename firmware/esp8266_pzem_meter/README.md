# ESP8266 + PZEM-004T Smart Energy Meter — Wiring

## ⚠️ Mains safety first

This project connects directly to 220V AC mains. If you're not comfortable
working with mains wiring, have a qualified electrician do the physical
install. Always work with the circuit isolated (breaker off) while wiring,
double-check before re-energizing, and enclose all mains connections
(HLK-PM01 input, PZEM L/N terminals) in proper insulated enclosures —
never leave bare 220V terminals exposed. The low-voltage side (5V logic,
ESP8266, LCD, PZEM TX/RX) is safe to touch once wired correctly, but the
HLK-PM01 input side and the PZEM's L/N pass-through are not.

## Bill of materials

| Part | Notes |
|---|---|
| ESP8266 NodeMCU (or D1 Mini) | Any ESP8266 dev board with enough GPIO |
| PZEM-004T **v3.0** | TTL UART version (not the older v1/v2 analog-pin version) |
| Split-core CT clamp | Usually bundled with the PZEM-004T v3.0, rated 100A |
| HI-LINK HLK-PM01 | 220V AC → 5V DC, 3W, isolated |
| 16x2 LCD + PCF8574 I2C backpack | Address is usually 0x27 or 0x3F |
| Enclosure, terminal blocks, fuse | For the mains side |

## Power wiring (HLK-PM01) — logic side only

```
220V AC Line ──┬────────────────► HLK-PM01  IN (L)
220V AC Neutral┴────────────────► HLK-PM01  IN (N)

HLK-PM01 OUT (+5V) ──┬──► ESP8266 5V / VIN pin (NodeMCU accepts 5V here)
                       ├──► LCD I2C backpack VCC
                       └──► PZEM-004T  5V logic pin (NOT the L/N mains pins)
HLK-PM01 OUT (GND) ───┬──► ESP8266 GND
                       ├──► LCD GND
                       └──► PZEM-004T GND
```

The HLK-PM01 only powers the *logic/microcontroller side* of everything.
It never touches the PZEM's L/N mains-sensing terminals or the CT clamp —
those carry the mains current being measured and are wired separately, below.

## PZEM-004T mains sensing (separate from HLK-PM01)

```
220V AC Line ──► PZEM  L_IN ──── PZEM  L_OUT ──► Load (the appliance/circuit being metered)
220V AC Neutral ──────────────────────────────► PZEM  N  (and straight through to the load)

CT clamp: clip around the LIVE wire between PZEM L_OUT and the load,
          with the arrow on the clamp pointing toward the load.
CT clamp leads ──► PZEM CT terminals (polarity matters — reverse if readings are negative)
```

## Low-voltage signal wiring (ESP8266 ↔ PZEM ↔ LCD)

| Signal | ESP8266 (NodeMCU pin) | Connects to |
|---|---|---|
| PZEM TX → ESP RX | **D6** (GPIO12) | PZEM TX pin |
| ESP TX → PZEM RX | **D5** (GPIO14) | PZEM RX pin |
| LCD SDA | **D2** (GPIO4) | LCD backpack SDA |
| LCD SCL | **D1** (GPIO5) | LCD backpack SCL |
| Common ground | GND | PZEM GND + LCD GND (all grounds tied together) |

These pin numbers match the `#define` block at the top of
`esp8266_pzem_meter.ino` — change both together if you rewire.

## Software setup

1. Arduino IDE → **Boards Manager** → install "esp8266 by ESP8266 Community".
2. **Library Manager** → install:
   - `PZEM004Tv30` (by Jakub Mandula)
   - `LiquidCrystal I2C` (by Frank de Brabander)
   - `ArduinoJson` (v6.x, by Benoit Blanchon)
3. Open `esp8266_pzem_meter.ino`, edit the CONFIG block near the top:
   - `WIFI_SSID` / `WIFI_PASSWORD`
   - `SERVER_URL` — your backend's LAN IP, e.g. `http://192.168.1.50:4000/api/telemetry`
     (not `localhost` — that would mean the ESP8266 itself)
   - `DEVICE_KEY` — must match `DEVICE_API_KEY` set on the backend
   - `METER_ID` — must match a Meter ID already registered in the EB Station dashboard
4. Board: **NodeMCU 1.0 (ESP-12E Module)** (or your specific board). Upload.
5. Open Serial Monitor at 115200 baud to watch Wi-Fi connect and readings upload.

## Bringing a new physical meter online

1. In the EB Station dashboard, register the customer with the exact Meter
   ID you'll flash into the device (e.g. `AR1004`), and optionally a Grid
   Feeder ID if this line also feeds a panel on the Power Grid Monitor.
2. Flash the firmware with that `METER_ID`.
3. Power it up — within `READ_INTERVAL_MS` (5s default) the dashboard's
   "Live reading" column should show a green "live" badge with real
   voltage/current/power.

If a reading is rejected with a 404, the meter ID hasn't been registered
yet — the server never auto-creates a customer from a device post.
