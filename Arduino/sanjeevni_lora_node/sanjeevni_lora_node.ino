/*
 * SANJEEVNI - LoRa sensor node (Phase 2)
 * =====================================================================
 * Samples every sensor every 5 s, runs the edge-AI model on the device,
 * and decides locally what to send:
 *   - elevated (edge AI WATCH/URGENT, or a local threshold): send NOW
 *   - normal: one heartbeat reading per minute
 * Every reading to send goes into a LittleFS queue first and is removed
 * only after the gateway (LoRa) or backend (WiFi) acknowledges it - so
 * readings survive link outages and reboots (store-and-forward).
 *
 * Libraries (Arduino Library Manager): RadioLib (jgromes, 6.x/7.x),
 * DHT sensor library (Adafruit), Arduino_TensorFlowLite (or
 * Chirale_TensorFlowLite). Board: ESP32 Dev Module. Partition scheme
 * must include a SPIFFS/LittleFS partition (the default one does).
 *
 * NOT COMPILED OR FLASHED BY THE AUTHOR - test on your board, starting
 * with the Serial Monitor at 115200 baud.
 *
 * Serial commands: z = re-zero tilt, r = MQ135 R0 calibration value,
 * s = soil millivolts, p = pH millivolts, q = queue status, c = clear queue
 */
#include <Arduino.h>
#include <esp_timer.h>
#include "config.h"
#include "sj_packet.h"
#include "sj_file_queue.h"
#include "sensors.h"
#include "edge_ai.h"

#if TRANSPORT == TRANSPORT_LORA
#include <SPI.h>
#include <RadioLib.h>
#elif TRANSPORT == TRANSPORT_WIFI
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "secrets.h"
#else
#error "Set TRANSPORT in config.h"
#endif

// One queued reading + when it was measured (device seconds since boot)
struct QueuedReading {
  SjReading reading;
  uint32_t takenAtS;
};

static SjFileQueue<QueuedReading> queue;
static uint16_t session = 0;  // bumped on every boot, persisted in NVS
static uint32_t seq = 0;

static uint32_t lastSampleMs = 0;
static uint32_t lastReportMs = 0;
static uint32_t nextFlushMs = 0;
static float pendingRainMm = 0;  // rain since the last REPORTED reading
static bool elevated = false;

// Seconds since boot; 64-bit timer, so no 49-day millis() wrap.
static uint32_t deviceSeconds() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }

