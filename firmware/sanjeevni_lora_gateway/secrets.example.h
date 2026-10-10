// Copy to secrets.h (git-ignored) and fill in.
#pragma once

// WiFi backhaul
#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"
#define BACKEND_BATCH_URL "https://example.ngrok-free.app/api/ingest/batch"

// NB-IoT backhaul (SIM7020). The module's HTTP client is used over plain
// HTTP - HTTPS on the SIM7020 needs CA certificates loaded on the module.
// Format: "http://host[:port]/" (trailing slash) + path separately.
#define NBIOT_APN "your-operator-nbiot-apn"
#define NBIOT_BACKEND_BASE "http://example.ngrok-free.app/"
#define NBIOT_BATCH_PATH "/api/ingest/batch"

// Offline SOS Wi-Fi requests go to /api/ingest/sos on the same server. By
// default the gateway takes the batch URL / path above and replaces the
// last part ("batch" -> "sos"); set these only if the server differs.
// #define BACKEND_SOS_URL "https://example.ngrok-free.app/api/ingest/sos"
// #define NBIOT_SOS_PATH "/api/ingest/sos"

// Device key for this gateway, from:
//   node device_keys.js add gateway-1 --nodes NODE-04,NODE-07,NODE-INDB
// Sent as X-Device-Key on every upload (WiFi and NB-IoT). The backend
// refuses readings without a valid key, and readings for nodes the key
// isn't allowed to report for.
#define DEVICE_KEY "paste-the-key-printed-by-device_keys.js"

// Village sirens: the gateway signs every siren command it hands a node
// (sj_auth.h) - a node obeys only commands that carry its own key. 32
// random bytes as 64 hex characters, e.g. from
//   python -c "import secrets;print(secrets.token_hex(32))"
// Without it the gateway passes NO siren commands on (the server keeps
// asking; nodes still have their offline fallback). Each siren node's
// SIREN_CMD_KEY is derived from this and its NODE_ID (the command is in
// the node's secrets.example.h). A new master key means new node keys.
#define SIREN_MASTER_KEY "paste-64-hex-characters-from-the-command-above"
