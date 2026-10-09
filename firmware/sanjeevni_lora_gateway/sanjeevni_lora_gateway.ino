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
 * Two jobs, two FreeRTOS tasks: loop() only serves the LoRa radio and the
 * Serial commands, and a separate forwarding task does the backend
 * uploads. An upload can block for 15 s (WiFi timeout) or about a minute
 * (NB-IoT AT exchange); in one task the radio was deaf for all of it, so
 * nodes missed their ACKs and kept resending the same oldest reading.
 * The queue is shared under a mutex that is never held during a request
 * (see sj_forward.h).
 *
 * Nodes have no real clock: each packet says how old the reading is
 * (age_s). The gateway adds the time the reading waited in its own queue,
 * so the backend gets an accurate "taken N seconds ago".
 *
 * Libraries: RadioLib (jgromes, 6.x/7.x). Board: ESP32 Dev Module.
 * Compiles for ESP32 (checked with arduino-cli), but NOT YET FLASHED -
 * test on your board.
 *
 * Serial commands: q = queue status, c = clear queue,
 *                  a = AT pass-through to the SIM7020 (type ~ to exit)
 */
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <esp_timer.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include "config.h"
#include "secrets.h"
#include "sj_packet.h"
#include "sj_file_queue.h"
#include "sj_forward.h"
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
static uint16_t session = 0;  // gateway boot counter: only tells "rxAtS is from this boot"

// ---- shared between loop() and the forwarding task ------------------
// queueLock guards `queue` and `queueClears`. backhaulLock is held for one
// upload (attach + request) so the 'a' AT pass-through never talks to the
// SIM7020 in the middle of one.
static SemaphoreHandle_t queueLock = nullptr;
static SemaphoreHandle_t backhaulLock = nullptr;
static uint32_t queueClears = 0;           // bumped by every 'c' (sj_forward.h)
static volatile uint32_t queuedCount = 0;  // queue.count() as of the last change, for the LED/logs/task wake-up
static bool forwardTaskRunning = false;

// Only the forwarding task (or loop() if the task could not start) uses these
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

// Holds a FreeRTOS mutex for one scope. A missing mutex (creation failed
// at boot - then there is no forwarding task either) counts as held.
struct SjLock {
  SemaphoreHandle_t m;
  bool held;
  explicit SjLock(SemaphoreHandle_t mutex, TickType_t wait = portMAX_DELAY)
      : m(mutex), held(!mutex || xSemaphoreTake(mutex, wait) == pdTRUE) {}
  ~SjLock() {
    if (m && held) xSemaphoreGive(m);
  }
  SjLock(const SjLock&) = delete;
  SjLock& operator=(const SjLock&) = delete;
};

