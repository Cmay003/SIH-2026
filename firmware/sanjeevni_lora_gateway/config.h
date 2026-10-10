// =====================================================================
// SANJEEVNI LoRa gateway - configuration.
// CHECK EVERY PIN AGAINST YOUR WIRING BEFORE FLASHING.
// WiFi / backend URLs / APN live in secrets.h (git-ignored) - copy
// secrets.example.h to secrets.h and fill it in.
// =====================================================================
#pragma once

// ---- LoRa SX1278 - MUST match every node's config.h ------------------
#define LORA_FREQUENCY_MHZ 433.0
#define LORA_BANDWIDTH_KHZ 125.0
#define LORA_SPREADING_FACTOR 9
#define LORA_CODING_RATE 7
#define LORA_SYNC_WORD 0x34
#define LORA_TX_POWER_DBM 10  // ACK power; confirm legal limits (see node config.h)

#define LORA_SCK 18
#define LORA_MISO 19
#define LORA_MOSI 23
#define LORA_NSS 5
#define LORA_RST 14
#define LORA_DIO0 26

// ---- Queue (LittleFS) -----------------------------------------------
// Readings are acknowledged to nodes only AFTER they are saved here, then
// forwarded to the backend. 4000 x (104 B + 4 B CRC) = ~422 KB in 109
// small segment files (sj_file_queue.h; a record is the 64-byte reading,
// receive time / session / RSSI and the node's 32-byte summary) - the
// default ESP32 partition scheme's ~1.4 MB LittleFS holds it and a second
// copy. Changing this on a gateway that still holds readings is safe: the
// next boot moves them to the new size (newest kept if smaller), which
// briefly needs free flash for a second copy. Without that room (e.g. a
// much larger capacity on a full queue) the queue keeps the old size and
// its readings, and the move is retried at the next boot. Readings queued
// by older firmware (64-byte v2 records, 72-byte v3 records without a
// summary) are converted the same way at the first boot after the update -
// if that copy fails for lack of room they are lost (the old records
// can't be used as they are).
#define QUEUE_CAPACITY 4000

// Urgent readings (a node's WATCH / URGENT, fast rise, new anomaly) are
// forwarded ahead of the queue: the newest URGENT_OUTBOX_SLOTS of them
// wait in RAM (older ones keep their place in the queue). Readings
// forwarded that way are remembered (SENT_AHEAD_SLOTS, ~24 bytes each) so
// their queued copies are not uploaded a second time.
#define URGENT_OUTBOX_SLOTS 16
#define SENT_AHEAD_SLOTS 96
// Only a reading at most this old when it arrives counts as urgent
// (sjIsUrgentReading): a node draining its backlog after an outage sends
// hours-old WATCH / fast-rise readings, which are history, not news.
// A live urgent reading arrives within seconds (nodes send them at once,
// whatever their report interval); 2 x a siren node's 60 s report interval
// - a configurable demo default.
#define URGENT_MAX_AGE_S 120
static_assert(URGENT_OUTBOX_SLOTS >= 1 && URGENT_OUTBOX_SLOTS <= 32, "URGENT_OUTBOX_SLOTS: 1..32");
static_assert(SENT_AHEAD_SLOTS >= URGENT_OUTBOX_SLOTS + 4 && SENT_AHEAD_SLOTS <= 255,
              "SENT_AHEAD_SLOTS: at least both outboxes' size, at most 255");

// ---- Backhaul -------------------------------------------------------
// WiFi is tried first; NB-IoT is used when WiFi is not connected.
#define ENABLE_WIFI 1
#define ENABLE_NBIOT 1

#define FORWARD_RETRY_INTERVAL_MS 15000UL
// Uploads run in their own FreeRTOS task so the LoRa radio is served
// during a request. 12 KB: the TLS handshake ran in Arduino's 8 KB loop
// task before; the rest is margin.
#define FORWARD_TASK_STACK_BYTES 12288
// How long a received packet waits for the queue while the forwarding task
// reads or pops a batch. Kept well under the node's ACK timeout - a packet
// not ACKed in time is simply resent by the node.
#define QUEUE_LOCK_WAIT_MS 500
#define WIFI_MAX_BATCH 20  // readings per HTTPS request
// SIM7020 sends the body hex-encoded inside one AT command, so keep NB-IoT
// requests small. Raise only after testing larger bodies on your module.
#define NBIOT_MAX_BATCH 1

// SIM7020E on UART1. PWRKEY pin optional (-1 if the board powers on by itself).
#define NBIOT_RX_PIN 32  // ESP32 RX  <- SIM7020 TX
#define NBIOT_TX_PIN 33  // ESP32 TX  -> SIM7020 RX
#define NBIOT_PWRKEY_PIN 25
#define NBIOT_BAUD 115200
#define NBIOT_ATTACH_TIMEOUT_MS 60000UL
#define NBIOT_RETRY_INTERVAL_MS 300000UL  // after a failed attach, wait 5 min before trying NB-IoT again
#define NBIOT_BODY_WAIT_MS 5000UL         // after a 200: wait this long for the response body (siren commands)

