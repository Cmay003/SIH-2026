// Tests for smart sending (node sj_report.h): the NORMAL-mode summary
// (aggregation, the compact encoding, the packet and the JSON), what is
// sent at once and ahead of a backlog, the airtime figures quoted in
// sj_report.h, and - node and gateway - urgent readings overtaking a
// 2000-reading backlog after an outage without losing or reordering the
// rest (SjPriorityOutbox / SjSentAhead / sjPopSentAhead / sjCollectBatch in
// sj_packet.h, sjFlushOnce in sj_sos.h). Included by test_firmware_logic.cpp
// after anomaly_tests.h (uses its CHECK, makeReading and anomaly::encode).
#pragma once
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>
#include "../../firmware/sanjeevni_lora_node/sj_report.h"

namespace report {

// The gateway's URGENT_MAX_AGE_S (its config.h can't be included next to the
// node's; run_tests.py checks the gateway uses this value).
const uint32_t GW_URGENT_MAX_AGE_S = 120;

// The node's QueuedReading and the gateway's GatewayQueued, as in the sketches.
struct NRec {
  SjReading reading;
  uint32_t takenAtS;
  SjSummary summary;
};
struct GRec {
  SjReading reading;
  uint32_t rxAtS;
  uint16_t gwSession;
  int16_t rssi;
  SjSummary summary;
};

inline SjReading sample(float waterM, float tempC, float hum, float gas, float pm, float tilt, uint8_t edge = SJ_EDGE_NONE) {
  SjReading r = anomaly::encode(waterM, tempC, hum, gas, pm, tilt);
  std::strncpy(r.node_id, "NODE-07", SJ_NODE_ID_LEN);
  r.edge_risk = edge;
  return r;
}

// Semtech SX127x time on air (ms) at the node's config.h LoRa settings:
// explicit header, CRC on, 8-symbol preamble (RadioLib's default); low data
// rate optimisation only when a symbol lasts 16 ms or more.
inline double airtimeMs(size_t payload) {
  const int sf = LORA_SPREADING_FACTOR;
  const double ts = (double)(1 << sf) / LORA_BANDWIDTH_KHZ;  // ms per symbol
  const int de = ts >= 16.0 ? 1 : 0;
  const int cr = LORA_CODING_RATE - 4;
  double blocks = std::ceil((8.0 * payload - 4.0 * sf + 28 + 16) / (4.0 * (sf - 2 * de)));
  double n = 8 + std::max(blocks * (cr + 4), 0.0);
  return (8 + 4.25) * ts + n * ts;
}

inline bool near(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

// ---- the compact summary: exact when narrow, outward when wide ----------------
inline void codecTests() {
  CHECK(sizeof(SjSummary) == 32 && SJ_SUMMARY_MAX_WIRE == 32 && SJ_READING_MAX_PACKET == 96);
  CHECK(sizeof(NRec) == 100 && sizeof(GRec) == 104);  // the queue records (config.h figures)

  SjSummary s;
  std::memset(&s, 0, sizeof(s));
  sjSummarySetStat(s, SJ_AF_WATER, 1180, 1200, 1230);  // mm: a normal minute
  int32_t mn, mean, mx;
  CHECK(sjSummaryRange(s, SJ_AF_WATER, mn, mean, mx) && mn == 1180 && mean == 1200 && mx == 1230);
  CHECK(sjSummaryShift(s, SJ_AF_WATER) == 0);
  sjSummarySetStat(s, SJ_AF_TEMP, -1520, -1490, -1400);  // -15.2 .. -14.0 C: signed
  CHECK(sjSummaryRange(s, SJ_AF_TEMP, mn, mean, mx) && mn == -1520 && mean == -1490 && mx == -1400);
  CHECK(!sjSummaryRange(s, SJ_AF_GAS, mn, mean, mx));  // not set
  // a smoke puff: PM2.5 20 -> 900 within the minute, mean 95: needs a shift
  sjSummarySetStat(s, SJ_AF_PM25, 20, 95, 900);
  CHECK(sjSummaryShift(s, SJ_AF_PM25) == 2);
  CHECK(sjSummaryRange(s, SJ_AF_PM25, mn, mean, mx) && mean == 95 && mn <= 20 && mn > 20 - 4 && mx >= 900 && mx < 904);
  // the extremes of each type: clamped to what the packet can hold
  sjSummarySetStat(s, SJ_AF_HUMIDITY, 0, 0, 65535);
  CHECK(sjSummaryRange(s, SJ_AF_HUMIDITY, mn, mean, mx) && mn == 0 && mean == 0 && mx == 65535);
  sjSummarySetStat(s, SJ_AF_TILT, -32768, 0, 32767);
  CHECK(sjSummaryRange(s, SJ_AF_TILT, mn, mean, mx) && mn == -32768 && mean == 0 && mx == 32767);
  // the nibbles of neighbouring fields don't disturb each other
  CHECK(sjSummaryRange(s, SJ_AF_WATER, mn, mean, mx) && mn == 1180 && mx == 1230);
  CHECK(sjSummaryRange(s, SJ_AF_TEMP, mn, mean, mx) && mn == -1520 && mx == -1400);

  // random ranges: the mean exact, the range never narrower, at most one step wider
  uint32_t seed = 12345;
  auto rnd = [&](uint32_t m) {
    seed = seed * 1664525u + 1013904223u;
    return (seed >> 8) % m;
  };
  bool allGood = true;
  for (int i = 0; i < 20000; i++) {
    uint8_t f = (uint8_t)rnd(SJ_AF_COUNT);
    bool sgn = SJ_AF_CODEC[f].isSigned;
    int32_t lo = sgn ? -32768 : 0;
    int32_t span = (int32_t)rnd(i % 3 == 0 ? 65536 : (i % 3 == 1 ? 600 : 40));
    int32_t a = lo + (int32_t)rnd((uint32_t)(65536 - span));
    int32_t b = a + span;
    int32_t m = a + (span ? (int32_t)rnd((uint32_t)span + 1) : 0);
    SjSummary t;
    std::memset(&t, 0, sizeof(t));
    sjSummarySetStat(t, f, a, m, b);
    int32_t dmn, dmean, dmx;
    uint32_t step = 1u << sjSummaryShift(t, f);
    allGood &= sjSummaryRange(t, f, dmn, dmean, dmx) && dmean == m && dmn <= a && dmx >= b &&
               (uint32_t)(a - dmn) < step && (uint32_t)(dmx - b) < step;
    allGood &= std::max(m - a, b - m) > 255 || (sjSummaryShift(t, f) == 0 && dmn == a && dmx == b);  // exact
  }
  CHECK(allGood);

  // wire form: only the fields present travel
  SjSummary full;
  std::memset(&full, 0, sizeof(full));
  full.samples = 12;
  full.maxEdge = 1;
  full.windowS = 55;
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) sjSummarySetStat(full, f, 100 + f, 200 + f, 300 + f);
  uint8_t wire[SJ_SUMMARY_MAX_WIRE];
  CHECK(sjSummaryToWire(full, wire) == 32 && sjSummaryWireSize(full) == 32);
  SjSummary back;
  CHECK(sjSummaryFromWire(wire, 32, back) && std::memcmp(&back, &full, sizeof(full)) == 0);
  CHECK(!sjSummaryFromWire(wire, 31, back) && !sjSummaryFromWire(wire, 33, back) && back.fields == 0);
  SjSummary waterOnly;
  std::memset(&waterOnly, 0, sizeof(waterOnly));
  waterOnly.samples = 12;
  waterOnly.maxEdge = SJ_EDGE_NONE;
  sjSummarySetStat(waterOnly, SJ_AF_WATER, 1000, 1010, 1020);
  CHECK(sjSummaryToWire(waterOnly, wire) == 12);
  CHECK(sjSummaryFromWire(wire, 12, back) && sjSummaryRange(back, SJ_AF_WATER, mn, mean, mx) && mean == 1010);
  CHECK(!sjSummaryRange(back, SJ_AF_TEMP, mn, mean, mx));
  wire[4] |= 0x80;  // an unknown field bit: refused, never misread
  CHECK(!sjSummaryFromWire(wire, 12, back));

  // content checks
  CHECK(sjSummaryValid(full) && sjSummaryValid(waterOnly));
  SjSummary bad = full;
  bad.samples = 1;
  CHECK(!sjSummaryValid(bad));
  bad = full;
  bad.maxEdge = 3;
  CHECK(!sjSummaryValid(bad));
  bad = full;
  bad.fields |= 0x40;
  CHECK(!sjSummaryValid(bad));
}

// ---- the packet: 64 bytes, + the summary when flagged ----------------------
inline void packetTests() {
  SjReading r = sample(1.2f, 25, 60, 410, 20, 0.1f, 0);
  r.session = 5;
  r.seq = 9;
  SjSummary s;
  std::memset(&s, 0, sizeof(s));
  s.samples = 12;
  s.maxEdge = 0;
  s.windowS = 55;
  sjSummarySetStat(s, SJ_AF_WATER, 1195, 1200, 1210);
  sjSummarySetStat(s, SJ_AF_GAS, 400, 410, 431);
  uint8_t pkt[SJ_READING_MAX_PACKET];
  CHECK(sjEncodeReading(r, s, pkt) == 64);  // no flag: the summary stays home
  SjReading got;
  SjSummary gs;
  CHECK(sjParseReading(pkt, 64, got, gs) && std::memcmp(&got, &r, sizeof(r)) == 0 && gs.samples == 0);
  CHECK(sjIsValidReading(pkt, 64));
  r.xflags |= SJ_X_SUMMARY;
  size_t len = sjEncodeReading(r, s, pkt);
  CHECK(len == 64 + 8 + 2 * 4);
  CHECK(!sjIsValidReading(pkt, len));  // an older (pre-summary) v3 gateway would refuse it: update gateways first
  CHECK(sjParseReading(pkt, len, got, gs) && std::memcmp(&got, &r, sizeof(r)) == 0 &&
        std::memcmp(&gs, &s, sizeof(s)) == 0);
  CHECK(!sjParseReading(pkt, len - 1, got, gs) && !sjParseReading(pkt, len + 4, got, gs));
  CHECK(!sjParseReading(pkt, 64, got, gs));  // the flag without its summary: not one of ours
  // implausible content: the reading is kept, the summary dropped
  SjSummary one = s;
  one.samples = 1;
  len = sjEncodeReading(r, one, pkt);
  CHECK(sjParseReading(pkt, len, got, gs) && !(got.xflags & SJ_X_SUMMARY) && gs.samples == 0 &&
        got.water_level_mm == r.water_level_mm);
  // every reading still fits LoRa's 255 bytes and the gateway's receive buffer
  CHECK(SJ_READING_MAX_PACKET <= sizeof(SjSosMsg));
  // the ACK is the reading's, whatever followed it
  SjAck a = sjMakeAck(r);
  CHECK(sjAckMatches((uint8_t*)&a, sizeof(a), got));
}

// ---- the accumulator ----------------------------------------------------------
inline void accumulatorTests() {
  SjSummaryAcc a;
  sjSummaryReset(a);
  SjSummary s;
  CHECK(!sjSummaryBuild(a, s));  // nothing yet
  sjSummaryAdd(a, sample(1.200f, 25.0f, 60, 410, 20, 0.10f), 1000);
  CHECK(!sjSummaryBuild(a, s));  // one sample: the report itself says it all
  // 12 samples, 5 s apart; the DHT fails on two of them; one has an edge verdict
  for (int i = 1; i < 12; i++) {
    float t = (i == 4 || i == 8) ? NAN : 25.0f + 0.1f * i;
    sjSummaryAdd(a, sample(1.200f + 0.001f * i, t, 60, (float)(410 - i), 20, -0.10f * i, i == 6 ? 1 : SJ_EDGE_NONE),
                 1000 + 5000u * i);
  }
  CHECK(sjSummaryBuild(a, s) && s.samples == 12 && s.windowS == 55 && s.maxEdge == 1);
  int32_t mn, mean, mx;
  CHECK(sjSummaryRange(s, SJ_AF_WATER, mn, mean, mx) && mn == 1200 && mx == 1211 && mean == 1206);  // 1205.5 -> 1206
  CHECK(sjSummaryRange(s, SJ_AF_TEMP, mn, mean, mx) && mn == 2500 && mx == 2610);  // 10 values, no NaN
  CHECK(sjSummaryRange(s, SJ_AF_GAS, mn, mean, mx) && mn == 399 && mx == 410 && mean == 405);  // 404.5 -> 405
  CHECK(sjSummaryRange(s, SJ_AF_TILT, mn, mean, mx) && mn == -110 && mx == 10 && mean == -54);  // -54.17
  CHECK(s.fields == SJ_AF_ALL);
  // a negative mean rounds half away from zero, like the packet's own values
  sjSummaryReset(a);
  sjSummaryAdd(a, sample(NAN, -0.01f, 50, NAN, NAN, NAN), 0);
  sjSummaryAdd(a, sample(NAN, -0.02f, 50, NAN, NAN, NAN), 5000);
  CHECK(sjSummaryBuild(a, s) && sjSummaryRange(s, SJ_AF_TEMP, mn, mean, mx) && mean == -2 && mn == -2 && mx == -1);
  CHECK(s.maxEdge == SJ_EDGE_NONE);
  // a window across the millis() wrap
  sjSummaryReset(a);
  sjSummaryAdd(a, sample(1, NAN, NAN, NAN, NAN, NAN), 0xFFFFFFFFu - 20000);
  sjSummaryAdd(a, sample(1, NAN, NAN, NAN, NAN, NAN), 34999);
  CHECK(sjSummaryBuild(a, s) && s.windowS == 55);
  // only fields the summary covers: a soil-only node has nothing to summarise
  sjSummaryReset(a);
  SjReading soil = sample(NAN, NAN, NAN, NAN, NAN, NAN);
  soil.flags = SJ_HAS_SOIL;
  sjSummaryAdd(a, soil, 0);
  sjSummaryAdd(a, soil, 5000);
  CHECK(!sjSummaryBuild(a, s));
  // more than 255 samples (a long interval): counted to 255, statistics exact
  sjSummaryReset(a);
  for (int i = 0; i < 300; i++) sjSummaryAdd(a, sample(NAN, NAN, NAN, (float)(i % 2 ? 500 : 400), NAN, NAN), 1000u * i);
  CHECK(sjSummaryBuild(a, s) && s.samples == 255 && sjSummaryRange(s, SJ_AF_GAS, mn, mean, mx) && mean == 450);
}

// ---- what goes when -------------------------------------------------------------
inline void planTests() {
  auto plan = [](bool regular, bool measured, bool sos, bool siren, bool elevated, bool anomaly, bool interval) {
    return sjPlanReport({regular, measured, sos, siren, elevated, anomaly, interval});
  };
  SjReportPlan p = plan(true, true, false, false, false, false, false);
  CHECK(!p.send && !p.priority && !p.summary);  // a quiet sample between reports: summarised later
  p = plan(true, true, false, false, false, false, true);
  CHECK(p.send && !p.priority && p.summary);  // the report: latest sample + summary
  p = plan(true, true, false, false, true, false, false);
  CHECK(p.send && p.priority && p.summary);  // WATCH / URGENT / local limit / fast rise: now, first
  p = plan(true, true, false, false, false, true, false);
  CHECK(p.send && p.priority && p.summary);  // a new anomaly: now, first
  p = plan(true, true, false, true, false, false, false);
  CHECK(p.send && !p.priority && p.summary);  // a siren change: now, but no alarm
  p = plan(false, true, false, true, false, false, false);
  CHECK(p.send && !p.priority && !p.summary);  // ...from an extra sample: the window goes on
  p = plan(true, true, true, false, false, false, false);
  CHECK(p.send && p.priority && !p.summary);  // SOS: never carries the window
  p = plan(false, false, true, false, false, false, false);
  CHECK(p.send && p.priority && !p.summary);  // SOS with nothing measured still goes
  p = plan(true, false, false, false, true, true, true);
  CHECK(!p.send);  // nothing measured, no SOS: nothing to send

  uint8_t prev[SJ_AC_COUNT] = {0, 0, 0, 0}, now[SJ_AC_COUNT] = {0, 0, 0, 0};
  CHECK(!sjNewAnomaly(prev, now));
  now[SJ_AC_STUCK] = 1u << SJ_AF_GAS;
  CHECK(sjNewAnomaly(prev, now));
  prev[SJ_AC_STUCK] = 1u << SJ_AF_GAS;
  CHECK(!sjNewAnomaly(prev, now));  // still stuck: not news
  now[SJ_AC_SPIKE] = 1u << SJ_AF_GAS;
  CHECK(sjNewAnomaly(prev, now));  // another check on the same field is
  std::memset(now, 0, sizeof(now));
  CHECK(!sjNewAnomaly(prev, now));  // cleared: not news either
}

// ---- an hour of NORMAL operation: the sj_report.h figures ------------------------
// The node's loop() for regular samples (no edge model: all NORMAL). Returns
// the reports' on-air bytes; `peakSeen` = the largest PM2.5 max in a summary.
struct HourResult {
  int reports = 0, withSummary = 0, priority = 0;
  size_t bytes = 0;
  double airMs = 0;
  int32_t peakPm = 0;
  std::vector<std::string> json;
};

inline HourResult runHour(bool waterOnly, int samples, bool pmPuff, uint32_t intervalMs = SIREN_REPORT_INTERVAL_MS) {
  HourResult res;
  SjSummaryAcc acc;
  sjSummaryReset(acc);
  uint32_t lastReport = 0;
  bool any = false;
  for (int i = 0; i < samples; i++) {
    uint32_t now = 7000 + (uint32_t)i * SAMPLE_INTERVAL_MS;
    float noise = (float)((i * 7) % 5) - 2;  // -2..2
    float pm = pmPuff && i == 30 ? 280 : 18 + noise;  // one 5-s smoke puff between two reports
    SjReading r = waterOnly ? sample(1.2f + noise / 1000, NAN, NAN, NAN, NAN, NAN, 0)
                            : sample(1.2f + noise / 1000, 25 + noise / 10, 60 + noise, 410 + noise * 3, pm,
                                     0.1f + noise / 100, 0);
    sjSummaryAdd(acc, r, now);
    SjReportPlan p = sjPlanReport({true, true, false, false, false, false,
                                   now - lastReport >= intervalMs || !any});
    if (!p.send) continue;
    NRec q;
    std::memset(&q, 0, sizeof(q));
    if (p.summary && sjSummaryBuild(acc, q.summary)) r.xflags |= SJ_X_SUMMARY;
    q.reading = r;
    sjSummaryReset(acc);
    lastReport = now;
    any = true;
    if (i == 0) continue;  // the first report after power-on: the hour starts after it
    uint8_t pkt[SJ_READING_MAX_PACKET];
    size_t len = sjEncodeReading(q.reading, q.summary, pkt);
    res.reports++;
    res.withSummary += (r.xflags & SJ_X_SUMMARY) ? 1 : 0;
    res.priority += p.priority;
    res.bytes += len;
    res.airMs += airtimeMs(len) + airtimeMs(sizeof(SjAck));
    int32_t mn, mean, mx;
    if (sjSummaryRange(q.summary, SJ_AF_PM25, mn, mean, mx)) res.peakPm = std::max(res.peakPm, mx);
    if (res.json.size() < 2) {
      String js;
      sjAppendJson(js, q.reading, 3, -90, "lora", &q.summary);
      res.json.push_back(js.c_str());
    }
  }
  return res;
}

inline void airtimeTests() {
  // per packet (the sj_report.h figures, ms)
  CHECK(near(airtimeMs(64), 513.0, 0.05) && near(airtimeMs(23), 255.0, 0.05));
  CHECK(near(airtimeMs(96), 713.7, 0.05) && near(airtimeMs(76), 599.0, 0.05));
  CHECK(sizeof(SjAck) == 23 && sizeof(SjReading) + 8 + 6 * 4 == 96 && sizeof(SjReading) + 8 + 4 == 76);

  // an hour: 720 samples after the first report
  HourResult full = runHour(false, 721, false);
  CHECK(full.reports == 60 && full.withSummary == 60 && full.priority == 0);
  CHECK(full.bytes == 5760 && near(full.airMs / 1000, 58.1, 0.05));
  HourResult water = runHour(true, 721, false);
  CHECK(water.reports == 60 && water.bytes == 4560 && near(water.airMs / 1000, 51.2, 0.05));
  const double rawS = 720 * (airtimeMs(64) + airtimeMs(23)) / 1000, oldS = 60 * (airtimeMs(64) + airtimeMs(23)) / 1000;
  CHECK(near(rawS, 553.0, 0.05) && near(oldS, 46.1, 0.05));
  CHECK(720 * 64 == 46080 && 60 * 64 == 3840);
  CHECK(46080 - 5760 == 40320 && near(rawS - full.airMs / 1000, 494.8, 0.05));  // saved vs every sample
  CHECK(5760 - 3840 == 1920 && near(full.airMs / 1000 - oldS, 12.0, 0.05));   // cost vs the old heartbeat
  CHECK(std::lround(100 * (1 - full.airMs / 1000 / rawS)) == 89 && std::lround(100 * (full.airMs / 1000 / oldS - 1)) == 26);

  // what it buys: a 5-s smoke puff between two reports reaches the backend
  HourResult puff = runHour(false, 721, true);
  CHECK(puff.peakPm == 280 && puff.reports == 60 && puff.bytes == 5760);
  CHECK(!puff.json.empty() && std::strstr(puff.json[0].c_str(), ",\"summary\":{\"samples\":12,\"window_s\":55,"));
}

// ---- the node's own loop: urgent at once, anomalies once, quiet = summaries -----
// Regular samples through the real checks (sj_anomaly.h) and the plan.
struct NodeSim {
  SjEdgeTrack t;
  SjEdgeConfig c;
  SjSummaryAcc acc;
  uint32_t lastReport = 0;
  bool any = false;
  uint32_t nowMs = 1000;
  uint32_t intervalMs;
  int sent = 0, priority = 0, summaries = 0;
  SjSummary lastSummary;  // the summary of the last report that had one
  explicit NodeSim(uint32_t interval = SIREN_REPORT_INTERVAL_MS) : intervalMs(interval) {
    std::memset(&lastSummary, 0, sizeof(lastSummary));
    c = anomaly::shippedConfig(false, anomaly::RIVER_MOUNT_M);
    sjEdgeBegin(t);
    sjSummaryReset(acc);
  }
  // returns the plan for this sample
  SjReportPlan step(const SjReading& in) {
    SjReading r = in;
    uint8_t before[SJ_AC_COUNT];
    std::memcpy(before, sjEdgeLast(t).anomaly, sizeof(before));
    SjSample s;
    sjSampleFromReading(r, 0, s);
    SjEdgeResult e;
    sjEdgeSample(t, s, nowMs, c, e);
    sjEdgeStamp(r, e);
    sjSummaryAdd(acc, r, nowMs);
    bool elevated = (r.xflags & SJ_X_FAST_RISE) != 0;  // values stay under the LOCAL_* limits here
    SjReportPlan p = sjPlanReport({true, true, false, false, elevated, sjNewAnomaly(before, r.anomaly),
                                   nowMs - lastReport >= intervalMs || !any});
    if (p.send) {
      SjSummary sum;
      if (p.summary && sjSummaryBuild(acc, sum)) {
        summaries++;
        lastSummary = sum;
      }
      sjSummaryReset(acc);
      lastReport = nowMs;
      any = true;
      sent++;
      priority += p.priority;
    }
    nowMs += SAMPLE_INTERVAL_MS;
    return p;
  }
};

inline void nodeLoopTests() {
  // 30 quiet minutes: one report a minute, each with its summary, none urgent
  {
    NodeSim n;
    for (int i = 0; i < 360; i++)
      n.step(sample(1.5f + 0.002f * ((i * 3) % 5), 25 + 0.1f * (i % 3), 60, 410 + (i % 7), 18, 0.1f + 0.01f * (i % 2)));
    CHECK(n.sent == 30 && n.priority == 0 && n.summaries == 29);  // the first report has nothing before it
  }
  // a tilt spike (2.9 deg: under LOCAL_TILT_LIMIT_DEG, but a jump) goes at once, once
  {
    NodeSim n;
    for (int i = 0; i < 100; i++) n.step(sample(1.5f, 25, 60, 410, 18, 0.1f + 0.01f * (i % 2)));
    int sentBefore = n.sent;
    SjReportPlan p = n.step(sample(1.5f, 25, 60, 410, 18, 3.0f));
    CHECK(p.send && p.priority && n.sent == sentBefore + 1);
    p = n.step(sample(1.5f, 25, 60, 410, 18, 0.1f));
    CHECK(!p.priority);  // back to normal: summarised with the next report
  }
  // a gas sensor frozen for 30 min: flagged stuck - sent at once ONCE, not every 5 s
  {
    NodeSim n;
    int stuckReports = 0, stuckPriority = 0;
    for (int i = 0; i < 480; i++) {
      SjReportPlan p = n.step(sample(1.5f + 0.001f * (i % 3), 25 + 0.1f * (i % 2), 60, 412, 18, 0.1f + 0.01f * (i % 2)));
      if (p.send && (sjEdgeLast(n.t).anomaly[SJ_AC_STUCK] & (1u << SJ_AF_GAS))) {
        stuckReports++;
        stuckPriority += p.priority;
      }
    }
    CHECK(stuckPriority == 1 && stuckReports > 5);  // later ones ride with the minute reports
  }
  // a flash flood: every sample of the fast rise goes at once
  {
    NodeSim n;
    for (int i = 0; i < 60; i++) n.step(sample(1.5f, 25, 60, 410, 18, 0.1f));
    int fast = 0, fastSent = 0;
    for (int i = 1; i <= 60; i++) {  // 2 cm/min for 5 min
      SjReportPlan p = n.step(sample(1.5f + 0.02f * i * SAMPLE_INTERVAL_MS / 60000.0f, 25, 60, 410, 18, 0.1f));
      if (sjEdgeLast(n.t).fastRise) {
        fast++;
        fastSent += p.send && p.priority;
      }
    }
    CHECK(fast > 30 && fastSent == fast);
  }
}

// ---- decision 2026-10-09: 5-min summaries on a node without a siren -------------
// (config.h NO_SIREN_REPORT_INTERVAL_MS; a siren node stays at 1 min - that
// config.h refuses a siren node at 300 s is checked by run_tests.py, which
// compiles config.h with the overrides and expects the static_assert.)
inline void fiveMinuteTests() {
  CHECK(SIREN_REPORT_INTERVAL_MS <= 60000UL && NO_SIREN_REPORT_INTERVAL_MS == 300000UL);
  CHECK(NORMAL_REPORT_INTERVAL_MS == (SIREN_PIN >= 0 ? SIREN_REPORT_INTERVAL_MS : NO_SIREN_REPORT_INTERVAL_MS));
  // RAM: running min / max / sum per field - the same 96 bytes for 60 samples as for 12
  CHECK(sizeof(SjSummaryAcc) == 96);

  // one 5-min window: 60 samples, 295 s first to last, statistics exact
  {
    SjSummaryAcc a;
    sjSummaryReset(a);
    for (int i = 0; i < 60; i++)
      sjSummaryAdd(a, sample(1.200f + 0.001f * (i % 10), NAN, NAN, (float)(400 + 10 * i), NAN, NAN, i == 41 ? 1 : 0),
                   1000 + 5000u * i);
    SjSummary s;
    CHECK(sjSummaryBuild(a, s) && s.samples == 60 && s.windowS == 295 && s.maxEdge == 1);
    int32_t mn, mean, mx;
    CHECK(sjSummaryRange(s, SJ_AF_WATER, mn, mean, mx) && mn == 1200 && mx == 1209 && mean == 1205);  // 1204.5
    // gas 400 .. 990 ppm over 5 min: wider than 255 steps around the mean - the
    // mean stays exact, min / max are rounded OUTWARD, never inward
    CHECK(sjSummaryRange(s, SJ_AF_GAS, mn, mean, mx) && mean == 695 && mn <= 400 && mn > 398 && mx >= 990 && mx < 992);
    CHECK(sjSummaryShift(s, SJ_AF_GAS) == 1);
  }

  // an hour at 5 min (the sj_report.h table), same method as the 1-min rows
  HourResult one = runHour(false, 721, false, SIREN_REPORT_INTERVAL_MS);
  HourResult full = runHour(false, 721, false, NO_SIREN_REPORT_INTERVAL_MS);
  CHECK(full.reports == 12 && full.withSummary == 12 && full.priority == 0);
  CHECK(full.bytes == 12 * 96 && full.bytes == 1152 && near(full.airMs / 1000, 11.6, 0.05));
  HourResult water = runHour(true, 721, false, NO_SIREN_REPORT_INTERVAL_MS);
  HourResult waterOne = runHour(true, 721, false, SIREN_REPORT_INTERVAL_MS);
  CHECK(water.reports == 12 && water.bytes == 912 && near(water.airMs / 1000, 10.2, 0.05));
  const double oldS = 60 * (airtimeMs(64) + airtimeMs(23)) / 1000;
  CHECK(std::lround(100 * (1 - full.airMs / one.airMs)) == 80 && std::lround(100 * (1 - full.airMs / 1000 / oldS)) == 75);
  CHECK(std::lround(100 * (1 - water.airMs / waterOne.airMs)) == 80 &&
        std::lround(100 * (1 - water.airMs / 1000 / oldS)) == 78);
  // every sample still reaches the backend: a 5-s smoke puff inside a 5-min window
  HourResult puff = runHour(false, 721, true, NO_SIREN_REPORT_INTERVAL_MS);
  CHECK(puff.peakPm == 280 && puff.reports == 12 && puff.bytes == 1152);
  CHECK(!puff.json.empty() && std::strstr(puff.json[0].c_str(), ",\"summary\":{\"samples\":60,\"window_s\":295,"));

  // 30 quiet minutes: 6 reports, each (after the power-on one) summarising 60 samples
  {
    NodeSim n(NO_SIREN_REPORT_INTERVAL_MS);
    for (int i = 0; i < 360; i++)
      n.step(sample(1.5f + 0.002f * ((i * 3) % 5), 25 + 0.1f * (i % 3), 60, 410 + (i % 7), 18, 0.1f + 0.01f * (i % 2)));
    CHECK(n.sent == 6 && n.priority == 0 && n.summaries == 5 && n.lastSummary.samples == 60);
  }
  // urgent mid-window: sent at the very sample, ahead of the backlog, carrying
  // the 2 min summarised so far; the next quiet report 5 min after it
  {
    NodeSim n(NO_SIREN_REPORT_INTERVAL_MS);
    for (int i = 0; i < 25; i++) n.step(sample(1.5f, 25, 60, 410, 18, 0.1f + 0.01f * (i % 2)));
    CHECK(n.sent == 1);  // only the power-on report so far
    SjReportPlan p = n.step(sample(1.5f, 25, 60, 410, 18, 3.0f));  // tilt jump: a new anomaly
    CHECK(p.send && p.priority && p.summary && n.sent == 2 && n.lastSummary.samples == 25 &&
          n.lastSummary.windowS == 120);
    int quietSteps = 0, urgentAfter = 0;
    while (n.sent == 2 && quietSteps < 200) {
      p = n.step(sample(1.5f, 25, 60, 410, 18, 0.1f + 0.01f * (quietSteps % 2)));
      quietSteps++;
      urgentAfter += p.priority;
    }
    CHECK(quietSteps == 60 && urgentAfter == 0 && !p.priority && n.lastSummary.samples == 60);
  }
  // a flash flood on a 5-min node: every fast-rise sample goes at once, as at 1 min
  {
    NodeSim n(NO_SIREN_REPORT_INTERVAL_MS);
    for (int i = 0; i < 60; i++) n.step(sample(1.5f, 25, 60, 410, 18, 0.1f));
    int fast = 0, fastSent = 0, firstFast = -1;
    for (int i = 1; i <= 60; i++) {  // 2 cm/min for 5 min
      SjReportPlan p = n.step(sample(1.5f + 0.02f * i * SAMPLE_INTERVAL_MS / 60000.0f, 25, 60, 410, 18, 0.1f));
      if (sjEdgeLast(n.t).fastRise) {
        if (firstFast < 0) firstFast = i;
        fast++;
        fastSent += p.send && p.priority;
      }
    }
    CHECK(fast > 30 && fastSent == fast && firstFast > 0 && firstFast * SAMPLE_INTERVAL_MS < 180000UL);
  }
}

// ---- node: urgent readings overtake a 2000-reading backlog ----------------------
inline void nodeOutageTests() {
  SjFileQueue<NRec> q;
  CHECK(q.begin("/rep_node.bin", "/rep_node.hdr", QUEUE_CAPACITY));
  q.clear();
  SjPriorityOutbox<NRec, 2> sosOut = {};
  SjPriorityOutbox<NRec, URGENT_OUTBOX_SLOTS> urgOut = {};
  SjSentAhead<SENT_AHEAD_SLOTS> ahead = {};
  uint32_t seq = 0;
  std::set<uint32_t> urgentSeqs, routineSeqs;
  auto push = [&](bool urgent, bool sos) {
    NRec r;
    std::memset(&r, 0, sizeof(r));
    r.reading = makeReading("NODE-07", 5, ++seq);
    r.reading.flags = SJ_HAS_WATER | (sos ? SJ_SOS_PRESSED : 0);
    if (urgent || sos) r.reading.xflags |= SJ_X_PRIORITY;
    r.takenAtS = seq;
    CHECK(q.push(r));  // the flash copy: the guarantee
    if (sos) {
      sosOut.add(r);
    } else if (urgent) {
      urgOut.add(r);
      urgentSeqs.insert(seq);
    } else {
      routineSeqs.insert(seq);
    }
    return seq;
  };
  // the gateway out of reach for hours: 2000 readings, every 50th urgent
  for (int i = 1; i <= 2000; i++) push(i % 50 == 0, false);
  CHECK(q.count() == 2000 && q.dropped() == 0 && urgOut.count == URGENT_OUTBOX_SLOTS);

  std::vector<uint32_t> gw;  // what the gateway stored, in order
  std::map<uint32_t, bool> arrivedPriority;  // seq -> SJ_X_PRIORITY on its first arrival
  bool linkUp = false;
  uint32_t lcg = 99;
  int lost = 0, ackLost = 0;
  auto send = [&](NRec& r) {
    if (!linkUp) return false;
    lcg = lcg * 1103515245u + 12345u;
    uint32_t roll = (lcg >> 16) % 100;
    if (roll < 3) {  // the packet never arrived
      lost++;
      return false;
    }
    gw.push_back(r.reading.seq);
    arrivedPriority.emplace((uint32_t)r.reading.seq, (r.reading.xflags & SJ_X_PRIORITY) != 0);
    if (roll < 6) {  // it arrived, its ACK did not: the node resends (a duplicate)
      ackLost++;
      return false;
    }
    return true;
  };
  auto never = [] { return false; };
  auto noop = [](const NRec&) {};
  CHECK(sjFlushOnce(q, sosOut, urgOut, ahead, MAX_SENDS_PER_FLUSH, send, never, noop) == SJ_FLUSH_NO_ACK);
  CHECK(q.count() == 2000 && urgOut.count == URGENT_OUTBOX_SLOTS && gw.empty());

  // link back. While the backlog drains, the node keeps sampling: a routine
  // reading every flush, an urgent one every 4th, and one SOS.
  linkUp = true;
  struct Late {
    uint32_t seq;
    size_t gwAt;  // gw.size() when it was queued
  };
  std::vector<Late> lateUrgent;
  Late sosLate = {0, 0};
  int flushes = 0;
  while ((q.count() > 0 || !urgOut.empty() || !sosOut.empty()) && flushes < 5000) {
    sjFlushOnce(q, sosOut, urgOut, ahead, MAX_SENDS_PER_FLUSH, send, never, noop);
    flushes++;
    // what the node measures meanwhile - once the full queue has room (a push
    // into the full ring overwrites the oldest, its documented behaviour
    // during a very long outage - queue_tests.h)
    if (flushes <= 200 && q.count() + 2 <= QUEUE_CAPACITY) {
      push(false, false);
      if (flushes % 4 == 0) lateUrgent.push_back({push(true, false), gw.size()});
      if (flushes == 77) sosLate = {push(false, true), gw.size()};
    }
  }
  CHECK(flushes < 5000 && q.count() == 0 && q.dropped() == 0 && ahead.count() == 0 && lateUrgent.size() > 20);

  // 1. the newest URGENT_OUTBOX_SLOTS urgent readings of the outage went first, oldest of them first
  std::vector<uint32_t> firstSent;
  std::set<uint32_t> seen;
  std::map<uint32_t, size_t> pos;  // first arrival
  for (size_t i = 0; i < gw.size(); i++) {
    if (seen.insert(gw[i]).second) {
      firstSent.push_back(gw[i]);
      pos[gw[i]] = i;
    }
  }
  bool newestFirst = firstSent.size() > URGENT_OUTBOX_SLOTS;
  for (uint32_t k = 0; newestFirst && k < URGENT_OUTBOX_SLOTS; k++)
    newestFirst = firstSent[k] == 2000 - 50 * (URGENT_OUTBOX_SLOTS - 1 - k);
  CHECK(newestFirst);
  // 2. no reading lost: every one arrived; duplicates only where an ACK was lost
  CHECK(seen.size() == seq);
  for (uint32_t s = 1; s <= seq; s++) CHECK(seen.count(s) == 1);
  CHECK(gw.size() - seen.size() <= (size_t)ackLost && lost > 0 && ackLost > 0);
  // 3. the rest kept its order: routine readings (and the urgent ones that
  //    fell back to the queue) arrive oldest first
  uint32_t last = 0;
  bool fifo = true;
  for (uint32_t s : firstSent) {
    bool wentAhead = urgentSeqs.count(s) && (s > 2000 - 50 * URGENT_OUTBOX_SLOTS || s > 2000);
    if (wentAhead || s == sosLate.seq) continue;
    fifo &= s > last;
    last = s;
  }
  CHECK(fifo);
  // 4. urgent readings measured during the drain overtake what is still queued
  bool overtook = !lateUrgent.empty();
  for (const Late& u : lateUrgent) {
    size_t p = pos[u.seq];
    // the next routine reading to arrive after it was queued came after it
    for (size_t i = u.gwAt; i < gw.size(); i++) {
      if (routineSeqs.count(gw[i]) && gw[i] < u.seq && pos[gw[i]] == i) {
        overtook &= p < i;
        break;
      }
    }
  }
  CHECK(overtook);
  // 5. the SOS went before everything else queued after it was pressed
  CHECK(sosLate.seq != 0 && pos[sosLate.seq] == sosLate.gwAt);
  // 6. review: an urgent reading that fell back to the queue (its outbox
  //    entry made room for a newer one) arrives as BACKLOG - no
  //    SJ_X_PRIORITY on air - so the gateway does not push it ahead again;
  //    the ones that went ahead carry it. The flash records keep the flag.
  int fellBack = 0, fellBackPriority = 0, wentFirst = 0, wentFirstPriority = 0;
  for (uint32_t s : urgentSeqs) {
    bool wentAhead = s > 2000 - 50 * URGENT_OUTBOX_SLOTS;
    if (s > 2000) continue;  // measured during the drain: either way, depending on timing
    (wentAhead ? wentFirst : fellBack)++;
    (wentAhead ? wentFirstPriority : fellBackPriority) += arrivedPriority[s];
  }
  CHECK(fellBack == 40 - URGENT_OUTBOX_SLOTS && fellBackPriority == 0);
  CHECK(wentFirst == URGENT_OUTBOX_SLOTS && wentFirstPriority == wentFirst);
  CHECK(arrivedPriority[sosLate.seq]);  // an SOS goes from its outbox, flagged
}

// ---- gateway: the same through its queue to the backend -------------------------
// The forwarding task's order (sanjeevni_lora_gateway.ino forwardQueue):
// SOS readings alone, urgent ones batched, then the queue - with the shared
// pieces the sketch uses (sjIsUrgentReading, the outboxes, SjSentAhead,
// sjPopSentAhead, sjCollectBatch, sjUploadAction).
inline void gatewayOutageTests() {
  SjFileQueue<GRec> q;
  CHECK(q.begin("/rep_gw.bin", "/rep_gw.hdr", 4000));
  q.clear();
  SjPriorityOutbox<GRec, 4> sosOut = {};
  SjPriorityOutbox<GRec, 16> urgOut = {};
  SjSentAhead<96> ahead = {};
  const char* nodes[] = {"NODE-01", "NODE-02", "NODE-03", "NODE-04", "NODE-05"};
  std::map<std::string, int> uidKind;  // reading_uid key -> 0 routine, 1 urgent, 2 SOS
  uint32_t n = 0;
  auto receive = [&](int kind, int style = 0) {  // what handleLoraPacket() does with a stored packet
    GRec g;
    std::memset(&g, 0, sizeof(g));
    const char* node = nodes[n % 5];
    g.reading = makeReading(node, 7, ++n);
    g.reading.flags = SJ_HAS_WATER | (kind == 2 ? SJ_SOS_PRESSED : 0);
    if (kind == 1) {
      if (style == 0) g.reading.xflags = SJ_X_PRIORITY;  // a v3 node's verdict
      if (style == 1) g.reading.xflags = SJ_X_FAST_RISE;
      if (style == 2) g.reading.edge_risk = 2;           // a v2 node on URGENT (no xflags)
    }
    if (kind == 0 && n % 3 == 0) g.reading.edge_risk = 0;  // NORMAL verdicts are routine
    CHECK(q.push(g));
    if (g.reading.flags & SJ_SOS_PRESSED) {
      sosOut.add(g);
    } else if (sjIsUrgentReading(g.reading, GW_URGENT_MAX_AGE_S)) {
      urgOut.add(g);
    }
    uidKind[std::string(node) + "/" + std::to_string(n)] = kind;
  };
  // backhaul down: 2000 readings from 5 nodes, 30 of them urgent, 2 SOS
  for (int i = 1; i <= 2000; i++) receive(i % 67 == 0 ? 1 : (i == 500 || i == 1500) ? 2 : 0, i % 3);
  CHECK(q.count() == 2000 && sosOut.count == 2 && urgOut.count == 16);

  std::vector<std::string> backend;  // reading_uids in arrival order
  int requests = 0;
  auto post = [&](const std::vector<GRec>& batch) {
    requests++;
    for (const GRec& g : batch) {
      char node[SJ_NODE_ID_LEN + 1] = {0};
      std::memcpy(node, g.reading.node_id, SJ_NODE_ID_LEN);
      backend.push_back(std::string(node) + "/" + std::to_string(g.reading.seq));
    }
    return 200;
  };
  const uint32_t maxBatch = 20;  // WIFI_MAX_BATCH
  bool urgentSingle = false;
  int steps = 0;
  while ((q.count() > 0 || !sosOut.empty() || !urgOut.empty()) && steps < 2000) {
    steps++;
    if (!sosOut.empty()) {  // forwardSos
      GRec g = sosOut.front();
      if (sjUploadAction(post({g}), 1) == SJ_UPLOAD_RETRY) continue;
      sosOut.remove(g.reading);
      ahead.add(g.reading);
      continue;
    }
    if (!urgOut.empty()) {  // forwardUrgent
      uint8_t k = urgOut.count;
      if (urgentSingle && k > 1) k = 1;
      if (k > maxBatch) k = (uint8_t)maxBatch;
      std::vector<GRec> batch(urgOut.items, urgOut.items + k);
      SjUploadAction a = sjUploadAction(post(batch), k);
      if (a == SJ_UPLOAD_RETRY) continue;
      if (a == SJ_UPLOAD_SPLIT) {
        urgentSingle = true;
        continue;
      }
      for (const GRec& g : batch) {
        urgOut.remove(g.reading);
        ahead.add(g.reading);
      }
      continue;
    }
    sjPopSentAhead<GRec>(q, ahead);  // forwardQueue
    if (q.count() == 0) continue;
    std::vector<GRec> batch;
    uint32_t k = sjCollectBatch<GRec>(q, ahead, std::min<uint32_t>(q.count(), maxBatch),
                                      [&](const GRec& g) { batch.push_back(g); });
    CHECK(k == batch.size() && k > 0);
    if (sjUploadAction(post(batch), k) == SJ_UPLOAD_DONE) q.pop(k);
    if (steps == 10) receive(1, 0);  // an urgent reading arrives during the drain
  }
  CHECK(q.count() == 0 && steps < 2000 && ahead.count() == 0);
  // SOS first, then the 16 newest urgent readings, in one request
  CHECK(backend.size() >= 18 && uidKind[backend[0]] == 2 && uidKind[backend[1]] == 2);
  bool urgentNext = true;
  for (int i = 2; i < 18; i++) urgentNext &= uidKind[backend[i]] == 1;
  // ~100 batches of 20; a batch also ends before a copy that went ahead
  CHECK(urgentNext && requests < 2000 / 20 + 40);
  // every reading exactly once - no lost, no duplicate upload
  std::set<std::string> uniq(backend.begin(), backend.end());
  CHECK(uniq.size() == backend.size() && uniq.size() == n);
  // the urgent reading that arrived mid-drain overtook the rest of the backlog
  size_t latePos = 0, lastRoutine = 0;
  uint32_t lastSeq = 0;
  bool fifo = true;
  for (size_t i = 0; i < backend.size(); i++) {
    uint32_t s = (uint32_t)std::stoul(backend[i].substr(backend[i].find('/') + 1));
    if (uidKind[backend[i]] == 1 && s > 2000) latePos = i;
    if (uidKind[backend[i]] == 0) {
      fifo &= s > lastSeq;
      lastSeq = s;
      lastRoutine = i;
    }
  }
  CHECK(fifo && latePos > 0 && latePos < lastRoutine);
}

// ---- the queue helpers on their own -----------------------------------------------
inline void helperTests() {
  SjSentAhead<4> ahead = {};
  SjReading a = makeReading("NODE-07", 1, 1), b = makeReading("NODE-07", 1, 2), other = makeReading("NODE-08", 1, 1);
  ahead.add(a);
  ahead.add(a);
  CHECK(ahead.count() == 1 && ahead.contains(a) && !ahead.contains(b) && !ahead.contains(other));
  CHECK(ahead.take(a) && !ahead.take(a) && ahead.count() == 0);
  for (uint32_t i = 1; i <= 6; i++) ahead.add(makeReading("NODE-07", 2, i));  // full: the oldest forgotten
  CHECK(ahead.count() == 4 && !ahead.contains(makeReading("NODE-07", 2, 1)) && ahead.contains(makeReading("NODE-07", 2, 6)));
  ahead.next = 200;  // a corrupted index never writes past the ring
  ahead.add(b);
  CHECK(ahead.contains(b));

  SjFileQueue<NRec> q;
  CHECK(q.begin("/rep_help.bin", "/rep_help.hdr", 50));
  q.clear();
  for (uint32_t i = 1; i <= 10; i++) {
    NRec r;
    std::memset(&r, 0, sizeof(r));
    r.reading = makeReading("NODE-07", 3, i);
    CHECK(q.push(r));
  }
  SjSentAhead<8> sa = {};
  sa.add(makeReading("NODE-07", 3, 1));
  sa.add(makeReading("NODE-07", 3, 2));
  sa.add(makeReading("NODE-07", 3, 5));
  CHECK(sjPopSentAhead<NRec>(q, sa) == 2 && q.count() == 8);  // the leading two, unsent
  std::vector<uint32_t> got;
  uint32_t k = sjCollectBatch<NRec>(q, sa, 6, [&](const NRec& r) { got.push_back(r.reading.seq); });
  CHECK(k == 2 && got.size() == 2 && got[0] == 3 && got[1] == 4);  // stops before 5
  q.pop(k);
  CHECK(sjPopSentAhead<NRec>(q, sa) == 1 && sa.count() == 0);
  got.clear();
  CHECK(sjCollectBatch<NRec>(q, sa, 20, [&](const NRec& r) { got.push_back(r.reading.seq); }) == 5 && got.back() == 10);
  sa.add(makeReading("NODE-07", 3, 7));  // right behind the head: a batch of one
  got.clear();
  CHECK(sjCollectBatch<NRec>(q, sa, 20, [&](const NRec& r) { got.push_back(r.reading.seq); }) == 1 && got[0] == 6);
  CHECK(sjCollectBatch<NRec>(q, sa, 0, [&](const NRec&) {}) == 0);
  // the gateway's view of "urgent"
  const uint32_t A = GW_URGENT_MAX_AGE_S;
  SjReading u = makeReading("NODE-07", 1, 1);
  CHECK(!sjIsUrgentReading(u, A));
  u.edge_risk = 0;
  CHECK(!sjIsUrgentReading(u, A));
  u.edge_risk = 1;
  CHECK(sjIsUrgentReading(u, A));
  u.edge_risk = SJ_EDGE_NONE;
  u.xflags = SJ_X_SUMMARY | SJ_X_RISE_RATE;
  CHECK(!sjIsUrgentReading(u, A));
  u.xflags |= SJ_X_PRIORITY;
  CHECK(sjIsUrgentReading(u, A));
  // review: only while fresh - a node's backlog of old WATCH / fast-rise /
  // priority readings after an outage is history, not news
  u.age_s = A;
  CHECK(sjIsUrgentReading(u, A));
  u.age_s = A + 1;
  CHECK(!sjIsUrgentReading(u, A));
  u.age_s = SJ_AGE_UNKNOWN;  // from before the node's reboot
  CHECK(!sjIsUrgentReading(u, A));
  u.xflags = SJ_X_FAST_RISE | SJ_X_RISE_RATE;
  u.age_s = 3 * 3600;
  CHECK(!sjIsUrgentReading(u, A));
  u.age_s = 5;
  CHECK(sjIsUrgentReading(u, A));
  u.flags |= SJ_SOS_PRESSED;
  CHECK(!sjIsUrgentReading(u, A));  // the SOS outbox's business
}

// ---- review: a stranger's packet must not inject JSON through its node id -----------
// The gateway writes the node id into the upload unescaped (sjAppendJson);
// sjReceiveReading() refuses (and the gateway never ACKs) any reading
// whose id is not a plain id - in every protocol version it serves.
inline void receiveIdTests() {
  auto packet = [](const char* id, uint8_t version, std::vector<uint8_t>& out) {
    SjReading r = makeReading("NODE-07", 9, 3);
    std::memset(r.node_id, 0, SJ_NODE_ID_LEN);
    std::memcpy(r.node_id, id, std::min<size_t>(std::strlen(id), SJ_NODE_ID_LEN));
    r.flags = SJ_HAS_WATER;
    r.water_level_mm = 1500;
    out.assign((uint8_t*)&r, (uint8_t*)&r + sizeof(r));
    if (version == SJ_VERSION_V2) {
      out.resize(SJ_V2_READING_SIZE);
      out[1] = SJ_VERSION_V2;
    } else if (version == SJ_VERSION_V1) {  // v1: 16-bit session at the same place
      std::vector<uint8_t> v1(out.begin(), out.begin() + SJ_V1_SESSION_OFFSET);
      uint16_t s16 = 9;
      v1.insert(v1.end(), (uint8_t*)&s16, (uint8_t*)&s16 + 2);
      v1.insert(v1.end(), out.begin() + SJ_V1_SESSION_OFFSET + 4, out.begin() + SJ_V2_READING_SIZE);
      v1[1] = SJ_VERSION_V1;
      out = v1;
    }
  };
  std::vector<uint8_t> p;
  SjReading r;
  SjSummary s;
  uint8_t v = 0;
  for (uint8_t version : {(uint8_t)SJ_VERSION, (uint8_t)SJ_VERSION_V2, (uint8_t)SJ_VERSION_V1}) {
    packet("NODE-INDB.12", version, p);
    CHECK(sjReceiveReading(p.data(), p.size(), r, s, v) && v == version);
    for (const char* bad : {"X\",\"s\":\"", "NODE\"07", "NODE 07", "NODE\\07", "", "<b>"}) {
      packet(bad, version, p);
      CHECK(!sjReceiveReading(p.data(), p.size(), r, s, v));
    }
    packet("NODE-07", version, p);
    p[3 + 8] = 'x';  // garbage after the NUL padding
    CHECK(!sjReceiveReading(p.data(), p.size(), r, s, v));
  }
  // what it guards: the injected id would have produced valid JSON with an extra key
  SjReading evil = makeReading("NODE-07", 9, 3);
  std::memcpy(evil.node_id, "X\",\"s\":\"", 9);
  evil.flags = SJ_HAS_WATER;
  String js;
  sjAppendJson(js, evil, 1, -90, "lora");
  CHECK(std::strstr(js.c_str(), "{\"node_id\":\"X\",\"s\":\"\""));
  CHECK(!sjReceiveReading((uint8_t*)&evil, sizeof(evil), r, s, v));
  // noise is still noise
  uint8_t junk[64] = {0x53, 3, 1};
  CHECK(!sjReceiveReading(junk, sizeof(junk), r, s, v));
}

// ---- review: the gateway after an outage of the NODE-gateway link ----------------
// Five nodes come back at once and drain hours of backlog; the stale
// WATCH / fast-rise readings in it must not fill the urgent outbox and
// push out a genuinely new urgent reading of another node.
inline void staleUrgentTests() {
  SjPriorityOutbox<GRec, 16> urgOut = {};
  uint32_t n = 0;
  int urgentAdded = 0;
  auto arrive = [&](const char* node, uint32_t ageS, uint8_t xflags, uint8_t edge) {
    GRec g;
    std::memset(&g, 0, sizeof(g));
    g.reading = makeReading(node, 9, ++n);
    g.reading.flags = SJ_HAS_WATER;
    g.reading.age_s = ageS;
    g.reading.xflags = xflags;
    g.reading.edge_risk = edge;
    if (sjIsUrgentReading(g.reading, GW_URGENT_MAX_AGE_S)) {
      urgOut.add(g);
      urgentAdded++;
    }
    return n;
  };
  // the backlog: 500 old readings, a third of them WATCH or fast-rise (as v3 nodes send them -
  // their own PRIORITY bit is already cleared on backlog copies - and as v2 nodes do, edge only)
  const char* nodes[] = {"NODE-01", "NODE-02", "NODE-03", "NODE-04", "NODE-05"};
  uint32_t fresh = 0;
  for (int i = 0; i < 500; i++) {
    uint8_t x = i % 3 == 0 ? (uint8_t)(SJ_X_FAST_RISE | SJ_X_RISE_RATE) : 0;
    uint8_t e = i % 3 == 1 ? 1 : 0;
    arrive(nodes[i % 5], 7200 - i * 10, x, e);
    if (i == 250) fresh = arrive("NODE-09", 3, SJ_X_PRIORITY, 2);  // a NEW urgent reading mid-drain
  }
  CHECK(urgentAdded == 1 && urgOut.count == 1 && urgOut.items[0].reading.seq == fresh);
}

// ---- review: a refused SOS must not hold back the readings ------------------------
// forwardQueue()'s order and parking rule (sj_forward.h), driven like the
// sketch drives it, with a server that refuses the gateway's own SOS
// requests (403: GATEWAY_ID missing from its device key).
inline void forwardPassTests() {
  CHECK(sjForwardStep(true, false, true, false, true, true) == SJ_FWD_SOS);
  CHECK(sjForwardStep(true, true, true, false, true, true) == SJ_FWD_SOS_MSG);
  CHECK(sjForwardStep(false, false, true, true, true, true) == SJ_FWD_URGENT);
  CHECK(sjForwardStep(false, false, true, true, false, true) == SJ_FWD_BACKLOG);
  CHECK(sjForwardStep(true, true, true, true, false, false) == SJ_FWD_IDLE);
  CHECK(sjSosRetryParks(403) && sjSosRetryParks(401) && sjSosRetryParks(429) && sjSosRetryParks(503) &&
        sjSosRetryParks(404));
  CHECK(!sjSosRetryParks(-1) && !sjSosRetryParks(-11) && !sjSosRetryParks(0));

  struct World {
    int sosMsgs = 1, sosReadings = 1, urgent = 3, backlog = 95;  // waiting
    int msgAttempts = 0, sosAttempts = 0, readingRequests = 0, readingsUp = 0;
    int msgCode = 403, sosCode = 403, readingCode = 200;  // the server's answers
  };
  // one forwardQueue() pass; returns how it ended
  auto pass = [](World& w) {
    bool sosParked = false, msgParked = false;
    for (int guard = 0; guard < 1000; guard++) {
      SjFwdStep step = sjForwardStep(w.sosReadings > 0, sosParked, w.sosMsgs > 0, msgParked, w.urgent > 0, w.backlog > 0);
      if (step == SJ_FWD_IDLE) return;
      if (step == SJ_FWD_SOS) {
        w.sosAttempts++;
        if (sjUploadAction(w.sosCode, 1) == SJ_UPLOAD_RETRY) {
          sosParked = sjSosRetryParks(w.sosCode);
          if (!sosParked) return;
          continue;
        }
        w.sosReadings--;
        continue;
      }
      if (step == SJ_FWD_SOS_MSG) {
        w.msgAttempts++;
        if (sjUploadAction(w.msgCode, 1) == SJ_UPLOAD_RETRY) {
          msgParked = sjSosRetryParks(w.msgCode);
          if (!msgParked) return;
          continue;
        }
        w.sosMsgs--;
        continue;
      }
      int k = step == SJ_FWD_URGENT ? w.urgent : std::min(w.backlog, 20);
      w.readingRequests++;
      if (sjUploadAction(w.readingCode, (uint32_t)k) != SJ_UPLOAD_DONE) return;
      (step == SJ_FWD_URGENT ? w.urgent : w.backlog) -= k;
      w.readingsUp += k;
    }
    CHECK(false);  // a pass always ends
  };
  // the reviewer's case: the SOS request (and a node SOS) refused with 403 -
  // tried once each, kept, and every reading still goes in the same pass
  World w;
  pass(w);
  CHECK(w.msgAttempts == 1 && w.sosAttempts == 1 && w.sosMsgs == 1 && w.sosReadings == 1);
  CHECK(w.urgent == 0 && w.backlog == 0 && w.readingsUp == 98 && w.readingRequests == 1 + 5);
  // the next pass: the SOS first again (still refused), nothing else to send
  w.backlog = 10;
  pass(w);
  CHECK(w.msgAttempts == 2 && w.sosAttempts == 2 && w.backlog == 0);
  // the admin fixes the key: both go, first
  w.msgCode = w.sosCode = 200;
  pass(w);
  CHECK(w.sosMsgs == 0 && w.sosReadings == 0 && w.msgAttempts == 3);
  // the backhaul itself is down: the pass ends at the first attempt, nothing else is tried
  World down;
  down.msgCode = down.sosCode = down.readingCode = -1;
  pass(down);
  CHECK(down.sosAttempts == 1 && down.msgAttempts == 0 && down.readingRequests == 0);
  // the server is up but refuses SOS with 503, and readings fail too: one try each, then the pass ends
  World busy;
  busy.msgCode = busy.sosCode = busy.readingCode = 503;
  pass(busy);
  CHECK(busy.sosAttempts == 1 && busy.msgAttempts == 1 && busy.readingRequests == 1 && busy.urgent == 3);
}

// ---- JSON samples for the backend check in run_tests.py ---------------------------
inline void jsonSamples(std::FILE* jf) {
  // 1. a full node's minute: every watched field, a WATCH sample among them
  //    and a smoke puff wide enough to need a shift
  SjReading r = sample(1.234f, -1.5f, 65.43f, 950, 140, 7.12f, 0);
  std::strncpy(r.node_id, "NODE-07", SJ_NODE_ID_LEN);
  r.session = 77;
  r.seq = 30;
  r.xflags = SJ_X_SUMMARY;
  SjSummary s;
  std::memset(&s, 0, sizeof(s));
  s.samples = 12;
  s.maxEdge = 1;
  s.windowS = 55;
  sjSummarySetStat(s, SJ_AF_WATER, 1201, 1220, 1234);
  sjSummarySetStat(s, SJ_AF_TEMP, -180, -160, -150);
  sjSummarySetStat(s, SJ_AF_HUMIDITY, 6400, 6500, 6543);
  sjSummarySetStat(s, SJ_AF_GAS, 900, 930, 950);
  sjSummarySetStat(s, SJ_AF_PM25, 20, 95, 900);
  sjSummarySetStat(s, SJ_AF_TILT, 700, 706, 712);
  String a;
  sjAppendJson(a, r, 2, -90, "lora", &s);
  std::fprintf(jf, "%s\n", a.c_str());
  // 2. a water-only river node, no edge model: no max_edge_risk_level
  SjReading w = sample(2.5f, NAN, NAN, NAN, NAN, NAN);
  w.session = 78;
  w.seq = 4;
  w.xflags = SJ_X_SUMMARY;
  SjSummary ws;
  std::memset(&ws, 0, sizeof(ws));
  ws.samples = 12;
  ws.maxEdge = SJ_EDGE_NONE;
  ws.windowS = 55;
  sjSummarySetStat(ws, SJ_AF_WATER, 2490, 2496, 2500);
  String b;
  sjAppendJson(b, w, 2, -90, "lora", &ws);
  std::fprintf(jf, "%s\n", b.c_str());
  // 3. an urgent reading (no summary - nothing to summarise during WATCH)
  //    and a reading whose summary was not flagged: no "summary" key
  SjReading u = w;
  u.seq = 5;
  u.xflags = SJ_X_PRIORITY;
  u.edge_risk = 1;
  String c;
  sjAppendJson(c, u, 1, -90, "lora", &ws);
  std::fprintf(jf, "%s\n", c.c_str());
  CHECK(!std::strstr(c.c_str(), "summary") && !std::strstr(c.c_str(), "PRIORITY"));
  // an invalid summary is never written, a missing one neither
  SjSummary bad = ws;
  bad.samples = 1;
  String d, e;
  sjAppendJson(d, w, 2, -90, "lora", &bad);
  sjAppendJson(e, w, 2, -90, "lora");
  CHECK(!std::strstr(d.c_str(), "summary") && !std::strstr(e.c_str(), "summary"));
  CHECK(std::strstr(a.c_str(), "\"pm25_ugm3\":{\"min\":19,\"max\":903,\"mean\":95}") &&
        std::strstr(a.c_str(), "\"temp_c\":{\"min\":-1.80,\"max\":-1.50,\"mean\":-1.60}") &&
        std::strstr(a.c_str(), "\"max_edge_risk_level\":\"WATCH\""));
}

inline void runReportTests(const std::string& dir) {
  codecTests();
  packetTests();
  accumulatorTests();
  planTests();
  airtimeTests();
  nodeLoopTests();
  fiveMinuteTests();
  helperTests();
  nodeOutageTests();
  gatewayOutageTests();
  staleUrgentTests();
  forwardPassTests();
  receiveIdTests();
  std::FILE* jf = std::fopen((dir + "/summary_samples.jsonl").c_str(), "wb");
  CHECK(jf != nullptr);
  if (jf) {
    jsonSamples(jf);
    std::fclose(jf);
  }
}

}  // namespace report
