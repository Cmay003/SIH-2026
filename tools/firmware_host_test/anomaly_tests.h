// Tests for the node's river rate of rise and on-device anomaly checks
// (sj_anomaly.h): a true positive for every check, NO false alarm over a
// day of realistic sensor noise (river and bench rig), real step changes
// flagged only once, gaps / clock restarts / the millis() wrap, the packet
// bytes and JSON, and that a doubtful value never sounds the offline siren
// (sj_siren.h). Uses the shipped config.h values. Included by
// test_firmware_logic.cpp (uses its CHECK).
#pragma once
#include <cmath>
#include <random>

namespace anomaly {

constexpr uint32_t SEC = 1000;
constexpr uint32_t STEP = SAMPLE_INTERVAL_MS;  // 5 s, as shipped
const float NONE = NAN;                        // "this sensor is absent" in sensors()

// The config the sketch builds in setupEdgeChecks() from the shipped config.h.
inline SjEdgeConfig shippedConfig(bool bench, float mountM) {
  SjEdgeConfig c;
  std::memset(&c, 0, sizeof(c));
  sjEdgeDefaultLimits(c.field, bench, mountM);
  c.staleMs = EDGE_STALE_S * 1000UL;
  c.riseWindowMs = RISE_WINDOW_S * 1000UL;
  c.fastRiseCmPerMin = bench ? FAST_RISE_BENCH_FRACTION_PER_MIN * mountM * 100.0f : FAST_RISE_CM_PER_MIN;
  c.riseMinSamples = RISE_MIN_SAMPLES;
  c.fastRiseSamples = FAST_RISE_SAMPLES;
  c.riseNoiseK = RISE_NOISE_K;
  return c;
}
const float RIVER_MOUNT_M = 4.0f;  // a river gauge 4 m above gauge zero

// A reading encoded the way takeReading() does it (fixed point), and the
// sample sjSampleFromReading() makes of it - so the tests see exactly the
// resolution the node sends. NAN = sensor absent; failedMask as in the sketch.
inline SjReading encode(float waterM, float tempC, float hum, float gas, float pm, float tilt) {
  SjReading r;
  std::memset(&r, 0, sizeof(r));
  r.magic = SJ_MAGIC;
  r.version = SJ_VERSION;
  r.type = SJ_TYPE_READING;
  r.edge_risk = SJ_EDGE_NONE;
  if (!std::isnan(waterM)) {
    r.flags |= SJ_HAS_WATER;
    r.water_level_mm = sjClampU16(waterM * 1000.0f);
  }
  if (!std::isnan(tempC)) {
    r.flags |= SJ_HAS_DHT;
    r.temp_c_x100 = sjClampI16(tempC * 100);
    r.humidity_x100 = sjClampU16(hum * 100);
  }
  if (!std::isnan(gas)) {
    r.flags |= SJ_HAS_GAS;
    r.gas_ppm = sjClampU16(gas);
  }
  if (!std::isnan(pm)) {
    r.flags |= SJ_HAS_PM;
    r.pm25 = sjClampU16(pm);
  }
  if (!std::isnan(tilt)) {
    r.flags |= SJ_HAS_TILT;
    r.tilt_deg_x100 = sjClampI16(tilt * 100);
  }
  return r;
}
inline SjSample sensors(float waterM, float tempC, float hum, float gas, float pm, float tilt, uint8_t failed = 0) {
  SjSample s;
  sjSampleFromReading(encode(waterM, tempC, hum, gas, pm, tilt), failed, s);
  return s;
}
inline SjSample water(float m) { return sensors(m, NONE, NONE, NONE, NONE, NONE); }
inline SjSample waterFailed() { return sensors(NONE, NONE, NONE, NONE, NONE, NONE, 1u << SJ_AF_WATER); }

// One node's checks, fed a regular sample every STEP.
struct Run {
  SjEdgeTrack t;
  SjEdgeConfig c;
  uint32_t now;
  SjEdgeResult r;
  Run(const SjEdgeConfig& cfg, uint32_t startMs = 1000000) : c(cfg), now(startMs) {
    sjEdgeBegin(t);
    std::memset(&r, 0, sizeof(r));
  }
  const SjEdgeResult& sample(const SjSample& s) {
    sjEdgeSample(t, s, now, c, r);
    now += STEP;
    return r;
  }
};

inline bool flagged(const SjEdgeResult& r, uint8_t check, uint8_t field) { return (r.anomaly[check] >> field) & 1u; }
inline int flagCount(const SjEdgeResult& r) {
  int n = 0;
  for (uint8_t c = 0; c < SJ_AC_COUNT; c++)
    for (uint8_t f = 0; f < SJ_AF_COUNT; f++) n += flagged(r, c, f);
  return n;
}
inline float q(float v, float res) { return std::round(v / res) * res; }  // sensor resolution

// ---- no false alarms: a day of noisy but healthy sensors ------------------
inline void testNoFalseAlarmsRiver() {
  std::mt19937 rng(20261009);
  std::normal_distribution<float> n01(0.0f, 1.0f);
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  const int samples = 24 * 3600 / (STEP / SEC);
  int flags = 0, fast = 0, withRate = 0;
  float maxRate = -1e9f, minRate = 1e9f;
  for (int k = 0; k < samples; k++) {
    float hours = k * (STEP / 1000.0f) / 3600.0f;
    float day = 2 * 3.14159265f * hours / 24.0f;
    // river: 1.80 m, a 5 cm daily swing, a slow monsoon rise of 10 cm/h for
    // 6 hours, and 5 mm of gauge noise
    float rise = hours < 6 ? 0 : (hours < 12 ? 0.10f * (hours - 6) : 0.60f);
    float w = 1.80f + 0.05f * std::sin(day) + rise + 0.005f * n01(rng);
    float t = q(28 + 4 * std::sin(day) + 0.1f * n01(rng), 0.1f);       // DHT22: 0.1 C steps
    float h = q(70 + 15 * std::sin(day + 1) + 0.5f * n01(rng), 0.1f);
    float g = std::round(420 + 8 * n01(rng));
    float p = std::round(std::max(0.0f, 40 + 10 * std::sin(day) + 4 * n01(rng)));
    float tilt = 0.3f + 0.02f * n01(rng);
    const SjEdgeResult& r = run.sample(sensors(w, t, h, g, p, tilt));
    flags += flagCount(r);
    fast += r.fastRise;
    if (r.hasRate) {
      withRate++;
      maxRate = std::max(maxRate, r.riseCmPerMin);
      minRate = std::min(minRate, r.riseCmPerMin);
    }
  }
  CHECK(flags == 0);
  CHECK(fast == 0);
  CHECK(withRate > samples - 40);  // a rate from the first full window on
  CHECK(maxRate < 0.9f * FAST_RISE_CM_PER_MIN && minRate > -0.9f * FAST_RISE_CM_PER_MIN);
  std::printf("   [anomaly] river day: %d samples, 0 flags, rate %.2f .. %.2f cm/min\n", samples, minRate, maxRate);
}

// isolated misses (an echo lost now and then) are not a dropout
inline void testIsolatedMissesAreNotDropout() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  int flags = 0;
  for (int k = 0; k < 2000; k++) {
    bool miss = k % 6 == 0;  // 2 of every 12 samples
    flags += flagCount(run.sample(miss ? waterFailed() : water(1.5f + 0.001f * (k % 3))));
  }
  CHECK(flags == 0);
}

