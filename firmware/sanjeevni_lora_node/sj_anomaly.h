// =====================================================================
// SANJEEVNI node - river rate of rise (flash flood) and on-device sensor
// anomaly checks (hardware-independent, so it is unit-tested on a PC:
// tools/firmware_host_test/anomaly_tests.h).
//
// Both work on the stream of REGULAR samples (every SAMPLE_INTERVAL_MS, or
// every deep-sleep wake). An extra sample taken a moment later for an SOS
// or a siren report would see the same values over a tiny time step, so it
// gets the last regular verdict instead (sjEdgeLast) - like the siren's
// "consecutive samples" rule.
//
// 1. FLASH FLOOD. The river's rate of rise in cm/min over the last
//    riseWindowMs: each sample of the older half of the window is paired
//    with its partner half a window later, and the rate is the MEDIAN of
//    those pairs' slopes. Not a least-squares line: one misread sample (an
//    echo off rain or debris, a common ultrasonic failure) spoils one pair
//    and cannot fake a fast rise. (Plain medians of the two halves were
//    tried first: on a steady rise their noise is that of single samples,
//    so the rate wandered by +-15 %.) The reading is flagged fast_rise and
//    sent at once instead of at the next heartbeat when, on fastRiseSamples
//    CONSECUTIVE regular samples, the rate is
//      - at or above the fast-rise limit, AND
//      - clearly above the gauge's own noise: at least riseNoiseK standard
//        errors. The noise is measured in the same window, from the spread
//        of the sample-to-sample steps (trimmed, so a real step or one bad
//        echo does not inflate it); the standard error of the median pair
//        slope follows from it. Checked on simulated noise: the estimate
//        matches the rate's actual scatter, and a level river exceeds 5
//        standard errors on about 1 sample in 100 000 (4: 1 in 10 000 -
//        too often over a day of 17 280 samples).
//    The limit alone was not enough (review): with ~2 cm of gauge noise
//    (waves, no stilling well) a quiet river crossed 1 cm/min often, and
//    the backend raises a flash-flood alert on the node's flag alone. Now a
//    noisy gauge needs a proportionally clearer rise (with K = 5: at 1 cm
//    of noise about 1.3 cm/min, at 2 cm about 2.6 cm/min), and a
//    quiet one is as fast as before plus (fastRiseSamples - 1) samples. A
//    doubtful sample (see 2.) neither counts towards the streak nor breaks
//    it. The backend computes its own rate from the readings it gets
//    (hazard_classification.classify_flash_flood) and takes the faster of
//    the two; the node's rate sees every raw sample, also between reports.
//
// 2. ANOMALY CHECKS per sensor value, sent as edge_anomaly
//    "<check>:<field>" (contract; SJ_AC_* / SJ_AF_* in sj_packet.h):
//      stuck    exactly the same value (at the packet's resolution) for
//               stuckS and at least SJ_AN_STUCK_MIN_SAMPLES samples - a
//               frozen sensor or a cached value; values at a clamp limit
//               (an empty gauge reads 0) are exempt
//      spike    far from the rolling mean of recent good samples AND far
//               from the previous sample: a sudden jump, not a drift.
//               "Far" = max(spikeK x deviation, spikeMin), so normal noise
//               (which sets the deviation) and a sensor's quantisation
//               (which spikeMin covers) never count
//      rate     changed faster than physically plausible per minute since
//               the last good value (so the sample that returns from a
//               spike is not flagged too)
//      dropout  the sensor failed on SJ_AN_DROPOUT_MIN of its last
//               SJ_AN_DROPOUT_WINDOW samples (an isolated miss is normal;
//               samples where it is absent - warming up - don't count)
//    A spiked or impossible value is kept out of the rolling statistics and
//    the rise-rate history, so it can't mask the next spike or fake a rise.
//    The comparison with the PREVIOUS sample (flagged or not) means a real
//    step change - a flash flood's front, a gas leak starting - is flagged
//    only on its first sample: the next one sits next to it and counts.
//    The backend uses the flags as a fault signal (lower alert confidence;
//    a flood resting on a doubtful level is held), and the node itself:
//    a doubtful value never sounds the offline siren (sjSirenLocalUrgent)
//    and never makes a fast rise.
//
// THE LIMITS (sjEdgeDefaultLimits below, plus the RISE_* / FAST_RISE_*
// values in config.h) ARE CONFIGURABLE DEMO DEFAULTS chosen for this
// project, not values from a standard or a sensor datasheet. Tune them
// per site from the node's own history before field use.
//
// Time: `nowMs` is a millisecond clock that keeps running through deep
// sleep (the sketch's RTC clock). All ages are unsigned differences, so the
// 49.7-day wrap is harmless; a clock that restarts (power-on) makes every
// stored sample look ancient - it is then simply ignored.
// =====================================================================
#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>
#include "sj_packet.h"