// Recently ACKed readings. A node re-sends when it misses our ACK; this
// avoids queueing the same reading twice (the backend would ignore the
// duplicate anyway, but it costs airtime/data to forward it).
static struct {
  char nodeId[SJ_NODE_ID_LEN];
  uint32_t session;
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
// LoRa receive -> queue -> ACK   (loop() task)
// =====================================================================
static void handleLoraPacket() {
  loraIrq = false;
  uint8_t buf[64];
  size_t len = radio.getPacketLength();
  if (len > sizeof(buf) || radio.readData(buf, len) != RADIOLIB_ERR_NONE) {
    radio.startReceive();
    return;
  }
  // A node still on protocol v1 (16-bit session) is served too, so nodes
  // can be re-flashed one by one after the gateway (sj_packet.h).
  bool v1 = sjIsValidReadingV1(buf, len);
  if (!v1 && !sjIsValidReading(buf, len)) {
    radio.startReceive();
    return;  // noise, another LoRa network, or a corrupted packet
  }
  SjReading r;
  if (v1) {
    r = sjReadingFromV1(buf);
  } else {
    memcpy(&r, buf, sizeof(r));
  }
  int16_t rssi = (int16_t)radio.getRSSI();

  bool stored = seenRecently(r);
  if (!stored) {
    GatewayQueued g = {r, deviceSeconds(), session, rssi};
    // The forwarding task holds the lock only to read a batch or pop it
    // (milliseconds). Waiting longer than the node's ACK window is useless:
    // not ACKing makes the node resend later, nothing is lost.
    SjLock lock(queueLock, pdMS_TO_TICKS(QUEUE_LOCK_WAIT_MS));
    if (lock.held) {
      stored = queue.push(g);
      queuedCount = queue.count();
    }
    if (stored) rememberReading(r);
  }
  if (stored) {  // ACK only what is safely on flash
    if (v1) {
      SjAckV1 ack = sjMakeAckV1(r);
      radio.transmit((uint8_t*)&ack, sizeof(ack));
    } else {
      SjAck ack = sjMakeAck(r);
      radio.transmit((uint8_t*)&ack, sizeof(ack));
    }
  }
  char nodeId[SJ_NODE_ID_LEN + 1] = {0};
  memcpy(nodeId, r.node_id, SJ_NODE_ID_LEN);
  Serial.printf("[lora] %s #%lu-%lu%s rssi=%d snr=%.1f %s, queue=%lu\n", nodeId, (unsigned long)r.session,
                (unsigned long)r.seq, v1 ? " (v1 node - re-flash it)" : "", rssi, radio.getSNR(),
                stored ? "ACKed" : "NOT stored (flash error or queue busy)", (unsigned long)queuedCount);
  loraIrq = false;  // DIO0 also fired for our own ACK transmission
  radio.startReceive();
}

// =====================================================================
// Forwarding to the backend   (forwarding task)
// =====================================================================
static long ageAtForward(const GatewayQueued& g) {
  if (g.reading.age_s == SJ_AGE_UNKNOWN || g.gwSession != session) return -1;  // unknown - backend uses receive time
  return (long)g.reading.age_s + (long)(deviceSeconds() - g.rxAtS);
}

// Caller holds queueLock.
static bool buildBatch(uint32_t n, String& body) {
  body = "{\"readings\":[";
  for (uint32_t i = 0; i < n; i++) {
    GatewayQueued g;
    if (!queue.peek(i, g)) return false;
    sjUpgradeQueuedReading(g.reading);  // queued by a v1 gateway firmware before an update
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
  while (queuedCount > 0) {
    if (!forwardTaskRunning && loraIrq) return;  // fallback in loop(): serve the radio first
    SjLock backhaul(backhaulLock);
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
    // wait). The LoRa radio is served meanwhile now, but each attempt still
    // costs power and delays uploads, so after a failed one don't try
    // NB-IoT again for NBIOT_RETRY_INTERVAL_MS (review R21).
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

    uint32_t n, droppedAtBuild, clearsAtBuild;
    String body;
    {
      SjLock lock(queueLock);
      uint32_t before = queue.count();
      n = singleMode ? 1 : min<uint32_t>(before, maxBatch);
      bool built = n > 0 && buildBatch(n, body);
      droppedAtBuild = queue.dropped();
      clearsAtBuild = queueClears;
      queuedCount = queue.count();  // a failed peek rebuilds the queue without the unreadable record
      if (!built) {                 // start again from count() on the next pass, nothing popped
        // If the rebuild failed too (flash full or failing), the bad record
        // is still there, and only peek(0) can skip it without a copy: go
        // one at a time until it is the oldest (a success ends singleMode).
        if (n > 0) singleMode = true;
        // Nothing changed = the queue could not repair itself: wait instead
        // of retrying (and re-attaching NB-IoT) every 20 ms on a broken flash.
        if (queuedCount == before) nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
        return;
      }
    }

    // No queue lock from here until the response: loop() keeps receiving,
    // queueing and ACKing node packets during the request.
    int code = -1;
#if ENABLE_WIFI
    if (strcmp(via, "wifi") == 0) code = postViaWifi(body);
#endif
#if ENABLE_NBIOT
    if (strcmp(via, "nbiot") == 0) code = nbiot.httpPost(NBIOT_BACKEND_BASE, NBIOT_BATCH_PATH, body, DEVICE_KEY);
#endif

    SjUploadAction action = sjUploadAction(code, n);
    uint32_t accepted = action == SJ_UPLOAD_DONE ? n : (action == SJ_UPLOAD_DROP_ONE ? 1 : 0);
    uint32_t left;
    {
      SjLock lock(queueLock);
      // Fewer than `accepted` if a full ring overwrote some of them or 'c'
      // cleared the queue while the request ran (sj_forward.h).
      uint32_t toPop = sjPopAfterUpload(accepted, droppedAtBuild, queue.dropped(), clearsAtBuild, queueClears);
      if (toPop) queue.pop(toPop);
      left = queue.count();
      queuedCount = left;
    }

    switch (action) {
      case SJ_UPLOAD_DONE:
        singleMode = false;
        Serial.printf("[forward] %lu reading(s) via %s, %lu left\n", (unsigned long)n, via, (unsigned long)left);
        break;
      case SJ_UPLOAD_SPLIT:
        singleMode = true;  // resend one at a time to find the refused reading
        break;
      case SJ_UPLOAD_DROP_ONE:
        Serial.printf("[forward] backend rejected a reading as invalid (HTTP %d) - dropping it\n", code);
        singleMode = false;
        break;
      case SJ_UPLOAD_RETRY:
        if (code == 401 || code == 403) {
          Serial.printf("[forward] HTTP %d: DEVICE_KEY in secrets.h is missing, wrong, revoked or not allowed for these nodes - readings kept\n", code);
        } else {
          Serial.printf("[forward] via %s failed (code %d) - %lu reading(s) kept\n", via, code, (unsigned long)left);
        }
        nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
        return;
    }
  }
}

static void forwardTask(void*) {
  for (;;) {
    if (queuedCount > 0 && (int32_t)(millis() - nextForwardMs) >= 0) forwardQueue();
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// =====================================================================
static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'q') {
    SjLock lock(queueLock);
    Serial.printf("[queue] %lu waiting, %lu dropped (overflow or unreadable)\n", (unsigned long)queue.count(),
                  (unsigned long)queue.dropped());
  }
  if (c == 'c') {
    SjLock lock(queueLock);
    queue.clear();
    queueClears++;  // an upload in flight must not pop readings that arrive after this
    queuedCount = queue.count();
    Serial.println("[queue] cleared");
  }
#if ENABLE_NBIOT
  if (c == 'a') {
    SjLock backhaul(backhaulLock, 0);
    if (!backhaul.held) {
      Serial.println("[nbiot] waiting for the current upload to finish...");
      backhaul.held = xSemaphoreTake(backhaulLock, portMAX_DELAY) == pdTRUE;
    }
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

  queueLock = xSemaphoreCreateMutex();
  backhaulLock = xSemaphoreCreateMutex();

  if (!queue.begin("/gw_queue.bin", "/gw_queue.hdr", QUEUE_CAPACITY)) {
    Serial.println("[queue] LittleFS unavailable - cannot store readings, NOT acknowledging nodes");
  }
  queuedCount = queue.count();
  Serial.printf("[queue] %lu reading(s) left from before reboot\n", (unsigned long)queuedCount);

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

  // Same core and priority as loop(): the scheduler time-slices the two,
  // so loop() gets the CPU within a tick even during a TLS handshake, and
  // the TLS/HTTP code keeps running on the core it was tested on.
  forwardTaskRunning = queueLock && backhaulLock &&
                       xTaskCreatePinnedToCore(forwardTask, "forward", FORWARD_TASK_STACK_BYTES, nullptr, 1, nullptr,
                                               xPortGetCoreID()) == pdPASS;
  if (!forwardTaskRunning) {
    Serial.println("[gateway] could not start the forwarding task (out of memory?) - forwarding from loop(), "
                   "the radio is not served during uploads");
  }
  Serial.println("[gateway] listening");
}

void loop() {
  handleSerial();
  if (loraIrq) handleLoraPacket();
  if (!forwardTaskRunning && queuedCount > 0 && (int32_t)(millis() - nextForwardMs) >= 0) forwardQueue();
  // LED: on while readings are waiting to be forwarded
  digitalWrite(LED_PIN, queuedCount > 0);
  delay(5);
}