// the tabletop rig: a few mm of water, 1 mm noise, all day
inline void testNoFalseAlarmsBench() {
  std::mt19937 rng(7);
  std::normal_distribution<float> n01(0.0f, 1.0f);
  const float mount = ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f;
  Run run(shippedConfig(true, mount));
  int flags = 0, fast = 0;
  for (int k = 0; k < 24 * 720; k++) flags += flagCount(run.sample(water(0.008f + 0.001f * n01(rng)))), fast += run.r.fastRise;
  CHECK(flags == 0 && fast == 0);
}

// ---- review: no fast rise from gauge NOISE ----------------------------------
// A river gauge without a stilling well reads waves: 1-2 cm of noise per
// sample. A whole day of a level river must give no fast_rise (the backend
// raises a flash-flood alert on the node's flag alone). Before the noise
// test and the consecutive-samples rule, ~2 cm of noise flagged often.
inline int noisyDayFastRises(float noiseCm, uint32_t seed, float& maxRate) {
  std::mt19937 rng(seed);
  std::normal_distribution<float> n01(0.0f, 1.0f);
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  int fast = 0;
  maxRate = 0;
  for (int k = 0; k < 24 * 720; k++) {
    float day = k / 720.0f / 24.0f * 6.2832f;
    float lvl = 1.80f + 0.05f * std::sin(day) + noiseCm / 100.0f * n01(rng);  // a slow tide-like swing + waves
    const SjEdgeResult& r = run.sample(water(lvl));
    fast += r.fastRise;
    if (r.hasRate) maxRate = std::max(maxRate, r.riseCmPerMin);
  }
  return fast;
}

inline void testNoFastRiseFromNoise() {
  float peak;
  for (float noise : {1.0f, 1.5f, 2.0f}) {
    for (uint32_t seed : {1u, 2u, 3u}) {
      int fast = noisyDayFastRises(noise, seed, peak);
      CHECK(fast == 0);
      if (seed == 1) std::printf("   [anomaly] a day at %.1f cm gauge noise: %d fast rise(s), peak rate %.2f cm/min\n",
                                 noise, fast, peak);
    }
  }
  // ...while a real rise on the same noisy gauge is still flagged - later
  // the noisier the gauge (a clearer rise is needed above the noise)
  auto detect = [](float cmPerMin, float noiseCm) {
    std::mt19937 rng(11);
    std::normal_distribution<float> n01(0.0f, 1.0f);
    Run run(shippedConfig(false, RIVER_MOUNT_M));
    for (int s = 0; s < 1200; s += STEP / SEC) {
      float lvl = 1.5f + (s >= 300 ? cmPerMin / 100.0f * (s - 300) / 60.0f : 0) + noiseCm / 100.0f * n01(rng);
      if (run.sample(water(lvl)).fastRise) return s >= 300 ? s - 300 : -2;  // -2: flagged before the rise
    }
    return -1;
  };
  int d1 = detect(3.0f, 1.0f), d2 = detect(5.0f, 2.0f), dq = detect(2.0f, 0.3f);
  std::printf("   [anomaly] flagged after: 3 cm/min at 1 cm noise %d s, 5 cm/min at 2 cm noise %d s\n", d1, d2);
  CHECK(d1 >= 0 && d1 <= 240 && d2 >= 0 && d2 <= 240 && dq >= 0 && dq <= 180);
  // the persistence rule on its own: one sample over the line is not enough
  SjEdgeConfig one = shippedConfig(false, RIVER_MOUNT_M), three = one;
  one.fastRiseSamples = 1;
  CHECK(FAST_RISE_SAMPLES >= 2 && three.fastRiseSamples == FAST_RISE_SAMPLES);
  Run a(one), b(three);
  float lvl = 1.5f;
  int firstA = -1, firstB = -1;
  for (int k = 0; k < 80; k++, lvl += 0.0025f) {  // 3 cm/min, clean
    if (a.sample(water(lvl)).fastRise && firstA < 0) firstA = k;
    if (b.sample(water(lvl)).fastRise && firstB < 0) firstB = k;
  }
  CHECK(firstA >= 0 && firstB == firstA + FAST_RISE_SAMPLES - 1);
}

