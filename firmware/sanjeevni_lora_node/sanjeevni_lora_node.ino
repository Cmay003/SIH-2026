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
 * DEEP_SLEEP_ENABLED 1 (config.h, battery nodes without MQ135/PMS5003):
 * each wake measures once, queues, sends, and sleeps again - every
 * DEEP_SLEEP_INTERVAL_S, or DEEP_SLEEP_ELEVATED_INTERVAL_S after an
 * elevated reading. A rain-gauge tip wakes the node just long enough to
 * count it. After a real power-on the node first runs always-on for
 * DEEP_SLEEP_SETUP_WINDOW_MS so the Serial commands below can be used.
 *
 * Libraries (Arduino Library Manager): RadioLib (jgromes), DHT sensor
 * library (Adafruit), Chirale_TensorFLowLite. Board: ESP32 Dev Module
 * (esp32 by Espressif 3.3.x). Partition scheme must include a
 * SPIFFS/LittleFS partition (the default one does).
 *
 * Compiles for ESP32 (checked with arduino-cli), but NOT YET FLASHED -
 * test on your board, starting with the Serial Monitor at 115200 baud.
 *
 * Serial commands: t = self-test (every sensor + radio + queue, OK/WAIT/
 * WARN/FAIL with a wiring hint; also runs once after power-on), z = re-zero
 * tilt, r = MQ135 R0 calibration value, s = soil millivolts, p = pH
 * millivolts, q = queue status, c = clear queue
 */
#include <Arduino.h>
#include <esp_sleep.h>
#include <sys/time.h>
#include "config.h"
#include "sj_packet.h"
#include "sj_file_queue.h"
#include "sj_sleep.h"
#include "sj_selftest.h"
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
static uint16_t session = 0;  // bumped on every power-on, persisted in NVS
static uint32_t seq = 0;

static uint32_t lastSampleMs = 0;
static uint32_t lastReportMs = 0;
static uint32_t nextFlushMs = 0;
static float pendingRainMm = 0;  // rain since the last REPORTED reading
static bool elevated = false;
static uint32_t lastSerialMs = 0;  // deep sleep: a Serial command keeps the node awake

// What setup() managed to start - reported by the self-test
static bool queueOk = false;
static bool edgeOk = false;

// Survives deep sleep (not a power-on) - see sj_sleep.h
RTC_DATA_ATTR static SjSleepState sleepState;
static bool resumedFromSleep = false;

// Seconds on the RTC clock. Unlike esp_timer (which restarts at 0 on every
// wake), it keeps counting through deep sleep, so a reading queued before
// a sleep still gets its true age when it is finally sent. It restarts on
// a power-on - the new session number then marks old readings' age as
// unknown.
static uint32_t deviceSeconds() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint32_t)tv.tv_sec;
}

