// =====================================================================
// SANJEEVNI - LoRa packet format shared by node and gateway.
// KEEP IDENTICAL in firmware/sanjeevni_lora_node/ and
// firmware/sanjeevni_lora_gateway/ (Arduino can't include across sketch
// folders). tools/firmware_host_test/run_tests.py checks the copies match.
// =====================================================================
#pragma once
// A classic guard as well: the host tests include the node's AND the
// gateway's headers in one program, and #pragma once sees the two
// identical copies as different files.
#ifndef SJ_PACKET_H_
#define SJ_PACKET_H_
#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "sj_auth.h"

#define SJ_MAGIC 0x53  // 'S'
// 2: session widened from 16 to 32 bits (review B: a replacement board or
// an erased NVS restarted the session at 1, so its reading_uids repeated
// the old board's and the backend dropped them as duplicates - a 32-bit
// session that starts at a random value makes that practically impossible).
// 3: a reading also carries the node's own river rate of rise and its
// sensor anomaly checks (8 more bytes, see SjReading). Every packet this
// firmware sends is v3 (readings, SOS messages, ACKs).
// A v3 reading can also carry a NORMAL-mode summary of the samples since
// the previous report (SJ_X_SUMMARY: SjSummary's wire form follows the 64
// bytes, see sjEncodeReading / sjParseReading below) - no new version:
// v3 itself has not been released without it.
// The gateway still accepts and ACKs version-1 and version-2 readings
// (sjReadingFromV1 / sjReadingFromV2), so nodes can be re-flashed one at a
// time AFTER the gateway: a v2 gateway refuses v3 packets (wrong length),
// and a v3 node then gets no ACK and keeps everything queued.
#define SJ_VERSION 3
#define SJ_VERSION_V2 2
#define SJ_VERSION_V1 1
#define SJ_TYPE_READING 1
#define SJ_TYPE_ACK 2
#define SJ_TYPE_ACK_CMD 3  // an ACK that carries a command for the node (SjAckCmd)
#define SJ_TYPE_SOS_MSG 4      // an SOS typed on a node's offline Wi-Fi page (SjSosMsg below)
#define SJ_TYPE_SOS_MSG_ACK 5  // the gateway has stored that SOS (SjAck layout with this type)
#define SJ_NODE_ID_LEN 12          // "NODE-INDB" etc., NUL-padded
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
  // Someone held the SOS button on the node (sj_sos.h) - for people with no
  // phone. Bits 12-15 were unused, so the packet layout and SJ_VERSION stay
  // the same: a gateway with older firmware forwards the reading without
  // the flag (its measurements arrive, the SOS does not) - update gateways
  // before relying on the button. Not a measurement: the reading carries
  // the node's normal sensor values as well.
  SJ_SOS_PRESSED = 1 << 12,
  // Village siren (node sj_siren.h). Bits 13-15 were the last free ones,
  // so again no new SJ_VERSION: an older gateway forwards the reading
  // without them (no siren state, no commands). These were the last free
  // bits: newer per-reading flags go into SjReading.xflags (v3).
  //  FITTED     the node has a siren output (SIREN_PIN) - also tells the
  //             gateway it understands SjAckCmd; older firmware never sets it
  //  ON         the siren is sounding now
  //  BY_COMMAND with ON: an officer / the server switched it on;
  //             without it the node did ("auto_offline", see sj_siren.h)
  SJ_SIREN_FITTED = 1 << 13,
  SJ_SIREN_ON = 1 << 14,
  SJ_SIREN_BY_COMMAND = 1 << 15,
  // Flags that count as a measurement (rain is excluded: the backend
  // can't tell "0 mm" from "no gauge"; battery is telemetry). A reading
  // needs at least one of these or the backend rejects it.
  SJ_MEASUREMENT_FLAGS = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME | SJ_HAS_SOIL | SJ_HAS_TILT |
                         SJ_HAS_PM | SJ_HAS_PH | SJ_HAS_TURBIDITY,
};

// ---- v3: the node's own flash-flood rise rate + sensor anomaly checks ----
// (computed in the node's sj_anomaly.h). The 16 reading flags are all
// used, so these have a byte of their own (SjReading.xflags).
enum : uint8_t {
  SJ_X_RISE_RATE = 1 << 0,  // rise_cm_min_x100 holds the river's rate of rise (water level present)
  SJ_X_FAST_RISE = 1 << 1,  // ...at or above the node's fast-rise limit: the reading went out at once
  // The node sent this reading at once and AHEAD of any queued backlog
  // (node sj_report.h: edge AI WATCH/URGENT, a local threshold, a fast
  // rise, a newly raised anomaly, or an SOS). The gateway forwards it ahead
  // of ITS backlog too (sjIsUrgentReading). Not in the JSON.
  SJ_X_PRIORITY = 1 << 2,
  // An SjSummary follows the 64 bytes on air (and is kept next to the
  // reading in both queues): the samples since the previous report.
  SJ_X_SUMMARY = 1 << 3,
  // bits 4-7: free. Unknown bits are ignored by the gateway and the JSON
  // writer, so a later firmware can use them without a new SJ_VERSION.
};

// The sensor values the anomaly checks watch, by their JSON names (the
// backend's RawReading fields). anomaly[check] has bit (1 << SJ_AF_x) set
// when that check flagged field x.
enum : uint8_t { SJ_AF_WATER = 0, SJ_AF_TEMP, SJ_AF_HUMIDITY, SJ_AF_GAS, SJ_AF_PM25, SJ_AF_TILT, SJ_AF_COUNT };
static const char* const SJ_AF_NAMES[] = {"river_level_m", "temp_c",    "humidity_pct",
                                          "gas_ppm",       "pm25_ugm3", "tilt_angle_deg"};
// The checks, JSON "<check>:<field>" (contract; backend EDGE_ANOMALY_PATTERN).
enum : uint8_t { SJ_AC_STUCK = 0, SJ_AC_SPIKE, SJ_AC_RATE, SJ_AC_DROPOUT, SJ_AC_COUNT };
static const char* const SJ_AC_NAMES[] = {"stuck", "spike", "rate", "dropout"};
#define SJ_AF_ALL ((uint8_t)((1u << SJ_AF_COUNT) - 1))

// 64 bytes - well inside LoRa's 255-byte limit (~460 ms on air at
// SF9/125 kHz, CR 4/7). Fixed-point integers instead of floats/JSON for size.
struct __attribute__((packed)) SjReading {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  char node_id[SJ_NODE_ID_LEN];
  uint32_t session;  // random start per board, +1 on every power-on/reset (sj_session.h)
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
  // ---- v3 (bytes 56..63) ----
  uint8_t xflags;                // SJ_X_*
  int16_t rise_cm_min_x100;      // river rate of rise, cm/min x 100, + = rising (with SJ_X_RISE_RATE)
  uint8_t anomaly[SJ_AC_COUNT];  // per check: (1 << SJ_AF_*) for each field it flagged
  uint8_t tx_state;              // SJ_TX_*: the node's state when it TRANSMITTED this copy (0 = not stamped)
};

