// =====================================================================
// SANJEEVNI node - self-test verdicts (hardware-independent, so they are
// unit-tested on a PC: tools/firmware_host_test).
//
// The sketch measures (raw pin millivolts, echo counts, I2C answers...)
// and these functions decide OK / WAIT / WARN / FAIL and say why. Each
// FAIL threshold is the same one the matching readX() in sensors.h uses
// to leave a value out of a reading - so "OK" here means the value will
// really be sent, and "FAIL" means it won't.
// =====================================================================
#pragma once
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>

enum SjCheck : uint8_t {
  SJ_CHECK_OK = 0,
  SJ_CHECK_WAIT,  // still warming up / settling - run the self-test again later
  SJ_CHECK_WARN,  // value is sent but probably wrong (calibration, divider...)
  SJ_CHECK_FAIL,  // value is NOT sent, or useless (sensor missing, unwired, dead)
};
static const char* const SJ_CHECK_NAMES[] = {"OK  ", "WAIT", "WARN", "FAIL"};

struct SjCheckResult {
  SjCheck status;
  char detail[120];
};

inline SjCheckResult sjResult(SjCheck status, const char* fmt, ...) {
  SjCheckResult r;
  r.status = status;
  va_list args;
  va_start(args, fmt);
  vsnprintf(r.detail, sizeof(r.detail), fmt, args);
  va_end(args);
  return r;
}

// ESP32 ADC at 11 dB attenuation is accurate up to about 3.1 V and flat
// at the top - a pin at/above this is probably clipped (missing divider or
// wrong ratio). Same limit as ESP_ADC_GOOD_V in tools/wiring.
#define SJ_ADC_CLIP_MV 3100.0f
// ...and flat at the bottom: with the factory calibration a pin at 0 V
// reads ~140 mV, never 0. So "unpowered / unplugged" means "at or below
// this floor" - sensors.h uses the same constant to leave such values out.
#define SJ_ADC_FLOOR_MV 200.0f

// ---------------------------------------------------------------------
// HC-SR04: `echoes` of `pings` answered; min / median / max distance (cm)
// of the answered ones. readWaterLevelM() needs 3 of 5.
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckUltrasonic(int echoes, int pings, float minCm, float medianCm, float maxCm,
                                       float mountCm) {
  if (echoes == 0) return sjResult(SJ_CHECK_FAIL, "no echo from %d pings", pings);
  if (echoes < 3) return sjResult(SJ_CHECK_FAIL, "only %d/%d pings echoed - level left out (needs 3)", echoes, pings);
  if (medianCm < 2.0f)
    return sjResult(SJ_CHECK_WARN, "%.1f cm - closer than the HC-SR04 minimum (2 cm)", medianCm);
  float tolerance = fmaxf(2.0f, mountCm * 0.05f);
  if (medianCm > mountCm + tolerance)
    return sjResult(SJ_CHECK_WARN, "%.1f cm, more than ULTRASONIC_MOUNT_HEIGHT_CM %.1f - level reads 0", medianCm,
                    mountCm);
  float spread = maxCm - minCm;
  if (spread > fmaxf(3.0f, medianCm * 0.1f))
    return sjResult(SJ_CHECK_WARN, "echoes vary %.1f..%.1f cm - obstruction or angled surface", minCm, maxCm);
  float levelCm = fminf(fmaxf(mountCm - medianCm, 0.0f), mountCm);
  return sjResult(echoes < pings ? SJ_CHECK_WARN : SJ_CHECK_OK, "%.1f cm -> level %.3f m (%d/%d echoes)", medianCm,
                  levelCm / 100.0f, echoes, pings);
}

// ---------------------------------------------------------------------
// DHT22 (`ok` = readDht() succeeded)
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckDht(bool ok, float tempC, float humidityPct) {
  if (!ok) return sjResult(SJ_CHECK_FAIL, "no answer (2 tries)");
  if (tempC < -40.0f || tempC > 80.0f || humidityPct < 0.0f || humidityPct > 100.0f)
    return sjResult(SJ_CHECK_WARN, "%.1f C %.0f %% - outside the DHT22 range", tempC, humidityPct);
  return sjResult(SJ_CHECK_OK, "%.1f C, %.0f %% humidity", tempC, humidityPct);
}