// =====================================================================
// Reading
// =====================================================================
// Every sensor is optional (modular nodes): one that is disabled or fails
// is simply left out, so e.g. a dead DHT22 no longer throws away a good
// water level. Returns false only if NOTHING could be measured - the
// backend rejects such a reading, so it isn't queued.
static bool takeReading(SjReading& r, EdgeRiskLevel& edge, bool& localAlert) {
  memset(&r, 0, sizeof(r));
  r.magic = SJ_MAGIC;
  r.version = SJ_VERSION;
  r.type = SJ_TYPE_READING;
  strncpy(r.node_id, NODE_ID, SJ_NODE_ID_LEN);
  r.edge_risk = SJ_EDGE_NONE;
  localAlert = false;

  float waterM = 0, tempC = 0, humidity = 0, gasPpm = 0;
  bool flame = false;
#if ENABLE_WATER_LEVEL
  if (readWaterLevelM(waterM)) {
    r.flags |= SJ_HAS_WATER;
    r.water_level_mm = sjClampU16(waterM * 1000.0f);
    localAlert |= waterM >= LOCAL_WATER_FRACTION_LIMIT * ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f;
  } else {
    Serial.println("[sensor] water level: no echo");
  }
#endif
#if ENABLE_DHT
  if (readDht(tempC, humidity)) {
    r.flags |= SJ_HAS_DHT;
    r.temp_c_x100 = sjClampI16(tempC * 100);
    r.humidity_x100 = sjClampU16(humidity * 100);
    localAlert |= tempC >= LOCAL_TEMP_LIMIT_C;
  } else {
    Serial.println("[sensor] DHT22 read failed");
  }
#endif
#if ENABLE_GAS
  if (readGasPpm(gasPpm)) {
    r.flags |= SJ_HAS_GAS;
    r.gas_ppm = sjClampU16(gasPpm);
    localAlert |= gasPpm >= LOCAL_GAS_LIMIT_PPM;
  } else {
    Serial.println("[sensor] MQ135: no signal");
  }
#endif
#if ENABLE_FLAME
  flame = readFlameDetected();
  r.flags |= SJ_HAS_FLAME;
  if (flame) r.flags |= SJ_FLAME_DETECTED;
  localAlert |= flame;
#endif

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

  // The edge model was trained on all five core inputs together.
  edge = EDGE_UNAVAILABLE;
  const uint16_t edgeInputs = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME;
  if ((r.flags & edgeInputs) == edgeInputs) {
    edge = runEdgeInference(waterM, tempC, humidity, gasPpm, flame);
    if (edge != EDGE_UNAVAILABLE) r.edge_risk = (uint8_t)edge;
  }
  return (r.flags & SJ_MEASUREMENT_FLAGS) != 0;
}

static void printReading(const SjReading& r, EdgeRiskLevel edge, bool localAlert) {
  Serial.printf("[%s #%u-%u]", NODE_ID, r.session, r.seq);
  if (r.flags & SJ_HAS_WATER) Serial.printf(" water=%.3fm", r.water_level_mm / 1000.0f);
  if (r.flags & SJ_HAS_DHT) Serial.printf(" temp=%.1fC hum=%.0f%%", r.temp_c_x100 / 100.0f, r.humidity_x100 / 100.0f);
  if (r.flags & SJ_HAS_GAS) Serial.printf(" gas=%uppm", r.gas_ppm);
  if (r.flags & SJ_HAS_FLAME) Serial.printf(" flame=%d", (r.flags & SJ_FLAME_DETECTED) ? 1 : 0);
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
static int16_t loraBeginState = RADIOLIB_ERR_UNKNOWN;  // radio.begin() result, for the self-test
static_assert(RADIOLIB_ERR_CHIP_NOT_FOUND == SJ_LORA_ERR_CHIP_NOT_FOUND, "sj_selftest.h mirrors this RadioLib code");

static bool setupTransport() {
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int state = radio.begin(LORA_FREQUENCY_MHZ, LORA_BANDWIDTH_KHZ, LORA_SPREADING_FACTOR, LORA_CODING_RATE,
                          LORA_SYNC_WORD, LORA_TX_POWER_DBM);
  loraBeginState = state;
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

// false = the gateway didn't acknowledge (readings stay queued)
static bool flushQueue() {
  for (int sent = 0; sent < MAX_SENDS_PER_FLUSH && queue.count() > 0; sent++) {
    QueuedReading q;
    if (!queue.peek(0, q)) break;
    if (!sendOne(q)) {
#if DEEP_SLEEP_ENABLED
      Serial.printf("[lora] no ACK - %u reading(s) kept in queue for the next wake\n", queue.count());
#else
      Serial.printf("[lora] no ACK - %u reading(s) kept in queue, retrying in %lus\n", queue.count(),
                    FLUSH_RETRY_INTERVAL_MS / 1000);
#endif
      nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
      return false;
    }
    queue.pop(1);
  }
  return true;
}

static bool waitForLink() { return true; }  // LoRa needs no connection
static void transportSleep() { radio.sleep(); }  // SX1278 sleep: ~1 uA instead of ~1.6 mA standby

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

// false = not connected / the backend didn't take them (readings stay queued)
static bool flushQueue() {
  if (WiFi.status() != WL_CONNECTED) {
    nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
    return false;
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
        return false;
    }
  }
  return true;
}

// Deep sleep: WiFi starts from scratch on every wake, so wait for it once
// (also used by the self-test just after power-on).
static bool waitForLink() {
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) delay(50);
#if DEEP_SLEEP_ENABLED
  if (WiFi.status() != WL_CONNECTED) Serial.println("[wifi] not connected - readings stay queued until the next wake");
#else
  if (WiFi.status() != WL_CONNECTED) Serial.println("[wifi] not connected yet - readings stay queued, retried automatically");
#endif
  return WiFi.status() == WL_CONNECTED;
}

