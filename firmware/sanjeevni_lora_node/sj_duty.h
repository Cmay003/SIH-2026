// =====================================================================
// SANJEEVNI node - optional duty cycle for the MQ135 heater and the
// PMS5003 fan, for solar nodes (hardware-independent, unit-tested on a PC:
// tools/firmware_host_test/duty_tests.h). OFF by default (config.h
// MQ135_DUTY_CYCLE / PMS5003_DUTY_CYCLE 0): both then run continuously.
//
// Why anchored on the REPORTS, not a free-running timer: the backend
// classifies a reading by its top-level values, which are the LATEST sample
// (the summary only feeds the smoke trend - backend ReadingSummary). A
// sensor that measured at some other moment of the window would almost
// never be in a normal report. So the sensor wakes `leadMs` (its warm-up +
// a margin) before the report that should carry its value, its values
// count once it has been powered for its warm-up (the same rule as after a
// boot - sj_warmup.h), and it sleeps again once a report has carried a
// warm value. It carries one in every `everyN`-th report.
//
// It stays powered while `hold` is set (the node is elevated: a local
// alert - flame included -, edge WATCH/URGENT, a fast rise), so an event is
// followed every sample; and wakes at once when `hold` comes on.
//
// A value never counts unless the sensor has been powered for warmMs at
// the moment the value was MEASURED (a PMS5003 frame can be seconds old) -
// "never a cold reading". All times are millis() differences: a wrap
// (49.7 days) is harmless.
// =====================================================================
#pragma once
#include <stdint.h>

struct SjDutyCfg {
  uint32_t warmMs;    // powered this long before a value counts (MQ135_WARMUP_S / PMS5003_WARMUP_S)
  uint32_t leadMs;    // wake this long before the report that should carry the value (warmMs + a margin)
  uint32_t giveUpMs;  // powered this long and no report carried a warm value: sleep anyway (dead sensor)
  uint8_t everyN;     // a warm value in every N-th report (1 = every report)
};

struct SjDuty {
  bool powered;
  bool carried;          // since this power-on, a report carried a warm value
  uint8_t reportsSince;  // reports while asleep (since the last sleep)
  uint32_t onSinceMs;    // its warm-up counts from here (a repeated wake command moves it)
  uint32_t wokeMs;       // when it was switched on - the give-up timer counts from here
};

// The timing for a sensor with warm-up `warmS`, woken `marginS` early, in a
// node reporting every `intervalMs`, carrying a value in every `everyN`-th
// report. Give up after the report after next: one more chance for a slow
// first frame (or a lost command), but a dead sensor is not kept on.
inline SjDutyCfg sjDutyConfig(uint32_t warmS, uint32_t marginS, uint32_t intervalMs, uint32_t everyN) {
  SjDutyCfg c;
  c.warmMs = warmS * 1000UL;
  c.leadMs = (warmS + marginS) * 1000UL;
  c.giveUpMs = c.leadMs + intervalMs + marginS * 1000UL;
  c.everyN = (uint8_t)(everyN < 1 ? 1 : everyN > 255 ? 255 : everyN);
  return c;
}

enum SjDutyAction : uint8_t { SJ_DUTY_STAY = 0, SJ_DUTY_WAKE = 1, SJ_DUTY_SLEEP = 2 };

// At boot the sensor is switched on (the first warm-up starts with the node).
inline void sjDutyBegin(SjDuty& d, uint32_t nowMs) {
  d.powered = true;
  d.carried = false;
  d.reportsSince = 0;
  d.onSinceMs = nowMs;
  d.wokeMs = nowMs;
}

// The sensor may only have started now (a PMS5003 that missed its serial
// wake command and got it again): its warm-up counts from now.
inline void sjDutyRestartWarmUp(SjDuty& d, uint32_t nowMs) {
  if (d.powered) d.onSinceMs = nowMs;
}

// How long it has been powered (0 while asleep) - the self-test's "warming up (Ns of Ws)".
inline uint32_t sjDutyPoweredMs(const SjDuty& d, uint32_t nowMs) { return d.powered ? nowMs - d.onSinceMs : 0; }

// A value measured `ageMs` before now counts only if the sensor was powered
// AND warm at that moment.
inline bool sjDutyWarm(const SjDuty& d, const SjDutyCfg& c, uint32_t nowMs, uint32_t ageMs) {
  if (!d.powered) return false;
  uint32_t on = nowMs - d.onSinceMs;
  return on >= c.warmMs && ageMs <= on - c.warmMs;
}

