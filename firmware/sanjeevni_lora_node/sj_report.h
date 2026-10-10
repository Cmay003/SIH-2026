// =====================================================================
// SANJEEVNI node - smart sending: WHAT to report and HOW urgently
// (hardware-independent, so it is unit-tested on a PC:
// tools/firmware_host_test/report_tests.h).
//
// The node samples every SAMPLE_INTERVAL_MS. Per regular sample:
//  - URGENT (sent at once, AHEAD of any queued backlog - SJ_X_PRIORITY,
//    the node's and the gateway's urgent outbox, sj_packet.h): edge AI
//    WATCH / URGENT, a local threshold (config.h LOCAL_*), a fast river
//    rise, a NEWLY raised anomaly (sj_anomaly.h - a check that was not
//    flagged on the previous sample; a sensor that stays stuck is reported
//    once at once, then with the normal reports, not every 5 s), or an SOS.
//  - a siren start / stop: sent at once, but not ahead of the backlog (it
//    is a state report, not an alarm - the start of the node's own
//    fallback comes with an URGENT sample anyway).
//  - NORMAL: one report per NORMAL_REPORT_INTERVAL_MS (config.h: 5 min on a
//    node without a siren, 1 min on a siren node - its commands ride on
//    the ACKs). Its top-level values are the LATEST sample and, with
//    SUMMARY_ENABLE, it carries an SjSummary of every regular sample since
//    the previous report (min / max / mean per watched field, the highest
//    edge verdict) - so a spike between two reports is no longer lost. The
//    window is kept as running min / max / sum per field (SjSummaryAcc,
//    ~100 bytes of RAM whatever its length), never as a list of samples:
//    60 samples in a 5-min window cost no more RAM than 12 in a minute.
//    The urgent path does not depend on the interval at all.
// Every regular report (urgent ones too) closes the summary window; an
// urgent sample right after a quiet spell therefore carries the summary of
// that spell, and during a WATCH period (every sample sent) there is
// nothing to summarise. SOS / siren-report samples are extra ones taken a
// moment later: they neither feed nor close the window.
//
// AIRTIME (the question "what does this cost / save?"). Semtech SX127x
// time-on-air formula at this project's LoRa settings (SF9, 125 kHz, CR 4/7,
// 8-symbol preamble, explicit header, CRC on): 64-byte reading 513.0 ms,
// 23-byte ACK 255.0 ms; with a summary 96 bytes (all six watched fields)
// 713.7 ms, 76 bytes (water level only) 599.0 ms. Per hour of NORMAL
// operation on an always-on node (720 samples; every report ACKed):
//                                    packets   payload B   airtime incl. ACKs
//   every raw sample                   720      46 080        553.0 s
//   old firmware: 1 sample a minute     60       3 840         46.1 s   (11 of 12 samples never left the node)
//   1-min summary, all 6 fields         60       5 760         58.1 s   (siren node)
//   1-min summary, water level only     60       4 560         51.2 s   (siren node)
//   5-min summary, all 6 fields         12       1 152         11.6 s   (no siren, default)
//   5-min summary, water level only     12         912         10.2 s   (no siren, default)
// So against sending every sample the 1-min summary saves 40 320 B and
// 494.8 s of airtime per hour (-89 %); against the old one-sample heartbeat
// it COSTS 1 920 B and 12.0 s per hour (+26 %, all six fields) for keeping
// the min / max / mean of the 11 samples that were dropped before. A node
// without a siren reports every 5 min (decision 2026-10-09): 11.6 s an
// hour, -80 % against the 1-min summary and -75 % against the old
// heartbeat (water only: 10.2 s, -80 % / -78 %), and every sample still
// reaches the backend in a summary. A siren node stays at 1 min, because
// siren commands only arrive in the ACK of a report. These are CALCULATED
// figures for quiet hours (formula, not a measurement on air); urgent
// readings add one packet + ACK per 5-s sample while they last, at either
// interval. "Quiet" includes a "Moderately polluted" / "Poor" PM day since
// 2026-10-09 (config.h LOCAL_PM*_LIMIT: send-now only from "Very Poor");
// a sustained "Very Poor" day is urgent all day - ~17 300 packets, ~13 300 s
// of airtime per day in duty_tests.h, no saving.
// Urgent readings: their queued copy is no longer sent a second time after
// going ahead (SjSentAhead) - without that, the priority path would have
// doubled the airtime of every WATCH period (720 readings an hour).
// tools/firmware_host_test/report_tests.h recomputes every figure above.
// =====================================================================
#pragma once
#include <stdint.h>
#include <string.h>
#include "sj_packet.h"