// ---- flash flood: the rise rate ---------------------------------------------
// Feeds `flatS` of a flat river then `rampS` rising at `cmPerMin`; returns
// the seconds from the ramp's start to the first fast_rise (-1 = never),
// and the rate at the end.
inline int riseScenario(float cmPerMin, int flatS, int rampS, float& endRate, int& fastBeforeRamp,
                        uint32_t startMs = 1000000) {
  std::mt19937 rng(42);
  std::normal_distribution<float> n01(0.0f, 1.0f);
  Run run(shippedConfig(false, RIVER_MOUNT_M), startMs);
  fastBeforeRamp = 0;
  int detectedS = -1;
  for (int s = 0; s < flatS + rampS; s += STEP / SEC) {
    float lvl = 1.50f + (s >= flatS ? cmPerMin / 100.0f * (s - flatS) / 60.0f : 0) + 0.003f * n01(rng);
    const SjEdgeResult& r = run.sample(water(lvl));
    if (s < flatS) fastBeforeRamp += r.fastRise;
    if (s >= flatS && r.fastRise && detectedS < 0) detectedS = s - flatS;
    CHECK(flagCount(r) == 0);  // a steady rise is not an anomaly
  }
  endRate = run.r.riseCmPerMin;
  CHECK(run.r.hasRate);
  return detectedS;
}

inline void testFastRise() {
  float end;
  int before;
  // 2 cm/min (the backend's flash-flood HIGH): flagged within about a minute and a half
  int det = riseScenario(2.0f, 600, 600, end, before);
  CHECK(before == 0);
  CHECK(det >= 45 && det <= 150);
  CHECK(std::fabs(end - 2.0f) < 0.2f);
  std::printf("   [anomaly] 2 cm/min rise flagged after %d s, rate %.2f cm/min\n", det, end);
  // 5 cm/min (backend CRITICAL): sooner
  int det5 = riseScenario(5.0f, 600, 300, end, before);
  CHECK(det5 >= 0 && det5 < det && std::fabs(end - 5.0f) < 0.4f);
  // 0.5 cm/min: a rate, but never "fast"
  CHECK(riseScenario(0.5f, 300, 1800, end, before) == -1 && std::fabs(end - 0.5f) < 0.15f);
  // falling 3 cm/min: negative rate, never fast
  CHECK(riseScenario(-3.0f, 300, 900, end, before) == -1 && std::fabs(end + 3.0f) < 0.3f);
  // the same rise across the 49.7-day millis() wrap
  int detWrap = riseScenario(2.0f, 600, 600, end, before, 0xFFFFFFFFu - 700 * SEC);
  CHECK(detWrap == det && before == 0 && std::fabs(end - 2.0f) < 0.2f);
}

// not enough history: no rate (and so never fast) - 4 samples over half the window at least
inline void testRateNeedsHistory() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 4; k++) CHECK(!run.sample(water(1.5f + 0.5f * k)).hasRate);  // 4 samples in 15 s
  int firstRate = -1;
  for (int k = 4; k < 40 && firstRate < 0; k++)
    if (run.sample(water(1.5f)).hasRate) firstRate = k;
  CHECK(firstRate == (int)(RISE_WINDOW_S / 2 / (STEP / SEC)));  // the levels must span half the window
  // a node whose water sensor failed this sample: no rate, no fast rise
  CHECK(!run.sample(waterFailed()).hasRate);
}

