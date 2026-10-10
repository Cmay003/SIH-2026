// =====================================================================
// SANJEEVNI node - power-on warm-up gate for the MQ135 and PMS5003
// (hardware-independent, unit-tested on a PC: tools/firmware_host_test).
//
// Why: after a power cut the MQ135 heater is cold and its resistance reads
// far off - "ppm" values in the thousands are common. Sent as-is, the node
// would raise its local alert and report every 5 s, and the backend's
// "persistent" rule (hazard_confirmation.py) can confirm a gas leak from
// the node's own repeats - a false public alert after every power cut.
// The PMS5003 fan likewise needs time before its PM values are stable.
//
// So until the warm-up time (config.h) has passed since boot - and, with
// the optional duty cycle (sj_duty.h), since the sensor was last switched
// on - the value is left OUT: its SJ_HAS_* flag stays unset (no packet format change - the
// backend already treats it as "sensor absent"), it does not count toward
// the local alert, and without SJ_HAS_GAS the edge-AI model (which needs
// gas) does not run either. The self-test reports WAIT for the same window
// (sjWarmingUp() in sj_selftest.h - one rule for both).
//
// Trade-off: a real leak in the first MQ135_WARMUP_S after a boot is not
// reported by the MQ135. The flame sensor still is (no warm-up).
// =====================================================================
#pragma once
#include <stdint.h>
#include "sj_packet.h"
#include "sj_selftest.h"

// Adds the MQ135 value to `r` only when `warm`: past the boot warm-up
// and, with the duty cycle (sj_duty.h), powered long enough since the
// heater was last switched on. Not warm = left out, no alert.
// Returns true when it should raise the local alert.
inline bool sjAddGasValueIfWarm(SjReading& r, float ppm, bool warm, float alertPpm) {
  if (!warm) return false;
  r.flags |= SJ_HAS_GAS;
  r.gas_ppm = sjClampU16(ppm);
  return ppm >= alertPpm;
}

// The boot warm-up alone (no duty cycle): warm once uptimeS >= warmupS.
inline bool sjAddGasValue(SjReading& r, float ppm, uint32_t uptimeS, uint32_t warmupS, float alertPpm) {
  return sjAddGasValueIfWarm(r, ppm, !sjWarmingUp(uptimeS, warmupS), alertPpm);
}

// Past the boot warm-up at the moment the value was MEASURED, ageMs ago (a
// PMS5003 frame is read up to seconds after it was measured: it streams
// every 0.2 - 2.3 s). The age is rounded UP to whole seconds and uptimeS is
// whole seconds rounded down, so a frame measured before the end of the
// warm-up never counts. Until 2026-10-09 the node without the duty cycle
// checked the uptime only - a frame measured ~1-2 s before the end of the
// fan's warm-up could count (tools/firmware_host_test/duty_tests.h).
inline bool sjWarmWhenMeasured(uint32_t uptimeS, uint32_t ageMs, uint32_t warmupS) {
  const uint32_t ageS = ageMs / 1000 + (ageMs % 1000 != 0 ? 1 : 0);
  return !sjWarmingUp(uptimeS > ageS ? uptimeS - ageS : 0, warmupS);
}

// Adds the PMS5003 values to `r` only when `warm` (the fan has settled -
// as for the gas value above). Returns true when they should raise the
// local alert.
inline bool sjAddPmValuesIfWarm(SjReading& r, uint16_t pm25, uint16_t pm10, bool warm, float alertPm25,
                                float alertPm10) {
  if (!warm) return false;
  r.flags |= SJ_HAS_PM;
  r.pm25 = pm25;
  r.pm10 = pm10;
  // Either fraction alone: dust storms raise PM10 with little PM2.5.
  // '>' not '>=': CPCB ranges are integers and the backend keeps a band
  // top in its own band, so with the config.h limits (120 / 350, top of
  // "Poor") the node alerts from 121 / 351, the first "Very Poor" value =
  // backend HIGH - same edge as the backend.
  return pm25 > alertPm25 || pm10 > alertPm10;
}

// The boot warm-up alone (no duty cycle).
inline bool sjAddPmValues(SjReading& r, uint16_t pm25, uint16_t pm10, uint32_t uptimeS, uint32_t warmupS,
                          float alertPm25, float alertPm10) {
  return sjAddPmValuesIfWarm(r, pm25, pm10, !sjWarmingUp(uptimeS, warmupS), alertPm25, alertPm10);
}