// ---------------------------------------------------------------------
// MQ135: millivolts at the ESP32 pin, the divider ratio, the computed
// resistance / ppm, and seconds since power-on (heater warm-up).
// ---------------------------------------------------------------------
#define SJ_MQ135_WARMUP_S 120

inline SjCheckResult sjCheckMq135(float pinMv, float dividerRatio, float rsKohm, float ppm, uint32_t uptimeS) {
  float aoV = pinMv * dividerRatio / 1000.0f;
  // readGasPpm() drops the value when Rs <= 0 (AO at/above MQ135_VCC) -
  // a clipped pin with a 2:1 divider always lands here, so check it first.
  if (rsKohm <= 0) {
    if (pinMv >= SJ_ADC_CLIP_MV)
      return sjResult(SJ_CHECK_FAIL, "pin at %.0f mV (ADC max ~3100) - divider missing or ratio wrong", pinMv);
    return sjResult(SJ_CHECK_FAIL, "AO %.2f V is at/above MQ135_VCC - check MQ135_VCC / divider ratio", aoV);
  }
  if (pinMv >= SJ_ADC_CLIP_MV)
    return sjResult(SJ_CHECK_WARN, "pin at %.0f mV (ADC max ~3100) - divider missing or ratio wrong", pinMv);
  // The value is still sent here, but the ADC can't tell an unpowered
  // sensor from clean air with a small load resistor.
  if (pinMv <= SJ_ADC_FLOOR_MV)
    return sjResult(SJ_CHECK_WARN, "pin at the ADC floor (%.0f mV) - unpowered, or RL too small for clean air", pinMv);
  if (uptimeS < SJ_MQ135_WARMUP_S)
    return sjResult(SJ_CHECK_WAIT, "heater warming up (%us of %us) - %.0f ppm not valid yet", (unsigned)uptimeS,
                    (unsigned)SJ_MQ135_WARMUP_S, ppm);
  if (ppm < 10.0f || ppm > 10000.0f)
    return sjResult(SJ_CHECK_WARN, "%.0f ppm is implausible - calibrate R0 with 'r' in clean air", ppm);
  return sjResult(SJ_CHECK_OK, "AO %.2f V, Rs %.1f kOhm -> %.0f ppm", aoV, rsKohm, ppm);
}

// ---------------------------------------------------------------------
// IR flame (active LOW): the pin read with the internal pull-down, then
// the pull-up, then plain. A connected module drives the pin, so both
// pulls read the same; an unconnected pin just follows the pull.
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckFlame(bool highWithPullDown, bool highWithPullUp, bool highPlain) {
  // (The flame value is still sent - always "no flame" via the pull-up -
  // but a fire would be missed, so this is a FAIL.)
  if (!highWithPullDown && highWithPullUp)
    return sjResult(SJ_CHECK_FAIL, "pin follows the internal pull - module not connected, a fire would be missed");
  if (!highPlain)
    return sjResult(SJ_CHECK_WARN, "sees FLAME now - if there is none, turn the module's pot (sun/IR trigger it)");
  return sjResult(SJ_CHECK_OK, "no flame seen (DO high)");
}

// ---------------------------------------------------------------------
// Rain gauge: the reed switch is open (pin HIGH via the external pull-up)
// except during a tip.
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckRain(bool pinHigh, uint32_t tipsSinceBoot) {
  if (!pinHigh)
    return sjResult(SJ_CHECK_WARN, "pin LOW at rest - reed stuck closed or 10k pull-up missing (%u tips)",
                    (unsigned)tipsSinceBoot);
  return sjResult(SJ_CHECK_OK, "idle, %u tip(s) since boot - tip the bucket and run 't' again",
                  (unsigned)tipsSinceBoot);
}