// ---- spikes, steps, impossible rates --------------------------------------
inline void testSpike() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  int fast = 0;
  for (int k = 0; k < 60; k++) CHECK(flagCount(run.sample(water(1.5f + 0.002f * (k % 4)))) == 0);
  // an echo off rain: 3.2 m for one sample
  const SjEdgeResult& a = run.sample(water(3.2f));
  CHECK(flagged(a, SJ_AC_SPIKE, SJ_AF_WATER) && flagged(a, SJ_AC_RATE, SJ_AF_WATER) && !a.fastRise);
  CHECK(flagCount(run.sample(water(1.502f))) == 0);  // back to normal: not flagged (rate is from the last GOOD value)
  CHECK(flagCount(run.sample(water(1.500f))) == 0);
  // a second spike soon after is caught too: the first never entered the statistics
  CHECK(flagged(run.sample(water(0.4f)), SJ_AC_SPIKE, SJ_AF_WATER));
  for (int k = 0; k < 60; k++) {
    const SjEdgeResult& r = run.sample(water(1.5f + 0.002f * (k % 4)));
    fast += r.fastRise;
    CHECK(flagCount(r) == 0 && std::fabs(r.riseCmPerMin) < 0.5f);  // the spikes left the rate alone
  }
  CHECK(fast == 0);
  // gas: one wild value (no rate limit for gas - a leak can start that fast)
  Run gas(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 30; k++) gas.sample(sensors(NONE, NONE, NONE, 420.0f + (k % 5), NONE, NONE));
  const SjEdgeResult& g = gas.sample(sensors(NONE, NONE, NONE, 2400, NONE, NONE));
  CHECK(flagged(g, SJ_AC_SPIKE, SJ_AF_GAS) && !flagged(g, SJ_AC_RATE, SJ_AF_GAS) && flagCount(g) == 1);
  CHECK(flagCount(gas.sample(sensors(NONE, NONE, NONE, 421, NONE, NONE))) == 0);
}

// Heavy rain: the gauge reads echoes off the drops on 2 of every 3 samples
// for two minutes. Every echo is flagged (the second of a pair as an
// impossible rate from the last good level), none enters the rise history,
// so the river - level all along - never shows a rise.
inline void testEchoStorm() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 60; k++) run.sample(water(1.5f + 0.002f * (k % 3)));
  int fast = 0, unflaggedEchoes = 0;
  float maxRate = 0;
  for (int k = 0; k < 24 + 36; k++) {
    bool echo = k < 24 && k % 3 != 0;
    const SjEdgeResult& r = run.sample(water(echo ? 2.5f : 1.5f + 0.002f * (k % 3)));
    if (echo) unflaggedEchoes += !(flagged(r, SJ_AC_SPIKE, SJ_AF_WATER) || flagged(r, SJ_AC_RATE, SJ_AF_WATER));
    fast += r.fastRise;
    maxRate = std::max(maxRate, std::fabs(r.riseCmPerMin));
  }
  CHECK(unflaggedEchoes == 0 && fast == 0 && maxRate < 0.5f);
}

// A doubtful level is never a fast rise, even while the river IS rising fast:
// the backend distrusts the node rate for the same checks.
inline void testNoFastRiseOnDoubt() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  float lvl = 1.5f;
  for (int k = 0; k < 80; k++, lvl += 0.0025f) run.sample(water(lvl));  // 3 cm/min
  CHECK(run.r.fastRise);
  const SjEdgeResult& spike = run.sample(water(lvl + 1.0f));
  lvl += 0.0025f;
  CHECK(flagged(spike, SJ_AC_SPIKE, SJ_AF_WATER) && spike.hasRate && !spike.fastRise);
  CHECK(run.sample(water(lvl)).fastRise);  // the next good sample: fast again
  lvl += 0.0025f;
  // three missed echoes in a row of 12: the values in between are flagged
  // dropout - a rate is still sent, "fast" is not
  int doubtfulFast = 0, doubtful = 0;
  for (int k = 0; k < 12; k++, lvl += 0.0025f) {
    bool miss = k == 0 || k == 2 || k == 4;
    const SjEdgeResult& r = run.sample(miss ? waterFailed() : water(lvl));
    if (!miss && flagged(r, SJ_AC_DROPOUT, SJ_AF_WATER)) {
      doubtful++;
      doubtfulFast += r.fastRise;
      CHECK(r.hasRate);
    }
  }
  CHECK(doubtful == 7 && doubtfulFast == 0);
}

// A REAL step (a flash flood's front, a gas leak starting) is flagged on its
// first sample only; then it is the new normal - and the river's step is a
// fast rise.
inline void testRealStep() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 60; k++) run.sample(water(1.5f + 0.002f * (k % 4)));
  const SjEdgeResult& first = run.sample(water(1.8f));  // +30 cm in 5 s
  CHECK(flagged(first, SJ_AC_SPIKE, SJ_AF_WATER) && !first.fastRise);
  int laterFlags = 0, fastAt = -1;
  for (int k = 1; k < 80; k++) {
    const SjEdgeResult& r = run.sample(water(1.8f + 0.002f * (k % 4)));
    laterFlags += flagCount(r);
    if (r.fastRise && fastAt < 0) fastAt = k;
  }
  CHECK(laterFlags == 0);
  CHECK(fastAt > 0 && fastAt * (int)(STEP / SEC) <= RISE_WINDOW_S / 2 + 10);
  CHECK(!run.r.fastRise);  // a window later the river is level again: no longer "rising"
  // gas leak: 420 -> 1200 ppm and staying
  Run gas(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 30; k++) gas.sample(sensors(NONE, NONE, NONE, 420.0f + (k % 5), NONE, NONE));
  CHECK(flagged(gas.sample(sensors(NONE, NONE, NONE, 1200, NONE, NONE)), SJ_AC_SPIKE, SJ_AF_GAS));
  int gasFlags = 0;
  for (int k = 0; k < 30; k++) gasFlags += flagCount(gas.sample(sensors(NONE, NONE, NONE, 1200.0f + (k % 7), NONE, NONE)));
  CHECK(gasFlags == 0);
}