// SjReading.tx_state. Everything else in a reading is as MEASURED - a
// backlog reading sent after an outage still says what the siren did
// then. The gateway needs the node's state NOW to decide whether a siren
// command has arrived (sj_siren_cmd.h): the node's sendOne() stamps this
// byte on every transmission. Not in the JSON (the server orders the
// readings by measurement time itself). 0 = an older v3 firmware that
// left the byte 0: the gateway falls back to the flags of fresh readings.
enum : uint8_t {
  SJ_TX_SIREN_ON = 1 << 0,  // the siren is sounding at this transmission
  SJ_TX_VALID = 1 << 7,     // the byte is stamped
};

// ---- the watched fields' fixed point (summary, anomaly checks) ----------
// How each SJ_AF_* field is stored in SjReading: its flag, whether the
// integer is signed, and the divisor / decimals that turn it into the JSON
// value (river_level_m = water_level_mm / 1000 with 3 decimals, ...).
struct SjFieldCodec {
  uint16_t flag;
  uint8_t isSigned;
  uint16_t div;
  uint8_t decimals;
};
static const SjFieldCodec SJ_AF_CODEC[SJ_AF_COUNT] = {
    {SJ_HAS_WATER, 0, 1000, 3}, {SJ_HAS_DHT, 1, 100, 2}, {SJ_HAS_DHT, 0, 100, 2},
    {SJ_HAS_GAS, 0, 1, 0},      {SJ_HAS_PM, 0, 1, 0},    {SJ_HAS_TILT, 1, 100, 2},
};

// Field f of `r` as its packet integer; false = not in this reading.
inline bool sjFieldRaw(const SjReading& r, uint8_t f, int32_t& v) {
  if (f >= SJ_AF_COUNT || !(r.flags & SJ_AF_CODEC[f].flag)) return false;
  switch (f) {
    case SJ_AF_WATER: v = r.water_level_mm; break;
    case SJ_AF_TEMP: v = r.temp_c_x100; break;
    case SJ_AF_HUMIDITY: v = r.humidity_x100; break;
    case SJ_AF_GAS: v = r.gas_ppm; break;
    case SJ_AF_PM25: v = r.pm25; break;
    default: v = r.tilt_deg_x100; break;
  }
  return true;
}

// ---- NORMAL-mode summary (built by the node's sj_report.h) ---------------
// While nothing is wrong a node reports once per NORMAL_REPORT_INTERVAL_MS,
// but it samples every SAMPLE_INTERVAL_MS: the report's top-level values
// are the LATEST sample (so the backend pipeline is unchanged) and this
// summary describes all the samples since the previous report - min / max
// / mean per watched field, how many, over how long, and the highest edge
// verdict among them. A short spike between two reports is no longer
// invisible, at a fraction of the airtime of sending every sample (the
// figures are in the node's sj_report.h).
// Compact: per field the mean in the field's own fixed point, and min /
// max as 8-bit distances below / above it in steps of 2^shift (4-bit shift
// per field). shift is the smallest that fits, so a normal minute (well
// under 255 steps of mm, 0.01 C, 0.01 %, ppm, ug/m3, 0.01 deg) is exact;
// a wider one is rounded OUTWARD - the reported min is never above the
// true min, the reported max never below the true max.
#define SJ_SUMMARY_HEADER_SIZE 8  // offsetof(SjSummary, stat)
#define SJ_SUMMARY_STAT_SIZE 4
#define SJ_SUMMARY_MAX_WIRE (SJ_SUMMARY_HEADER_SIZE + SJ_AF_COUNT * SJ_SUMMARY_STAT_SIZE)  // 32

struct __attribute__((packed)) SjSummaryStat {
  uint16_t mean;  // fixed point as in SjReading (a signed field's int16 bits)
  uint8_t below;  // min = mean - (below << shift)
  uint8_t above;  // max = mean + (above << shift)
};

struct __attribute__((packed)) SjSummary {
  uint8_t samples;    // regular samples summarised (>= 2), saturating at 255
  uint8_t maxEdge;    // highest edge verdict among them: 0..2, or SJ_EDGE_NONE
  uint16_t windowS;   // first to last of those samples, seconds
  uint8_t fields;     // (1 << SJ_AF_*) per field with statistics
  uint8_t shifts[3];  // field f: (shifts[f / 2] >> (4 * (f % 2))) & 15
  SjSummaryStat stat[SJ_AF_COUNT];  // in memory at fixed places; on air only the fields present
};
static_assert(sizeof(SjSummary) == SJ_SUMMARY_MAX_WIRE, "SjSummary layout");

// Content check (the gateway forwards nothing it can't vouch for).
inline bool sjSummaryValid(const SjSummary& s) {
  return s.samples >= 2 && (s.maxEdge <= 2 || s.maxEdge == SJ_EDGE_NONE) && !(s.fields & ~SJ_AF_ALL);
}

inline uint8_t sjSummaryShift(const SjSummary& s, uint8_t f) {
  return (uint8_t)((s.shifts[f / 2] >> (4 * (f % 2))) & 15);
}

// Stores field f's statistics (packet integers, mn <= mean <= mx).
inline void sjSummarySetStat(SjSummary& s, uint8_t f, int32_t mn, int32_t mean, int32_t mx) {
  const uint32_t dBelow = (uint32_t)(mean - mn), dAbove = (uint32_t)(mx - mean);  // <= 65535 each
  uint8_t sh = 0;
  while (sh < 15 && (((dBelow + (1u << sh) - 1) >> sh) > 255 || ((dAbove + (1u << sh) - 1) >> sh) > 255)) sh++;
  s.stat[f].mean = (uint16_t)mean;  // a signed field keeps its int16 bits
  s.stat[f].below = (uint8_t)((dBelow + (1u << sh) - 1) >> sh);  // rounded up: outward
  s.stat[f].above = (uint8_t)((dAbove + (1u << sh) - 1) >> sh);
  s.shifts[f / 2] = (uint8_t)((s.shifts[f / 2] & ~(15u << (4 * (f % 2)))) | ((uint32_t)sh << (4 * (f % 2))));
  s.fields |= (uint8_t)(1u << f);
}

// Field f's min / mean / max as packet integers; false = no statistics.
inline bool sjSummaryRange(const SjSummary& s, uint8_t f, int32_t& mn, int32_t& mean, int32_t& mx) {
  if (f >= SJ_AF_COUNT || !(s.fields & (1u << f))) return false;
  const SjFieldCodec& c = SJ_AF_CODEC[f];
  mean = c.isSigned ? (int32_t)(int16_t)s.stat[f].mean : (int32_t)s.stat[f].mean;
  const uint8_t sh = sjSummaryShift(s, f);
  const int32_t lo = c.isSigned ? -32768 : 0, hi = c.isSigned ? 32767 : 65535;
  mn = mean - ((int32_t)s.stat[f].below << sh);
  mx = mean + ((int32_t)s.stat[f].above << sh);
  if (mn < lo) mn = lo;  // the true value can't be outside the packet's range
  if (mx > hi) mx = hi;
  return true;
}

inline uint8_t sjSummaryFieldCount(uint8_t fields) {
  uint8_t n = 0;
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) n += (fields >> f) & 1u;
  return n;
}