// =====================================================================
// Reading
// =====================================================================
// Returns false if a REQUIRED sensor failed - the backend would reject
// the reading, so it isn't queued (the failure is logged instead).
static bool takeReading(SjReading& r, EdgeRiskLevel& edge, bool& localAlert) {
  memset(&r, 0, sizeof(r));
  r.magic = SJ_MAGIC;
  r.version = SJ_VERSION;
  r.type = SJ_TYPE_READING;
  strncpy(r.node_id, NODE_ID, SJ_NODE_ID_LEN);
  r.edge_risk = SJ_EDGE_NONE;
  localAlert = false;

  float waterM, tempC, humidity, gasPpm;
  bool ok = true;
  if (readWaterLevelM(waterM)) {
    r.flags |= SJ_HAS_WATER;
    r.water_level_mm = sjClampU16(waterM * 1000.0f);
    localAlert |= waterM >= LOCAL_WATER_FRACTION_LIMIT * ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f;
  } else {
    Serial.println("[sensor] water level: no echo");
    ok = false;
  }
  if (readDht(tempC, humidity)) {
    r.flags |= SJ_HAS_DHT;
    r.temp_c_x100 = sjClampI16(tempC * 100);
    r.humidity_x100 = sjClampU16(humidity * 100);
    localAlert |= tempC >= LOCAL_TEMP_LIMIT_C;
  } else {
    Serial.println("[sensor] DHT22 read failed");
    ok = false;
  }
  if (readGasPpm(gasPpm)) {
    r.flags |= SJ_HAS_GAS;
    r.gas_ppm = sjClampU16(gasPpm);
    localAlert |= gasPpm >= LOCAL_GAS_LIMIT_PPM;
  } else {
    Serial.println("[sensor] MQ135: no signal");
    ok = false;
  }
  bool flame = readFlameDetected();
  r.flags |= SJ_HAS_FLAME;
  if (flame) r.flags |= SJ_FLAME_DETECTED;
  localAlert |= flame;

#if ENABLE_RAIN_GAUGE
  pendingRainMm += readRainSinceLastMm();
  r.flags |= SJ_HAS_RAIN;
  r.rain_mm_x100 = sjClampU16(pendingRainMm * 100);
#endif
#if ENABLE_SOIL
  float soil;
  if (readSoilMoisturePct(soil)) {
    r.flags |= SJ_HAS_SOIL;
    r.soil_moisture_x10 = sjClampU16(soil * 10);
  }
#endif
#if ENABLE_MPU6050
  float tilt, vibration;
  if (readTiltAndVibration(tilt, vibration)) {
    r.flags |= SJ_HAS_TILT;
    r.tilt_deg_x100 = sjClampI16(tilt * 100);
    r.vibration_g_x1000 = sjClampU16(vibration * 1000);
    localAlert |= tilt >= LOCAL_TILT_LIMIT_DEG;
  }
#endif
#if ENABLE_PMS5003
  uint16_t pm25, pm10;
  if (readPm(pm25, pm10)) {
    r.flags |= SJ_HAS_PM;
    r.pm25 = pm25;
    r.pm10 = pm10;
    localAlert |= pm25 >= LOCAL_PM25_LIMIT;
  }
#endif
#if ENABLE_PH
  float ph;
  if (readPh(ph)) {
    r.flags |= SJ_HAS_PH;
    r.ph_x100 = sjClampU16(ph * 100);
  }
#endif
#if ENABLE_TURBIDITY
  float ntu;
  if (readTurbidityNtu(ntu)) {
    r.flags |= SJ_HAS_TURBIDITY;
    r.turbidity_ntu_x10 = sjClampU16(ntu * 10);
  }
#endif
#if ENABLE_BATTERY
  float battery;
  if (readBatteryPct(battery)) {
    r.flags |= SJ_HAS_BATTERY;
    r.battery_x10 = sjClampU16(battery * 10);
  }
#endif

  edge = EDGE_UNAVAILABLE;
  if (ok) {
    edge = runEdgeInference(waterM, tempC, humidity, gasPpm, flame);
    if (edge != EDGE_UNAVAILABLE) r.edge_risk = (uint8_t)edge;
  }
  return ok;
}

static void printReading(const SjReading& r, EdgeRiskLevel edge, bool localAlert) {
  Serial.printf("[%s #%u-%u] water=%.3fm temp=%.1fC hum=%.0f%% gas=%uppm flame=%d",
                NODE_ID, r.session, r.seq, r.water_level_mm / 1000.0f, r.temp_c_x100 / 100.0f,
                r.humidity_x100 / 100.0f, r.gas_ppm, (r.flags & SJ_FLAME_DETECTED) ? 1 : 0);
  if (r.flags & SJ_HAS_RAIN) Serial.printf(" rain=%.2fmm", r.rain_mm_x100 / 100.0f);
  if (r.flags & SJ_HAS_SOIL) Serial.printf(" soil=%.0f%%", r.soil_moisture_x10 / 10.0f);
  if (r.flags & SJ_HAS_TILT) Serial.printf(" tilt=%.2fdeg vib=%.3fg", r.tilt_deg_x100 / 100.0f, r.vibration_g_x1000 / 1000.0f);
  if (r.flags & SJ_HAS_PM) Serial.printf(" pm2.5=%u pm10=%u", r.pm25, r.pm10);
  if (r.flags & SJ_HAS_PH) Serial.printf(" pH=%.2f", r.ph_x100 / 100.0f);
  if (r.flags & SJ_HAS_TURBIDITY) Serial.printf(" turb=%.0fNTU", r.turbidity_ntu_x10 / 10.0f);
  if (r.flags & SJ_HAS_BATTERY) Serial.printf(" batt=%.0f%%", r.battery_x10 / 10.0f);
  Serial.printf(" | edge=%s local_alert=%d queued=%u\n",
                edge <= EDGE_URGENT ? SJ_EDGE_NAMES[edge] : "n/a", localAlert, queue.count());
}

