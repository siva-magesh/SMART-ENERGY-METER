/*
  ESP8266 + PZEM-004T v3.0 Smart Energy Meter (OLED version)
  ------------------------------------------------------------
  Part of the Power Systems Monitor project.

  What this sketch does, every READ_INTERVAL_MS:
    1. Reads voltage, current, power, energy, frequency and power factor
       from a PZEM-004T v3.0 module over a software-serial UART.
    2. Shows the live reading on a 128x64 I2C OLED (SSD1306), alternating
       with the Wi-Fi / upload status.
    3. POSTs the reading as JSON to the backend's telemetry endpoint,
       tagged with this meter's METER_ID. The server matches that ID to
       the right customer record and updates the EB Station dashboard and
       (if linked) the Power Grid Monitor automatically.

  Power: this board, the OLED, and the PZEM's LOGIC side are all powered
  from a HI-LINK HLK-PM01 (220V AC -> isolated 5V DC). The PZEM's mains
  sensing side (L/N pass-through + CT clamp) is separate high-voltage
  wiring — see README.md in this folder before wiring anything up.

  Required libraries (Arduino IDE -> Library Manager):
    - ESP8266WiFi, ESP8266HTTPClient   (bundled with the ESP8266 board package)
    - PZEM004Tv30       by Jakub Mandula     ("PZEM004T v30")
    - Adafruit SSD1306  by Adafruit
    - Adafruit GFX Library  by Adafruit
    - ArduinoJson       by Benoit Blanchon   (v6.x)

  Board package: install "esp8266" by ESP8266 Community in Boards Manager,
  then select e.g. "NodeMCU 1.0 (ESP-12E Module)".
*/

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <SoftwareSerial.h>
#include <PZEM004Tv30.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>

// ────────────────────────────────────────────────────────────
// CONFIG — edit these for your Wi-Fi, server, and this specific meter
// ────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "SIVA MAGESH";
const char* WIFI_PASSWORD = "1234567890";

// Backend base URL. Use your PC/server's LAN IP, not "localhost" — the
// ESP8266 is a separate device on the network. Port 4000 = backend/server.js.
const char* SERVER_URL = "http://192.168.137.1:4000/api/telemetry";

// Must exactly match DEVICE_API_KEY on the backend (see backend README).
const char* DEVICE_KEY = "dev-only-device-key-change-me";

// This meter's ID. Must already be registered as a customer in the EB
// Station dashboard (Meter ID field) before readings will be accepted.
const char* METER_ID = "KK1001";

const unsigned long READ_INTERVAL_MS  = 5000;   // how often to read + upload
const unsigned long WIFI_RETRY_MS     = 15000;  // how often to retry a dropped Wi-Fi link
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 12000;

// ────────────────────────────────────────────────────────────
// PIN MAP (NodeMCU / D1 Mini silkscreen labels)
// ────────────────────────────────────────────────────────────
//   OLED (I2C, SSD1306):          SDA -> D2 (GPIO4)   SCL -> D1 (GPIO5)
//   PZEM-004T (TTL UART):         ESP RX <- PZEM TX -> D6 (GPIO12)
//                                 ESP TX -> PZEM RX <- D5 (GPIO14)
#define OLED_SDA_PIN D2
#define OLED_SCL_PIN D1
#define PZEM_RX_PIN  D6   // ESP8266 receives here, wire to PZEM TX
#define PZEM_TX_PIN  D5   // ESP8266 transmits here, wire to PZEM RX

#define SCREEN_WIDTH   128
#define SCREEN_HEIGHT 64
// Most SSD1306 128x64 modules are at 0x3C; some are 0x3D — change if the
// OLED stays blank after wiring is confirmed correct.
#define OLED_I2C_ADDR 0x3C

SoftwareSerial pzemSerial(PZEM_RX_PIN, PZEM_TX_PIN);
PZEM004Tv30 pzem(pzemSerial);

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

unsigned long lastReadAt = 0;
unsigned long lastWifiAttemptAt = 0;

