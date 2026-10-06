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

// Device key for this gateway, from:
//   node device_keys.js add gateway-1 --nodes NODE-04,NODE-07,NODE-INDB
// Sent as X-Device-Key on every upload (WiFi and NB-IoT). The backend
// refuses readings without a valid key, and readings for nodes the key
// isn't allowed to report for.
#define DEVICE_KEY "paste-the-key-printed-by-device_keys.js"