// ---------------------------------------------------------------------
// Capacitive soil moisture (readSoilMoisturePct() drops <= the ADC floor)
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckSoil(uint32_t mv, uint32_t dryMv, uint32_t wetMv) {
  if (mv <= SJ_ADC_FLOOR_MV) return sjResult(SJ_CHECK_FAIL, "%u mV - probe unplugged / unpowered", (unsigned)mv);
  if (mv >= SJ_ADC_CLIP_MV) return sjResult(SJ_CHECK_WARN, "%u mV - at the ADC maximum", (unsigned)mv);
  if (mv > dryMv + 200 || mv + 200 < wetMv)
    return sjResult(SJ_CHECK_WARN, "%u mV is outside SOIL_WET_MV..SOIL_DRY_MV (%u..%u) - recalibrate with 's'",
                    (unsigned)mv, (unsigned)wetMv, (unsigned)dryMv);
  float pct = (float)((int)dryMv - (int)mv) / (float)((int)dryMv - (int)wetMv) * 100.0f;
  pct = fminf(fmaxf(pct, 0.0f), 100.0f);
  return sjResult(SJ_CHECK_OK, "%u mV -> %.0f %%", (unsigned)mv, pct);
}

// ---------------------------------------------------------------------
// MPU6050: I2C answer at boot (`initialised`) and now (`acksNow`), the
// WHO_AM_I register, a gravity sample, and the tilt from the baseline.
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckMpu(bool initialised, bool acksNow, int whoAmI, bool readOk, float gravityG,
                                float tiltDeg, float tiltLimitDeg) {
  if (!acksNow) return sjResult(SJ_CHECK_FAIL, "no I2C answer");
  if (!initialised) return sjResult(SJ_CHECK_FAIL, "answers now but not at boot - press RESET to use it");
  if (!readOk) return sjResult(SJ_CHECK_FAIL, "accelerometer read failed");
  // 0x68 MPU6050; 0x70 / 0x71 / 0x73 = MPU6500 / 9250 / 9255 sold as "MPU6050"
  // boards - same accelerometer registers.
  if (whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73)
    return sjResult(SJ_CHECK_WARN, "unexpected chip id 0x%02X - not an MPU6050?", whoAmI & 0xFF);
  if (fabsf(gravityG - 1.0f) > 0.15f)
    return sjResult(SJ_CHECK_WARN, "|a| = %.2f g at rest (expect ~1.00) - loose mount or vibration", gravityG);
  if (tiltDeg >= tiltLimitDeg)
    return sjResult(SJ_CHECK_WARN, "tilted %.1f deg from the baseline - send 'z' if just (re)mounted", tiltDeg);
  return sjResult(SJ_CHECK_OK, "chip 0x%02X, |a| = %.2f g, tilt %.1f deg", whoAmI & 0xFF, gravityG, tiltDeg);
}

// ---------------------------------------------------------------------
// PMS5003 (readPm() needs a valid frame within the last 10 s)
// ---------------------------------------------------------------------
#define SJ_PMS_WARMUP_S 30

inline SjCheckResult sjCheckPms(bool everSeen, uint32_t frameAgeMs, uint16_t pm25, uint16_t pm10, uint32_t uptimeS) {
  if (!everSeen) return sjResult(SJ_CHECK_FAIL, "no valid frame received");
  if (frameAgeMs > 10000)
    return sjResult(SJ_CHECK_FAIL, "last frame %us ago - sensor stopped sending", (unsigned)(frameAgeMs / 1000));
  if (uptimeS < SJ_PMS_WARMUP_S)
    return sjResult(SJ_CHECK_WAIT, "fan settling (%us of %us) - PM2.5 %u, PM10 %u", (unsigned)uptimeS,
                    (unsigned)SJ_PMS_WARMUP_S, pm25, pm10);
  if (pm25 > pm10) return sjResult(SJ_CHECK_WARN, "PM2.5 %u > PM10 %u - impossible, bad frames?", pm25, pm10);
  return sjResult(SJ_CHECK_OK, "PM2.5 %u, PM10 %u ug/m3", pm25, pm10);
}