// a DHT22 that jumps 14 C in 5 s: impossible - until it has stayed there
// long enough to be plausible (30 C/min from the last good value)
inline void testImpossibleRate() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 30; k++) run.sample(sensors(NONE, 26.0f + 0.1f * (k % 2), 60, NONE, NONE, NONE));
  const SjEdgeResult& j = run.sample(sensors(NONE, 40.0f, 60, NONE, NONE, NONE));
  CHECK(flagged(j, SJ_AC_RATE, SJ_AF_TEMP) && flagged(j, SJ_AC_SPIKE, SJ_AF_TEMP));
  int rateFlagged = 1, k = 0;
  while (flagged(run.sample(sensors(NONE, 40.0f, 60, NONE, NONE, NONE)), SJ_AC_RATE, SJ_AF_TEMP) && k++ < 50) rateFlagged++;
  // 14 C at 30 C/min = 28 s after the last good value
  CHECK(rateFlagged == 5);
  CHECK(flagCount(run.sample(sensors(NONE, 40.1f, 60, NONE, NONE, NONE))) == 0);
  // water: a river gauge "moving" 3 m in 5 s
  Run w(shippedConfig(false, RIVER_MOUNT_M));
  w.sample(water(1.0f));
  CHECK(flagged(w.sample(water(3.5f)), SJ_AC_RATE, SJ_AF_WATER));
  // ...but no rate check for water on the bench rig (a hand-filled tank)
  const float mount = ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f;
  Run b(shippedConfig(true, mount));
  b.sample(water(0.0f));
  CHECK(!flagged(b.sample(water(mount)), SJ_AC_RATE, SJ_AF_WATER));
}

// ---- stuck ------------------------------------------------------------------
// index of the first sample flagged stuck for `field`, -1 = never
inline int stuckAt(const SjEdgeConfig& cfg, uint8_t field, const SjSample& s, int maxSamples) {
  Run run(cfg);
  for (int k = 0; k < maxSamples; k++)
    if (flagged(run.sample(s), SJ_AC_STUCK, field)) return k;
  return -1;
}

inline void testStuck() {
  SjEdgeConfig cfg = shippedConfig(false, RIVER_MOUNT_M);
  const int perS = STEP / SEC;
  // exactly the configured time after the first identical sample
  CHECK(stuckAt(cfg, SJ_AF_WATER, water(1.234f), 1000) == (int)(cfg.field[SJ_AF_WATER].stuckS / perS));
  CHECK(stuckAt(cfg, SJ_AF_TEMP, sensors(NONE, 25.0f, 61.3f, NONE, NONE, NONE), 4000) ==
        (int)(cfg.field[SJ_AF_TEMP].stuckS / perS));
  CHECK(stuckAt(cfg, SJ_AF_GAS, sensors(NONE, NONE, NONE, 433, NONE, NONE), 1000) == 360);
  CHECK(stuckAt(cfg, SJ_AF_TILT, sensors(NONE, NONE, NONE, NONE, NONE, 1.25f), 1000) == 360);
  // values that legitimately stay put: empty gauge, water at the sensor face,
  // saturated air, clean air
  CHECK(stuckAt(cfg, SJ_AF_WATER, water(0.0f), 10 * 720) == -1);
  CHECK(stuckAt(cfg, SJ_AF_WATER, water(RIVER_MOUNT_M), 10 * 720) == -1);
  CHECK(stuckAt(cfg, SJ_AF_HUMIDITY, sensors(NONE, 25.0f + 0, 99.9f, NONE, NONE, NONE), 5 * 720) == -1);
  CHECK(stuckAt(cfg, SJ_AF_PM25, sensors(NONE, NONE, NONE, NONE, 0, NONE), 5 * 720) == -1);
  // one change restarts the clock; the flag clears at once
  Run run(cfg);
  for (int k = 0; k < 359; k++) run.sample(water(1.234f));
  run.sample(water(1.235f));
  int k = 0;
  while (!flagged(run.sample(water(1.235f)), SJ_AC_STUCK, SJ_AF_WATER) && k < 1000) k++;
  CHECK(k == 359);
  CHECK(!flagged(run.sample(water(1.236f)), SJ_AC_STUCK, SJ_AF_WATER));
}

