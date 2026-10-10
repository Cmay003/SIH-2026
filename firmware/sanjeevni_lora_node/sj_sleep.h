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
#include "sj_packet.h"

#define SJ_SLEEP_MAGIC 0x534A5335u  // "SJS5" (64-byte v3 SOS reading) - bump if SjSleepState changes

struct SjSleepState {
  uint32_t magic;
  uint32_t session;       // kept across wakes: reading_uid stays session-seq
  uint8_t elevated;       // last reading was elevated -> short sleep
  uint8_t rainWakeOff;    // rain pin stuck low: don't wake on it this cycle
  uint8_t sosEver;        // sosAtS is valid
  uint8_t sosPending;     // sosReading / sosTakenAtS hold an SOS not acknowledged yet
  uint32_t seq;           // last sequence number used
  uint32_t nextWakeS;     // when the next MEASUREMENT is due (sjClock seconds)
  float pendingRainMm;    // rain since the last QUEUED reading
  uint32_t rainTipsTotal; // diagnostics: tips counted while asleep
  uint32_t sosAtS;        // when the SOS button last sent an SOS: its cooldown spans wakes
  uint32_t sosTakenAtS;   // the pending SOS reading's QueuedReading.takenAtS
  SjReading sosReading;   // packed 64 bytes: no padding before `check`
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

// The newest SOS reading the gateway hasn't acknowledged (null = none),
// kept in step with the node's outbox. The outbox is RAM and lost in deep
// sleep or a reset; finding the SOS again in the flash queue by seq only
// worked while it was among the newest SOS_QUEUE_SCAN records - a wake
// pushes one reading, so after ~16 min without a gateway it fell back
// behind the backlog - and not at all if its flash push had failed. The
// reading itself (64 bytes) in RTC memory has neither problem.
inline void sjSleepKeepSos(SjSleepState& s, const SjReading* r, uint32_t takenAtS) {
  s.sosPending = r != nullptr;
  if (r) {
    s.sosReading = *r;
    s.sosTakenAtS = takenAtS;
  } else {
    memset(&s.sosReading, 0, sizeof(s.sosReading));
    s.sosTakenAtS = 0;
  }
  sjSleepStateSeal(s);
}

// The SOS kept by sjSleepKeepSos(), if the state verifies (not after a
// power-on: RTC memory is garbage then) and it really is an SOS reading.
inline bool sjSleepPendingSos(const SjSleepState& s, SjReading& r, uint32_t& takenAtS) {
  if (!sjSleepStateValid(s) || !s.sosPending || s.sosReading.magic != SJ_MAGIC ||
      !(s.sosReading.flags & SJ_SOS_PRESSED))
    return false;
  r = s.sosReading;
  takenAtS = s.sosTakenAtS;
  return true;
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
