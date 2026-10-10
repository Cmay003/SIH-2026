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
 * SOS readings (a node's SOS button, SJ_SOS_PRESSED) are queued like any
 * reading and ALSO forwarded first, alone, ahead of the backlog
 * (SjPriorityOutbox in sj_packet.h) - after an outage the queue can hold
 * thousands of readings, and NB-IoT sends one per exchange. The outbox has
 * a copy in NVS, so a reboot does not put an SOS back behind that backlog.
 * URGENT readings (the node's SJ_X_PRIORITY: WATCH / URGENT, a fast rise, a
 * new anomaly - sjIsUrgentReading) go the same way through a second, RAM
 * outbox right after the SOS ones (batched; full = its oldest falls back
 * to its place in the queue). A reading forwarded from an outbox is
 * remembered (SjSentAhead) and its queued copy popped without a second
 * upload.
 *
 * Offline SOS Wi-Fi (SOS_HOTSPOT_ENABLE, sj_hotspot.h): an open access
 * point "SANJEEVNI-SOS" with a captive SOS page, served by its own task.
 * Its requests, and those the nodes' hotspots send over LoRa (SjSosMsg),
 * wait in an outbox (RAM + NVS) and go to the server's /api/ingest/sos
 * right after the SOS readings, ahead of the backlog, until it has them.
 *
 * Village sirens: the server's answer to an upload may hold "commands"
 * (siren on / off for a node). The gateway keeps each one (RAM + NVS) and
 * hands it to the node in the ACK of that node's next reading (SjAckCmd,
 * sj_siren_cmd.h) until the node's readings show it took effect.
 *
 * Protocol: v3 readings (64 bytes, with the node's river rise rate and
 * anomaly checks, plus a NORMAL-mode summary of the samples since the
 * node's previous report when it has one - kept with the reading and
 * forwarded as "summary"); nodes still on v2 or v1 firmware are served too
 * - their readings are widened and ACKed in their own version (sj_packet.h).
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
#include "sj_siren_cmd.h"
#include "sj_hotspot.h"
#if ENABLE_WIFI || SOS_HOTSPOT_ENABLE
#include <WiFi.h>
#endif
#if ENABLE_WIFI
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#endif
#if SOS_HOTSPOT_ENABLE
#include "sj_hotspot_ap.h"
#endif
#if ENABLE_NBIOT
#include "nbiot_sim7020.h"
#endif