#define SJ_AN_WIN 12               // good samples in the rolling mean / deviation (1 min at 5 s)
#define SJ_AN_MIN_STATS 6          // the spike check needs at least this many
#define SJ_AN_DROPOUT_WINDOW 12    // samples looked back for dropouts (<= 16)
#define SJ_AN_DROPOUT_MIN 3        // failures in that window = dropout
#define SJ_AN_STUCK_MIN_SAMPLES 3  // "stuck" needs at least this many identical samples
#define SJ_RISE_SLOTS 40           // river levels kept for the rise rate (3 min at 5 s)
#define SJ_RISE_STEP_FLOOR_CM 0.1f // the steps' noise is never taken as below the gauge's 1 mm resolution
#define SJ_EDGE_TRACK_MAGIC 0x534A4542u  // "SJEB" - bump if SjEdgeTrack changes (kept in RTC memory)

static_assert(SJ_AN_DROPOUT_WINDOW <= 16, "the dropout history is a 16-bit mask");

// What one sample says about one field.
enum : uint8_t {
  SJ_AN_ABSENT = 0,  // not fitted, or warming up (sj_warmup.h): no information, history untouched
  SJ_AN_FAILED,      // fitted, but the read failed this time (the value is left out of the reading)
  SJ_AN_VALUE,       // measured
};

struct SjSample {
  uint8_t status[SJ_AF_COUNT];
  float value[SJ_AF_COUNT];  // in the JSON field's units (m, C, %, ppm, ug/m3, deg), as sent
};

// One field's limits, in its JSON units. 0 turns a check off.
struct SjAnomalyLimits {
  float spikeK;            // deviations from the rolling mean
  float spikeMin;          // ...and at least this far from the mean AND from the previous sample
  float maxRatePerMin;     // a faster change per minute is not physically plausible
  uint32_t stuckS;         // identical this long = stuck
  float stuckExemptBelow;  // values <= this may legitimately stay put (a clamp limit)
  float stuckExemptAbove;  // values >= this likewise
};

struct SjEdgeConfig {
  SjAnomalyLimits field[SJ_AF_COUNT];
  uint32_t staleMs;        // previous sample older than this = no baseline: the field starts over
  uint32_t riseWindowMs;   // rise rate over this window
  float fastRiseCmPerMin;  // fast_rise at or above this (0 = never)
  uint8_t riseMinSamples;  // levels needed in the window (>= 4: two per half)
  uint8_t fastRiseSamples; // ...on this many consecutive regular samples (0 / 1 = the sample alone)
  float riseNoiseK;        // ...and this many standard errors above zero (0 = no noise test)
};

struct SjFieldTrack {
  float win[SJ_AN_WIN];  // recent good values (ring)
  float prev;            // the previous value, flagged or not (spike step, stuck)
  float good;            // the last good value (rate)
  uint32_t prevMs;
  uint32_t goodMs;
  uint32_t stuckSinceMs;  // first sample of the current run of identical values
  uint16_t failHist;      // bit i = the sample i regular samples ago failed
  uint16_t stuckSamples;  // length of that run
  uint8_t winCount;
  uint8_t winHead;
  uint8_t havePrev;
  uint8_t haveGood;
};