static void transportSleep() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}
#endif

// =====================================================================
// Self-test ('t', and once after a power-on): every enabled sensor plus
// the radio, queue and edge model in one go - OK / WAIT / WARN / FAIL and
// a wiring hint, for the first flash and for field checks. The verdict
// rules are in sj_selftest.h (unit-tested on a PC).
// =====================================================================
static SjSelfTestTally selfTestTally;

static const char* selfTestHint(const char* fmt, ...) {
  static char buf[128];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  return buf;
}

static void selfTestLine(const char* name, const SjCheckResult& r, const char* hint) {
  sjTallyAdd(selfTestTally, r.status);
  Serial.printf("  %s %-11s %s\n", SJ_CHECK_NAMES[r.status], name, r.detail);
  if (r.status >= SJ_CHECK_WARN) Serial.printf("       check: %s\n", hint);
}

static void selfTestOff(const char* name, const char* flag) { Serial.printf("  --   %-11s off (%s 0)\n", name, flag); }

static void runSelfTest() {
  memset(&selfTestTally, 0, sizeof(selfTestTally));
  uint32_t uptimeS = millis() / 1000;
  Serial.printf("\n=== SELF-TEST %s (up %lus) ===\n", NODE_ID, (unsigned long)uptimeS);

#if ENABLE_WATER_LEVEL
  {
    float d[SJ_ULTRASONIC_PINGS];
    int n = pingDistancesCm(d);
    selfTestLine("water", sjCheckUltrasonic(n, SJ_ULTRASONIC_PINGS, n ? d[0] : 0, n ? d[n / 2] : 0, n ? d[n - 1] : 0,
                                            ULTRASONIC_MOUNT_HEIGHT_CM),
                 selfTestHint("HC-SR04 VCC 5 V, TRIG GPIO%d, ECHO via 1k/2k divider to GPIO%d, aim at the surface",
                              ULTRASONIC_TRIG, ULTRASONIC_ECHO));
  }
#else
  selfTestOff("water", "ENABLE_WATER_LEVEL");
#endif
#if ENABLE_DHT
  {
    float t = 0, h = 0;
    bool ok = readDht(t, h);
    selfTestLine("DHT22", sjCheckDht(ok, t, h),
                 selfTestHint("DATA to GPIO%d with a 10k pull-up to 3.3 V, VCC 3.3 V, GND", DHT_PIN));
  }
#else
  selfTestOff("DHT22", "ENABLE_DHT");
#endif
#if ENABLE_GAS
  {
    float pinMv = analogReadMilliVolts(MQ135_PIN);
    float rs = mq135ResistanceKohm(pinMv);
    selfTestLine("MQ135 gas", sjCheckMq135(pinMv, MQ135_ADC_DIVIDER_RATIO, rs, rs > 0 ? mq135Ppm(rs) : 0, uptimeS),
                 selfTestHint("AO via 10k/10k divider to GPIO%d (MQ135_ADC_DIVIDER_RATIO %.1f), VCC 5 V", MQ135_PIN,
                              MQ135_ADC_DIVIDER_RATIO));
  }
#else
  selfTestOff("MQ135 gas", "ENABLE_GAS");
#endif
#if ENABLE_FLAME
  {
    bool highPullDown, highPullUp;
    probeFlamePin(highPullDown, highPullUp);
    selfTestLine("flame", sjCheckFlame(highPullDown, highPullUp, digitalRead(FLAME_PIN) == HIGH),
                 selfTestHint("module DO to GPIO%d, VCC 3.3 V; its pot sets the sensitivity", FLAME_PIN));
  }
#else
  selfTestOff("flame", "ENABLE_FLAME");
#endif
#if ENABLE_RAIN_GAUGE
  selfTestLine("rain gauge", sjCheckRain(digitalRead(RAIN_GAUGE_PIN) == HIGH, sjRainTipsSinceBoot),
               selfTestHint("reed switch between GPIO%d and GND, 10k pull-up GPIO%d to 3.3 V", RAIN_GAUGE_PIN,
                            RAIN_GAUGE_PIN));
#else
  selfTestOff("rain gauge", "ENABLE_RAIN_GAUGE");
#endif
#if ENABLE_SOIL
  selfTestLine("soil", sjCheckSoil(readSoilMillivolts(), SOIL_DRY_MV, SOIL_WET_MV),
               selfTestHint("AOUT to GPIO%d, VCC 3.3 V; 's' prints mV for SOIL_DRY_MV / SOIL_WET_MV", SOIL_PIN));
#else
  selfTestOff("soil", "ENABLE_SOIL");
#endif
#if ENABLE_MPU6050
  {
    bool acks = mpuAcks();
    int who = acks ? mpuWhoAmI() : -1;
    bool readOk = false;
    float gravityG = 0, tilt = 0, vibration = 0;
    if (acks && sjMpuOk) {
      readOk = true;
      for (int i = 0; i < 10 && readOk; i++) {
        float a[3];
        readOk = mpuReadAccelG(a);
        gravityG += sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) / 10.0f;
        delay(4);
      }
      readOk = readOk && readTiltAndVibration(tilt, vibration);
    }
    selfTestLine("MPU6050", sjCheckMpu(sjMpuOk, acks, who, readOk, gravityG, tilt, LOCAL_TILT_LIMIT_DEG),
                 selfTestHint("SDA GPIO%d, SCL GPIO%d, VCC 3.3 V, AD0 to GND (address 0x%02X)", I2C_SDA, I2C_SCL,
                              MPU6050_ADDR));
  }