// Statistics of the regular samples since the last regular report.
struct SjSummaryAcc {
  uint32_t firstMs;
  uint32_t lastMs;
  uint16_t samples;
  uint8_t maxEdge;  // SJ_EDGE_NONE until a sample had a verdict
  uint8_t fields;   // (1 << SJ_AF_*) seen at least once
  int32_t sum[SJ_AF_COUNT];
  int32_t mn[SJ_AF_COUNT];
  int32_t mx[SJ_AF_COUNT];
  uint16_t n[SJ_AF_COUNT];
};

inline void sjSummaryReset(SjSummaryAcc& a) {
  memset(&a, 0, sizeof(a));
  a.maxEdge = SJ_EDGE_NONE;
}

// One regular sample that measured something (the reading as it will be
// sent - packet fixed point, so the summary describes what the backend
// would have seen). `nowMs` only for the window length.
inline void sjSummaryAdd(SjSummaryAcc& a, const SjReading& r, uint32_t nowMs) {
  if (a.samples == 0) a.firstMs = nowMs;
  a.lastMs = nowMs;
  if (a.samples < 0xFFFF) a.samples++;
  if (r.edge_risk <= 2 && (a.maxEdge == SJ_EDGE_NONE || r.edge_risk > a.maxEdge)) a.maxEdge = r.edge_risk;
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
    int32_t v;
    if (!sjFieldRaw(r, f, v) || a.n[f] == 0xFFFF) continue;  // 0xFFFF samples: a sum of 16-bit values still fits
    if (a.n[f] == 0 || v < a.mn[f]) a.mn[f] = v;
    if (a.n[f] == 0 || v > a.mx[f]) a.mx[f] = v;
    a.sum[f] += v;
    a.n[f]++;
    a.fields |= (uint8_t)(1u << f);
  }
}

// The summary of the window. false = nothing worth sending: fewer than two
// samples (the report itself is the only one) or no watched field.
inline bool sjSummaryBuild(const SjSummaryAcc& a, SjSummary& s) {
  memset(&s, 0, sizeof(s));
  if (a.samples < 2 || a.fields == 0) return false;
  s.samples = a.samples > 255 ? 255 : (uint8_t)a.samples;
  s.maxEdge = a.maxEdge;
  uint32_t w = (a.lastMs - a.firstMs + 500u) / 1000u;  // unsigned: a millis() wrap inside the window is harmless
  s.windowS = w > 0xFFFF ? 0xFFFF : (uint16_t)w;
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
    if (!a.n[f]) continue;
    // round half away from zero, as sjClampI16 does
    int32_t n = a.n[f];
    int32_t mean = a.sum[f] >= 0 ? (a.sum[f] + n / 2) / n : -((-a.sum[f] + n / 2) / n);
    sjSummarySetStat(s, f, a.mn[f], mean, a.mx[f]);
  }
  return true;
}

// Bits raised in `now` that were not in `prev` (per check, SjReading.anomaly).
inline bool sjNewAnomaly(const uint8_t prev[SJ_AC_COUNT], const uint8_t now[SJ_AC_COUNT]) {
  for (uint8_t c = 0; c < SJ_AC_COUNT; c++)
    if (now[c] & (uint8_t)~prev[c]) return true;
  return false;
}

struct SjReportInput {
  bool regular;       // the sample on the regular schedule (not an extra one for an SOS / a siren report)
  bool measured;      // at least one sensor answered
  bool sos;           // the SOS button was held: this reading carries the SOS
  bool sirenChanged;  // the siren started / stopped
  bool elevated;      // edge WATCH / URGENT, a local threshold or a fast rise
  bool newAnomaly;    // sjNewAnomaly(previous regular sample, this one)
  bool intervalDue;   // NORMAL_REPORT_INTERVAL_MS since the last report (or none yet)
};

struct SjReportPlan {
  bool send;      // queue this reading
  bool priority;  // SJ_X_PRIORITY: send now, ahead of the backlog (urgent outbox)
  bool summary;   // closes the summary window: attach its summary (SUMMARY_ENABLE, >= 2 samples), start a new one
};

inline SjReportPlan sjPlanReport(const SjReportInput& in) {
  SjReportPlan p = {false, false, false};
  const bool urgent = in.measured && (in.elevated || in.newAnomaly);
  // An SOS goes even if no sensor answered: the server raises the SOS from
  // the flag (the backend then refuses the reading itself).
  p.send = in.sos || (in.measured && (urgent || in.sirenChanged || in.intervalDue));
  p.priority = in.sos || urgent;
  // Only a regular, non-SOS report closes the window: an SOS reading may be
  // kept in RTC memory without its summary (sj_sleep.h) or be refused by
  // the backend (nothing measured) - its window goes with the next report.
  p.summary = p.send && in.regular && in.measured && !in.sos;
  return p;
}