// =====================================================================
// Transport
// =====================================================================
#if TRANSPORT == TRANSPORT_LORA
static SX1278 radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST);
static volatile bool loraIrq = false;
static void IRAM_ATTR onLoraDio0() { loraIrq = true; }

static bool setupTransport() {
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int state = radio.begin(LORA_FREQUENCY_MHZ, LORA_BANDWIDTH_KHZ, LORA_SPREADING_FACTOR, LORA_CODING_RATE,
                          LORA_SYNC_WORD, LORA_TX_POWER_DBM);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("[lora] init failed, code %d - check wiring/frequency\n", state);
    return false;
  }
  radio.setCRC(true);
  radio.setDio0Action(onLoraDio0, RISING);
  Serial.println("[lora] ready");
  return true;
}

// Sends one reading and waits for the gateway's ACK (which it only sends
// after saving the reading to its own flash queue).
static bool sendOne(QueuedReading& q) {
  SjReading r = q.reading;
  r.age_s = (r.session == session) ? deviceSeconds() - q.takenAtS : SJ_AGE_UNKNOWN;
  if (radio.transmit((uint8_t*)&r, sizeof(r)) != RADIOLIB_ERR_NONE) return false;

  loraIrq = false;  // DIO0 also fires on TX done
  radio.startReceive();
  uint32_t start = millis();
  while (!loraIrq && millis() - start < LORA_ACK_TIMEOUT_MS) delay(1);
  bool acked = false;
  if (loraIrq) {
    uint8_t buf[sizeof(SjAck)];
    size_t len = radio.getPacketLength();
    if (len == sizeof(SjAck) && radio.readData(buf, len) == RADIOLIB_ERR_NONE) {
      acked = sjAckMatches(buf, len, r);
    }
  }
  radio.standby();
  return acked;
}

static void flushQueue() {
  for (int sent = 0; sent < MAX_SENDS_PER_FLUSH && queue.count() > 0; sent++) {
    QueuedReading q;
    if (!queue.peek(0, q)) break;
    if (!sendOne(q)) {
      Serial.printf("[lora] no ACK - %u reading(s) kept in queue, retrying in %lus\n", queue.count(),
                    FLUSH_RETRY_INTERVAL_MS / 1000);
      nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
      return;
    }
    queue.pop(1);
  }
}

#elif TRANSPORT == TRANSPORT_WIFI
static bool setupTransport() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // reconnects automatically afterwards
  Serial.println("[wifi] connecting in the background");
  return true;
}