void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
    Serial.println("SSD1306 allocation failed — check wiring/address");
    while (true) delay(1000); // halt, nothing more we can do without the display
  }

  display.setTextColor(SSD1306_WHITE);
  oledMessage("Smart EB Meter", String("ID: ") + METER_ID);
  delay(1500);

  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptAt > WIFI_RETRY_MS) {
    connectWiFi();
  }

  if (millis() - lastReadAt >= READ_INTERVAL_MS) {
    lastReadAt = millis();
    readAndUpload();
  }
}

// ────────────────────────────────────────────────────────────
// Wi-Fi
// ────────────────────────────────────────────────────────────
void connectWiFi() {
  lastWifiAttemptAt = millis();
  oledMessage("Connecting WiFi", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
    oledMessage("WiFi connected", WiFi.localIP().toString());
    delay(1000);
  } else {
    Serial.println();
    Serial.println("WiFi connect failed, will retry");
    oledMessage("WiFi FAILED", "retrying...");
  }
}

// ────────────────────────────────────────────────────────────
// PZEM read + OLED display + HTTP upload
// ────────────────────────────────────────────────────────────
void readAndUpload() {
  float voltage = pzem.voltage();
  float current = pzem.current();
  float power = pzem.power();
  float energy = pzem.energy();       // cumulative kWh, stored on the PZEM itself
  float frequency = pzem.frequency();
  float powerFactor = pzem.pf();

  bool validReading = !isnan(voltage) && !isnan(current) && !isnan(power);

  if (!validReading) {
    Serial.println("PZEM read failed (check wiring / mains power to PZEM)");
    oledMessage("PZEM read error", "check wiring");
    return;
  }

  Serial.printf(
    "V=%.1fV  I=%.2fA  P=%.0fW  E=%.3fkWh  F=%.1fHz  PF=%.2f\n",
    voltage, current, power, energy, frequency, powerFactor
  );

  // Full-detail readout — OLED has room for more than the old 16x2 LCD did
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.printf("Meter: %s\n", METER_ID);
  display.drawLine(0, 10, SCREEN_WIDTH - 1, 10, SSD1306_WHITE);

  display.setCursor(0, 16);
  display.printf("V: %.1f V\n", voltage);
  display.setCursor(0, 27);
  display.printf("I: %.2f A\n", current);
  display.setCursor(0, 38);
  display.printf("P: %.0f W\n", power);

  display.setCursor(70, 16);
  display.printf("E:%.2fkWh", energy);
  display.setCursor(70, 27);
  display.printf("F:%.1fHz", frequency);
  display.setCursor(70, 38);
  display.printf("PF:%.2f", powerFactor);

  display.display();

  bool uploadOk = uploadReading(voltage, current, power, energy, frequency, powerFactor);

  delay(1200);
  oledMessage(
    uploadOk ? "Uploaded OK" : "Upload FAILED",
    String("Meter ") + METER_ID
  );
}

bool uploadReading(float voltage, float current, float power, float energy, float frequency, float powerFactor) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Skip upload: WiFi not connected");
    return false;
  }

  WiFiClient client;
  HTTPClient http;

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("HTTP begin() failed");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  StaticJsonDocument<256> doc;
  doc["meterId"] = METER_ID;
  doc["voltage"] = voltage;
  doc["current"] = current;
  doc["power"] = power;
  doc["energy"] = energy;
  doc["frequency"] = frequency;
  doc["powerFactor"] = powerFactor;

  String payload;
  serializeJson(doc, payload);

  int statusCode = http.POST(payload);
  bool ok = statusCode == 200;

  if (ok) {
    Serial.println("Upload OK");
  } else {
    Serial.printf("Upload failed, HTTP status %d\n", statusCode);
    Serial.println(http.getString());
  }

  http.end();
  return ok;
}

// ────────────────────────────────────────────────────────────
// OLED helper — mimics the old 2-line LCD message style
// ────────────────────────────────────────────────────────────
void oledMessage(const String& line1, const String& line2) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 20);
  display.println(line1);
  display.setCursor(0, 36);
  display.println(line2);
  display.display();
}