inline size_t sjSummaryWireSize(const SjSummary& s) {
  return SJ_SUMMARY_HEADER_SIZE + SJ_SUMMARY_STAT_SIZE * sjSummaryFieldCount(s.fields);
}

// On air: the 8-byte header, then the statistics of the fields present, in
// SJ_AF_* order (a water-only river node sends 12 bytes, not 32).
inline size_t sjSummaryToWire(const SjSummary& s, uint8_t* out) {
  memcpy(out, &s, SJ_SUMMARY_HEADER_SIZE);
  size_t k = SJ_SUMMARY_HEADER_SIZE;
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
    if (!(s.fields & (1u << f))) continue;
    memcpy(out + k, &s.stat[f], SJ_SUMMARY_STAT_SIZE);
    k += SJ_SUMMARY_STAT_SIZE;
  }
  return k;
}

// false = not a summary of exactly `len` bytes (the content is checked by
// sjSummaryValid).
inline bool sjSummaryFromWire(const uint8_t* in, size_t len, SjSummary& s) {
  memset(&s, 0, sizeof(s));
  if (len < SJ_SUMMARY_HEADER_SIZE) return false;
  memcpy(&s, in, SJ_SUMMARY_HEADER_SIZE);
  if ((s.fields & ~SJ_AF_ALL) || len != sjSummaryWireSize(s)) {
    memset(&s, 0, sizeof(s));
    return false;
  }
  size_t k = SJ_SUMMARY_HEADER_SIZE;
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
    if (!(s.fields & (1u << f))) continue;
    memcpy(&s.stat[f], in + k, SJ_SUMMARY_STAT_SIZE);
    k += SJ_SUMMARY_STAT_SIZE;
  }
  return true;
}

struct __attribute__((packed)) SjAck {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  char node_id[SJ_NODE_ID_LEN];
  uint32_t session;
  uint32_t seq;
};

// ---- commands to a node (downlink) ---------------------------------------
// A node only listens right after it transmits (its ACK window), so a
// command rides on the ACK of one of its own readings: the same 23 bytes
// as SjAck, type SJ_TYPE_ACK_CMD, plus the command. Older node firmware
// accepts only a 23-byte ACK and would take this one for "no ACK" and
// resend forever - so the gateway sends it ONLY in reply to a reading
// flagged SJ_SIREN_FITTED, which only firmware that understands it sets.
// One command per ACK; the gateway keeps it until the node's readings
// show the wanted state (desired-state, see the gateway's sj_siren_cmd.h),
// so a lost ACK only delays it to the next reading.
// AUTHENTICATED: a siren is a physical alarm, and the node id / session /
// seq an ACK must match go out in plain text in the node's own reading.
// The command carries the first SJ_CMD_MAC_LEN bytes of HMAC-SHA256 over
// everything before the MAC, with the node's own key (sj_auth.h). The
// session / seq inside it make a recorded command useless for any other
// reading. A node without a valid key, or a command whose MAC is wrong,
// still counts as the ACK (the reading did arrive), but the command is
// ignored (SjDownlink.refused).
#define SJ_CMD_KEY_LEN 16       // a node's key (secrets.h SIREN_CMD_KEY, 32 hex chars)
#define SJ_CMD_MASTER_LEN 32    // the gateway's key (secrets.h SIREN_MASTER_KEY, 64 hex chars)
#define SJ_CMD_MAC_LEN 8        // 64-bit tag: one forgery try per ACK window - guessing is hopeless
#define SJ_ACK_CMD_V0_SIZE 26   // the first, unauthenticated layout: still an ACK, never a command
enum : uint8_t {
  SJ_CMD_NONE = 0,       // (plain ACK)
  SJ_CMD_SIREN_OFF = 1,  // arg unused
  SJ_CMD_SIREN_ON = 2,   // arg = seconds to sound (the node caps it), 0 = the node's default
};

struct __attribute__((packed)) SjAckCmd {
  uint8_t magic;
  uint8_t version;
  uint8_t type;  // SJ_TYPE_ACK_CMD
  char node_id[SJ_NODE_ID_LEN];
  uint32_t session;
  uint32_t seq;
  uint8_t cmd;   // SJ_CMD_*
  uint16_t arg;
  uint8_t mac[SJ_CMD_MAC_LEN];  // sjCmdMac(): HMAC-SHA256(node key, the 26 bytes above), truncated
};
static_assert(sizeof(SjAckCmd) == SJ_ACK_CMD_V0_SIZE + SJ_CMD_MAC_LEN, "SjAckCmd layout");

struct SjDownlink {
  uint8_t cmd;      // SJ_CMD_*
  uint16_t arg;
  uint8_t refused;  // a command came but was ignored: no key on this node, or the MAC did not match
};

// The node's key: the first 16 bytes of HMAC-SHA256(master, node id
// without its NUL padding). `nodeId`: a NUL-padded SJ_NODE_ID_LEN field.
// The same as the command in secrets.example.h, so a key worked out on a
// PC matches what the gateway computes.
inline void sjSirenNodeKey(const uint8_t master[SJ_CMD_MASTER_LEN], const char* nodeId, uint8_t key[SJ_CMD_KEY_LEN]) {
  uint8_t full[SJ_SHA256_LEN];
  sjHmacSha256(master, SJ_CMD_MASTER_LEN, (const uint8_t*)nodeId, strnlen(nodeId, SJ_NODE_ID_LEN), full);
  memcpy(key, full, SJ_CMD_KEY_LEN);
}

// The MAC of an SjAckCmd: over its bytes before `mac` (header with node
// id / session / seq, command, argument).
inline void sjCmdMac(const uint8_t key[SJ_CMD_KEY_LEN], const SjAckCmd& a, uint8_t mac[SJ_CMD_MAC_LEN]) {
  uint8_t full[SJ_SHA256_LEN];
  sjHmacSha256(key, SJ_CMD_KEY_LEN, (const uint8_t*)&a, offsetof(SjAckCmd, mac), full);
  memcpy(mac, full, SJ_CMD_MAC_LEN);
}

// ---- protocol versions 1 and 2, still understood --------------------------
// A v2 reading is the first 56 bytes of a v3 one (no xflags / rise rate /
// anomaly bytes). A v1 reading is the v2 one with a 2-byte session: bytes
// 0..14 (header + node id) and everything after the session are laid out
// the same.
#define SJ_V2_READING_SIZE 56
#define SJ_V1_READING_SIZE 54
#define SJ_V1_SESSION_OFFSET 15  // offsetof(SjReading, session) in all versions

struct __attribute__((packed)) SjAckV1 {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  char node_id[SJ_NODE_ID_LEN];
  uint16_t session;
  uint32_t seq;
};

inline bool sjIsValidReadingV1(const uint8_t* buf, size_t len) {
  return len == SJ_V1_READING_SIZE && buf[0] == SJ_MAGIC && buf[1] == SJ_VERSION_V1 && buf[2] == SJ_TYPE_READING;
}

