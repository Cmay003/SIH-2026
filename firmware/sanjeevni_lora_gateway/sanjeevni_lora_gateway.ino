/*
 * SANJEEVNI - LoRa gateway (Phase 2)
 * =====================================================================
 * Receives readings from SANJEEVNI LoRa nodes, saves each one to its own
 * LittleFS queue, THEN acknowledges it (so an ACKed reading is never
 * lost), and forwards the queue to the backend's /api/ingest/batch:
 *   - over WiFi when connected
 *   - over NB-IoT (SIM7020) otherwise
 * The backend ignores duplicates (reading_uid), so retries are safe at
 * every hop: node -> gateway -> backend.
 *
 * Nodes have no real clock: each packet says how old the reading is
 * (age_s). The gateway adds the time the reading waited in its own queue,
 * so the backend gets an accurate "taken N seconds ago".
 *
 * Libraries: RadioLib (jgromes, 6.x/7.x). Board: ESP32 Dev Module.
 * NOT COMPILED OR FLASHED BY THE AUTHOR - test on your board.
 *
 * Serial commands: q = queue status, c = clear queue,
 *                  a = AT pass-through to the SIM7020 (type ~ to exit)
 */
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <esp_timer.h>
#include <Preferences.h>
#include "config.h"
#include "secrets.h"
#include "sj_packet.h"
#include "sj_file_queue.h"
#if ENABLE_WIFI
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#endif
#if ENABLE_NBIOT
#include "nbiot_sim7020.h"
#endif

struct GatewayQueued {
  SjReading reading;
  uint32_t rxAtS;     // gateway device seconds when received
  uint16_t gwSession; // gateway boot session when received
  int16_t rssi;       // LoRa RSSI of the node's packet
};

static SjFileQueue<GatewayQueued> queue;
static Preferences prefs;
static uint16_t session = 0;
static uint32_t nextForwardMs = 0;
static bool singleMode = false;

static SX1278 radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST);
static volatile bool loraIrq = false;
static void IRAM_ATTR onLoraDio0() { loraIrq = true; }

#if ENABLE_NBIOT
static Sim7020 nbiot;
static uint32_t nbiotRetryAtMs = 0;  // see forwardQueue() - back-off after a failed attach
#endif

static uint32_t deviceSeconds() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }

// Recently ACKed readings. A node re-sends when it misses our ACK; this
// avoids queueing the same reading twice (the backend would ignore the
// duplicate anyway, but it costs airtime/data to forward it).
static struct {
  char nodeId[SJ_NODE_ID_LEN];
  uint16_t session;
  uint32_t seq;
} recent[32];
static uint8_t recentNext = 0;

static bool seenRecently(const SjReading& r) {
  for (auto& e : recent)
    if (e.seq == r.seq && e.session == r.session && strncmp(e.nodeId, r.node_id, SJ_NODE_ID_LEN) == 0) return true;
  return false;
}

static void rememberReading(const SjReading& r) {
  memcpy(recent[recentNext].nodeId, r.node_id, SJ_NODE_ID_LEN);
  recent[recentNext].session = r.session;
  recent[recentNext].seq = r.seq;
  recentNext = (recentNext + 1) % 32;
}

// =====================================================================
// LoRa receive -> queue -> ACK
// =====================================================================
static void handleLoraPacket() {
  loraIrq = false;
  uint8_t buf[64];
  size_t len = radio.getPacketLength();
  if (len > sizeof(buf) || radio.readData(buf, len) != RADIOLIB_ERR_NONE || !sjIsValidReading(buf, len)) {
    radio.startReceive();
    return;  // noise, another LoRa network, or a corrupted packet
  }
  SjReading r;
  memcpy(&r, buf, sizeof(r));
  int16_t rssi = (int16_t)radio.getRSSI();

  bool stored = seenRecently(r);
  if (!stored) {
    GatewayQueued g = {r, deviceSeconds(), session, rssi};
    stored = queue.push(g);
    if (stored) rememberReading(r);
  }
  if (stored) {  // ACK only what is safely on flash
    SjAck ack = sjMakeAck(r);
    radio.transmit((uint8_t*)&ack, sizeof(ack));
  }
  char nodeId[SJ_NODE_ID_LEN + 1] = {0};
  memcpy(nodeId, r.node_id, SJ_NODE_ID_LEN);
  Serial.printf("[lora] %s #%u-%u rssi=%d snr=%.1f %s, queue=%u\n", nodeId, r.session, r.seq, rssi, radio.getSNR(),
                stored ? "ACKed" : "NOT stored (flash error)", queue.count());
  loraIrq = false;  // DIO0 also fired for our own ACK transmission
  radio.startReceive();
}

// =====================================================================
// Forwarding to the backend
// =====================================================================
static long ageAtForward(const GatewayQueued& g) {
  if (g.reading.age_s == SJ_AGE_UNKNOWN || g.gwSession != session) return -1;  // unknown - backend uses receive time
  return (long)g.reading.age_s + (long)(deviceSeconds() - g.rxAtS);
}

static bool buildBatch(uint32_t n, String& body) {
  body = "{\"readings\":[";
  for (uint32_t i = 0; i < n; i++) {
    GatewayQueued g;
    if (!queue.peek(i, g)) return false;
    if (i) body += ",";
    // The node's link to us is LoRa, so its signal is the LoRa RSSI.
    sjAppendJson(body, g.reading, ageAtForward(g), g.rssi, "lora");
  }
  body += "]}";
  return true;
}