// ---- Village siren commands (server -> node, sj_siren_cmd.h) ----------
// The server's answer to an upload can ask for a node's siren on / off;
// the gateway keeps that wish and hands it to the node in the ACK of its
// next reading (siren nodes report at least every 60 s - the node's
// config.h checks it; nodes without a siren every 5 min). Kept in NVS too.
// Signed per node with a key derived from SIREN_MASTER_KEY (secrets.h,
// sj_auth.h) - without it no command is sent.
#define SIREN_CMD_SLOTS 8          // nodes with a command waiting at once
#define SIREN_DEFAULT_ON_S 180     // an "on" without for_s (= the server's default)
#define SIREN_CMD_MAX_ON_S 900     // an "on" is never kept / sent longer than this (= server siren.js MAX_ON_SECONDS)
#define SIREN_CMD_OFF_TTL_S 900    // an "off" the node has not taken by then is dropped (the server re-sends)

// ---- Offline SOS Wi-Fi "SANJEEVNI-SOS" (sj_hotspot.h) --------------------
// An OPEN Wi-Fi with a captive SOS page (EN/HI) for people whose phone has
// no mobile data. Requests from it - and those the nodes' own hotspots send
// over LoRa (SjSosMsg) - are kept in an outbox (RAM + NVS) and forwarded to
// the server's POST /api/ingest/sos ahead of the reading backlog, over WiFi
// or NB-IoT, until the server has them.
// Works with NB-IoT backhaul only (ENABLE_WIFI 0) too. With ENABLE_WIFI 1
// the radio is shared: once the gateway's WiFi client is connected, the
// access point moves to the router's channel; while the router is out of
// reach the client retries only every WIFI_RETRY_WITH_HOTSPOT_MS (each try
// scans all channels and takes the access point off the air for a moment).
// The SOS is placed at GATEWAY_ID's registered position: register GATEWAY_ID
// on the admin page WITH this gateway's position, and add it to this
// gateway's device key (node device_keys.js add gateway-1 --nodes ...,GW-01),
// or the server refuses its requests (403 - they stay queued and retried).
// The limits are configurable demo defaults, not values from a standard.
#define SOS_HOTSPOT_ENABLE 1
#define GATEWAY_ID "GW-01"             // max 12 chars: letters, digits, - _ .
#define SOS_HOTSPOT_SSID "SANJEEVNI-SOS"
#define SOS_HOTSPOT_CHANNEL 1          // while the WiFi client is not connected
#define SOS_HOTSPOT_MAX_CLIENTS 8      // phones connected at once (the ESP32 allows up to 10)
// Per phone - recognised by its page id AND its Wi-Fi address, so a fresh
// id from the same phone does not count as a new phone: one open request,
// then SOS_HOTSPOT_CLIENT_GAP_S after it went out. The access-point-wide
// window is only the backstop against many phones (or a phone that keeps
// re-joining with a new address), so it is set well above what one phone
// can use.
#define SOS_HOTSPOT_MAX_PER_WINDOW 20  // new requests per window on the whole access point (<= 32)
#define SOS_HOTSPOT_WINDOW_S 600
#define SOS_HOTSPOT_CLIENT_GAP_S 120   // after a phone's request went out, it waits this long to send another
#define SOS_MSG_SLOTS 12               // SOS requests waiting for the server (own + nodes'), RAM + NVS
#define HOTSPOT_TASK_STACK_BYTES 8192  // the page server runs in its own task, like the uploads
#define WIFI_RETRY_WITH_HOTSPOT_MS 120000UL

static_assert(sizeof(GATEWAY_ID) - 1 >= 1 && sizeof(GATEWAY_ID) - 1 <= 12, "GATEWAY_ID: 1..12 characters");
static_assert(SOS_HOTSPOT_MAX_PER_WINDOW >= 1 && SOS_HOTSPOT_MAX_PER_WINDOW <= 32,
              "SOS_HOTSPOT_MAX_PER_WINDOW must be 1..32 (sj_hotspot.h SJ_HS_RATE_SLOTS)");
static_assert(SOS_HOTSPOT_MAX_CLIENTS >= 1 && SOS_HOTSPOT_MAX_CLIENTS <= 10, "SOS_HOTSPOT_MAX_CLIENTS: 1..10 (ESP32)");
static_assert(SOS_MSG_SLOTS >= 1 && SOS_MSG_SLOTS <= 24, "SOS_MSG_SLOTS: 1..24 (each is ~160 bytes of RAM and NVS)");

#define LED_PIN 2