// ---- dropout ----------------------------------------------------------------
inline void testDropout() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 20; k++) run.sample(water(1.5f));
  CHECK(flagCount(run.sample(waterFailed())) == 0);  // 1 of 12
  run.sample(water(1.5f));
  CHECK(flagCount(run.sample(waterFailed())) == 0);  // 2 of 12
  run.sample(water(1.5f));
  const SjEdgeResult& third = run.sample(waterFailed());  // 3 of 12
  CHECK(flagged(third, SJ_AC_DROPOUT, SJ_AF_WATER) && flagCount(third) == 1 && !third.hasRate);
  // a value that does arrive meanwhile is still sent - flagged dropout, never fast
  const SjEdgeResult& v = run.sample(water(1.5f));
  CHECK(flagged(v, SJ_AC_DROPOUT, SJ_AF_WATER) && !v.fastRise);
  // still 3 failures among the last 12 for 6 more samples (until the first
  // one leaves the window), then clear
  int stillFlagged = 0;
  for (int k = 0; k < 12; k++) stillFlagged += flagged(run.sample(water(1.5f)), SJ_AC_DROPOUT, SJ_AF_WATER);
  CHECK(stillFlagged == 6);
  CHECK(flagCount(run.sample(water(1.5f))) == 0);
  // ABSENT samples (a gas sensor warming up, a sensor not fitted) are no failures
  Run warm(shippedConfig(false, RIVER_MOUNT_M));
  int flags = 0;
  for (int k = 0; k < 100; k++) flags += flagCount(warm.sample(sensors(1.5f, 25.0f + 0.1f * (k % 2), 60, NONE, NONE, NONE)));
  CHECK(flags == 0);
  // the dropout window only moves with samples that say something about the sensor
  Run gap(shippedConfig(false, RIVER_MOUNT_M));
  gap.sample(waterFailed());
  gap.sample(waterFailed());
  for (int k = 0; k < 10; k++) gap.sample(sensors(NONE, 25.0f + 0.1f * (k % 2), 60, NONE, NONE, NONE));  // water absent
  CHECK(flagged(gap.sample(waterFailed()), SJ_AC_DROPOUT, SJ_AF_WATER));  // still 3 of the last 12 WATER samples
}

// ---- gaps, clock restart ----------------------------------------------------
inline void testStaleAndClockRestart() {
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 40; k++) run.sample(water(1.5f + 0.002f * (k % 3)));
  CHECK(run.r.hasRate);
  run.now += 10 * 60 * SEC;  // the node was off / the sensor away for 10 minutes
  const SjEdgeResult& after = run.sample(water(3.0f));
  CHECK(flagCount(after) == 0 && !after.hasRate);  // no baseline to call it a spike / an impossible rate
  // the clock restarted (power-on: the RTC clock starts at 0 again)
  Run rs(shippedConfig(false, RIVER_MOUNT_M), 900000000u);
  for (int k = 0; k < 40; k++) rs.sample(water(1.5f));
  rs.now = 5000;
  const SjEdgeResult& r0 = rs.sample(water(1.6f));
  CHECK(flagCount(r0) == 0 && !r0.hasRate);  // the old history looks ancient: ignored
  int k = 0;
  while (!rs.sample(water(1.6f)).hasRate && k < 60) k++;
  CHECK(k + 1 == (int)(RISE_WINDOW_S / 2 / (STEP / SEC)));  // a fresh window, as after a power-on
  CHECK(std::fabs(rs.r.riseCmPerMin) < 0.01f);
}

// ---- bench rig: a demo pour is a fast rise, not an anomaly -------------------
inline void testBenchPour() {
  const float mount = ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f;
  SjEdgeConfig cfg = shippedConfig(true, mount);
  CHECK(std::fabs(cfg.fastRiseCmPerMin - 0.10f * ULTRASONIC_MOUNT_HEIGHT_CM) < 1e-4f);
  Run run(cfg);
  for (int k = 0; k < 60; k++) run.sample(water(0.004f + 0.001f * (k % 2)));
  int flags = 0, fastAt = -1;
  for (int s = 0; s < 240; s += STEP / SEC) {
    float lvl = s < 20 ? 0.004f + (mount - 0.004f) * s / 20.0f : mount;  // fill the rig in 20 s
    const SjEdgeResult& r = run.sample(water(lvl));
    flags += flagCount(r);
    if (r.fastRise && fastAt < 0) fastAt = s;
  }
  CHECK(flags == 0);
  CHECK(fastAt >= 0 && fastAt <= 90);
  // the bench scaling is what makes a small pour "fast": 5 mm in 20 s is
  // fast on the rig, not at river scale (1 cm/min)
  int benchFast = 0, riverFast = 0;
  Run b(cfg), river(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 60; k++) b.sample(water(0.004f)), river.sample(water(0.004f));
  for (int s = 0; s < 240; s += STEP / SEC) {
    float lvl = s < 20 ? 0.004f + 0.005f * s / 20 : 0.009f;
    benchFast += b.sample(water(lvl)).fastRise;
    riverFast += river.sample(water(lvl)).fastRise;
  }
  CHECK(benchFast > 0 && riverFast == 0);
}

