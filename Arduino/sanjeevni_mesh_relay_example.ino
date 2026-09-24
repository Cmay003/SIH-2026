/*
 * SANJEEVNI - ESP-NOW MESH RELAY EXAMPLE
 * =====================================================
 * Lets nodes relay readings to each other WITHOUT direct WiFi/internet -
 * useful when a node is out of router range but within ESP-NOW range of
 * another node that DOES have a working connection.
 *
 * SCOPE - be clear about what this actually is:
 * This is a ONE-HOP relay, not full multi-hop mesh routing. A node that
 * can't reach WiFi broadcasts its reading via ESP-NOW; any node that
 * DOES have WiFi and receives that broadcast forwards it to the backend
 * on the sender's behalf. If NO node within ESP-NOW range has working
 * WiFi, the reading is lost (buffered briefly, not stored indefinitely).
 * True multi-hop mesh (relay through several hops to reach connectivity)
 * would need a real routing protocol (e.g. painlessMesh) - a bigger
 * undertaking than fits this upgrade pass. This solves the common case
 * from the brief ("nodes relay data to each other") at one hop, which
 * is a real, working improvement over "no relay at all".
 *
 * HOW ESP-NOW ITSELF WORKS (for context): it's a WiFi-radio-based
 * peer-to-peer protocol built into ESP32/ESP8266 - no router needed,
 * ~200m range in open air, very low latency and power cost. Two ESP32s
 * can talk directly even with no WiFi network present at all.
 *
 * SETUP YOU MUST DO:
 * 1. Flash this on every node that should participate in relaying.
 * 2. Find each node's MAC address (Serial.println(WiFi.macAddress())
 *    on first boot) and fill in PEER_MAC_ADDRESSES below.
 * 3. Nodes without WiFi in range still call trySendOrRelay() the same
 *    way - the function decides locally whether to send directly or
 *    relay, no manual configuration needed per-reading.
 *
 * HONEST LIMITATION: I cannot compile, flash, or radio-test this. The
 * ESP-NOW API calls and struct-based message passing shown here match
 * the standard ESP-IDF/Arduino-ESP32 ESP-NOW pattern, but real-world
 * range, interference, and peer registration quirks can only be
 * confirmed on your actual hardware.
 */

#include <WiFi.h>
#include <esp_now.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

const char* WIFI_SSID = "IQOO Z10X";
const char* WIFI_PASSWORD = "123456789";
const char* BACKEND_URL = "https://crusader-equate-spoon.ngrok-free.dev/api/ingest";
const char* DEVICE_ID = "NODE-07"; // change per node

// Fill in with the actual MAC addresses of nearby nodes this one should
// relay through/for. Get each node's MAC via WiFi.macAddress() on boot.
uint8_t PEER_MAC_ADDRESSES[][6] = {
  {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01}, // example - REPLACE with real MACs
  {0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x02},
};
const int NUM_PEERS = sizeof(PEER_MAC_ADDRESSES) / sizeof(PEER_MAC_ADDRESSES[0]);

// The message structure sent over ESP-NOW - kept small and fixed-size,
// since ESP-NOW has a 250-byte payload limit per message.
typedef struct {
  char node_id[16];
  float river_level_m;
  float temp_c;
  float humidity_pct;
  float gas_ppm;
  float flame_reading;
} RelayedReading;

RelayedReading incomingRelay;
volatile bool relayPending = false;

// Called by the ESP-NOW stack when a message arrives from any registered peer
void onEspNowReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(RelayedReading)) return; // ignore malformed/foreign packets
  memcpy(&incomingRelay, data, sizeof(RelayedReading));
  relayPending = true;
}

void setupEspNow() {
  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return;
  }
  esp_now_register_recv_cb(onEspNowReceive);

  for (int i = 0; i < NUM_PEERS; i++) {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, PEER_MAC_ADDRESSES[i], 6);
    peerInfo.channel = 0;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }
  Serial.println("ESP-NOW ready, " + String(NUM_PEERS) + " peers registered");
}

bool tryConnectWiFi(unsigned long timeoutMs) {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(200);
  }
  return WiFi.status() == WL_CONNECTED;
}

bool sendReadingToBackend(const char* nodeId, float river, float temp, float humidity, float gas, float flame) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, BACKEND_URL)) return false;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("ngrok-skip-browser-warning", "true");

  String json = "{";
  json += "\"node_id\":\"" + String(nodeId) + "\",";
  json += "\"river_level_m\":" + String(river, 3) + ",";
  json += "\"temp_c\":" + String(temp, 2) + ",";
  json += "\"humidity_pct\":" + String(humidity, 2) + ",";
  json += "\"gas_ppm\":" + String(gas, 1) + ",";
  json += "\"flame_reading\":" + String(flame, 2) + ",";
  json += "\"rainfall_mm_since_last\":0.0";
  json += "}";

  int code = http.POST(json);
  http.end();
  return code > 0 && code < 300;
}

// This is the function your normal sensor-reading loop calls instead of
// posting directly - it decides locally whether direct WiFi works, and
// falls back to an ESP-NOW broadcast relay if not.
void trySendOrRelay(float river, float temp, float humidity, float gas, float flame) {
  if (tryConnectWiFi(8000)) {
    bool ok = sendReadingToBackend(DEVICE_ID, river, temp, humidity, gas, flame);
    Serial.println(ok ? "Sent directly via WiFi" : "Direct send failed despite WiFi connection");
    WiFi.disconnect(true);
    return;
  }

  Serial.println("No direct WiFi - relaying via ESP-NOW to peers");
  RelayedReading reading;
  strncpy(reading.node_id, DEVICE_ID, sizeof(reading.node_id) - 1);
  reading.river_level_m = river;
  reading.temp_c = temp;
  reading.humidity_pct = humidity;
  reading.gas_ppm = gas;
  reading.flame_reading = flame;

  for (int i = 0; i < NUM_PEERS; i++) {
    esp_now_send(PEER_MAC_ADDRESSES[i], (uint8_t *)&reading, sizeof(reading));
  }
}

// Call this from loop() on every node that participates in relaying -
// forwards anything received from a peer, IF this node currently has
// working WiFi. If this node also lacks WiFi, the reading is simply not
// forwarded further (one-hop only, per the scope note above).
void processIncomingRelay() {
  if (!relayPending) return;
  relayPending = false;

  if (WiFi.status() == WL_CONNECTED) {
    bool ok = sendReadingToBackend(
      incomingRelay.node_id, incomingRelay.river_level_m, incomingRelay.temp_c,
      incomingRelay.humidity_pct, incomingRelay.gas_ppm, incomingRelay.flame_reading
    );
    Serial.println(String("Relayed reading from ") + incomingRelay.node_id +
                    (ok ? " -> backend OK" : " -> backend FAILED"));
  } else {
    Serial.println(String("Received relay from ") + incomingRelay.node_id +
                    " but this node also has no WiFi - reading dropped (one-hop only)");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.print("This node's MAC address (add it to peers on OTHER nodes): ");
  Serial.println(WiFi.macAddress());
  setupEspNow();
}

void loop() {
  processIncomingRelay();

  // Replace this with your actual sensor reads (see sanjeevni_node.ino) -
  // this stub shows where trySendOrRelay() plugs into your existing loop.
  // trySendOrRelay(waterLevel, temperature, humidity, gasReading, flameReading);

  delay(5000);
}