struct SjRiseTrack {
  float levelCm[SJ_RISE_SLOTS];  // ring, oldest at (head - count)
  uint32_t atMs[SJ_RISE_SLOTS];
  uint8_t count;
  uint8_t head;
  uint8_t fastStreak;  // consecutive regular samples that met the fast-rise test (saturates at 255)
};

struct SjEdgeResult {
  uint8_t anomaly[SJ_AC_COUNT];  // as in SjReading.anomaly
  uint8_t hasRate;
  uint8_t fastRise;
  float riseCmPerMin;
};

// Everything the checks remember. Plain data: the sketch keeps it in RTC
// memory on a deep-sleep node (survives the sleeps, magic-checked).
struct SjEdgeTrack {
  uint32_t magic;
  SjFieldTrack f[SJ_AF_COUNT];
  SjRiseTrack rise;
  SjEdgeResult last;  // the last regular sample's verdict (sjEdgeLast)
};

inline void sjEdgeBegin(SjEdgeTrack& t) {
  memset(&t, 0, sizeof(t));
  t.magic = SJ_EDGE_TRACK_MAGIC;
}

inline bool sjEdgeValid(const SjEdgeTrack& t) { return t.magic == SJ_EDGE_TRACK_MAGIC; }

// The demo-default limits (see the top). mountM = the ultrasonic gauge's
// mount height (ULTRASONIC_MOUNT_HEIGHT_CM / 100). bench = the tabletop rig
// (config.h RISE_BENCH_SCALE): its whole range is a few cm, so the river's
// absolute limits would never fire and fractions of mountM are used, as
// the backend's bench mode does.
//  water  spike 5 cm (river) / half the rig; a river gauge jumping > 2 m
//         per minute is far more likely an echo off rain, debris or an
//         animal than the river (off on the bench: a hand-filled tank can
//         do anything); stuck 30 min, except at 0 (empty / below gauge
//         zero) and at the mount height (water at the sensor face) - the
//         readings are clamped there, so constancy is expected
//  temp   spike 3 C, > 30 C/min, stuck 3 h (a DHT22 reports 0.1 C steps and
//         a quiet night can hold one for a while)
//  hum    spike 15 %, > 60 %/min, stuck 3 h, except >= 99 % (fog / rain
//         keeps it saturated for hours)
//  gas    spike 150 ppm, no rate limit (a gas leak can start that fast),
//         stuck 30 min (the MQ135 value moves with every ADC count)
//  pm25   spike 75 ug/m3, no rate limit (smoke can arrive that fast), stuck
//         2 h except at 0 (clean air)
//  tilt   spike 2 deg, no rate limit (a pole knocked over is a real event),
//         stuck 30 min (the accelerometer's noise moves the 0.01 deg value)
// The spikeK of 6 deviations sits well above the scatter of a 12-sample
// estimate of a noisy sensor; spikeMin covers quiet (quantised) sensors.
inline void sjEdgeDefaultLimits(SjAnomalyLimits lim[SJ_AF_COUNT], bool bench, float mountM) {
  const float none = 1e30f;
  lim[SJ_AF_WATER] = {6.0f, bench ? 0.5f * mountM : 0.05f, bench ? 0.0f : 2.0f, 1800, 0.0005f,
                      mountM > 0.001f ? mountM - 0.0005f : none};
  lim[SJ_AF_TEMP] = {6.0f, 3.0f, 30.0f, 3 * 3600, -none, none};
  lim[SJ_AF_HUMIDITY] = {6.0f, 15.0f, 60.0f, 3 * 3600, -none, 99.0f};
  lim[SJ_AF_GAS] = {6.0f, 150.0f, 0.0f, 1800, -none, none};
  lim[SJ_AF_PM25] = {6.0f, 75.0f, 0.0f, 2 * 3600, 0.0f, none};
  lim[SJ_AF_TILT] = {6.0f, 2.0f, 0.0f, 1800, -none, none};
}