// ---- extra samples, the sample a reading makes, stamping, JSON -----------------
inline void testStampAndJson() {
  // sjSampleFromReading: present / failed / absent, decoded at the packet's resolution
  SjReading r = encode(1.2345f, -1.5f, 65.43f, 950, 140, 7.12f);
  SjSample s;
  sjSampleFromReading(r, 0, s);
  CHECK(s.status[SJ_AF_WATER] == SJ_AN_VALUE && std::fabs(s.value[SJ_AF_WATER] - 1.235f) < 1e-6f);  // mm
  CHECK(s.value[SJ_AF_TEMP] == -1.5f && std::fabs(s.value[SJ_AF_HUMIDITY] - 65.43f) < 1e-4f);
  CHECK(s.value[SJ_AF_GAS] == 950 && s.value[SJ_AF_PM25] == 140 && std::fabs(s.value[SJ_AF_TILT] - 7.12f) < 1e-5f);
  SjReading part = encode(NONE, NONE, NONE, 400, NONE, NONE);
  sjSampleFromReading(part, (1u << SJ_AF_WATER) | (1u << SJ_AF_PM25), s);
  CHECK(s.status[SJ_AF_WATER] == SJ_AN_FAILED && s.status[SJ_AF_PM25] == SJ_AN_FAILED);
  CHECK(s.status[SJ_AF_TEMP] == SJ_AN_ABSENT && s.status[SJ_AF_TILT] == SJ_AN_ABSENT && s.status[SJ_AF_GAS] == SJ_AN_VALUE);

  // sjEdgeLast: an extra sample (SOS / siren report) gets the last regular verdict
  Run run(shippedConfig(false, RIVER_MOUNT_M));
  for (int k = 0; k < 30; k++) run.sample(water(1.5f));
  run.sample(water(3.5f));
  SjEdgeResult last = sjEdgeLast(run.t);
  CHECK(flagged(last, SJ_AC_SPIKE, SJ_AF_WATER) && std::memcmp(&last, &run.r, sizeof(last)) == 0);

  // stamping into the reading
  SjEdgeResult e;
  std::memset(&e, 0, sizeof(e));
  e.hasRate = 1;
  e.fastRise = 1;
  e.riseCmPerMin = 2.5f;
  e.anomaly[SJ_AC_STUCK] = 1u << SJ_AF_GAS;
  e.anomaly[SJ_AC_DROPOUT] = (1u << SJ_AF_TEMP) | 0xC0;  // bits beyond the fields are never sent
  SjReading w = encode(2.345f, NONE, NONE, 300, NONE, NONE);
  sjEdgeStamp(w, e);
  CHECK(w.xflags == (SJ_X_RISE_RATE | SJ_X_FAST_RISE) && w.rise_cm_min_x100 == 250);
  CHECK(w.anomaly[SJ_AC_DROPOUT] == (1u << SJ_AF_TEMP) && w.anomaly[SJ_AC_STUCK] == (1u << SJ_AF_GAS));
  String js;
  sjAppendJson(js, w, 5, -90, "lora");
  CHECK(std::strstr(js.c_str(), ",\"fast_rise\":true,\"rise_rate_cm_per_min\":2.50"));
  CHECK(std::strstr(js.c_str(), ",\"edge_anomaly\":[\"stuck:gas_ppm\",\"dropout:temp_c\"]"));
  // no water level in the reading: no rate, even if the checks had one
  SjReading noWater = encode(NONE, 25, 60, NONE, NONE, NONE);
  sjEdgeStamp(noWater, e);
  CHECK(noWater.xflags == 0 && noWater.rise_cm_min_x100 == 0);
  noWater.xflags = SJ_X_RISE_RATE | SJ_X_FAST_RISE;  // from the radio: still nothing about a rise
  noWater.rise_cm_min_x100 = 300;
  String jn;
  sjAppendJson(jn, noWater, 5, -90, "lora");
  CHECK(!std::strstr(jn.c_str(), "rise"));
  // a stale rate never survives a re-stamp
  e.hasRate = 0;
  sjEdgeStamp(w, e);
  CHECK(w.xflags == 0 && w.rise_cm_min_x100 == 0);
  // falling, clamped, unknown bits from the radio
  SjReading f = encode(1.0f, NONE, NONE, NONE, NONE, NONE);
  f.xflags = SJ_X_RISE_RATE | 0xF0;
  f.rise_cm_min_x100 = -125;
  f.anomaly[SJ_AC_SPIKE] = 0xC0;  // nothing known
  String jf;
  sjAppendJson(jf, f, 5, -90, "lora");
  CHECK(std::strstr(jf.c_str(), "\"rise_rate_cm_per_min\":-1.25") && !std::strstr(jf.c_str(), "fast_rise") &&
        !std::strstr(jf.c_str(), "edge_anomaly"));
  f.xflags = SJ_X_FAST_RISE;  // fast without a rate: nothing (contract: fast_rise comes with its rate)
  String jf2;
  sjAppendJson(jf2, f, 5, -90, "lora");
  CHECK(!std::strstr(jf2.c_str(), "rise"));
  std::memset(&e, 0, sizeof(e));
  e.hasRate = 1;
  e.riseCmPerMin = 1000.0f;
  sjEdgeStamp(f, e);
  CHECK(f.rise_cm_min_x100 == 32767);
  // all 24 "<check>:<field>" names fit the backend's pattern (checked in
  // Python too): lower-case letters, digits, '_'
  for (uint8_t c = 0; c < SJ_AC_COUNT; c++) CHECK(std::strlen(SJ_AC_NAMES[c]) <= 16);
  for (uint8_t f2 = 0; f2 < SJ_AF_COUNT; f2++) CHECK(std::strlen(SJ_AF_NAMES[f2]) <= 32);
}