#else
  selfTestOff("MPU6050", "ENABLE_MPU6050");
#endif
#if ENABLE_PMS5003
  {
    uint32_t start = millis();  // just powered on: give it time for a first frame
    while (!sjPmEverSeen && millis() - start < 2500) {
      pollPms5003();
      delay(20);
    }
    pollPms5003();
    selfTestLine("PMS5003", sjCheckPms(sjPmEverSeen, millis() - sjPmLastFrameMs, sjPm25, sjPm10, uptimeS),
                 selfTestHint("PMS TX to GPIO%d, VCC 5 V, GND; the fan should be audible", PMS_RX_PIN));
  }
#else
  selfTestOff("PMS5003", "ENABLE_PMS5003");
#endif
#if ENABLE_PH
  selfTestLine("pH", sjCheckPh(readPhMillivolts() / PH_ADC_DIVIDER_RATIO, PH_ADC_DIVIDER_RATIO, PH_MV_AT_7, PH_MV_AT_4),
               selfTestHint("PO via divider to GPIO%d (PH_ADC_DIVIDER_RATIO %.1f); 'p' prints mV for calibration",
                            PH_PIN, PH_ADC_DIVIDER_RATIO));
#else
  selfTestOff("pH", "ENABLE_PH");
#endif
#if ENABLE_TURBIDITY
  selfTestLine("turbidity", sjCheckTurbidity(analogReadMilliVolts(TURBIDITY_PIN), TURBIDITY_ADC_DIVIDER_RATIO),
               selfTestHint("OUT via divider to GPIO%d (TURBIDITY_ADC_DIVIDER_RATIO %.1f), VCC 5 V", TURBIDITY_PIN,
                            TURBIDITY_ADC_DIVIDER_RATIO));