// Widens a v1 reading (54 bytes at `v1`) to the current layout. The
// session keeps its value, so its reading_uid ("<session>-<seq>") is the
// same string the old firmware produced - a resend is still a duplicate.
inline SjReading sjReadingFromV1(const uint8_t* v1) {
  SjReading r;
  memset(&r, 0, sizeof(r));  // the v3 bytes: no rise rate, no anomaly
  memcpy(&r, v1, SJ_V1_SESSION_OFFSET);
  uint16_t s16;
  memcpy(&s16, v1 + SJ_V1_SESSION_OFFSET, sizeof(s16));
  r.session = s16;
  memcpy((uint8_t*)&r + SJ_V1_SESSION_OFFSET + sizeof(uint32_t), v1 + SJ_V1_SESSION_OFFSET + sizeof(uint16_t),
         SJ_V1_READING_SIZE - SJ_V1_SESSION_OFFSET - sizeof(uint16_t));
  r.version = SJ_VERSION;
  return r;
}

inline bool sjIsValidReadingV2(const uint8_t* buf, size_t len) {
  return len == SJ_V2_READING_SIZE && buf[0] == SJ_MAGIC && buf[1] == SJ_VERSION_V2 && buf[2] == SJ_TYPE_READING;
}

// Widens a v2 reading (56 bytes at `v2`) to the current layout: same
// values and reading_uid, no rise rate / anomaly (the old node has none).
inline SjReading sjReadingFromV2(const uint8_t* v2) {
  SjReading r;
  memset(&r, 0, sizeof(r));
  memcpy(&r, v2, SJ_V2_READING_SIZE);
  r.version = SJ_VERSION;
  return r;
}

// A reading as an older firmware stored it in its queue / outbox records:
// the 56-byte v2 layout, or a v1 reading in that frame (v1 firmware put
// its 54 bytes there; the queue kept them through the v2 update). false =
// not a reading at all. For SjFileQueue's record upgrade (sj_file_queue.h).
inline bool sjReadingFromStoredV2(const uint8_t* p, SjReading& out) {
  if (p[0] != SJ_MAGIC || p[2] != SJ_TYPE_READING) return false;
  if (p[1] == SJ_VERSION_V2) {
    out = sjReadingFromV2(p);
    return true;
  }
  if (p[1] == SJ_VERSION_V1) {
    out = sjReadingFromV1(p);
    return true;
  }
  return false;
}

// SjFileQueue upgrade (sj_file_queue.h) for a queue record T laid out as
// [reading][the record's own members][summary]. Older firmware stored
//   v2:                [56-byte reading][the same members]
//   v3 before summaries: [64-byte reading][the same members]
// Both reading sizes are multiples of 4, so the members after the reading
// keep their layout and are copied as they are; the summary starts empty.
// Node: QueuedReading; gateway: GatewayQueued.
template <typename T>
inline bool sjUpgradeRecord(const uint8_t* old, uint32_t size, T& out) {
  static_assert(offsetof(T, reading) == 0 && offsetof(T, summary) + sizeof(SjSummary) == sizeof(T),
                "the reading comes first, the summary last");
  const uint32_t rest = (uint32_t)(offsetof(T, summary) - sizeof(SjReading));
  memset(&out, 0, sizeof(out));
  if (size == SJ_V2_READING_SIZE + rest) {
    if (!sjReadingFromStoredV2(old, out.reading)) return false;
    memcpy((uint8_t*)&out + sizeof(SjReading), old + SJ_V2_READING_SIZE, rest);
    return true;
  }
  if (size != sizeof(SjReading) + rest) return false;
  memcpy(&out.reading, old, sizeof(SjReading));
  if (out.reading.magic != SJ_MAGIC || out.reading.version != SJ_VERSION || out.reading.type != SJ_TYPE_READING)
    return false;
  out.reading.xflags &= (uint8_t)~SJ_X_SUMMARY;  // that firmware had none: never claim one
  memcpy((uint8_t*)&out + sizeof(SjReading), old + sizeof(SjReading), rest);
  return true;
}

inline SjAckV1 sjMakeAckV1(const SjReading& r) {
  SjAckV1 a;
  a.magic = SJ_MAGIC;
  a.version = SJ_VERSION_V1;
  a.type = SJ_TYPE_ACK;
  memcpy(a.node_id, r.node_id, SJ_NODE_ID_LEN);
  a.session = (uint16_t)r.session;
  a.seq = r.seq;
  return a;
}

inline bool sjIsValidReading(const uint8_t* buf, size_t len) {
  if (len != sizeof(SjReading)) return false;
  const SjReading* r = (const SjReading*)buf;
  return r->magic == SJ_MAGIC && r->version == SJ_VERSION && r->type == SJ_TYPE_READING;
}

// A node's reading on air: the 64 bytes, then the summary's wire form when
// SJ_X_SUMMARY is set. Returns the length (<= SJ_READING_MAX_PACKET).
#define SJ_READING_MAX_PACKET (sizeof(SjReading) + SJ_SUMMARY_MAX_WIRE)  // 96
inline size_t sjEncodeReading(const SjReading& r, const SjSummary& s, uint8_t* out) {
  memcpy(out, &r, sizeof(SjReading));
  if (!(r.xflags & SJ_X_SUMMARY)) return sizeof(SjReading);
  return sizeof(SjReading) + sjSummaryToWire(s, out + sizeof(SjReading));
}

// Gateway side: a current (v3) reading packet, with its summary if it has
// one (`s` is zeroed otherwise). false = not a v3 reading, or a summary of
// the wrong length. A summary whose content is implausible is dropped
// (flag cleared) and the reading kept - its measurements are fine.
inline bool sjParseReading(const uint8_t* buf, size_t len, SjReading& r, SjSummary& s) {
  memset(&s, 0, sizeof(s));
  if (len < sizeof(SjReading) || !sjIsValidReading(buf, sizeof(SjReading))) return false;
  memcpy(&r, buf, sizeof(r));
  if (!(r.xflags & SJ_X_SUMMARY)) return len == sizeof(SjReading);
  if (!sjSummaryFromWire(buf + sizeof(SjReading), len - sizeof(SjReading), s)) return false;
  if (!sjSummaryValid(s)) {
    r.xflags &= (uint8_t)~SJ_X_SUMMARY;
    memset(&s, 0, sizeof(s));
  }
  return true;
}

// The first 23 bytes of an ACK of `type` for this node / session / seq.
inline bool sjAckIdsMatch(const uint8_t* buf, uint8_t type, const char* nodeId, uint32_t session, uint32_t seq) {
  SjAck a;
  memcpy(&a, buf, sizeof(a));
  return a.magic == SJ_MAGIC && a.version == SJ_VERSION && a.type == type && a.session == session && a.seq == seq &&
         strncmp(a.node_id, nodeId, SJ_NODE_ID_LEN) == 0;
}

// The first 23 bytes of an SjAck or SjAckCmd answer `sent`, with `type`.
inline bool sjAckHeaderMatches(const uint8_t* buf, uint8_t type, const SjReading& sent) {
  return sjAckIdsMatch(buf, type, sent.node_id, sent.session, sent.seq);
}

inline bool sjAckMatches(const uint8_t* buf, size_t len, const SjReading& sent) {
  return len == sizeof(SjAck) && sjAckHeaderMatches(buf, SJ_TYPE_ACK, sent);
}