// Milliseconds until the report that should carry the next warm value is due.
inline uint32_t sjDutyMsToTarget(const SjDuty& d, const SjDutyCfg& c, uint32_t nowMs, uint32_t lastReportMs,
                                 uint32_t intervalMs) {
  uint32_t n = c.everyN ? c.everyN : 1;
  uint32_t toGo = n > d.reportsSince ? n - d.reportsSince : 1;
  uint32_t since = nowMs - lastReportMs;
  uint32_t remaining = since >= intervalMs ? 0 : intervalMs - since;
  return (toGo - 1) * intervalMs + remaining;
}

// Called every loop(): what to do with the sensor's power now.
inline SjDutyAction sjDutyStep(SjDuty& d, const SjDutyCfg& c, uint32_t nowMs, uint32_t lastReportMs,
                               uint32_t intervalMs, bool hold) {
  if (d.powered) {
    if (hold) return SJ_DUTY_STAY;
    if (!d.carried && nowMs - d.wokeMs < c.giveUpMs) return SJ_DUTY_STAY;
    d.powered = false;
    d.carried = false;
    d.reportsSince = 0;
    return SJ_DUTY_SLEEP;
  }
  if (hold || sjDutyMsToTarget(d, c, nowMs, lastReportMs, intervalMs) <= c.leadMs) {
    d.powered = true;
    d.carried = false;
    d.onSinceMs = nowMs;
    d.wokeMs = nowMs;
    return SJ_DUTY_WAKE;
  }
  return SJ_DUTY_STAY;
}

// After every reading that went out as a report (normal or urgent): did it
// carry this sensor's warm value?
inline void sjDutyOnReport(SjDuty& d, bool carriedWarmValue) {
  if (d.powered) {
    if (carriedWarmValue) d.carried = true;
  } else if (d.reportsSince < 255) {
    d.reportsSince++;
  }
}

// A reading found no recent value from the sensor (PMS5003: no frame for
// 10 s, readPm()): is that a DROPOUT (sj_anomaly.h)? Only once it has been
// powered for its warm-up since it was SWITCHED ON - counted from wokeMs,
// not from onSinceMs: a repeated wake command (sjPmsResendDue below) moves
// onSinceMs every SJ_PMS_RESEND_MS while a dead module sends nothing, so a
// warm-up-based rule would never call a dead PMS5003 a dropout.
inline bool sjDutyMissIsDropout(const SjDuty& d, const SjDutyCfg& c, uint32_t nowMs) {
  return d.powered && nowMs - d.wokeMs >= c.warmMs;
}

// PMS5003 slept by its serial command (PMS5003_SET_PIN -1): a command can
// be missed (e.g. sent while the module was sending), so it is repeated -
// at most every SJ_PMS_RESEND_MS - while the module does not obey:
//  - should run: no frame since it was switched on, or none for
//    SJ_PMS_RESEND_MS (the datasheet's slowest stream is one frame per
//    2.3 s, when the value is stable);
//  - should sleep: a frame within the last SJ_PMS_STREAMING_MS.
// The caller restarts the warm-up after a repeated wake (the fan may only
// start now - sjDutyRestartWarmUp). One rule for the sketch and the host
// simulation (tools/firmware_host_test/duty_tests.h).
#define SJ_PMS_RESEND_MS 5000UL
#define SJ_PMS_STREAMING_MS 3000UL
inline bool sjPmsResendDue(const SjDuty& d, uint32_t nowMs, uint32_t lastCmdMs, bool everFrame,
                           uint32_t lastFrameMs) {
  if (nowMs - lastCmdMs < SJ_PMS_RESEND_MS) return false;
  const uint32_t age = nowMs - lastFrameMs;
  if (d.powered) return !everFrame || age > SJ_PMS_RESEND_MS || age > nowMs - d.wokeMs;
  return everFrame && age < SJ_PMS_STREAMING_MS;
}

// PMS5003 serial command (datasheet PTQ3004-2015 V1.0, Appendix B): 0x42
// 0x4D, CMD, DATAH, DATAL, then the 16-bit sum of those five bytes, high
// byte first. CMD 0xE4 "Sleep set": DATAL 0x00 = sleep, 0x01 = wakeup.
#define SJ_PMS_CMD_SLEEP_SET 0xE4
inline void sjPmsCommand(uint8_t out[7], uint8_t cmd, uint8_t dataL) {
  out[0] = 0x42;
  out[1] = 0x4D;
  out[2] = cmd;
  out[3] = 0x00;
  out[4] = dataL;
  uint16_t sum = 0;
  for (int i = 0; i < 5; i++) sum += out[i];
  out[5] = (uint8_t)(sum >> 8);
  out[6] = (uint8_t)(sum & 0xFF);
}