#else
  selfTestOff("turbidity", "ENABLE_TURBIDITY");
#endif
#if ENABLE_BATTERY
  selfTestLine("battery", sjCheckBattery(analogReadMilliVolts(BATTERY_PIN), BATTERY_DIVIDER_RATIO, BATTERY_EMPTY_V,
                                         BATTERY_FULL_V),
               selfTestHint("18650 + via a 2:1 divider (e.g. 100k/100k) to GPIO%d", BATTERY_PIN));
#else
  selfTestOff("battery", "ENABLE_BATTERY");
#endif

#if TRANSPORT == TRANSPORT_LORA
  // A radio not found at boot makes RadioLib end the SPI bus; restart it
  // (no-op when it is running) so a since-fixed wire is seen.
  if (loraBeginState != RADIOLIB_ERR_NONE) SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  selfTestLine("LoRa radio", sjCheckLora(radio.getChipVersion(), loraBeginState),
               selfTestHint("Ra-02 on 3.3 V only: SCK %d MISO %d MOSI %d NSS %d RST %d DIO0 %d; antenna on", LORA_SCK,
                            LORA_MISO, LORA_MOSI, LORA_NSS, LORA_RST, LORA_DIO0));
#elif TRANSPORT == TRANSPORT_WIFI
  waitForLink();  // just after power-on WiFi is usually still connecting
  selfTestLine("WiFi", sjCheckWifi(WiFi.status() == WL_CONNECTED, WiFi.RSSI()),
               selfTestHint("WIFI_SSID / WIFI_PASSWORD in secrets.h; 2.4 GHz networks only"));
#endif
  selfTestLine("queue", sjCheckQueue(queueOk, queue.count(), QUEUE_CAPACITY, queue.dropped()),
               selfTestHint("Tools > Partition Scheme must include a SPIFFS/LittleFS partition"));
  selfTestLine("edge AI", sjCheckEdge(edgeOk, ENABLE_WATER_LEVEL && ENABLE_DHT && ENABLE_GAS && ENABLE_FLAME),
               selfTestHint("re-flash; edge_model_data.h must match the TFLite library version"));

  const uint8_t* n = selfTestTally.counts;
  Serial.printf("=== %u OK, %u WAIT, %u WARN, %u FAIL - %s ===\n\n", n[SJ_CHECK_OK], n[SJ_CHECK_WAIT],
                n[SJ_CHECK_WARN], n[SJ_CHECK_FAIL], sjTallyVerdict(selfTestTally));
}

// =====================================================================
// Serial commands (calibration helpers)
// =====================================================================
static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  lastSerialMs = millis();  // deep sleep: someone is calibrating - stay awake
  switch (c) {
    case 't': runSelfTest(); break;
    case 'z': Serial.println(zeroTiltBaseline() ? "[mpu6050] tilt re-zeroed" : "[mpu6050] re-zero failed"); break;
    case 'r': Serial.printf("[mq135] R0 for clean air = %.2f kOhm -> MQ135_R0_KOHM\n", calibrateMq135R0Kohm()); break;
    case 's': Serial.printf("[soil] %u mV (dry -> SOIL_DRY_MV, in water -> SOIL_WET_MV)\n", readSoilMillivolts()); break;
    case 'p': Serial.printf("[ph] %.0f mV (in pH7 -> PH_MV_AT_7, in pH4 -> PH_MV_AT_4)\n", readPhMillivolts()); break;
    case 'q': Serial.printf("[queue] %u waiting, %u dropped (overflow) since queue creation\n", queue.count(), queue.dropped()); break;
    case 'c': queue.clear(); Serial.println("[queue] cleared"); break;
  }
}