// Node side: is this packet the gateway's ACK for `sent` - plain or with a
// command? `cmd` is SJ_CMD_NONE unless an SjAckCmd for `sent` came whose
// MAC checks out with `key` (this node's SJ_CMD_KEY_LEN bytes; nullptr =
// no key: every command is refused). A command that fails the check, or
// one in the old 26-byte layout, still makes this the ACK - as a plain
// ACK would (those carry no secret either) - with cmd.refused set.
inline bool sjParseAck(const uint8_t* buf, size_t len, const SjReading& sent, SjDownlink& cmd, const uint8_t* key) {
  cmd.cmd = SJ_CMD_NONE;
  cmd.arg = 0;
  cmd.refused = 0;
  if (sjAckMatches(buf, len, sent)) return true;
  if ((len != sizeof(SjAckCmd) && len != SJ_ACK_CMD_V0_SIZE) || !sjAckHeaderMatches(buf, SJ_TYPE_ACK_CMD, sent))
    return false;
  SjAckCmd a;
  memset(&a, 0, sizeof(a));
  memcpy(&a, buf, len);
  if (a.cmd != SJ_CMD_SIREN_OFF && a.cmd != SJ_CMD_SIREN_ON) return true;  // unknown (newer gateway): just the ACK
  uint8_t mac[SJ_CMD_MAC_LEN];
  if (key) sjCmdMac(key, a, mac);
  if (!key || len != sizeof(SjAckCmd) || !sjSameBytes(mac, a.mac, SJ_CMD_MAC_LEN)) {
    cmd.refused = 1;
    return true;
  }
  cmd.cmd = a.cmd;
  cmd.arg = a.arg;
  return true;
}

// `version`: the protocol version the node sent the reading in - a node only
// accepts an ACK of its own version (the v2 ACK has the same layout).
inline SjAck sjMakeAck(const SjReading& r, uint8_t version = SJ_VERSION) {
  SjAck a;
  a.magic = SJ_MAGIC;
  a.version = version;
  a.type = SJ_TYPE_ACK;
  memcpy(a.node_id, r.node_id, SJ_NODE_ID_LEN);
  a.session = r.session;
  a.seq = r.seq;
  return a;
}

// Gateway side. `key`: the node's key (sjSirenNodeKey).
inline SjAckCmd sjMakeAckCmd(const SjReading& r, const SjDownlink& cmd, const uint8_t key[SJ_CMD_KEY_LEN],
                             uint8_t version = SJ_VERSION) {
  SjAckCmd a;
  SjAck plain = sjMakeAck(r, version);
  memcpy(&a, &plain, sizeof(plain));
  a.type = SJ_TYPE_ACK_CMD;
  a.cmd = cmd.cmd;
  a.arg = cmd.arg;
  sjCmdMac(key, a, a.mac);
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
// link the reading arrived on. `summary`: the record's SjSummary - written
// as "summary" only when the reading is flagged SJ_X_SUMMARY.
inline void sjAppendFixed(String& out, int32_t v, const SjFieldCodec& c) {
  if (c.div == 1) {
    out += String((long)v);
  } else {
    // (unsigned int): ESP32 String(float, unsigned int) - a uint8_t here is
    // ambiguous between the float/double/int constructors on the real core
    out += String(v / (float)c.div, (unsigned int)c.decimals);
  }
}

inline void sjAppendJson(String& out, const SjReading& r, long ageSeconds, int signalDbm, const char* link,
                         const SjSummary* summary = nullptr) {
  char nodeId[SJ_NODE_ID_LEN + 1];
  memcpy(nodeId, r.node_id, SJ_NODE_ID_LEN);
  nodeId[SJ_NODE_ID_LEN] = '\0';

  out += "{\"node_id\":\"";
  out += nodeId;
  out += "\",\"reading_uid\":\"";
  // Plain decimal: up to "4294967295-4294967295" (21 chars). The backend
  // takes any string; it only has to be unique per node_id.
  out += String((unsigned long)r.session) + "-" + String((unsigned long)r.seq);
  out += "\",\"link\":\"";
  out += link;
  out += "\",\"signal_strength_dbm\":";
  out += String(signalDbm);
  if (ageSeconds >= 0) out += ",\"age_seconds\":" + String(ageSeconds);
  // Only when set: the backend treats a missing field as "no SOS".
  if (r.flags & SJ_SOS_PRESSED) out += ",\"sos_button\":true";
  // Siren state as of the measurement, also only when set (contract:
  // omitted = no siren / silent). The server compares it with the state it
  // wants and answers with "commands" (sjParseSirenCommands below).
  if (r.flags & SJ_SIREN_FITTED) {
    out += ",\"siren_fitted\":true";
    if (r.flags & SJ_SIREN_ON) {
      out += ",\"siren_on\":true,\"siren_reason\":\"";
      out += (r.flags & SJ_SIREN_BY_COMMAND) ? "command" : "auto_offline";
      out += "\"";
    }
  }
  // The node's own river rise rate (sj_anomaly.h) - only with a water level,
  // and fast_rise only when set (contract: omitted = false / absent).
  if ((r.xflags & SJ_X_RISE_RATE) && (r.flags & SJ_HAS_WATER)) {
    if (r.xflags & SJ_X_FAST_RISE) out += ",\"fast_rise\":true";
    out += ",\"rise_rate_cm_per_min\":" + String(r.rise_cm_min_x100 / 100.0f, 2);
  }
  // Its anomaly checks, "<check>:<field>" - only known bits, so a damaged
  // or newer packet can't put anything else into the JSON.
  bool anyAnomaly = false;
  for (uint8_t c = 0; c < SJ_AC_COUNT; c++) {
    for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
      if (!(r.anomaly[c] & (1u << f))) continue;
      out += anyAnomaly ? ",\"" : ",\"edge_anomaly\":[\"";
      out += SJ_AC_NAMES[c];
      out += ":";
      out += SJ_AF_NAMES[f];
      out += "\"";
      anyAnomaly = true;
    }
  }
  if (anyAnomaly) out += "]";
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
  // The samples since the previous report (contract "summary"; the
  // top-level values above are the latest of them).
  if (summary && (r.xflags & SJ_X_SUMMARY) && sjSummaryValid(*summary)) {
    out += ",\"summary\":{\"samples\":" + String((unsigned)summary->samples);
    out += ",\"window_s\":" + String((unsigned)summary->windowS);
    if (summary->maxEdge <= 2) {
      out += ",\"max_edge_risk_level\":\"";
      out += SJ_EDGE_NAMES[summary->maxEdge];
      out += "\"";
    }
    for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
      int32_t mn, mean, mx;
      if (!sjSummaryRange(*summary, f, mn, mean, mx)) continue;
      out += ",\"";
      out += SJ_AF_NAMES[f];
      out += "\":{\"min\":";
      sjAppendFixed(out, mn, SJ_AF_CODEC[f]);
      out += ",\"max\":";
      sjAppendFixed(out, mx, SJ_AF_CODEC[f]);
      out += ",\"mean\":";
      sjAppendFixed(out, mean, SJ_AF_CODEC[f]);
      out += "}";
    }
    out += "}";
  }
  out += "}";
}

