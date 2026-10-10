// Copy to secrets.h (git-ignored) and fill in. The WiFi / backend lines
// are only used when TRANSPORT == TRANSPORT_WIFI in config.h; a LoRa node
// with a siren (SIREN_PIN) reads only SIREN_CMD_KEY from here.
#pragma once

#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"
// Node.js server batch endpoint, e.g. https://<your-ngrok-domain>/api/ingest/batch
#define BACKEND_BATCH_URL "https://example.ngrok-free.app/api/ingest/batch"
// Device key from: node device_keys.js add <name> --nodes NODE-04
// (sent as X-Device-Key; readings without a valid key are refused)
#define DEVICE_KEY "paste-the-key-printed-by-device_keys.js"

// Village siren over LoRa: this node's key for the siren commands in the
// gateway's ACK (sj_auth.h). Without it (or with a wrong one) the node
// ignores every LoRa siren command - an officer can't sound or silence it -
// but still sounds it itself as the offline fallback. It is derived from
// the gateway's SIREN_MASTER_KEY and THIS node's NODE_ID (config.h), so
// every node has its own. Work it out on a PC (replace MASTER and the id):
//   python -c "import hmac,hashlib;print(hmac.new(bytes.fromhex('MASTER'),b'NODE-04',hashlib.sha256).hexdigest()[:32])"
// Re-do it whenever NODE_ID or the gateway's master key changes.
#define SIREN_CMD_KEY "paste-the-32-hex-characters-printed-above"
