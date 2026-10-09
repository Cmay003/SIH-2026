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
// So until the warm-up time (config.h) has passed since boot, the value is
// left OUT: its SJ_HAS_* flag stays unset (no packet format change - the
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

// Adds the MQ135 value to `r` unless the heater is still warming up.
// Returns true when it should raise the local alert.
inline bool sjAddGasValue(SjReading& r, float ppm, uint32_t uptimeS, uint32_t warmupS, float alertPpm) {
  if (sjWarmingUp(uptimeS, warmupS)) return false;
  r.flags |= SJ_HAS_GAS;
  r.gas_ppm = sjClampU16(ppm);
  return ppm >= alertPpm;
}

// Adds the PMS5003 values to `r` unless the fan is still settling.
// Returns true when they should raise the local alert.
inline bool sjAddPmValues(SjReading& r, uint16_t pm25, uint16_t pm10, uint32_t uptimeS, uint32_t warmupS,
                          float alertPm25, float alertPm10) {
  if (sjWarmingUp(uptimeS, warmupS)) return false;
  r.flags |= SJ_HAS_PM;
  r.pm25 = pm25;
  r.pm10 = pm10;
  // Either fraction alone: dust storms raise PM10 with little PM2.5.
  // '>' not '>=': CPCB ranges are integers and the backend keeps the
  // band top itself LOW, so the node alerts from 61 / 101, the first
  // "Moderately polluted" value - same verdict as the backend.
  return pm25 > alertPm25 || pm10 > alertPm10;
}