// Posts up to `n` oldest readings as one batch. Backend answers per
// reading; any HTTP 200 means every reading in the batch is final
// (stored, duplicate or rejected) and can leave the queue.
static int postBatch(uint32_t n) {
  String body = "{\"readings\":[";
  uint32_t now = deviceSeconds();
  for (uint32_t i = 0; i < n; i++) {
    QueuedReading q;
    if (!queue.peek(i, q)) return -1;
    long age = (q.reading.session == session) ? (long)(now - q.takenAtS) : -1;
    if (i) body += ",";
    sjAppendJson(body, q.reading, age, WiFi.RSSI(), "wifi");
  }
  body += "]}";

  WiFiClientSecure client;
  client.setInsecure();  // TODO: pin the backend certificate for real deployments
  HTTPClient http;
  if (!http.begin(client, BACKEND_BATCH_URL)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("ngrok-skip-browser-warning", "true");
  http.addHeader("X-Device-Key", DEVICE_KEY);  // the backend refuses readings without a valid key
  http.setTimeout(15000);
  int code = http.POST(body);
  http.end();
  return code;
}

static bool singleMode = false;  // a refused batch is resent one reading at a time

static void flushQueue() {
  if (WiFi.status() != WL_CONNECTED) {
    nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
    return;
  }
  while (queue.count() > 0) {
    uint32_t n = singleMode ? 1 : min<uint32_t>(queue.count(), MAX_SENDS_PER_FLUSH);
    int code = postBatch(n);
    switch (sjUploadAction(code, n)) {  // shared rule, see sj_packet.h
      case SJ_UPLOAD_DONE:
        queue.pop(n);
        singleMode = false;
        break;
      case SJ_UPLOAD_SPLIT:
        singleMode = true;
        break;
      case SJ_UPLOAD_DROP_ONE:
        Serial.printf("[wifi] backend rejected a reading as invalid (HTTP %d) - dropping it\n", code);
        queue.pop(1);
        singleMode = false;
        break;
      case SJ_UPLOAD_RETRY:
        if (code == 401 || code == 403) {
          Serial.printf("[wifi] HTTP %d: DEVICE_KEY in secrets.h is missing, wrong, revoked or not allowed for %s\n", code, NODE_ID);
        } else {
          Serial.printf("[wifi] send failed (HTTP %d) - %u reading(s) kept in queue\n", code, queue.count());
        }
        nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
        return;
    }
  }
}
#endif

// =====================================================================
// Serial commands (calibration helpers)
// =====================================================================
static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  switch (c) {
    case 'z': Serial.println(zeroTiltBaseline() ? "[mpu6050] tilt re-zeroed" : "[mpu6050] re-zero failed"); break;
    case 'r': Serial.printf("[mq135] R0 for clean air = %.2f kOhm -> MQ135_R0_KOHM\n", calibrateMq135R0Kohm()); break;
    case 's': Serial.printf("[soil] %u mV (dry -> SOIL_DRY_MV, in water -> SOIL_WET_MV)\n", readSoilMillivolts()); break;
    case 'p': Serial.printf("[ph] %.0f mV (in pH7 -> PH_MV_AT_7, in pH4 -> PH_MV_AT_4)\n", readPhMillivolts()); break;
    case 'q': Serial.printf("[queue] %u waiting, %u dropped (overflow) since queue creation\n", queue.count(), queue.dropped()); break;
    case 'c': queue.clear(); Serial.println("[queue] cleared"); break;
  }
}

// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("\n=== SANJEEVNI LoRa node %s ===\n", NODE_ID);
  pinMode(LED_PIN, OUTPUT);

  setupSensors();
  session = sjPrefs.getUShort("session", 0) + 1;  // new session every boot -> unique reading_uid
  sjPrefs.putUShort("session", session);
  Serial.printf("[boot] session %u\n", session);

  if (!queue.begin("/node_queue.bin", "/node_queue.hdr", QUEUE_CAPACITY)) {
    Serial.println("[queue] LittleFS unavailable - readings will NOT survive outages");
  }
  Serial.printf("[queue] %u reading(s) left from before reboot\n", queue.count());
  Serial.println(setupEdgeAI() ? "[edge] model ready" : "[edge] model unavailable - sending without edge verdict");
  setupTransport();
}

void loop() {
  handleSerial();
#if ENABLE_PMS5003
  pollPms5003();  // keep the UART buffer drained
#endif

  uint32_t now = millis();
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    SjReading r;
    EdgeRiskLevel edge;
    bool localAlert;
    bool ok = takeReading(r, edge, localAlert);
    elevated = localAlert || edge == EDGE_WATCH || edge == EDGE_URGENT;
    bool due = elevated || now - lastReportMs >= NORMAL_REPORT_INTERVAL_MS || lastReportMs == 0;

    if (ok && due) {
      r.session = session;
      r.seq = ++seq;
      QueuedReading q = {r, deviceSeconds()};
      if (queue.push(q)) {
        pendingRainMm = 0;  // this rain is now in a queued reading
        lastReportMs = now;
        if (elevated) nextFlushMs = 0;  // elevated: try to send immediately
      }
    }
    printReading(r, edge, localAlert);
  }

  if (queue.count() > 0 && (int32_t)(millis() - nextFlushMs) >= 0) flushQueue();

  // LED: fast blink while elevated, off otherwise
  digitalWrite(LED_PIN, elevated && (millis() / 150) % 2);
  delay(10);
}