// ---- a doubtful value never sounds the offline siren -------------------------
inline void testSirenIgnoresDoubtfulValues() {
  const uint32_t waterLimitMm = 3200, gasLimit = SIREN_LOCAL_GAS_PPM;
  SjReading r = encode(3.5f, 25, 60, 300, NONE, NONE);
  CHECK(sjSirenLocalUrgent(r, waterLimitMm, gasLimit));
  for (uint8_t c : {SJ_AC_STUCK, SJ_AC_SPIKE, SJ_AC_RATE}) {
    SjReading d = r;
    d.anomaly[c] = 1u << SJ_AF_WATER;
    CHECK(!sjSirenLocalUrgent(d, waterLimitMm, gasLimit));
  }
  SjReading drop = r;  // a dropout says other samples were missed - this value counts
  drop.anomaly[SJ_AC_DROPOUT] = 1u << SJ_AF_WATER;
  CHECK(sjSirenLocalUrgent(drop, waterLimitMm, gasLimit));
  // gas: its own doubt only
  SjReading g = encode(1.0f, 25, 60, 900, NONE, NONE);
  CHECK(sjSirenLocalUrgent(g, waterLimitMm, gasLimit));
  g.anomaly[SJ_AC_SPIKE] = 1u << SJ_AF_GAS;
  CHECK(!sjSirenLocalUrgent(g, waterLimitMm, gasLimit));
  g.anomaly[SJ_AC_SPIKE] = 1u << SJ_AF_WATER;
  CHECK(sjSirenLocalUrgent(g, waterLimitMm, gasLimit));
  // an edge-AI URGENT is no siren trigger at all (decision 2026-10-09:
  // the models' URGENT also covers heat, flame and tilt) - doubtful inputs
  // or not; anomalies on other fields leave the water / gas rule alone
  SjReading e = encode(1.0f, 25, 60, 300, 50, 1.0f);
  e.edge_risk = 2;
  CHECK(!sjSirenLocalUrgent(e, waterLimitMm, gasLimit));
  for (uint8_t f : {SJ_AF_PM25, SJ_AF_TILT, SJ_AF_TEMP}) {
    SjReading d = r;  // 3.5 m: urgent by the water level itself
    d.anomaly[SJ_AC_SPIKE] = 1u << f;
    CHECK(sjSirenLocalUrgent(d, waterLimitMm, gasLimit));
  }
  // end to end: offline, the gauge misreading every other sample at a
  // flood level never gives two URGENT samples in a row
  const SjSirenTiming T = {SIREN_OFFLINE_AFTER_S * 1000UL, SIREN_OFFLINE_URGENT_SAMPLES, SIREN_ON_S * 1000UL,
                           SIREN_MAX_ON_S * 1000UL, SIREN_COOLDOWN_S * 1000UL};
  SjSiren siren;
  sjSirenBegin(siren, 0);
  Run run(shippedConfig(false, RIVER_MOUNT_M), 0);
  uint32_t now = 0;
  for (int k = 0; k < 400; k++, now += STEP) {  // 2000 s > SIREN_OFFLINE_AFTER_S: offline
    SjReading rd = encode(k % 2 ? 3.7f : 1.5f, NONE, NONE, NONE, NONE, NONE);
    SjSample sm;
    sjSampleFromReading(rd, 0, sm);
    SjEdgeResult er;
    sjEdgeSample(run.t, sm, now, run.c, er);
    sjEdgeStamp(rd, er);
    sjSirenSample(siren, sjSirenLocalUrgent(rd, waterLimitMm, gasLimit), now, T);
  }
  CHECK(siren.offline && !siren.on);
  // the river really is up (two clean samples at 3.5 m after the spikes settle): it sounds
  int sounded = -1;
  for (int k = 0; k < 40 && sounded < 0; k++, now += STEP) {
    SjReading rd = encode(3.5f, NONE, NONE, NONE, NONE, NONE);
    SjSample sm;
    sjSampleFromReading(rd, 0, sm);
    SjEdgeResult er;
    sjEdgeSample(run.t, sm, now, run.c, er);
    sjEdgeStamp(rd, er);
    sjSirenSample(siren, sjSirenLocalUrgent(rd, waterLimitMm, gasLimit), now, T);
    if (siren.on) sounded = k;
  }
  CHECK(siren.on && siren.reason == SJ_SIREN_AUTO_OFFLINE);
  // 2 m above the last good level (1.5 m) is more than the gauge may move
  // per minute (2 m/min): the samples count once a minute has passed since
  // that last good value - then two in a row sound it
  CHECK(sounded >= 11 && sounded <= 13);
}

inline void runAnomalyTests() {
  testNoFalseAlarmsRiver();
  testIsolatedMissesAreNotDropout();
  testNoFalseAlarmsBench();
  testFastRise();
  testNoFastRiseFromNoise();
  testRateNeedsHistory();
  testSpike();
  testRealStep();
  testEchoStorm();
  testNoFastRiseOnDoubt();
  testImpossibleRate();
  testStuck();
  testDropout();
  testStaleAndClockRestart();
  testBenchPour();
  testStampAndJson();
  testSirenIgnoresDoubtfulValues();
}

}  // namespace anomaly