// =====================================================================
// Deep sleep (DEEP_SLEEP_ENABLED)
// =====================================================================
#if DEEP_SLEEP_ENABLED
// Sleeps for `seconds` (timer), or until the rain gauge tips. Never returns:
// the next wake starts again at setup().
static void enterDeepSleep(uint32_t seconds) {
  if (seconds < 1) seconds = 1;
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
#if ENABLE_RAIN_GAUGE
  // Reed switch to GND with a pull-up: a tip pulls the pin LOW. Not armed
  // while it is stuck closed, or every wake would end instantly.
  if (!sleepState.rainWakeOff && digitalRead(RAIN_GAUGE_PIN) == HIGH) {
    esp_sleep_enable_ext0_wakeup((gpio_num_t)RAIN_GAUGE_PIN, 0);
  }
#endif
  sjSleepStateSeal(sleepState);
  Serial.printf("[sleep] %lu s\n", (unsigned long)seconds);
  Serial.flush();
  esp_deep_sleep_start();
}

// Woken by a bucket tip: count it and go back to sleep for whatever is
// left until the next measurement - no sensors, radio or flash touched.
// Returns only if a measurement is due anyway.
static void handleRainWake() {
#if ENABLE_RAIN_GAUGE
  sleepState.pendingRainMm += RAIN_MM_PER_TIP;
  sleepState.rainTipsTotal++;
  pinMode(RAIN_GAUGE_PIN, INPUT);  // external pull-up (GPIO39 has none)
  uint32_t start = millis();
  while (digitalRead(RAIN_GAUGE_PIN) == LOW && millis() - start < RAIN_WAKE_STUCK_MS) delay(5);
  if (digitalRead(RAIN_GAUGE_PIN) == LOW) {
    sleepState.rainWakeOff = 1;  // stuck closed (debris?) - timer wakes only until the next measurement
    Serial.println("[rain] reed switch stays closed - rain wake-up paused until the next measurement");
  }
  uint32_t now = deviceSeconds();
  if (sjRainWakeShouldResleep(now, sleepState.nextWakeS, DEEP_SLEEP_RAIN_SLACK_S)) {
    enterDeepSleep(sjRemainingS(now, sleepState.nextWakeS));
  }
#endif
}

// Everything that would keep drawing current while the ESP32 sleeps
static void sleepPeripherals() {
  transportSleep();
#if ENABLE_MPU6050
  mpuSleep();
#endif
  sensorPowerOff();
  digitalWrite(LED_PIN, LOW);
}

// Save what the next wake needs, power down, sleep. Never returns.
static void sleepUntilNextMeasurement() {
#if ENABLE_RAIN_GAUGE
  pendingRainMm += readRainSinceLastMm();  // tips the interrupt counted while awake
#endif
  uint32_t interval = sjPlanSleepS(elevated, DEEP_SLEEP_INTERVAL_S, DEEP_SLEEP_ELEVATED_INTERVAL_S);
  sleepState.session = session;
  sleepState.seq = seq;
  sleepState.pendingRainMm = pendingRainMm;
  sleepState.elevated = elevated;
  sleepState.nextWakeS = deviceSeconds() + interval;
  sleepPeripherals();
  enterDeepSleep(interval);
}