#if ENABLE_WIFI
static int postViaWifi(const String& body) {
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
#endif

// Forwards as much of the queue as the backhaul accepts. What happens to
// the queue after each response is decided by sjUploadAction() (shared
// with the node, see sj_packet.h): only a backend "this reading is
// invalid" drops a reading; outages, 404s and key problems keep it.
static void forwardQueue() {
  while (queue.count() > 0) {
    if (loraIrq) return;  // serve the radio first; forwarding resumes next loop
    const char* via = nullptr;
    uint32_t maxBatch = 0;
#if ENABLE_WIFI
    if (WiFi.status() == WL_CONNECTED) {
      via = "wifi";
      maxBatch = WIFI_MAX_BATCH;
    }
#endif
#if ENABLE_NBIOT
    // An attach attempt can block for over a minute (radio on/off + attach
    // wait), and the LoRa radio isn't served meanwhile. After a failed
    // attempt, don't try NB-IoT again for NBIOT_RETRY_INTERVAL_MS - before,
    // a gateway with WiFi down and no NB-IoT coverage was nearly deaf to
    // its nodes (review R21).
    if (!via && (int32_t)(millis() - nbiotRetryAtMs) >= 0) {
      if (nbiot.ensureAttached(NBIOT_APN)) {
        via = "nbiot";
        maxBatch = NBIOT_MAX_BATCH;
      } else {
        nbiotRetryAtMs = millis() + NBIOT_RETRY_INTERVAL_MS;
        Serial.printf("[nbiot] not available - next attempt in %lus\n", NBIOT_RETRY_INTERVAL_MS / 1000);
      }
    }
#endif
    if (!via) {
      nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
      return;
    }

    uint32_t n = singleMode ? 1 : min<uint32_t>(queue.count(), maxBatch);
    String body;
    if (!buildBatch(n, body)) return;
    int code = -1;
#if ENABLE_WIFI
    if (strcmp(via, "wifi") == 0) code = postViaWifi(body);
#endif
#if ENABLE_NBIOT
    if (strcmp(via, "nbiot") == 0) code = nbiot.httpPost(NBIOT_BACKEND_BASE, NBIOT_BATCH_PATH, body, DEVICE_KEY);
#endif

    switch (sjUploadAction(code, n)) {
      case SJ_UPLOAD_DONE:
        queue.pop(n);
        singleMode = false;
        Serial.printf("[forward] %u reading(s) via %s, %u left\n", n, via, queue.count());
        break;
      case SJ_UPLOAD_SPLIT:
        singleMode = true;  // resend one at a time to find the refused reading
        break;
      case SJ_UPLOAD_DROP_ONE:
        Serial.printf("[forward] backend rejected a reading as invalid (HTTP %d) - dropping it\n", code);
        queue.pop(1);
        singleMode = false;
        break;
      case SJ_UPLOAD_RETRY:
        if (code == 401 || code == 403) {
          Serial.printf("[forward] HTTP %d: DEVICE_KEY in secrets.h is missing, wrong, revoked or not allowed for these nodes - readings kept\n", code);
        } else {
          Serial.printf("[forward] via %s failed (code %d) - %u reading(s) kept\n", via, code, queue.count());
        }
        nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
        return;
    }
  }
}

// =====================================================================
static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'q') Serial.printf("[queue] %u waiting, %u dropped (overflow)\n", queue.count(), queue.dropped());
  if (c == 'c') {
    queue.clear();
    Serial.println("[queue] cleared");
  }
#if ENABLE_NBIOT
  if (c == 'a') {
    Serial.println("[nbiot] AT pass-through - type commands, '~' to exit");
    while (true) {
      if (Serial.available()) {
        char k = Serial.read();
        if (k == '~') break;
        nbiot.serial().write(k);
      }
      if (nbiot.serial().available()) Serial.write(nbiot.serial().read());
    }
    Serial.println("[nbiot] pass-through closed");
  }
#endif
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== SANJEEVNI LoRa gateway ===");
  pinMode(LED_PIN, OUTPUT);

  prefs.begin("sanjeevni-gw", false);
  session = prefs.getUShort("session", 0) + 1;
  prefs.putUShort("session", session);

  if (!queue.begin("/gw_queue.bin", "/gw_queue.hdr", QUEUE_CAPACITY)) {
    Serial.println("[queue] LittleFS unavailable - cannot store readings, NOT acknowledging nodes");
  }
  Serial.printf("[queue] %u reading(s) left from before reboot\n", queue.count());

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int state = radio.begin(LORA_FREQUENCY_MHZ, LORA_BANDWIDTH_KHZ, LORA_SPREADING_FACTOR, LORA_CODING_RATE,
                          LORA_SYNC_WORD, LORA_TX_POWER_DBM);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("[lora] init failed, code %d - check wiring/frequency\n", state);
  }
  radio.setCRC(true);
  radio.setDio0Action(onLoraDio0, RISING);
  radio.startReceive();

#if ENABLE_WIFI
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // auto-reconnects afterwards
#endif
#if ENABLE_NBIOT
  nbiot.begin();
#endif
  Serial.println("[gateway] listening");
}

void loop() {
  handleSerial();
  if (loraIrq) handleLoraPacket();
  if (queue.count() > 0 && (int32_t)(millis() - nextForwardMs) >= 0) forwardQueue();
  // LED: on while readings are waiting to be forwarded
  digitalWrite(LED_PIN, queue.count() > 0);
  delay(5);
}
