// =====================================================================
// SANJEEVNI - LoRa packet format shared by node and gateway.
// KEEP IDENTICAL in firmware/sanjeevni_lora_node/ and
// firmware/sanjeevni_lora_gateway/ (Arduino can't include across sketch
// folders). tools/firmware_host_test/run_tests.py checks the copies match.
// =====================================================================
#pragma once
#include <Arduino.h>
#include <stdint.h>
#include <string.h>

#define SJ_MAGIC 0x53  // 'S'
#define SJ_VERSION 1
#define SJ_TYPE_READING 1
#define SJ_TYPE_ACK 2
#define SJ_NODE_ID_LEN 12           // "NODE-INDB" etc., NUL-padded
#define SJ_AGE_UNKNOWN 0xFFFFFFFFu  // node lost its clock (power cycle) - backend uses receive time
#define SJ_EDGE_NONE 255

// Which optional values a reading carries. A sensor that isn't fitted or
// failed is left out of the JSON entirely instead of being sent as 0 - a
// fake 0 mm rain or pH 0 would look like real data to the backend.
enum : uint16_t {
  SJ_HAS_WATER = 1 << 0,
  SJ_HAS_DHT = 1 << 1,
  SJ_HAS_GAS = 1 << 2,
  SJ_HAS_FLAME = 1 << 3,
  SJ_FLAME_DETECTED = 1 << 4,
  SJ_HAS_RAIN = 1 << 5,
  SJ_HAS_SOIL = 1 << 6,
  SJ_HAS_TILT = 1 << 7,
  SJ_HAS_PM = 1 << 8,
  SJ_HAS_PH = 1 << 9,
  SJ_HAS_TURBIDITY = 1 << 10,
  SJ_HAS_BATTERY = 1 << 11,
  // Flags that count as a measurement (rain is excluded: the backend
  // can't tell "0 mm" from "no gauge"; battery is telemetry). A reading
  // needs at least one of these or the backend rejects it.
  SJ_MEASUREMENT_FLAGS = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME | SJ_HAS_SOIL | SJ_HAS_TILT |
                         SJ_HAS_PM | SJ_HAS_PH | SJ_HAS_TURBIDITY,
};

// 54 bytes - well inside LoRa's 255-byte limit and short on air (~100 ms
// at SF7/125 kHz). Fixed-point integers instead of floats/JSON for size.
struct __attribute__((packed)) SjReading {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  char node_id[SJ_NODE_ID_LEN];
  uint16_t session;  // increments on every power-on/reset of the node
  uint32_t seq;      // increments per reading within a session
  uint32_t age_s;    // seconds between measurement and THIS transmission
  uint16_t flags;
  uint16_t water_level_mm;
  int16_t temp_c_x100;
  uint16_t humidity_x100;
  uint16_t gas_ppm;
  uint16_t rain_mm_x100;  // rain since the previous reading
  uint16_t soil_moisture_x10;
  int16_t tilt_deg_x100;
  uint16_t vibration_g_x1000;
  uint16_t pm25;
  uint16_t pm10;
  uint16_t ph_x100;
  uint16_t turbidity_ntu_x10;
  uint16_t battery_x10;
  uint8_t edge_risk;  // 0 NORMAL, 1 WATCH, 2 URGENT, SJ_EDGE_NONE
};

struct __attribute__((packed)) SjAck {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  char node_id[SJ_NODE_ID_LEN];
  uint16_t session;
  uint32_t seq;
};

inline bool sjIsValidReading(const uint8_t* buf, size_t len) {
  if (len != sizeof(SjReading)) return false;
  const SjReading* r = (const SjReading*)buf;
  return r->magic == SJ_MAGIC && r->version == SJ_VERSION && r->type == SJ_TYPE_READING;
}

inline bool sjAckMatches(const uint8_t* buf, size_t len, const SjReading& sent) {
  if (len != sizeof(SjAck)) return false;
  const SjAck* a = (const SjAck*)buf;
  return a->magic == SJ_MAGIC && a->version == SJ_VERSION && a->type == SJ_TYPE_ACK &&
         a->session == sent.session && a->seq == sent.seq &&
         strncmp(a->node_id, sent.node_id, SJ_NODE_ID_LEN) == 0;
}

inline SjAck sjMakeAck(const SjReading& r) {
  SjAck a;
  a.magic = SJ_MAGIC;
  a.version = SJ_VERSION;
  a.type = SJ_TYPE_ACK;
  memcpy(a.node_id, r.node_id, SJ_NODE_ID_LEN);
  a.session = r.session;
  a.seq = r.seq;
  return a;
}

inline uint16_t sjClampU16(float v) {
  if (v < 0) return 0;
  if (v > 65535) return 65535;
  return (uint16_t)(v + 0.5f);
}

inline int16_t sjClampI16(float v) {
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return (int16_t)(v < 0 ? v - 0.5f : v + 0.5f);
}