// One measurement wake: measure, queue, send what the link takes, sleep.
static void runSleepCycle() {
  sleepState.rainWakeOff = 0;  // re-arm the rain wake-up every measurement
  SjReading r;
  EdgeRiskLevel edge;
  bool localAlert;
  if (takeReading(r, edge, localAlert)) {
    elevated = localAlert || edge == EDGE_WATCH || edge == EDGE_URGENT;
    r.session = session;
    r.seq = ++seq;
    QueuedReading q = {r, deviceSeconds()};
    if (queue.push(q)) pendingRainMm = 0;  // this rain is now in a queued reading
  } else {
    elevated = false;
    Serial.println("[sensor] nothing could be measured - no reading this wake");
  }
  printReading(r, edge, localAlert);
  if (waitForLink()) {
    while (queue.count() > 0 && millis() < DEEP_SLEEP_MAX_AWAKE_MS && flushQueue()) {
    }
  }
  sleepUntilNextMeasurement();
}
#endif

// =====================================================================
void setup() {
  Serial.begin(115200);
#if DEEP_SLEEP_ENABLED
  esp_sleep_wakeup_cause_t wake = esp_sleep_get_wakeup_cause();
  resumedFromSleep = wake != ESP_SLEEP_WAKEUP_UNDEFINED && sjSleepStateValid(sleepState);
  if (resumedFromSleep && wake == ESP_SLEEP_WAKEUP_EXT0) handleRainWake();  // usually sleeps again here
#endif
  if (!resumedFromSleep) delay(500);  // give the Serial Monitor a moment after a power-on
  Serial.printf("\n=== SANJEEVNI LoRa node %s ===\n", NODE_ID);
  pinMode(LED_PIN, OUTPUT);

  setupSensors();
  if (resumedFromSleep) {
    // Same session across wakes: reading_uid stays unique and queued
    // readings keep their age - and no flash write every few minutes.
    session = sleepState.session;
    seq = sleepState.seq;
    pendingRainMm = sleepState.pendingRainMm;
  } else {
    session = sjPrefs.getUShort("session", 0) + 1;  // new session every power-on -> unique reading_uid
    sjPrefs.putUShort("session", session);
    sjSleepStateReset(sleepState, session);
  }
  Serial.printf("[boot] session %u%s\n", session, resumedFromSleep ? " (woke from deep sleep)" : "");

  queueOk = queue.begin("/node_queue.bin", "/node_queue.hdr", QUEUE_CAPACITY);
  if (!queueOk) {
    Serial.println("[queue] LittleFS unavailable - readings will NOT survive outages");
  }
  Serial.printf("[queue] %u reading(s) left from before reboot\n", queue.count());
  edgeOk = setupEdgeAI();
  Serial.println(edgeOk ? "[edge] model ready" : "[edge] model unavailable - sending without edge verdict");
  setupTransport();  // LoRa: result kept in loraBeginState for the self-test
#if DEEP_SLEEP_ENABLED
  if (resumedFromSleep) runSleepCycle();  // never returns
#endif
  // Only after a power-on / reset from here on (deep-sleep wakes never get here)
#if SELF_TEST_ON_POWER_ON
  runSelfTest();
#endif
  Serial.println("[serial] t = self-test, z = re-zero tilt, r = MQ135 R0, s = soil mV, p = pH mV, q = queue, "
                 "c = clear queue");
#if DEEP_SLEEP_ENABLED
  Serial.printf("[sleep] power-on: always-on for %lus (Serial commands work; each one adds time), "
                "then one reading every %us\n", DEEP_SLEEP_SETUP_WINDOW_MS / 1000, (unsigned)DEEP_SLEEP_INTERVAL_S);
#endif
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

#if DEEP_SLEEP_ENABLED
  // Setup window after a power-on is over and nobody is typing commands:
  // send what is queued, then start the measure-and-sleep cycle.
  if (millis() >= DEEP_SLEEP_SETUP_WINDOW_MS && millis() - lastSerialMs >= DEEP_SLEEP_SETUP_WINDOW_MS) {
    Serial.println("[sleep] setup window over - starting the deep-sleep cycle");
    if (queue.count() > 0) flushQueue();
    sleepUntilNextMeasurement();
  }
#endif
  delay(10);
}