// The sample a reading represents: a field is a VALUE if the reading
// carries it, FAILED if the sketch says its read failed (`failedMask`, bit
// per SJ_AF_*), else ABSENT. Values are decoded from the packet's
// fixed point, so "stuck" means identical as sent.
inline void sjSampleFromReading(const SjReading& r, uint8_t failedMask, SjSample& s) {
  memset(&s, 0, sizeof(s));
  const struct {
    uint16_t flag;
    float v;
  } src[SJ_AF_COUNT] = {
      {SJ_HAS_WATER, r.water_level_mm / 1000.0f}, {SJ_HAS_DHT, r.temp_c_x100 / 100.0f},
      {SJ_HAS_DHT, r.humidity_x100 / 100.0f},     {SJ_HAS_GAS, (float)r.gas_ppm},
      {SJ_HAS_PM, (float)r.pm25},                 {SJ_HAS_TILT, r.tilt_deg_x100 / 100.0f},
  };
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
    if (r.flags & src[f].flag) {
      s.status[f] = SJ_AN_VALUE;
      s.value[f] = src[f].v;
    } else if (failedMask & (1u << f)) {
      s.status[f] = SJ_AN_FAILED;
    }
  }
}

namespace sjan {
inline float median(float* v, uint8_t n) {  // sorts v (n <= SJ_RISE_SLOTS)
  for (uint8_t i = 1; i < n; i++) {
    float x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) {
      v[j + 1] = v[j];
      j--;
    }
    v[j + 1] = x;
  }
  return n % 2 ? v[n / 2] : 0.5f * (v[n / 2 - 1] + v[n / 2]);
}

inline uint8_t bitCount(uint16_t v) {
  uint8_t n = 0;
  for (; v; v &= (uint16_t)(v - 1)) n++;
  return n;
}

// Rise rate (cm/min) from the levels in the window, and its standard error
// from the window's own noise; false = not enough data.
inline bool riseRate(const SjRiseTrack& r, uint32_t nowMs, const SjEdgeConfig& cfg, float& rate, float& stdErr) {
  float lv[SJ_RISE_SLOTS], tm[SJ_RISE_SLOTS];  // oldest first; time in minutes, 0 = now
  uint8_t n = 0;
  for (uint8_t k = 0; k < r.count; k++) {
    uint8_t i = (uint8_t)((r.head + SJ_RISE_SLOTS - r.count + k) % SJ_RISE_SLOTS);
    uint32_t age = nowMs - r.atMs[i];
    if (age > cfg.riseWindowMs) continue;  // too old - or from before a clock restart
    lv[n] = r.levelCm[i];
    tm[n] = -(float)age / 60000.0f;
    n++;
  }
  uint8_t need = cfg.riseMinSamples < 4 ? 4 : cfg.riseMinSamples;
  if (n < need) return false;
  // The levels must cover at least half the window: four samples bunched in
  // a few seconds say nothing about a rate per minute.
  if ((tm[n - 1] - tm[0]) * 60000.0f < cfg.riseWindowMs / 2.0f) return false;
  // sample k of the older half with sample k of the newer half: every pair
  // spans about half the window, so each slope is a fair estimate
  uint8_t h = n / 2;
  float slopes[SJ_RISE_SLOTS];
  uint8_t m = 0;
  float dtSum = 0;
  for (uint8_t k = 0; k < h; k++) {
    float dt = tm[n - h + k] - tm[k];
    if (dt > 0) {
      slopes[m++] = (lv[n - h + k] - lv[k]) / dt;
      dtSum += dt;
    }
  }
  if (m == 0) return false;
  rate = median(slopes, m);
  // Noise: a step between neighbours is the difference of two noisy levels
  // (plus a tiny share of the trend, removed with the median step), so its
  // spread is sqrt(2) x the level noise - and so is a pair slope's numerator.
  // Its standard deviation from the mean absolute deviation of the steps,
  // leaving out the largest 10 %: one real step (a flood front) or a stray
  // echo can't inflate it, and unlike a plain median of the deviations it
  // is steady enough from one window's ~35 steps (a median-based estimate
  // came out low often enough to let 2 cm of noise through now and then).
  // 0.6573 = E|Z| for |Z| below its 90 % point, Z standard normal.
  // 1.2533 / sqrt(m) turns one pair slope's spread into the median's
  // standard error.
  float steps[SJ_RISE_SLOTS];
  for (uint8_t k = 0; k + 1 < n; k++) steps[k] = lv[k + 1] - lv[k];
  float mid = median(steps, n - 1);
  for (uint8_t k = 0; k + 1 < n; k++) steps[k] = fabsf(steps[k] - mid);
  median(steps, n - 1);  // sorts them
  uint8_t keep = (uint8_t)((n - 1) * 9 / 10);
  if (keep < 1) keep = 1;
  float sum = 0;
  for (uint8_t k = 0; k < keep; k++) sum += steps[k];
  float stepSd = sum / keep / 0.6573f;
  if (stepSd < SJ_RISE_STEP_FLOOR_CM) stepSd = SJ_RISE_STEP_FLOOR_CM;
  stdErr = 1.2533f * stepSd / (dtSum / m) / sqrtf((float)m);
  return true;
}
}  // namespace sjan