static const char* const SJ_EDGE_NAMES[] = {"NORMAL", "WATCH", "URGENT"};

// What to do with queued readings after an upload attempt got `httpCode`
// (negative = no HTTP response at all: no network, DNS, timeout).
// Only a backend verdict that THE READING ITSELF is invalid may delete it.
// Everything else - ngrok offline (404), wrong URL, wrong/revoked device
// key (401/403), rate limit (429), server errors (5xx), no response - keeps
// the readings queued: those are outages or config mistakes, and dropping
// on them is what used to wipe the whole store-and-forward queue.
enum SjUploadAction : uint8_t {
  SJ_UPLOAD_DONE = 0,     // 200: every reading in the request is final (stored/duplicate/rejected)
  SJ_UPLOAD_SPLIT = 1,    // the request as a whole was refused - resend one reading at a time
  SJ_UPLOAD_DROP_ONE = 2, // a single reading was refused as invalid - drop just that one
  SJ_UPLOAD_RETRY = 3,    // keep everything queued, retry later
};

inline SjUploadAction sjUploadAction(int httpCode, uint32_t readingsInRequest) {
  if (httpCode == 200) return SJ_UPLOAD_DONE;
  bool invalidContent = httpCode == 400 || httpCode == 422;  // backend validation errors
  if (invalidContent || httpCode == 413) {                   // 413: request too large
    if (readingsInRequest > 1) return SJ_UPLOAD_SPLIT;
    return invalidContent ? SJ_UPLOAD_DROP_ONE : SJ_UPLOAD_RETRY;
  }
  return SJ_UPLOAD_RETRY;
}

// Appends one reading as the JSON object the backend's /api/ingest/batch
// expects (see backend_server.py RawReading). ageSeconds < 0 = unknown
// (field omitted, backend uses receive time). signalDbm/link describe the
// link the reading arrived on.
inline void sjAppendJson(String& out, const SjReading& r, long ageSeconds, int signalDbm, const char* link) {
  char nodeId[SJ_NODE_ID_LEN + 1];
  memcpy(nodeId, r.node_id, SJ_NODE_ID_LEN);
  nodeId[SJ_NODE_ID_LEN] = '\0';

  out += "{\"node_id\":\"";
  out += nodeId;
  out += "\",\"reading_uid\":\"";
  out += String(r.session) + "-" + String(r.seq);
  out += "\",\"link\":\"";
  out += link;
  out += "\",\"signal_strength_dbm\":";
  out += String(signalDbm);
  if (ageSeconds >= 0) out += ",\"age_seconds\":" + String(ageSeconds);
  // Every sensor is optional (modular nodes) - only when fitted and read successfully
  if (r.flags & SJ_HAS_WATER) out += ",\"river_level_m\":" + String(r.water_level_mm / 1000.0f, 3);
  if (r.flags & SJ_HAS_DHT) {
    out += ",\"temp_c\":" + String(r.temp_c_x100 / 100.0f, 2);
    out += ",\"humidity_pct\":" + String(r.humidity_x100 / 100.0f, 2);
  }
  if (r.flags & SJ_HAS_GAS) out += ",\"gas_ppm\":" + String(r.gas_ppm);
  if (r.flags & SJ_HAS_FLAME) {
    out += ",\"flame_reading\":";
    out += (r.flags & SJ_FLAME_DETECTED) ? "1.0" : "0.0";
  }
  out += ",\"rainfall_mm_since_last\":" + String((r.flags & SJ_HAS_RAIN) ? r.rain_mm_x100 / 100.0f : 0.0f, 2);
  if (r.flags & SJ_HAS_SOIL) out += ",\"soil_moisture_pct\":" + String(r.soil_moisture_x10 / 10.0f, 1);
  if (r.flags & SJ_HAS_TILT) {
    out += ",\"tilt_angle_deg\":" + String(r.tilt_deg_x100 / 100.0f, 2);
    out += ",\"vibration_magnitude\":" + String(r.vibration_g_x1000 / 1000.0f, 3);
  }
  if (r.flags & SJ_HAS_PM) {
    out += ",\"pm25_ugm3\":" + String(r.pm25);
    out += ",\"pm10_ugm3\":" + String(r.pm10);
  }
  if (r.flags & SJ_HAS_PH) out += ",\"water_ph\":" + String(r.ph_x100 / 100.0f, 2);
  if (r.flags & SJ_HAS_TURBIDITY) out += ",\"turbidity_ntu\":" + String(r.turbidity_ntu_x10 / 10.0f, 1);
  if (r.flags & SJ_HAS_BATTERY) out += ",\"battery_pct\":" + String(r.battery_x10 / 10.0f, 1);
  if (r.edge_risk <= 2) {
    out += ",\"edge_risk_level\":\"";
    out += SJ_EDGE_NAMES[r.edge_risk];
    out += "\"";
  }
  out += "}";
}