// ---------------------------------------------------------------------
// pH board (readPh(): pin at the ADC floor = unpowered; pH outside 0-14
// dropped)
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckPh(float pinMv, float dividerRatio, float mvAt7, float mvAt4) {
  float mv = pinMv * dividerRatio;
  if (pinMv <= SJ_ADC_FLOOR_MV) return sjResult(SJ_CHECK_FAIL, "pin %.0f mV - board unpowered or unplugged", pinMv);
  bool clipped = pinMv >= SJ_ADC_CLIP_MV;
  float ph = 7.0f + (mv - mvAt7) * (4.0f - 7.0f) / (mvAt4 - mvAt7);
  if (ph < 0.0f || ph > 14.0f) {
    if (clipped)
      return sjResult(SJ_CHECK_FAIL, "pin at %.0f mV (ADC max ~3100) -> pH %.1f, left out - bigger divider needed",
                      pinMv, ph);
    return sjResult(SJ_CHECK_FAIL, "%.0f mV -> pH %.1f, outside 0-14 - left out; recalibrate with 'p'", mv, ph);
  }
  if (clipped) return sjResult(SJ_CHECK_WARN, "pin at %.0f mV (ADC max ~3100) - bigger divider needed", pinMv);
  return sjResult(SJ_CHECK_OK, "%.0f mV -> pH %.2f", mv, ph);
}

// ---------------------------------------------------------------------
// Turbidity (readTurbidityNtu(): pin at the ADC floor = unplugged; < 2.5 V
// is off the sensor curve and reported as 3000 NTU). Clear water: ~4.1 V.
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckTurbidity(float pinMv, float dividerRatio) {
  float v = pinMv * dividerRatio / 1000.0f;
  if (pinMv <= SJ_ADC_FLOOR_MV) return sjResult(SJ_CHECK_FAIL, "pin %.0f mV - unpowered or unplugged", pinMv);
  if (pinMv >= SJ_ADC_CLIP_MV)
    return sjResult(SJ_CHECK_WARN, "pin at %.0f mV (ADC max ~3100) - bigger divider needed", pinMv);
  if (v < 2.5f)
    return sjResult(SJ_CHECK_WARN, "%.2f V - reported as 3000 NTU; clear water should read ~4.1 V (divider ratio?)", v);
  float ntu = fminf(fmaxf(-1120.4f * v * v + 5742.3f * v - 4352.9f, 0.0f), 3000.0f);
  return sjResult(SJ_CHECK_OK, "%.2f V -> %.0f NTU", v, ntu);
}

// ---------------------------------------------------------------------
// Battery divider (readBatteryPct(): < 1 V = divider not fitted)
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckBattery(float pinMv, float dividerRatio, float emptyV, float fullV) {
  float v = pinMv * dividerRatio / 1000.0f;
  if (v < 1.0f) return sjResult(SJ_CHECK_FAIL, "%.2f V - divider not fitted", v);
  if (pinMv >= SJ_ADC_CLIP_MV) return sjResult(SJ_CHECK_WARN, "pin at %.0f mV - at the ADC maximum", pinMv);
  if (v > fullV + 0.15f)
    return sjResult(SJ_CHECK_WARN, "%.2f V is above a full cell (%.1f V) - BATTERY_DIVIDER_RATIO wrong?", v, fullV);
  float pct = fminf(fmaxf((v - emptyV) / (fullV - emptyV) * 100.0f, 0.0f), 100.0f);
  if (v < emptyV) return sjResult(SJ_CHECK_WARN, "%.2f V - battery empty, charge it", v);
  return sjResult(SJ_CHECK_OK, "%.2f V -> %.0f %%", v, pct);
}

// ---------------------------------------------------------------------
// SX127x LoRa: the version register read over SPI now, and radio.begin()'s
// result code at boot (0 = ok; RadioLib error codes are negative).
// ---------------------------------------------------------------------
#define SJ_LORA_ERR_CHIP_NOT_FOUND (-2)  // = RADIOLIB_ERR_CHIP_NOT_FOUND (checked in the sketch)