// ---- siren commands in the server's ingest response --------------------
// The server answers an ingest request with the DESIRED siren state of
// every siren-fitted node in it whose reported state differs:
//   "commands":[{"node_id":"NODE-07","siren":"on","for_s":180}, ...]
// ("off" has no for_s). A node absent from the list is as the server
// wants it. No JSON library on the boards, so this reads just that array:
// keys in any order, other keys skipped, an entry without a valid node_id
// or siren value ignored. It stops at the first thing it can't read and
// keeps what it has - a mangled response must never invent a command.
struct SjSirenCommand {
  char node_id[SJ_NODE_ID_LEN + 1];
  uint8_t on;
  uint16_t forS;  // 0 = not given (the node's default)
};

namespace sjjson {
inline const char* ws(const char* p) {
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  return p;
}
// A string at p (after its opening quote) into out (cap incl. NUL). Returns
// the char after the closing quote, nullptr if unterminated. ok = false if
// it did not fit or had an escape (node ids and "on"/"off" never do).
inline const char* str(const char* p, char* out, size_t cap, bool& ok) {
  size_t n = 0;
  ok = true;
  for (; *p && *p != '"'; p++) {
    if (*p == '\\') {
      ok = false;
      if (!*++p) return nullptr;
      continue;
    }
    if (n + 1 < cap) {
      out[n++] = *p;
    } else {
      ok = false;
    }
  }
  if (cap) out[n] = '\0';
  return *p == '"' ? p + 1 : nullptr;
}
// Skips one value of any type (nested ones included). nullptr = malformed.
inline const char* skip(const char* p) {
  p = ws(p);
  if (*p == '"') {
    char dummy[1];
    bool ok;
    return str(p + 1, dummy, 0, ok);
  }
  if (*p == '{' || *p == '[') {
    int depth = 0;
    for (; *p; p++) {
      if (*p == '"') {
        char dummy[1];
        bool ok;
        p = str(p + 1, dummy, 0, ok);
        if (!p) return nullptr;
        p--;
      } else if (*p == '{' || *p == '[') {
        depth++;
      } else if (*p == '}' || *p == ']') {
        if (--depth == 0) return p + 1;
      }
    }
    return nullptr;
  }
  const char* start = p;
  while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\r' && *p != '\n' && *p != '\t') p++;
  return p == start ? nullptr : p;
}
}  // namespace sjjson

// Fills up to `max` commands from a response body. Returns how many, or -1
// when the body has no "commands" array at all (an older server, or
// nothing to send). `complete` (optional): true only if the array was read
// to its ']' and no valid entry was left out for lack of room - the
// gateway may then take "no command for a node" as "its state is right";
// after a cut-off body it must not (sjSirenApplyAnswer, sj_siren_cmd.h).
inline int sjParseSirenCommands(const char* body, SjSirenCommand* out, int max, bool* complete = nullptr) {
  if (complete) *complete = false;
  const char* p = body;
  for (;;) {  // the key, not the same text inside some string value
    p = strstr(p, "\"commands\"");
    if (!p) return -1;
    if (p == body || p[-1] != '\\') break;
    p++;
  }
  p = sjjson::ws(p + 10);
  if (*p != ':') return -1;
  p = sjjson::ws(p + 1);
  if (*p != '[') return -1;
  p++;
  int n = 0;
  bool dropped = false;
  for (;;) {
    p = sjjson::ws(p);
    if (*p == ',') p = sjjson::ws(p + 1);
    if (*p == ']' && complete) *complete = !dropped;
    if (*p != '{') return n;  // ']' = end, anything else = malformed: keep what we have
    p++;
    SjSirenCommand c;
    memset(&c, 0, sizeof(c));
    bool haveNode = false, haveSiren = false, valid = true;
    for (;;) {
      p = sjjson::ws(p);
      if (*p == ',') p = sjjson::ws(p + 1);
      if (*p == '}') {
        p++;
        break;
      }
      if (*p != '"') return n;
      char key[12];
      bool keyOk;
      p = sjjson::str(p + 1, key, sizeof(key), keyOk);
      if (!p) return n;
      p = sjjson::ws(p);
      if (*p != ':') return n;
      p = sjjson::ws(p + 1);
      if (keyOk && strcmp(key, "node_id") == 0 && *p == '"') {
        bool ok;
        p = sjjson::str(p + 1, c.node_id, sizeof(c.node_id), ok);
        if (!p) return n;
        haveNode = ok && c.node_id[0] != '\0';
        valid &= haveNode;
      } else if (keyOk && strcmp(key, "siren") == 0 && *p == '"') {
        char v[4];
        bool ok;
        p = sjjson::str(p + 1, v, sizeof(v), ok);
        if (!p) return n;
        haveSiren = ok && (strcmp(v, "on") == 0 || strcmp(v, "off") == 0);
        c.on = haveSiren && v[1] == 'n';
        valid &= haveSiren;
      } else if (keyOk && strcmp(key, "for_s") == 0 && *p >= '0' && *p <= '9') {
        uint32_t v = 0;
        for (; *p >= '0' && *p <= '9'; p++) {
          v = v * 10 + (uint32_t)(*p - '0');
          if (v > 65535) v = 65535;  // capped every digit, so it can't overflow
        }
        if (*p == '.') {  // "180.0" - whole seconds are enough
          p++;
          while (*p >= '0' && *p <= '9') p++;
        }
        c.forS = (uint16_t)v;
      } else {
        p = sjjson::skip(p);
        if (!p) return n;
      }
    }
    if (valid && haveNode && haveSiren) {
      if (n < max) {
        out[n++] = c;
      } else {
        dropped = true;
      }
    }
  }
}

// ---- SOS and urgent readings go before the backlog (node and gateway) ---
// Every SOS reading is pushed to the normal flash queue like any reading:
// that copy is the guarantee (it survives a reboot and stays until it is
// acknowledged; the queue's FIFO order and pop rules are untouched). It is
// ALSO copied into this small RAM outbox, which the sender empties BEFORE
// it touches the queue - so after a link outage the SOS goes out first,
// not behind hours of routine readings. An outbox entry leaves only once
// the next hop has it (node: gateway ACK; gateway: a backend answer that
// is final for it, sjUploadAction() DONE / DROP_ONE).
// URGENT readings (SJ_X_PRIORITY: WATCH / URGENT, a fast rise, a new
// anomaly - sjIsUrgentReading) take the same path through a second outbox
// of their own, emptied right after the SOS one: a full urgent outbox lets
// its OLDEST entry fall back to its place in the queue (the newest state
// matters most after an outage), and urgent readings can never push an SOS
// out. Order: SOS readings, then urgent ones, each oldest first; the rest
// of the queue keeps its FIFO order - only copies jump ahead.
// The queued copy of a reading that went ahead is NOT sent again when its
// turn comes: SjSentAhead (below) remembers it and the sender pops it
// unsent. If that memory is lost (reboot, deep sleep, more than it holds)
// the copy goes again - the same reading_uid, which the gateway (recent
// list), the backend and the server (one SOS per reading_uid) ignore as a
// duplicate: one extra packet at worst, never a lost or a second reading.
// T is the queue's record type; it must have a `reading` member.
template <typename T, uint8_t N>
struct SjPriorityOutbox {
  T items[N];
  uint8_t count;  // no initialisers: a plain aggregate, zero as a static

