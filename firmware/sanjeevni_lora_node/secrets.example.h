// Copy to secrets.h (git-ignored) and fill in. Only used when
// TRANSPORT == TRANSPORT_WIFI in config.h.
#pragma once

#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"
// Node.js server batch endpoint, e.g. https://<your-ngrok-domain>/api/ingest/batch
#define BACKEND_BATCH_URL "https://example.ngrok-free.app/api/ingest/batch"
// Device key from: node device_keys.js add <name> --nodes NODE-04
// (sent as X-Device-Key; readings without a valid key are refused)
#define DEVICE_KEY "paste-the-key-printed-by-device_keys.js"