inline SjCheckResult sjCheckLora(int chipVersion, int beginState) {
  // 0x12 SX1276/77/78 (datasheet), 0x13 seen on some SX1278, 0x11 RFM9x -
  // the same set RadioLib's SX1278 driver accepts.
  bool known = chipVersion == 0x12 || chipVersion == 0x13 || chipVersion == 0x11;
  if (!known) {
    if (chipVersion == 0x00 || chipVersion == 0xFF || chipVersion < 0)
      return sjResult(SJ_CHECK_FAIL, "SPI reads 0x%02X - radio not answering", chipVersion & 0xFF);
    return sjResult(SJ_CHECK_FAIL, "chip version 0x%02X - not an SX1278", chipVersion & 0xFF);
  }
  if (beginState == SJ_LORA_ERR_CHIP_NOT_FOUND)
    return sjResult(SJ_CHECK_FAIL, "answers now but was not found at boot - press RESET");
  if (beginState != 0)  // chip is there but rejected a setting - RESET won't help
    return sjResult(SJ_CHECK_FAIL, "init error %d at boot - check LORA_* in config.h (SX1278: 137-175 / 395-525 MHz)",
                    beginState);
  return sjResult(SJ_CHECK_OK, "SX127x found (version 0x%02X)", chipVersion);
}

// ---------------------------------------------------------------------
// WiFi transport
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckWifi(bool connected, int rssiDbm) {
  if (!connected) return sjResult(SJ_CHECK_FAIL, "not connected - readings stay queued");
  if (rssiDbm < -80) return sjResult(SJ_CHECK_WARN, "connected, weak signal %d dBm", rssiDbm);
  return sjResult(SJ_CHECK_OK, "connected, %d dBm", rssiDbm);
}

// ---------------------------------------------------------------------
// LittleFS queue
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckQueue(bool mounted, uint32_t count, uint32_t capacity, uint32_t dropped) {
  if (!mounted) return sjResult(SJ_CHECK_FAIL, "LittleFS unavailable - readings won't survive outages");
  if (count * 5 >= capacity * 4)
    return sjResult(SJ_CHECK_WARN, "%u/%u waiting - nearly full, is the link down?", (unsigned)count,
                    (unsigned)capacity);
  if (dropped > 0)
    return sjResult(SJ_CHECK_WARN, "%u/%u waiting, %u lost to overflow since the queue was created",
                    (unsigned)count, (unsigned)capacity, (unsigned)dropped);
  return sjResult(SJ_CHECK_OK, "%u/%u waiting", (unsigned)count, (unsigned)capacity);
}

// ---------------------------------------------------------------------
// Edge AI model (needs water + DHT + gas + flame enabled to be used)
// ---------------------------------------------------------------------
inline SjCheckResult sjCheckEdge(bool modelReady, bool inputsEnabled) {
  if (!modelReady) return sjResult(SJ_CHECK_WARN, "model unavailable - readings carry no edge verdict");
  if (!inputsEnabled) return sjResult(SJ_CHECK_OK, "loaded, unused on this node (needs water+DHT+gas+flame)");
  return sjResult(SJ_CHECK_OK, "loaded");
}

// ---------------------------------------------------------------------
struct SjSelfTestTally {
  uint8_t counts[4];
};

inline void sjTallyAdd(SjSelfTestTally& t, SjCheck status) {
  if (status <= SJ_CHECK_FAIL) t.counts[status]++;
}

// One-line verdict for the end of the self-test
inline const char* sjTallyVerdict(const SjSelfTestTally& t) {
  if (t.counts[SJ_CHECK_FAIL]) return "fix the FAIL lines before deploying";
  if (t.counts[SJ_CHECK_WARN]) return "works, but check the WARN lines";
  if (t.counts[SJ_CHECK_WAIT]) return "run 't' again once warmed up";
  return "all good";
}