  void clear() { count = 0; }
  bool empty() const { return count == 0; }
  const T& front() const { return items[0]; }

  static bool sameReading(const SjReading& a, const SjReading& b) {
    return a.session == b.session && a.seq == b.seq && strncmp(a.node_id, b.node_id, SJ_NODE_ID_LEN) == 0;
  }

  // false = the outbox was full and its oldest entry made room (that one
  // is still in the flash queue, only no longer ahead of the backlog).
  // The same reading twice (a node resend) is kept once.
  bool add(const T& item) {
    if (count > N) count = 0;  // never trust a corrupted count
    for (uint8_t i = 0; i < count; i++)
      if (sameReading(items[i].reading, item.reading)) return true;
    bool room = count < N;
    if (!room) remove(items[0].reading);
    items[count++] = item;
    return room;
  }

  // By identity, not "pop the front": on the gateway the LoRa task can add
  // entries while the upload of the front one is in flight.
  bool remove(const SjReading& r) {
    for (uint8_t i = 0; i < count; i++) {
      if (!sameReading(items[i].reading, r)) continue;
      for (uint8_t j = i + 1; j < count; j++) items[j - 1] = items[j];
      count--;
      return true;
    }
    return false;
  }
};

// Puts the entries of a saved copy of an outbox back into `outbox`, oldest
// first (the gateway keeps one in NVS: its outbox is RAM, and after a
// reboot an SOS it had ACKed but not forwarded would otherwise wait behind
// up to QUEUE_CAPACITY readings - hours over NB-IoT - while the node, which
// has its ACK, never resends). Only what still looks like a current SOS
// reading is taken, so a copy from another firmware layout or a damaged
// one restores nothing rather than garbage. Returns how many were taken.
template <typename T, uint8_t N>
inline uint8_t sjRestoreOutbox(SjPriorityOutbox<T, N>& outbox, const SjPriorityOutbox<T, N>& saved) {
  if (saved.count > N) return 0;
  uint8_t restored = 0;
  for (uint8_t i = 0; i < saved.count; i++) {
    const SjReading& r = saved.items[i].reading;
    if (r.magic != SJ_MAGIC || r.version != SJ_VERSION || r.type != SJ_TYPE_READING || !(r.flags & SJ_SOS_PRESSED))
      continue;
    outbox.add(saved.items[i]);
    restored++;
  }
  return restored;
}

// Gateway side: does a reading go ahead of the gateway's backlog through
// its urgent outbox? The node's own verdict (SJ_X_PRIORITY - it includes
// local thresholds the gateway can't see), a fast rise, or - for nodes on
// v1 / v2 firmware, which have no xflags - an edge verdict WATCH / URGENT.
// SOS readings have an outbox of their own and are not "urgent" here.
// Only a FRESH one (age_s known and <= maxAgeS when it arrived): after an
// outage a node drains hours of backlog, and its old WATCH / fast-rise
// readings are history, not news. Taken as urgent they pushed a genuinely
// new urgent reading of another node out of the 16-slot outbox and
// overflowed the sent-ahead memory, so queued copies went up twice
// (review). The node also clears SJ_X_PRIORITY on its backlog copies
// (sj_sos.h sjFlushOnce); this test covers v1 / v2 nodes and the
// fast-rise / edge flags, which stay set.
inline bool sjIsUrgentReading(const SjReading& r, uint32_t maxAgeS) {
  if (r.flags & SJ_SOS_PRESSED) return false;
  if (r.age_s == SJ_AGE_UNKNOWN || r.age_s > maxAgeS) return false;
  return (r.xflags & (SJ_X_PRIORITY | SJ_X_FAST_RISE)) || r.edge_risk == 1 || r.edge_risk == 2;
}

// Readings that went ahead of the queue through an outbox and are final at
// the next hop: their queued copies are popped without being sent again
// (see above). A ring: when full, the oldest entry is forgotten - its copy
// is then just sent once more. take() frees the entry once its copy is
// popped, so the ring only holds copies still waiting in the queue.
template <uint8_t M>
struct SjSentAhead {
  struct Id {
    char node_id[SJ_NODE_ID_LEN];
    uint32_t session;
    uint32_t seq;
    uint8_t used;
  };
  Id ids[M];
  uint8_t next;  // no initialisers: a plain aggregate, zero as a static

  void clear() { memset(this, 0, sizeof(*this)); }
  int find(const SjReading& r) const {
    for (uint8_t i = 0; i < M; i++)
      if (ids[i].used && ids[i].seq == r.seq && ids[i].session == r.session &&
          strncmp(ids[i].node_id, r.node_id, SJ_NODE_ID_LEN) == 0)
        return i;
    return -1;
  }
  bool contains(const SjReading& r) const { return find(r) >= 0; }
  void add(const SjReading& r) {
    if (contains(r)) return;
    if (next >= M) next = 0;  // never trust a corrupted index
    Id& e = ids[next];
    memcpy(e.node_id, r.node_id, SJ_NODE_ID_LEN);
    e.session = r.session;
    e.seq = r.seq;
    e.used = 1;
    next = (uint8_t)((next + 1) % M);
  }
  // true = it went ahead: forget it (its queued copy is being popped)
  bool take(const SjReading& r) {
    int i = find(r);
    if (i < 0) return false;
    ids[i].used = 0;
    return true;
  }
  uint8_t count() const {
    uint8_t n = 0;
    for (uint8_t i = 0; i < M; i++) n += ids[i].used;
    return n;
  }
};

// Pops the oldest queued records whose reading already went ahead (in
// `ahead`) - without sending them. Stops at the first one that did not, or
// at a record peek() can't read (the caller's own peek handles that).
// Returns how many were popped.
template <typename T, typename Queue, uint8_t M>
inline uint32_t sjPopSentAhead(Queue& queue, SjSentAhead<M>& ahead) {
  uint32_t popped = 0;
  while (queue.count() > 0) {
    T rec;
    if (!queue.peek(0, rec) || !ahead.take(rec.reading)) break;
    queue.pop(1);
    popped++;
  }
  return popped;
}

// The next batch upload: add(record) for up to `n` of the oldest queued
// records, stopping BEFORE one that already went ahead - that one is then
// popped unsent by the next sjPopSentAhead() instead of riding in a batch.
// Call after sjPopSentAhead() (so record 0 never went ahead). Returns how
// many were added = how many to pop once the upload is final; 0 = a record
// can't be read (peek() may have rebuilt the queue: start over).
template <typename T, typename Queue, uint8_t M, typename AddFn>
inline uint32_t sjCollectBatch(Queue& queue, const SjSentAhead<M>& ahead, uint32_t n, AddFn add) {
  uint32_t k = 0;
  for (; k < n && k < queue.count(); k++) {
    T rec;
    if (!queue.peek(k, rec)) return 0;
    if (k > 0 && ahead.contains(rec.reading)) break;
    add(rec);
  }
  return k;
}