// One REGULAR sample: runs the checks, updates the history, returns the
// verdict in `out` (also kept for sjEdgeLast).
inline void sjEdgeSample(SjEdgeTrack& t, const SjSample& s, uint32_t nowMs, const SjEdgeConfig& cfg,
                         SjEdgeResult& out) {
  memset(&out, 0, sizeof(out));
  bool waterDoubt = false;  // spike / rate: kept out of the rise history
  for (uint8_t f = 0; f < SJ_AF_COUNT; f++) {
    SjFieldTrack& ft = t.f[f];
    const SjAnomalyLimits& lim = cfg.field[f];
    const uint8_t bit = (uint8_t)(1u << f);
    if (s.status[f] == SJ_AN_ABSENT) continue;  // nothing learnt, nothing changed

    // dropout: failures among the last SJ_AN_DROPOUT_WINDOW samples (this one included)
    const uint16_t histMask = (uint16_t)((1u << SJ_AN_DROPOUT_WINDOW) - 1);
    ft.failHist = (uint16_t)(((ft.failHist << 1) | (s.status[f] == SJ_AN_FAILED ? 1u : 0u)) & histMask);
    if (sjan::bitCount(ft.failHist) >= SJ_AN_DROPOUT_MIN) out.anomaly[SJ_AC_DROPOUT] |= bit;
    if (s.status[f] != SJ_AN_VALUE) continue;

    const float x = s.value[f];
    if (ft.havePrev && nowMs - ft.prevMs > cfg.staleMs) {
      // A long gap (sensor away, node off, clock restarted): the old values
      // are no baseline for this one. Start the statistics over.
      ft.winCount = ft.winHead = 0;
      ft.havePrev = 0;
    }
    if (ft.haveGood && nowMs - ft.goodMs > cfg.staleMs) ft.haveGood = 0;

    bool spike = false, rate = false;
    if (ft.haveGood && lim.maxRatePerMin > 0) {
      const uint32_t dtMs = nowMs - ft.goodMs;
      // under a second apart a rate per minute is mostly rounding - skip
      if (dtMs >= 1000 && fabsf(x - ft.good) * 60000.0f / dtMs > lim.maxRatePerMin) rate = true;
    }
    if (ft.havePrev) {
      const float step = fabsf(x - ft.prev);
      if (lim.spikeK > 0 && ft.winCount >= SJ_AN_MIN_STATS) {
        float mean = 0;
        for (uint8_t k = 0; k < ft.winCount; k++) mean += ft.win[k];
        mean /= ft.winCount;
        float var = 0;
        for (uint8_t k = 0; k < ft.winCount; k++) var += (ft.win[k] - mean) * (ft.win[k] - mean);
        float sd = sqrtf(var / (ft.winCount - 1));
        float thr = lim.spikeK * sd > lim.spikeMin ? lim.spikeK * sd : lim.spikeMin;
        spike = fabsf(x - mean) > thr && step > thr;
      }
    }

    // stuck: the current run of identical values
    bool exempt = x <= lim.stuckExemptBelow || x >= lim.stuckExemptAbove;
    if (ft.havePrev && x == ft.prev && !exempt) {
      if (ft.stuckSamples < 0xFFFF) ft.stuckSamples++;
    } else {
      ft.stuckSamples = 1;
      ft.stuckSinceMs = nowMs;
    }
    bool stuck = lim.stuckS > 0 && !exempt && ft.stuckSamples >= SJ_AN_STUCK_MIN_SAMPLES &&
                 nowMs - ft.stuckSinceMs >= lim.stuckS * 1000ULL;

    if (!spike && !rate) {  // a good value: into the statistics
      ft.win[ft.winHead] = x;
      ft.winHead = (uint8_t)((ft.winHead + 1) % SJ_AN_WIN);
      if (ft.winCount < SJ_AN_WIN) ft.winCount++;
      ft.good = x;
      ft.goodMs = nowMs;
      ft.haveGood = 1;
    }
    ft.prev = x;
    ft.prevMs = nowMs;
    ft.havePrev = 1;

    if (stuck) out.anomaly[SJ_AC_STUCK] |= bit;
    if (spike) out.anomaly[SJ_AC_SPIKE] |= bit;
    if (rate) out.anomaly[SJ_AC_RATE] |= bit;
    if (f == SJ_AF_WATER) waterDoubt = spike || rate;
  }

  // ---- rise rate (needs this sample's water level) ----
  if (s.status[SJ_AF_WATER] == SJ_AN_VALUE) {
    SjRiseTrack& r = t.rise;
    if (!waterDoubt) {
      r.levelCm[r.head] = s.value[SJ_AF_WATER] * 100.0f;
      r.atMs[r.head] = nowMs;
      r.head = (uint8_t)((r.head + 1) % SJ_RISE_SLOTS);
      if (r.count < SJ_RISE_SLOTS) r.count++;
    }
    float rate, stdErr;
    if (sjan::riseRate(r, nowMs, cfg, rate, stdErr)) {
      out.hasRate = 1;
      out.riseCmPerMin = rate;
      // Any doubt about this level - including dropouts, which leave gaps
      // in the history - and it is not a fast rise (the backend distrusts
      // the node's rate in the same cases: NODE_RATE_DISTRUST_CHECKS). Nor
      // does it break the streak: it says nothing about the river.
      bool doubt = false;
      for (uint8_t c = 0; c < SJ_AC_COUNT; c++) doubt |= (out.anomaly[c] & (1u << SJ_AF_WATER)) != 0;
      bool fastNow = cfg.fastRiseCmPerMin > 0 && rate >= cfg.fastRiseCmPerMin && rate >= cfg.riseNoiseK * stdErr;
      if (!doubt) r.fastStreak = fastNow ? (uint8_t)(r.fastStreak < 255 ? r.fastStreak + 1 : 255) : 0;
      uint8_t need = cfg.fastRiseSamples > 1 ? cfg.fastRiseSamples : 1;
      out.fastRise = fastNow && !doubt && r.fastStreak >= need;
    } else {
      r.fastStreak = 0;  // too little history: start over
    }
  }
  t.last = out;
}

// The verdict for an extra (non-regular) sample: the last regular one's.
inline const SjEdgeResult& sjEdgeLast(const SjEdgeTrack& t) { return t.last; }

// Writes a verdict into the reading (v3 bytes, sj_packet.h). The rise rate
// only with a water level in the reading.
inline void sjEdgeStamp(SjReading& r, const SjEdgeResult& e) {
  r.xflags &= (uint8_t) ~(SJ_X_RISE_RATE | SJ_X_FAST_RISE);
  r.rise_cm_min_x100 = 0;
  if (e.hasRate && (r.flags & SJ_HAS_WATER)) {
    r.xflags |= SJ_X_RISE_RATE;
    if (e.fastRise) r.xflags |= SJ_X_FAST_RISE;
    r.rise_cm_min_x100 = sjClampI16(e.riseCmPerMin * 100.0f);
  }
  for (uint8_t c = 0; c < SJ_AC_COUNT; c++) r.anomaly[c] = e.anomaly[c] & SJ_AF_ALL;
}