struct GatewayQueued {
  SjReading reading;
  uint32_t rxAtS;     // gateway device seconds when received
  uint16_t gwSession; // gateway boot session when received
  int16_t rssi;       // LoRa RSSI of the node's packet
  SjSummary summary;  // with SJ_X_SUMMARY; last, so sjUpgradeRecord converts the older layouts
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
// SOS readings to forward before the backlog (also in `queue`), under
// queueLock. Four: SOS from several nodes during one backhaul outage.
static SjPriorityOutbox<GatewayQueued, 4> sosOutbox;
static volatile uint8_t sosWaiting = 0;     // sosOutbox.count as of the last change
static volatile bool sosArrived = false;    // a new SOS: forward now, don't wait out a retry back-off
static const char* SOS_OUTBOX_KEY = "sos_outbox";  // NVS copy of sosOutbox (saveSosOutbox())
// Urgent readings to forward right after the SOS ones (also in `queue`),
// under queueLock. RAM only: they arrive every few seconds while a node is
// on WATCH, and an NVS write each time would wear the flash out within
// months - after a reboot they simply wait in the queue, in order.
static SjPriorityOutbox<GatewayQueued, URGENT_OUTBOX_SLOTS> urgentOutbox;
static volatile uint8_t urgentWaiting = 0;  // urgentOutbox.count as of the last change
static bool urgentSingle = false;           // a batch of them was refused: one at a time (forwarding task)
// Readings forwarded from an outbox: their queued copies are popped
// without a second upload (sj_packet.h), under queueLock.
static SjSentAhead<SENT_AHEAD_SLOTS> sentAhead;
// Siren commands waiting for their node (sj_siren_cmd.h), under queueLock.
static SjSirenCmdTable<SIREN_CMD_SLOTS> sirenCmds;
static volatile bool sirenCmdsDirty = false;  // changed since the last NVS save
static const char* SIREN_CMDS_KEY = "siren_cmds";
static const SjSirenCmdLimits SIREN_LIMITS = {SIREN_DEFAULT_ON_S, SIREN_CMD_MAX_ON_S, SIREN_CMD_OFF_TTL_S};
// Signs each command with the node's own key, derived from this (sj_auth.h);
// without it no command is sent (they wait, and the server keeps asking).
#ifndef SIREN_MASTER_KEY
#define SIREN_MASTER_KEY ""
#endif
static uint8_t sirenMasterKey[SJ_CMD_MASTER_LEN];
static bool sirenMasterKeyOk = false;
// SOS requests from the offline Wi-Fi - this gateway's own page and the
// nodes' (LoRa) - waiting for the server, under queueLock, NVS copy.
static SjSosMsgOutbox<SOS_MSG_SLOTS> sosMsgOutbox;
static volatile uint8_t sosMsgWaiting = 0;  // sosMsgOutbox.count as of the last change
static const char* SOS_MSG_KEY = "sos_msgs";
static String sosUrl, sosPath;  // POST /api/ingest/sos over WiFi / NB-IoT (setup())
#if SOS_HOTSPOT_ENABLE
static SjHotspotAp hotspot;
static SjHotspotApp hotspotApp;  // under queueLock (the hotspot task and the forwarding task use it)
static SjHotspotSite hotspotSite;
static const SjHotspotLimits HOTSPOT_LIMITS = {SOS_HOTSPOT_MAX_PER_WINDOW, SOS_HOTSPOT_WINDOW_S,
                                               SOS_HOTSPOT_CLIENT_GAP_S};
static bool hotspotTaskRunning = false;
#endif
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

// Caller holds queueLock (it also serialises `prefs` between loop() and the
// forwarding task). The outbox is RAM: without this copy, a reboot between
// ACKing an SOS and forwarding it left the SOS only in the flash queue,
// behind up to QUEUE_CAPACITY readings - hours over NB-IoT - and the node,
// which has its ACK, never resends. Written only when an SOS arrives or is
// forwarded (rare), so NVS wear does not matter; a few ms, well inside the
// node's ACK window.
static void saveSosOutbox() {
  if (prefs.putBytes(SOS_OUTBOX_KEY, &sosOutbox, sizeof(sosOutbox)) != sizeof(sosOutbox)) {
    Serial.println("[sos] NVS copy of the SOS outbox NOT saved - after a reboot it waits behind the queue");
  }
}

// At boot: SOS readings that were waiting to be forwarded go first again
// (sjRestoreOutbox() takes only plausible SOS readings). One that was in
// fact forwarded just before the reboot is sent again: a duplicate
// reading_uid the server ignores.
static void restoreSosOutbox() {
  if (!prefs.isKey(SOS_OUTBOX_KEY) || prefs.getBytesLength(SOS_OUTBOX_KEY) != sizeof(sosOutbox)) return;
  SjPriorityOutbox<GatewayQueued, 4> saved;
  if (prefs.getBytes(SOS_OUTBOX_KEY, &saved, sizeof(saved)) != sizeof(saved)) return;
  uint8_t n = sjRestoreOutbox(sosOutbox, saved);
  sosWaiting = sosOutbox.count;
  sosArrived = n > 0;
  if (n) Serial.printf("[sos] %u SOS reading(s) not forwarded before the reboot - sending them first\n", n);
}

// Caller holds queueLock (as for saveSosOutbox()). Only when the table
// changed - a command arriving or being confirmed / dropped (rare) - and
// never between a node's packet and its ACK.
static void saveSirenCmds() {
  SjSirenCmdSaved<SIREN_CMD_SLOTS> saved;
  sjSirenSave(sirenCmds, deviceSeconds(), saved);
  if (prefs.putBytes(SIREN_CMDS_KEY, &saved, sizeof(saved)) != sizeof(saved)) {
    Serial.println("[siren] NVS copy of the siren commands NOT saved - a reboot would lose them");
  }
  sirenCmdsDirty = false;
}

// At boot: siren commands the server gave before the reboot, still not
// taken by their node (sj_siren_cmd.h; their time restarts at this boot).
static void restoreSirenCmds() {
  if (!prefs.isKey(SIREN_CMDS_KEY) || prefs.getBytesLength(SIREN_CMDS_KEY) != sizeof(SjSirenCmdSaved<SIREN_CMD_SLOTS>))
    return;
  SjSirenCmdSaved<SIREN_CMD_SLOTS> saved;
  if (prefs.getBytes(SIREN_CMDS_KEY, &saved, sizeof(saved)) != sizeof(saved)) return;
  uint8_t n = sjSirenRestore(sirenCmds, saved, deviceSeconds(), SIREN_LIMITS);
  if (n) Serial.printf("[siren] %u siren command(s) from before the reboot still to deliver\n", n);
}

// Caller holds queueLock (as for saveSosOutbox()). Written when a request
// arrives or is forwarded - before the node's ACK / the page's "saved", so
// both promises survive a reboot.
static void saveSosMsgs() {
  if (prefs.putBytes(SOS_MSG_KEY, &sosMsgOutbox, sizeof(sosMsgOutbox)) != sizeof(sosMsgOutbox)) {
    Serial.println("[sos-wifi] NVS copy of the SOS requests NOT saved - a reboot now would lose them");
  }
  sosMsgWaiting = sosMsgOutbox.count;
}

// At boot: SOS requests not forwarded before the reboot go first again
// (only entries that are still valid messages, sjSosMsgOutboxRestore()).
static void restoreSosMsgs() {
  if (!prefs.isKey(SOS_MSG_KEY) || prefs.getBytesLength(SOS_MSG_KEY) != sizeof(sosMsgOutbox)) return;
  static SjSosMsgOutbox<SOS_MSG_SLOTS> saved;  // ~2 KB: not on the setup() stack
  if (prefs.getBytes(SOS_MSG_KEY, &saved, sizeof(saved)) != sizeof(saved)) return;
  uint8_t n = sjSosMsgOutboxRestore(sosMsgOutbox, saved);
  sosMsgWaiting = sosMsgOutbox.count;
  if (n) {
    sosArrived = true;
    Serial.printf("[sos-wifi] %u SOS request(s) not forwarded before the reboot - sending them first\n", n);
  }
}

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
// Offline SOS Wi-Fi: this gateway's own page (hotspot task)
// =====================================================================
#if SOS_HOTSPOT_ENABLE
// sjHotspotHandle()'s store step. Caller holds queueLock (respondHotspot()).
static bool storeLocalSos(SjSosMsg& m) {
  SjSosMsgQueued e;
  memset(&e, 0, sizeof(e));
  e.msg = m;
  e.rxAtS = deviceSeconds();
  e.bootId = session;
  e.local = 1;
  if (sjSosMsgOutboxAdd(sosMsgOutbox, e) != 1) return false;
  saveSosMsgs();  // before the page says "saved"
  sosArrived = true;
  return true;
}

// One HTTP request from a phone. The lock is held only while the answer
// is built (no network I/O) - the LoRa loop waits at most milliseconds.
static void respondHotspot(const SjHttpReq& req, String& out) {
  char fresh[SJ_SOS_CLIENT_LEN + 1];
  sjHotspotNewClientId(fresh, esp_random(), esp_random());  // true random: the radio is on
  SjHsOutcome o;
  uint8_t waiting;
  {
    SjLock lock(queueLock);
    o = sjHotspotHandle(hotspotApp, hotspotSite, HOTSPOT_LIMITS, req, deviceSeconds(), fresh, storeLocalSos, out);
    waiting = sosMsgOutbox.count;
  }
  const char* what = sjHotspotOutcomeText(o);
  if (what) Serial.printf("[sos-wifi] %s (%u waiting for the server)\n", what, waiting);
}

static void hotspotTask(void*) {
  for (;;) {
    hotspot.poll(respondHotspot);
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

static void setupHotspot() {
  sjHotspotBegin(hotspotApp);
  if (!hotspot.begin(SOS_HOTSPOT_SSID, SOS_HOTSPOT_CHANNEL, SOS_HOTSPOT_MAX_CLIENTS)) {
    Serial.println("[sos-wifi] access point did NOT start - no offline SOS page on this gateway");
    return;
  }
  // A random number per boot (the radio is on, so esp_random() is truly
  // random): the sos_uid "<session>-h<seq>" never repeats, even after an
  // NVS erase - the server would drop a repeat as a duplicate.
  hotspotSite = {GATEWAY_ID, esp_random(), hotspot.ip(), true};
  sjHotspotRememberOutbox(hotspotApp, sosMsgOutbox, deviceSeconds());
  hotspotTaskRunning = queueLock && xTaskCreatePinnedToCore(hotspotTask, "hotspot", HOTSPOT_TASK_STACK_BYTES, nullptr,
                                                            1, nullptr, xPortGetCoreID()) == pdPASS;
  Serial.printf("[sos-wifi] open Wi-Fi '%s' at http://%s/ - requests go to the server as %s%s\n", SOS_HOTSPOT_SSID,
                hotspot.ip(), GATEWAY_ID, hotspotTaskRunning ? "" : " (served from loop(): no task)");
}

static void serviceHotspot() {
  if (!hotspotTaskRunning) hotspot.poll(respondHotspot);
}
#else
static void setupHotspot() {}
static void serviceHotspot() {}
#endif

#if ENABLE_WIFI && SOS_HOTSPOT_ENABLE
// With the hotspot on, the ESP32's own reconnect is off (setup()): while the
// router is out of reach it retries at once, again and again, and every try
// scans all channels - the access point is off its channel each time and
// phones drop off the SOS page. One try every WIFI_RETRY_WITH_HOTSPOT_MS
// instead; NB-IoT carries the uploads meanwhile.
static uint32_t lastStaTryMs = 0;
static void serviceWifiClient() {
  if (WiFi.status() == WL_CONNECTED || millis() - lastStaTryMs < WIFI_RETRY_WITH_HOTSPOT_MS) return;
  lastStaTryMs = millis();
  WiFi.reconnect();
}
#else
static void serviceWifiClient() {}
#endif

// =====================================================================
// LoRa receive -> queue -> ACK   (loop() task)
// =====================================================================
// An SOS typed on a node's offline Wi-Fi page: into the outbox (RAM + NVS),
// THEN the ACK - the node deletes its copy on our ACK. A resend of one we
// still hold is ACKed again; one we already forwarded comes back as new and
// the server answers "duplicate" (it dedups on node_id + sos_uid).
static void handleSosMsgPacket(const uint8_t* buf, size_t len) {
  SjSosMsg m;
  if (!sjParseSosMsg(buf, len, m)) return;  // noise, or not a valid request (never forwarded)
  SjSosMsgQueued e;
  memset(&e, 0, sizeof(e));
  e.msg = m;
  e.rxAtS = deviceSeconds();
  e.bootId = session;
  int added = -1;
  {
    SjLock lock(queueLock, pdMS_TO_TICKS(QUEUE_LOCK_WAIT_MS));
    if (lock.held) {
      added = sjSosMsgOutboxAdd(sosMsgOutbox, e);
      if (added == 1) {
        saveSosMsgs();  // before the ACK
        sosArrived = true;
      }
    }
  }
  if (added >= 0) {
    SjAck ack = sjMakeSosMsgAck(m);
    radio.transmit((uint8_t*)&ack, sizeof(ack));
  }
  char nodeId[SJ_NODE_ID_LEN + 1], uid[24];
  sjIdString(nodeId, m.node_id, SJ_NODE_ID_LEN);
  sjSosUid(uid, sizeof(uid), m);
  Serial.printf("[sos-wifi] SOS request %s from %s's hotspot: %s\n", uid, nodeId,
                added == 1 ? "stored, ACKed" : added == 0 ? "resend, ACKed again"
                                                          : "NOT stored (outbox full or busy) - the node retries");
}

static void handleLoraPacket() {
  loraIrq = false;
  uint8_t buf[sizeof(SjSosMsg)];  // the longest packet we take (a reading with a summary is <= 96 bytes)
  size_t len = radio.getPacketLength();
  if (len > sizeof(buf) || radio.readData(buf, len) != RADIOLIB_ERR_NONE) {
    radio.startReceive();
    return;
  }
  if (len >= SJ_SOS_MSG_HEADER_SIZE && buf[2] == SJ_TYPE_SOS_MSG) {
    handleSosMsgPacket(buf, len);
    loraIrq = false;  // DIO0 also fired for our ACK transmission
    radio.startReceive();
    return;
  }
  // Nodes still on protocol v1 (16-bit session) or v2 (no rise rate /
  // anomaly bytes) are served too, so nodes can be re-flashed one by one
  // after the gateway (sj_packet.h). Each is ACKed in its own version.
  SjReading r;
  SjSummary summary;  // a v3 node's summary, else zero
  uint8_t ackVersion = SJ_VERSION;
  if (!sjReceiveReading(buf, len, r, summary, ackVersion)) {
    radio.startReceive();
    return;  // noise, another LoRa network, a corrupted packet, or a node id that isn't one (never ACKed)
  }
  const bool v1 = ackVersion == SJ_VERSION_V1, v2 = ackVersion == SJ_VERSION_V2;
  const bool urgent = sjIsUrgentReading(r, URGENT_MAX_AGE_S);
  int16_t rssi = (int16_t)radio.getRSSI();

  bool stored = seenRecently(r);
  if (!stored) {
    GatewayQueued g = {r, deviceSeconds(), session, rssi, summary};
    // The forwarding task holds the lock only to read a batch or pop it
    // (milliseconds). Waiting longer than the node's ACK window is useless:
    // not ACKing makes the node resend later, nothing is lost.
    SjLock lock(queueLock, pdMS_TO_TICKS(QUEUE_LOCK_WAIT_MS));
    if (lock.held) {
      stored = queue.push(g);
      queuedCount = queue.count();
      // Only once it is safely queued, so the ACK still means "on flash";
      // a node's resend of it is caught by seenRecently() above.
      if (stored && (r.flags & SJ_SOS_PRESSED)) {
        sosOutbox.add(g);
        saveSosOutbox();  // before the ACK, like the queue push
        sosWaiting = sosOutbox.count;
        sosArrived = true;
      } else if (stored && urgent) {
        urgentOutbox.add(g);  // full: its oldest entry still waits in the queue, in order
        urgentWaiting = urgentOutbox.count;
      }
    }
    if (stored) rememberReading(r);
  }
  // A siren command waiting for this node rides on its ACK (also on the
  // ACK of a resend: the node may have missed the one that carried it).
  // A table lookup only - the NVS save it may need waits until after the ACK.
  SjDownlink cmd = {SJ_CMD_NONE, 0, 0};
  bool withCmd = false, noKey = false;
  if (stored && !v1 && (r.flags & SJ_SIREN_FITTED)) {
    SjLock lock(queueLock, pdMS_TO_TICKS(QUEUE_LOCK_WAIT_MS));
    if (lock.held) {
      bool changed = false;
      withCmd = sjSirenForReading(sirenCmds, r, deviceSeconds(), cmd, changed);
      if (changed) sirenCmdsDirty = true;
    }
  }
  if (withCmd && !sirenMasterKeyOk) {  // a node only obeys a command with its MAC: kept, not sent
    withCmd = false;
    noKey = true;
  }
  if (stored) {  // ACK only what is safely on flash
    if (v1) {
      SjAckV1 ack = sjMakeAckV1(r);
      radio.transmit((uint8_t*)&ack, sizeof(ack));
    } else if (withCmd) {
      uint8_t nodeKey[SJ_CMD_KEY_LEN];  // a few microseconds: well inside the node's ACK window
      sjSirenNodeKey(sirenMasterKey, r.node_id, nodeKey);
      SjAckCmd ack = sjMakeAckCmd(r, cmd, nodeKey, ackVersion);
      radio.transmit((uint8_t*)&ack, sizeof(ack));
    } else {
      SjAck ack = sjMakeAck(r, ackVersion);
      radio.transmit((uint8_t*)&ack, sizeof(ack));
    }
  }
  char nodeId[SJ_NODE_ID_LEN + 1] = {0};
  memcpy(nodeId, r.node_id, SJ_NODE_ID_LEN);
  Serial.printf("[lora] %s #%lu-%lu%s%s%s%s%s rssi=%d snr=%.1f %s, queue=%lu\n", nodeId, (unsigned long)r.session,
                (unsigned long)r.seq, (r.flags & SJ_SOS_PRESSED) ? " SOS BUTTON" : "",
                (r.flags & SJ_SIREN_ON) ? " SIREN ON" : "", (r.xflags & SJ_X_FAST_RISE) ? " FAST RISE" : "",
                urgent ? " URGENT" : (r.xflags & SJ_X_SUMMARY) ? " +summary" : "",
                v1 ? " (v1 node - re-flash it)" : v2 ? " (v2 node - re-flash it)" : "", rssi,
                radio.getSNR(), stored ? "ACKed" : "NOT stored (flash error or queue busy)", (unsigned long)queuedCount);
  if (withCmd) {
    Serial.printf("[siren] sent '%s' to %s with its ACK\n", cmd.cmd == SJ_CMD_SIREN_ON ? "on" : "off", nodeId);
  }
  if (noKey) {
    Serial.printf("[siren] a command for %s is waiting but NOT sent: SIREN_MASTER_KEY missing or not 64 hex "
                  "characters (secrets.h)\n", nodeId);
  }
  if (sirenCmdsDirty) {
    SjLock lock(queueLock, pdMS_TO_TICKS(QUEUE_LOCK_WAIT_MS));
    if (lock.held) saveSirenCmds();  // else the next change (or packet) saves it
  }
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

// One queued reading into a request body. The node's link to us is LoRa,
// so its signal is the LoRa RSSI.
static void appendForward(String& body, const GatewayQueued& g) {
  sjAppendJson(body, g.reading, ageAtForward(g), g.rssi, "lora", &g.summary);
}

// Caller holds queueLock, and has popped the readings already forwarded
// from an outbox (sjPopSentAhead). Up to `n` of the oldest; fewer if it
// reaches another such reading (sjCollectBatch). Returns how many are in
// the batch, 0 = a record can't be read. `fitted` collects the siren nodes.
static uint32_t buildBatch(uint32_t n, String& body, SjFittedNodes& fitted) {
  body = "{\"readings\":[";
  fitted.clear();
  bool first = true;
  uint32_t k = sjCollectBatch<GatewayQueued>(queue, sentAhead, n, [&](const GatewayQueued& g) {
    if (!first) body += ",";
    first = false;
    appendForward(body, g);
    fitted.add(g.reading);
  });
  body += "]}";
  return k;
}

#if ENABLE_WIFI
static int postViaWifi(const char* url, const String& body, String& answer) {
  WiFiClientSecure client;
  client.setInsecure();  // TODO: pin the backend certificate for real deployments
  HTTPClient http;
  if (!http.begin(client, url)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("ngrok-skip-browser-warning", "true");
  http.addHeader("X-Device-Key", DEVICE_KEY);  // the backend refuses readings without a valid key
  http.setTimeout(15000);
  int code = http.POST(body);
  // 200 and 5xx may hold siren commands (server.js attaches them to its
  // error answers too, so an officer's "off" works while the AI backend is down).
  // A 5xx body is read only when small and of known length: a proxy's HTML
  // error page (ngrok offline) must not eat the heap for nothing.
  int size = http.getSize();
  if (code == 200 || (code >= 500 && code < 600 && size > 0 && size <= 4096)) answer = http.getString();
  http.end();
  return code;
}
#endif

// One request over the backhaul forwardQueue() picked. No queue lock held.
// `answer` gets the body of a 200 response. sos = to /api/ingest/sos
// instead of /api/ingest/batch.
static int postBody(const char* via, const String& body, String& answer, bool sos) {
  int code = -1;
#if ENABLE_WIFI
  if (strcmp(via, "wifi") == 0) code = postViaWifi(sos ? sosUrl.c_str() : BACKEND_BATCH_URL, body, answer);
#endif
#if ENABLE_NBIOT
  if (strcmp(via, "nbiot") == 0) {
    code = nbiot.httpPost(NBIOT_BACKEND_BASE, sos ? sosPath.c_str() : NBIOT_BATCH_PATH, body, DEVICE_KEY, &answer);
  }
#endif
  return code;
}

// The oldest waiting offline-Wi-Fi SOS request on its own. Not taken yet
// (the backhaul failed, or the server said "later": 429 / 5xx / 401 /
// 403): it stays in the outbox, first again on the next pass, and
// `parked` says whether the server answered at all - then the readings
// still go in this pass (sjSosRetryParks, sj_forward.h). false = end the
// pass. Final: 200 (stored / duplicate / already_active) and 400 (it can
// never be accepted).
static bool forwardSosMsg(const char* via, bool& parked) {
  parked = false;
  SjSosMsgQueued e;
  {
    SjLock lock(queueLock);
    if (sosMsgOutbox.count == 0) return true;
    e = sosMsgOutbox.items[0];
  }
  String body;
  sjAppendSosMsgJson(body, e.msg, sjSosMsgAge(e, deviceSeconds(), session));
  String answer;
  int code = postBody(via, body, answer, true);
  char nodeId[SJ_NODE_ID_LEN + 1], uid[24];
  sjIdString(nodeId, e.msg.node_id, SJ_NODE_ID_LEN);
  sjSosUid(uid, sizeof(uid), e.msg);
  SjUploadAction action = sjUploadAction(code, 1);
  if (action == SJ_UPLOAD_RETRY) {
    parked = sjSosRetryParks(code);
    if (code == 401 || code == 403) {
      Serial.printf("[sos-wifi] HTTP %d for %s's SOS request %s: is %s registered (with its position) and in this "
                    "gateway's device key (--nodes)? KEPT and retried - SOS requests from %s wait until that is "
                    "fixed; readings are still forwarded\n", code, nodeId, uid, nodeId, nodeId);
    } else {
      Serial.printf("[sos-wifi] SOS request %s from %s via %s failed (code %d) - kept, first again on the retry%s\n",
                    uid, nodeId, via, code, parked ? "; readings are still forwarded" : "");
    }
    nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
    return parked;
  }
  {
    SjLock lock(queueLock);
    sjSosMsgOutboxRemove(sosMsgOutbox, e.msg);  // by identity: others may have arrived meanwhile
    saveSosMsgs();
#if SOS_HOTSPOT_ENABLE
    if (e.local && action == SJ_UPLOAD_DONE) sjHotspotMarkSent(hotspotApp, e.msg.session, e.msg.seq, deviceSeconds());
    if (e.local && action != SJ_UPLOAD_DONE) sjHotspotForget(hotspotApp, e.msg.session, e.msg.seq);
#endif
  }
  if (action == SJ_UPLOAD_DONE) {
    Serial.printf("[sos-wifi] SOS request %s from %s delivered via %s\n", uid, nodeId, via);
  } else {
    Serial.printf("[sos-wifi] server REFUSED SOS request %s from %s (HTTP %d) - dropped\n", uid, nodeId, code);
  }
  return true;
}

// A 200 answer: store its siren commands, drop those it says are done -
// only if the body arrived complete (sjSirenApplyAnswer, sj_siren_cmd.h).
// Takes queueLock itself.
static void applySirenCommands(const String& answer, const SjFittedNodes& fitted) {
  SjSirenCommand cmds[SIREN_CMD_SLOTS];
  int n = 0;
  {
    SjLock lock(queueLock);
    if (sjSirenApplyAnswer(sirenCmds, answer.c_str(), fitted, deviceSeconds(), SIREN_LIMITS, cmds, SIREN_CMD_SLOTS,
                           n))
      saveSirenCmds();
  }
  if (fitted.n > 0 && !sjJsonObjectComplete(answer.c_str())) {
    Serial.printf("[siren] the server's answer arrived empty or cut off (%u bytes) - pending siren commands kept\n",
                  (unsigned)answer.length());
  }
  for (int i = 0; i < n; i++) {
    Serial.printf("[siren] server wants %s's siren %s - sent with its next ACK\n", cmds[i].node_id,
                  cmds[i].on ? "ON" : "off");
  }
}

// Any upload answer. 200: as above. 5xx: server.js still attaches the
// commands (sendPipelineError), e.g. while the AI backend is down - they are
// stored so an officer's "off" still reaches the node, but an error answer
// never clears a pending command (empty `fitted` = nothing may be cleared).
static void applyUploadAnswer(int code, const String& answer, const SjFittedNodes& fitted) {
  if (code == 200) {
    applySirenCommands(answer, fitted);
  } else if (code >= 500 && code < 600) {
    SjFittedNodes none;
    none.clear();
    applySirenCommands(answer, none);
  }
}

// The oldest waiting SOS reading on its own. Not taken yet: it stays in
// the outbox and goes first again on the next pass; `parked` / false as
// for forwardSosMsg() (a 403 for a node missing from the device key must
// not hold back the other nodes' readings either).
static bool forwardSos(const char* via, bool& parked) {
  parked = false;
  GatewayQueued sos;
  {
    SjLock lock(queueLock);
    if (sosOutbox.empty()) return true;
    sos = sosOutbox.front();
  }
  String body = "{\"readings\":[";
  appendForward(body, sos);
  body += "]}";
  String answer;
  int code = postBody(via, body, answer, false);
  {
    SjFittedNodes fitted;
    fitted.clear();
    fitted.add(sos.reading);
    applyUploadAnswer(code, answer, fitted);
  }
  char nodeId[SJ_NODE_ID_LEN + 1] = {0};
  memcpy(nodeId, sos.reading.node_id, SJ_NODE_ID_LEN);
  if (sjUploadAction(code, 1) == SJ_UPLOAD_RETRY) {
    parked = sjSosRetryParks(code);
    Serial.printf("[forward] SOS from %s via %s failed (code %d) - kept, first again on the retry%s\n", nodeId, via,
                  code, parked ? "; the other readings are still forwarded" : "");
    nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
    return parked;
  }
  // 200, or 400/422 for the reading itself (no sensor value): final either
  // way - the server raises the SOS from the sos_button flag before it
  // passes the reading on. Its queued copy is popped unsent (sentAhead).
  {
    SjLock lock(queueLock);
    sosOutbox.remove(sos.reading);  // by identity: loop() may have added one meanwhile
    saveSosOutbox();
    sosWaiting = sosOutbox.count;
    sentAhead.add(sos.reading);
  }
  Serial.printf("[forward] SOS from %s via %s (HTTP %d)\n", nodeId, via, code);
  return true;
}

// The waiting urgent readings (sjIsUrgentReading), oldest first, as one
// batch of up to maxBatch - one at a time after the backend refused a
// batch of them (SPLIT), until the outbox is empty. false = the backhaul
// failed or the server said "later": they stay, first again on the retry.
// Final (200, or 400/422 for a single one): they leave the outbox and their
// queued copies are popped unsent (sentAhead).
static bool forwardUrgent(const char* via, uint32_t maxBatch) {
  static GatewayQueued items[URGENT_OUTBOX_SLOTS];  // forwarding task only: kept off its stack
  uint8_t n;
  {
    SjLock lock(queueLock);
    n = urgentOutbox.count <= URGENT_OUTBOX_SLOTS ? urgentOutbox.count : 0;
    if (n == 0) {
      urgentOutbox.clear();  // also a corrupted count
      urgentWaiting = 0;
      return true;
    }
    if (urgentSingle) n = 1;
    if (maxBatch > 0 && n > maxBatch) n = (uint8_t)maxBatch;
    for (uint8_t i = 0; i < n; i++) items[i] = urgentOutbox.items[i];
  }
  String body = "{\"readings\":[";
  SjFittedNodes fitted;
  fitted.clear();
  for (uint8_t i = 0; i < n; i++) {
    if (i) body += ",";
    appendForward(body, items[i]);
    fitted.add(items[i].reading);
  }
  body += "]}";
  String answer;
  int code = postBody(via, body, answer, false);
  applyUploadAnswer(code, answer, fitted);
  SjUploadAction action = sjUploadAction(code, n);
  if (action == SJ_UPLOAD_RETRY) {
    Serial.printf("[forward] %u urgent reading(s) via %s failed (code %d) - kept, first again on the retry\n", n, via,
                  code);
    nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
    return false;
  }
  if (action == SJ_UPLOAD_SPLIT) {
    urgentSingle = true;  // find the one the backend refuses
    return true;
  }
  {
    SjLock lock(queueLock);
    for (uint8_t i = 0; i < n; i++) {
      urgentOutbox.remove(items[i].reading);  // by identity: loop() may have added (or pushed one out) meanwhile
      sentAhead.add(items[i].reading);
    }
    urgentWaiting = urgentOutbox.count;
    if (urgentOutbox.empty()) urgentSingle = false;
  }
  if (action == SJ_UPLOAD_DONE) {
    Serial.printf("[forward] %u urgent reading(s) via %s, ahead of the queue\n", n, via);
  } else {
    Serial.printf("[forward] backend rejected an urgent reading as invalid (HTTP %d) - dropping it\n", code);
  }
  return true;
}

// Forwards as much of the queue as the backhaul accepts. What happens to
// the queue after each response is decided by sjUploadAction() (shared
// with the node, see sj_packet.h): only a backend "this reading is
// invalid" drops a reading; outages, 404s and key problems keep it.
// Order and what a refused SOS stops: sjForwardStep() / sjSosRetryParks()
// in sj_forward.h - an SOS the server refuses is parked for this pass and
// the readings still go.
static void forwardQueue() {
  bool sosParked = false, sosMsgParked = false;  // refused by the server in this pass: first again in the next
  while (queuedCount > 0 || sosWaiting > 0 || sosMsgWaiting > 0 || urgentWaiting > 0) {
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
    SjFwdStep step = sjForwardStep(sosWaiting > 0, sosParked, sosMsgWaiting > 0, sosMsgParked, urgentWaiting > 0,
                                   queuedCount > 0);
    if (step == SJ_FWD_SOS) {  // SOS readings before the backlog
      if (!forwardSos(via, sosParked)) return;
      continue;
    }
    if (step == SJ_FWD_SOS_MSG) {  // then offline-Wi-Fi SOS requests, also before the backlog
      if (!forwardSosMsg(via, sosMsgParked)) return;
      continue;
    }
    if (step == SJ_FWD_URGENT) {  // then urgent readings (WATCH / URGENT, fast rise, new anomaly)
      if (!forwardUrgent(via, maxBatch)) return;
      continue;
    }
    if (step != SJ_FWD_BACKLOG) return;  // only parked SOS left: they wait for the next pass

    uint32_t n, droppedAtBuild, clearsAtBuild;
    String body;
    SjFittedNodes fitted;
    fitted.clear();
    {
      SjLock lock(queueLock);
      // Readings already forwarded from an outbox: popped, no upload
      sjPopSentAhead<GatewayQueued>(queue, sentAhead);
      uint32_t before = queue.count();
      queuedCount = before;
      if (before == 0) continue;
      n = singleMode ? 1 : min<uint32_t>(before, maxBatch);
      n = buildBatch(n, body, fitted);
      bool built = n > 0;
      droppedAtBuild = queue.dropped();
      clearsAtBuild = queueClears;
      queuedCount = queue.count();  // a failed peek rebuilds the queue without the unreadable record
      if (!built) {                 // start again from count() on the next pass, nothing popped
        // If the rebuild failed too (flash full or failing), the bad record
        // is still there, and only peek(0) can skip it without a copy: go
        // one at a time until it is the oldest (a success ends singleMode).
        singleMode = true;
        // Nothing changed = the queue could not repair itself: wait instead
        // of retrying (and re-attaching NB-IoT) every 20 ms on a broken flash.
        if (queuedCount == before) nextForwardMs = millis() + FORWARD_RETRY_INTERVAL_MS;
        return;
      }
    }

    // No queue lock from here until the response: loop() keeps receiving,
    // queueing and ACKing node packets during the request.
    String answer;
    int code = postBody(via, body, answer, false);
    applyUploadAnswer(code, answer, fitted);

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

// Due = the retry back-off is over, or an SOS just arrived (the NB-IoT
// attach back-off inside forwardQueue() still applies). An urgent reading
// does not cut the back-off short: while the backhaul works there is none
// (the task forwards it within milliseconds), and while it is down, a node
// on WATCH sends one every few seconds - each would start another attempt.
static bool forwardDue() {
  if (queuedCount == 0 && sosWaiting == 0 && sosMsgWaiting == 0 && urgentWaiting == 0) return false;
  if (sosArrived) {
    sosArrived = false;
    return true;
  }
  return (int32_t)(millis() - nextForwardMs) >= 0;
}

static void forwardTask(void*) {
  for (;;) {
    if (forwardDue()) forwardQueue();
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// =====================================================================
static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  if (c == 'q') {
    SjLock lock(queueLock);
    Serial.printf("[queue] %lu waiting (+%u SOS, %u urgent forwarded first), %lu dropped (overflow or unreadable); "
                  "%u siren command(s) waiting for their node\n",
                  (unsigned long)queue.count(), sosOutbox.count, urgentOutbox.count, (unsigned long)queue.dropped(),
                  sjSirenPendingCount(sirenCmds));
    Serial.printf("[sos-wifi] %u SOS request(s) waiting for the server (max %u)\n", sosMsgOutbox.count,
                  (unsigned)SOS_MSG_SLOTS);
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

  // Readings queued by the protocol-v2 firmware, or by the v3 one before
  // summaries - already ACKed to their nodes - are converted at the first
  // boot after the update, not dropped (sjUpgradeRecord, sj_packet.h).
  if (!queue.begin("/gw_queue.bin", "/gw_queue.hdr", QUEUE_CAPACITY, sjUpgradeRecord<GatewayQueued>)) {
    Serial.println("[queue] LittleFS unavailable - cannot store readings, NOT acknowledging nodes");
  }
  queuedCount = queue.count();
  Serial.printf("[queue] %lu reading(s) left from before reboot\n", (unsigned long)queuedCount);
  restoreSosOutbox();  // before the forwarding task starts: no lock needed yet
  restoreSirenCmds();
  sirenMasterKeyOk = sjParseHexKey(SIREN_MASTER_KEY, sirenMasterKey, SJ_CMD_MASTER_LEN);
  if (!sirenMasterKeyOk) {
    Serial.println("[siren] SIREN_MASTER_KEY missing or not 64 hex characters (secrets.h) - siren commands from "
                   "the server can NOT be passed to nodes. See secrets.example.h");
  }
  restoreSosMsgs();
#if ENABLE_WIFI
#ifdef BACKEND_SOS_URL
  sosUrl = BACKEND_SOS_URL;
#else
  sosUrl = sjSiblingUrl(BACKEND_BATCH_URL, "sos");  // ".../api/ingest/batch" -> ".../api/ingest/sos"
#endif
#endif
#if ENABLE_NBIOT
#ifdef NBIOT_SOS_PATH
  sosPath = NBIOT_SOS_PATH;
#else
  sosPath = sjSiblingUrl(NBIOT_BATCH_PATH, "sos");
#endif
#endif

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int state = radio.begin(LORA_FREQUENCY_MHZ, LORA_BANDWIDTH_KHZ, LORA_SPREADING_FACTOR, LORA_CODING_RATE,
                          LORA_SYNC_WORD, LORA_TX_POWER_DBM);
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("[lora] init failed, code %d - check wiring/frequency\n", state);
  }
  radio.setCRC(true);
  radio.setDio0Action(onLoraDio0, RISING);
  radio.startReceive();

#if SOS_HOTSPOT_ENABLE
  WiFi.mode(ENABLE_WIFI ? WIFI_AP_STA : WIFI_AP);  // the SOS access point, + the uplink client if any
  setupHotspot();
#elif ENABLE_WIFI
  WiFi.mode(WIFI_STA);
#endif
#if ENABLE_WIFI
#if SOS_HOTSPOT_ENABLE
  WiFi.setAutoReconnect(false);  // retried by serviceWifiClient() instead
#endif
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // without the hotspot: auto-reconnects afterwards
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
  if (!forwardTaskRunning && forwardDue()) forwardQueue();
  serviceHotspot();  // only if its task could not start
  serviceWifiClient();
  // LED: on while readings / SOS requests are waiting to be forwarded
  digitalWrite(LED_PIN, queuedCount > 0 || sosMsgWaiting > 0 || urgentWaiting > 0);
  delay(5);
}