// ---- SOS typed on a node's offline Wi-Fi page (node -> gateway) ---------
// A mains/solar node can run the open "SANJEEVNI-SOS" Wi-Fi (sj_hotspot.h).
// What a person submits there goes to the gateway as this packet: its own
// type, not a reading flag (none are left), so a gateway with older
// firmware ignores it - no ACK, the node keeps retrying. Update gateways
// before enabling SOS_HOTSPOT_ENABLE on nodes.
// Variable length: the 48-byte header and only note_len bytes of the note
// (148 bytes at most, well inside LoRa's 255).
// session / seq: the node's session and a per-session counter of these
// messages, separate from the readings' seq. The ACK has its own type
// (SJ_TYPE_SOS_MSG_ACK), so it can never be taken for a reading's ACK with
// the same numbers. The sos_uid sent to the server is "<session>-h<seq>".
// The gateway's own hotspot builds the same struct (node_id = GATEWAY_ID),
// so one outbox and one JSON writer serve both.
#define SJ_SOS_NOTE_MAX 100       // bytes of UTF-8: ~100 Latin or ~33 Devanagari letters
#define SJ_SOS_CLIENT_LEN 8       // the phone's short id, [A-Za-z0-9_-], NUL-padded
#define SJ_SOS_PEOPLE_MAX 999     // = the server's HOTSPOT_PEOPLE_MAX (a sanity cap)
#define SJ_SOS_MSG_HEADER_SIZE 48 // offsetof(SjSosMsg, note)
#define SJ_SOS_MSG_HAS_POS 0x01   // flags: lat/lon were typed by the person

enum : uint8_t {
  SJ_NEED_TRAPPED = 1 << 0,
  SJ_NEED_INJURED = 1 << 1,
  SJ_NEED_MEDICAL = 1 << 2,
  SJ_NEED_FIRE = 1 << 3,
  SJ_NEEDS_ALL = 0x0F,
};
static const char* const SJ_NEED_NAMES[] = {"trapped", "injured", "medical", "fire"};  // the server's HOTSPOT_NEEDS

struct __attribute__((packed)) SjSosMsg {
  uint8_t magic;
  uint8_t version;
  uint8_t type;  // SJ_TYPE_SOS_MSG
  char node_id[SJ_NODE_ID_LEN];
  uint32_t session;
  uint32_t seq;
  uint32_t age_s;   // seconds since the person sent it, at THIS transmission (SJ_AGE_UNKNOWN)
  uint16_t people;  // 0 = not given
  uint8_t needs;    // SJ_NEED_* bits
  uint8_t flags;    // SJ_SOS_MSG_HAS_POS
  int32_t lat_e6;   // degrees x 1e6, only with SJ_SOS_MSG_HAS_POS
  int32_t lon_e6;
  char client_id[SJ_SOS_CLIENT_LEN];
  uint8_t note_len;  // bytes used in note (no NUL)
  char note[SJ_SOS_NOTE_MAX];
};
static_assert(sizeof(SjSosMsg) == SJ_SOS_MSG_HEADER_SIZE + SJ_SOS_NOTE_MAX, "SjSosMsg layout");

// Letters, digits, '-', '_' (and '.' for node ids: the server's NODE_ID_PATTERN).
inline bool sjIdChar(char c, bool allowDot) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
         (allowDot && c == '.');
}

// A NUL-padded id field: 1+ id characters, then only NULs. These go into
// JSON unescaped, so a packet from a stranger's radio must not carry '"'.
inline bool sjIdFieldOk(const char* f, size_t len, bool allowDot) {
  size_t n = 0;
  while (n < len && f[n]) {
    if (!sjIdChar(f[n], allowDot)) return false;
    n++;
  }
  for (size_t i = n; i < len; i++)
    if (f[i]) return false;
  return n > 0;
}

// Everything the gateway forwards is checked here - the radio is open to anyone.
inline bool sjSosMsgValid(const SjSosMsg& m) {
  if (m.magic != SJ_MAGIC || m.version != SJ_VERSION || m.type != SJ_TYPE_SOS_MSG) return false;
  if (m.note_len > SJ_SOS_NOTE_MAX || m.people > SJ_SOS_PEOPLE_MAX || (m.needs & ~SJ_NEEDS_ALL)) return false;
  if (m.flags & ~SJ_SOS_MSG_HAS_POS) return false;
  if ((m.flags & SJ_SOS_MSG_HAS_POS) &&
      (m.lat_e6 < -90000000 || m.lat_e6 > 90000000 || m.lon_e6 < -180000000 || m.lon_e6 > 180000000))
    return false;
  return sjIdFieldOk(m.node_id, SJ_NODE_ID_LEN, true) && sjIdFieldOk(m.client_id, SJ_SOS_CLIENT_LEN, false);
}

inline size_t sjSosMsgSize(const SjSosMsg& m) {
  return SJ_SOS_MSG_HEADER_SIZE + (m.note_len <= SJ_SOS_NOTE_MAX ? m.note_len : SJ_SOS_NOTE_MAX);
}

// Gateway side: a received packet -> `out` (the unused note bytes zeroed).
inline bool sjParseSosMsg(const uint8_t* buf, size_t len, SjSosMsg& out) {
  if (len < SJ_SOS_MSG_HEADER_SIZE || len > sizeof(SjSosMsg)) return false;
  memset(&out, 0, sizeof(out));
  memcpy(&out, buf, len);
  return out.note_len == len - SJ_SOS_MSG_HEADER_SIZE && sjSosMsgValid(out);
}

inline SjAck sjMakeSosMsgAck(const SjSosMsg& m) {
  SjAck a;
  a.magic = SJ_MAGIC;
  a.version = SJ_VERSION;
  a.type = SJ_TYPE_SOS_MSG_ACK;
  memcpy(a.node_id, m.node_id, SJ_NODE_ID_LEN);
  a.session = m.session;
  a.seq = m.seq;
  return a;
}

// Node side: is this the gateway's ACK for the SOS message `sent`?
inline bool sjSosMsgAckMatches(const uint8_t* buf, size_t len, const SjSosMsg& sent) {
  return len == sizeof(SjAck) && sjAckIdsMatch(buf, SJ_TYPE_SOS_MSG_ACK, sent.node_id, sent.session, sent.seq);
}

// Gateway side: a received reading packet of any version this gateway
// serves -> `r` (widened to v3) and its summary (`s`, zero without one),
// and `ackVersion`, the version to ACK it in (v1 has its own ACK layout,
// SjAckV1). false = not one to store or ACK: noise, another network, a
// damaged packet - or a node id that is not a plain id. The node id goes
// into the JSON unescaped (sjAppendJson), and the radio is open to anyone:
// an id like  X","s":"  would have added keys to the upload or broken the
// whole batch (review).
inline bool sjReceiveReading(const uint8_t* buf, size_t len, SjReading& r, SjSummary& s, uint8_t& ackVersion) {
  memset(&s, 0, sizeof(s));
  if (sjIsValidReadingV1(buf, len)) {
    r = sjReadingFromV1(buf);
    ackVersion = SJ_VERSION_V1;
  } else if (sjIsValidReadingV2(buf, len)) {
    r = sjReadingFromV2(buf);
    ackVersion = SJ_VERSION_V2;
  } else if (sjParseReading(buf, len, r, s)) {
    ackVersion = SJ_VERSION;
  } else {
    return false;
  }
  return sjIdFieldOk(r.node_id, SJ_NODE_ID_LEN, true);
}

#endif  // SJ_PACKET_H_
