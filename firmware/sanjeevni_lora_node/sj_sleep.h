// =====================================================================
// SANJEEVNI node - deep-sleep bookkeeping (hardware-independent, so it
// is unit-tested on a PC: tools/firmware_host_test).
//
// In deep sleep the ESP32 loses its RAM and restarts setup() on every
// wake. What must survive between wakes lives in an SjSleepState kept in
// RTC memory (RTC_DATA_ATTR in the sketch). RTC memory holds random
// garbage after a real power-on, so the state carries a magic number and
// a checksum: anything that doesn't verify is treated as a cold boot.
// =====================================================================
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define SJ_SLEEP_MAGIC 0x534A5332u  // "SJS2" (session became 32-bit) - bump if SjSleepState changes

struct SjSleepState {
  uint32_t magic;
  uint32_t session;       // kept across wakes: reading_uid stays session-seq
  uint8_t elevated;       // last reading was elevated -> short sleep
  uint8_t rainWakeOff;    // rain pin stuck low: don't wake on it this cycle
  uint8_t reserved[2];    // explicit padding, so the checksum covers no garbage
  uint32_t seq;           // last sequence number used
  uint32_t nextWakeS;     // when the next MEASUREMENT is due (sjClock seconds)
  float pendingRainMm;    // rain since the last QUEUED reading
  uint32_t rainTipsTotal; // diagnostics: tips counted while asleep
  uint32_t check;
};

// FNV-1a over everything except `check`
inline uint32_t sjSleepChecksum(const SjSleepState& s) {
  const uint8_t* p = reinterpret_cast<const uint8_t*>(&s);
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < offsetof(SjSleepState, check); i++) {
    h ^= p[i];
    h *= 16777619u;
  }
  return h;
}

inline bool sjSleepStateValid(const SjSleepState& s) {
  return s.magic == SJ_SLEEP_MAGIC && s.check == sjSleepChecksum(s);
}

inline void sjSleepStateSeal(SjSleepState& s) {
  s.magic = SJ_SLEEP_MAGIC;
  s.check = sjSleepChecksum(s);
}

inline void sjSleepStateReset(SjSleepState& s, uint32_t session) {
  memset(&s, 0, sizeof(s));
  s.session = session;
  sjSleepStateSeal(s);
}

// How long to sleep after a measurement: short while something looks
// wrong (the node keeps watching closely), otherwise the normal interval.
inline uint32_t sjPlanSleepS(bool elevated, uint32_t normalS, uint32_t elevatedS) {
  return elevated ? elevatedS : normalS;
}

// Seconds left until the next measurement (0 = due now). Used after a
// rain-tip wake: count the tip, then sleep only for what is left.
inline uint32_t sjRemainingS(uint32_t nowS, uint32_t nextWakeS) {
  return nextWakeS > nowS ? nextWakeS - nowS : 0;
}

// A rain wake goes straight back to sleep unless the measurement is due
// within `slackS` anyway (then it measures now instead of sleeping for
// a second or two).
inline bool sjRainWakeShouldResleep(uint32_t nowS, uint32_t nextWakeS, uint32_t slackS) {
  return sjRemainingS(nowS, nextWakeS) > slackS;
}

// Sends a backlog one flush (= one batch) at a time until the queue is
// empty, a flush fails, or `budgetMs` has passed since `startMs` - so a
// battery node never stays awake much past its budget: at most one batch
// (one request's timeout) over it. Each flush must send ONE batch only;
// the WiFi flushQueue() used to drain the whole queue inside a single
// call, so a 2000-reading backlog kept a deep-sleep node awake for
// minutes despite DEEP_SLEEP_MAX_AWAKE_MS (review B). Returns how many
// flushes ran.
template <typename HasMore, typename FlushOnce, typename NowMs>
inline uint32_t sjDrainWithinBudget(HasMore hasMore, FlushOnce flushOnce, NowMs nowMs, uint32_t startMs,
                                    uint32_t budgetMs) {
  uint32_t flushes = 0;
  while (hasMore() && (uint32_t)(nowMs() - startMs) < budgetMs) {
    flushes++;
    if (!flushOnce()) break;
  }
  return flushes;
}
