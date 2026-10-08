// =====================================================================
// SANJEEVNI node - sensor drivers. Every read returns false when the
// sensor isn't fitted, didn't answer, or gave an implausible value; the
// caller then leaves that value out of the reading instead of sending 0.
// =====================================================================
#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <DHT.h>
#include "config.h"
#include "sj_selftest.h"  // SJ_ADC_FLOOR_MV: shared with the self-test verdicts

static DHT sjDht(DHT_PIN, DHT_TYPE);
static Preferences sjPrefs;

// ---------------------------------------------------------------------
// Rain gauge: each bucket tip closes the reed switch once. Counted in an
// interrupt so no tip is missed between 5 s samples; debounced because
// reed switches bounce for a few ms.
// ---------------------------------------------------------------------
static volatile uint32_t sjRainTips = 0;
static volatile uint32_t sjRainTipsSinceBoot = 0;  // self-test only, never reset
static volatile uint32_t sjLastTipMs = 0;

static void IRAM_ATTR sjOnRainTip() {
  uint32_t now = millis();
  if (now - sjLastTipMs > RAIN_DEBOUNCE_MS) {
    sjRainTips = sjRainTips + 1;  // (++ on volatile is deprecated in C++20)
    sjRainTipsSinceBoot = sjRainTipsSinceBoot + 1;
    sjLastTipMs = now;
  }
}

// Rain (mm) since the previous call. (Tips while the node is in deep
// sleep are counted by the sketch's rain-wake path, not here.)
inline float readRainSinceLastMm() {
  noInterrupts();
  uint32_t tips = sjRainTips;
  sjRainTips = 0;
  interrupts();
  return tips * RAIN_MM_PER_TIP;
}

// ---------------------------------------------------------------------
// HC-SR04 water level
// ---------------------------------------------------------------------
inline float readDistanceCm() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(5);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 30000);  // ~5 m max
  if (duration == 0) return -1;
  return duration * 0.0343f / 2.0f;
}

#define SJ_ULTRASONIC_PINGS 5

// Pings SJ_ULTRASONIC_PINGS times; the distances that echoed, sorted
// ascending, go into samples[]. Returns how many echoed.
inline int pingDistancesCm(float samples[SJ_ULTRASONIC_PINGS]) {
  int n = 0;
  for (int i = 0; i < SJ_ULTRASONIC_PINGS; i++) {
    float d = readDistanceCm();
    if (d > 0) samples[n++] = d;
    delay(30);  // let echoes die down between pings
  }
  for (int i = 1; i < n; i++)  // insertion sort, n <= 5
    for (int j = i; j > 0 && samples[j - 1] > samples[j]; j--) {
      float t = samples[j];
      samples[j] = samples[j - 1];
      samples[j - 1] = t;
    }
  return n;
}

// Water level above the empty/zero surface, metres. Median of 5 pings so a
// single multipath echo can't move the value (the backend smooths too).
inline bool readWaterLevelM(float& levelM) {
  float samples[SJ_ULTRASONIC_PINGS];
  int n = pingDistancesCm(samples);
  if (n < 3) return false;  // mostly no echo - don't guess
  float levelCm = ULTRASONIC_MOUNT_HEIGHT_CM - samples[n / 2];
  if (levelCm < 0) levelCm = 0;
  if (levelCm > ULTRASONIC_MOUNT_HEIGHT_CM) levelCm = ULTRASONIC_MOUNT_HEIGHT_CM;
  levelM = levelCm / 100.0f;
  return true;
}

// ---------------------------------------------------------------------
// DHT22
// ---------------------------------------------------------------------
inline bool readDht(float& tempC, float& humidityPct) {
  for (int attempt = 0; attempt < 2; attempt++) {
    tempC = sjDht.readTemperature();
    humidityPct = sjDht.readHumidity();
    if (!isnan(tempC) && !isnan(humidityPct)) return true;
    delay(2100);  // DHT22 needs ~2 s between reads
  }
  return false;
}

// ---------------------------------------------------------------------
// MQ135 -> CO2-equivalent ppm (same method as sanjeevni_node.ino)
// ---------------------------------------------------------------------
#define MQ135_PARA 116.6020682f
#define MQ135_PARB 2.769034857f
#define MQ135_ATMOSPHERIC_CO2_PPM 420.0f

// Sensor resistance from the millivolts at the ESP32 pin (-1 = no signal)
inline float mq135ResistanceKohm(float pinMv) {
  float vOut = pinMv / 1000.0f * MQ135_ADC_DIVIDER_RATIO;
  if (vOut < 0.01f) return -1;
  return MQ135_RL_KOHM * (MQ135_VCC - vOut) / vOut;
}

inline float readMq135ResistanceKohm() { return mq135ResistanceKohm(analogReadMilliVolts(MQ135_PIN)); }

inline float mq135Ppm(float rsKohm) { return MQ135_PARA * powf(rsKohm / MQ135_R0_KOHM, -MQ135_PARB); }

inline bool readGasPpm(float& ppm) {
  float rs = readMq135ResistanceKohm();
  if (rs <= 0) return false;  // no signal - sensor unpowered/disconnected
  ppm = mq135Ppm(rs);
  return true;
}

inline float calibrateMq135R0Kohm() {
  float rs = readMq135ResistanceKohm();
  return rs <= 0 ? -1 : rs * powf(MQ135_ATMOSPHERIC_CO2_PPM / MQ135_PARA, 1.0f / MQ135_PARB);
}

// ---------------------------------------------------------------------
// IR flame
// ---------------------------------------------------------------------
// Pull-up: a loose DO wire then reads "no flame" instead of floating and
// raising random fire alarms (modules' open-collector output still pulls
// LOW). GPIO34-39 have no internal pull-ups.
#if FLAME_PIN >= 34
#define SJ_FLAME_PIN_MODE INPUT
#else
#define SJ_FLAME_PIN_MODE INPUT_PULLUP
#endif

inline bool readFlameDetected() { return digitalRead(FLAME_PIN) == LOW; }

// Self-test: read the pin with the internal pull-down, then the pull-up.
// A connected module drives the pin, so both read the same; a loose wire
// follows the pull. Restores SJ_FLAME_PIN_MODE afterwards. GPIO34-39 have
// no internal pulls - there the loose-wire check can't be done.
inline void probeFlamePin(bool& highWithPullDown, bool& highWithPullUp) {
#if FLAME_PIN >= 34
  highWithPullDown = highWithPullUp = digitalRead(FLAME_PIN) == HIGH;
#else
  pinMode(FLAME_PIN, INPUT_PULLDOWN);
  delay(2);
  highWithPullDown = digitalRead(FLAME_PIN) == HIGH;
  pinMode(FLAME_PIN, INPUT_PULLUP);
  delay(2);
  highWithPullUp = digitalRead(FLAME_PIN) == HIGH;
  pinMode(FLAME_PIN, SJ_FLAME_PIN_MODE);
  delay(2);
#endif
}

// ---------------------------------------------------------------------
// Capacitive soil moisture -> %
// ---------------------------------------------------------------------
inline uint32_t readSoilMillivolts() { return analogReadMilliVolts(SOIL_PIN); }

inline bool readSoilMoisturePct(float& pct) {
  uint32_t mv = readSoilMillivolts();
  if (mv <= SJ_ADC_FLOOR_MV) return false;  // unplugged probe: ADC floor (~140 mV), not 0
  pct = (float)((int)SOIL_DRY_MV - (int)mv) / (SOIL_DRY_MV - SOIL_WET_MV) * 100.0f;
  pct = constrain(pct, 0.0f, 100.0f);
  return true;
}

// ---------------------------------------------------------------------
// MPU6050 - tilt relative to the installed orientation + vibration
// ---------------------------------------------------------------------
static float sjTiltBaseline[3] = {0, 0, 1};  // gravity unit vector at install
static bool sjMpuOk = false;

inline bool mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

// Acceleration in g (default +-2 g range: 16384 LSB/g)
inline bool mpuReadAccelG(float a[3]) {
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x3B);  // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)6) != 6) return false;
  for (int i = 0; i < 3; i++) {
    int16_t raw = (Wire.read() << 8) | Wire.read();
    a[i] = raw / 16384.0f;
  }
  return true;
}

inline bool mpuAverageGravity(float g[3]) {
  float sum[3] = {0, 0, 0};
  for (int i = 0; i < 50; i++) {
    float a[3];
    if (!mpuReadAccelG(a)) return false;
    for (int k = 0; k < 3; k++) sum[k] += a[k];
    delay(4);
  }
  float norm = sqrtf(sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]);
  if (norm < 1e-3f) return false;
  for (int k = 0; k < 3; k++) g[k] = sum[k] / norm;
  return true;
}

// Self-test: does anything answer at MPU6050_ADDR, and its WHO_AM_I (-1 = no answer)
inline bool mpuAcks() {
  Wire.beginTransmission(MPU6050_ADDR);
  return Wire.endTransmission() == 0;
}

inline int mpuWhoAmI() {
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x75);  // WHO_AM_I
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

inline bool zeroTiltBaseline() {
  float g[3];
  if (!mpuAverageGravity(g)) return false;
  memcpy(sjTiltBaseline, g, sizeof(g));
  sjPrefs.putBytes("tilt_base", sjTiltBaseline, sizeof(sjTiltBaseline));
  return true;
}

inline void setupMpu6050() {
  Wire.begin(I2C_SDA, I2C_SCL);
  sjMpuOk = mpuWrite(0x6B, 0x00);  // PWR_MGMT_1: wake up
  if (!sjMpuOk) {
    Serial.println("[mpu6050] not found - check wiring / I2C address");
    return;
  }
  // Use the orientation stored at installation; first boot stores the
  // current one. Re-zero after (re)mounting the node with the 'z' command.
  if (sjPrefs.getBytes("tilt_base", sjTiltBaseline, sizeof(sjTiltBaseline)) != sizeof(sjTiltBaseline)) {
    delay(100);
    zeroTiltBaseline();
    Serial.println("[mpu6050] tilt baseline stored (first boot)");
  }
}

// Before deep sleep: the MPU6050 would otherwise keep drawing ~4 mA.
// setupMpu6050() wakes it again on the next boot.
inline void mpuSleep() {
  if (sjMpuOk) mpuWrite(0x6B, 0x40);  // PWR_MGMT_1: SLEEP bit
}

// tiltDeg: angle between the current gravity direction and the installed
// one. vibrationG: largest deviation of |a| from 1 g over ~0.2 s.
inline bool readTiltAndVibration(float& tiltDeg, float& vibrationG) {
  if (!sjMpuOk) return false;
  float g[3];
  if (!mpuAverageGravity(g)) return false;
  float dot = g[0] * sjTiltBaseline[0] + g[1] * sjTiltBaseline[1] + g[2] * sjTiltBaseline[2];
  tiltDeg = acosf(constrain(dot, -1.0f, 1.0f)) * 180.0f / PI;

  vibrationG = 0;
  for (int i = 0; i < 50; i++) {
    float a[3];
    if (!mpuReadAccelG(a)) return false;
    float magnitude = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    vibrationG = max(vibrationG, fabsf(magnitude - 1.0f));
    delay(4);
  }
  return true;
}

// ---------------------------------------------------------------------
// PMS5003 - streams a 32-byte frame about once a second (active mode).
// Frame: 0x42 0x4D, length(2), 13 data words, checksum(2) = sum of the
// first 30 bytes. Uses the "atmospheric environment" PM values.
// ---------------------------------------------------------------------
static uint16_t sjPm25 = 0, sjPm10 = 0;
static uint32_t sjPmLastFrameMs = 0;
static bool sjPmEverSeen = false;

inline void setupPms5003() { Serial2.begin(9600, SERIAL_8N1, PMS_RX_PIN, PMS_TX_PIN); }

inline void pollPms5003() {
  static uint8_t frame[32];
  static uint8_t pos = 0;
  while (Serial2.available()) {
    uint8_t b = Serial2.read();
    if ((pos == 0 && b != 0x42) || (pos == 1 && b != 0x4D)) {
      pos = 0;
      continue;
    }
    frame[pos++] = b;
    if (pos < 32) continue;
    pos = 0;
    uint16_t sum = 0;
    for (int i = 0; i < 30; i++) sum += frame[i];
    if (sum != ((frame[30] << 8) | frame[31])) continue;  // corrupted frame
    sjPm25 = (frame[12] << 8) | frame[13];
    sjPm10 = (frame[14] << 8) | frame[15];
    sjPmLastFrameMs = millis();
    sjPmEverSeen = true;
  }
}

inline bool readPm(uint16_t& pm25, uint16_t& pm10) {
  pollPms5003();
  if (!sjPmEverSeen || millis() - sjPmLastFrameMs > 10000) return false;  // stale / no sensor
  pm25 = sjPm25;
  pm10 = sjPm10;
  return true;
}

// ---------------------------------------------------------------------
// pH (two-point calibration) and turbidity
// ---------------------------------------------------------------------
inline float readPhMillivolts() {
  uint32_t sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogReadMilliVolts(PH_PIN);
    delay(5);
  }
  return sum / 10.0f * PH_ADC_DIVIDER_RATIO;
}

inline bool readPh(float& ph) {
  float mv = readPhMillivolts();
  if (mv / PH_ADC_DIVIDER_RATIO <= SJ_ADC_FLOOR_MV) return false;  // board unpowered: pin at the ADC floor
  ph = 7.0f + (mv - PH_MV_AT_7) * (4.0f - 7.0f) / (PH_MV_AT_4 - PH_MV_AT_7);
  return ph >= 0.0f && ph <= 14.0f;
}

// DFRobot SEN0189 curve (valid for 2.5-4.2 V at the sensor output).
inline bool readTurbidityNtu(float& ntu) {
  uint32_t pinMv = analogReadMilliVolts(TURBIDITY_PIN);
  if (pinMv <= SJ_ADC_FLOOR_MV) return false;  // unpowered / unplugged: pin at the ADC floor
  float v = pinMv / 1000.0f * TURBIDITY_ADC_DIVIDER_RATIO;
  if (v < 2.5f) {
    ntu = 3000;  // beyond the curve's range = extremely turbid
  } else {
    ntu = -1120.4f * v * v + 5742.3f * v - 4352.9f;
    ntu = constrain(ntu, 0.0f, 3000.0f);
  }
  return true;
}

// ---------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------
inline bool readBatteryPct(float& pct) {
  float v = analogReadMilliVolts(BATTERY_PIN) / 1000.0f * BATTERY_DIVIDER_RATIO;
  if (v < 1.0f) return false;  // divider not fitted
  pct = constrain((v - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0f, 0.0f, 100.0f);
  return true;
}

// ---------------------------------------------------------------------
// Optional switched sensor power (SENSOR_POWER_PIN, deep-sleep nodes)
inline void sensorPowerOff() {
#if SENSOR_POWER_PIN >= 0
  digitalWrite(SENSOR_POWER_PIN, !SENSOR_POWER_ON);
#endif
}

// ---------------------------------------------------------------------
inline void setupSensors() {
#if SENSOR_POWER_PIN >= 0
  pinMode(SENSOR_POWER_PIN, OUTPUT);
  digitalWrite(SENSOR_POWER_PIN, SENSOR_POWER_ON);
  delay(SENSOR_WARMUP_MS);  // DHT22 / soil sensor settle after power-up
#endif
  sjPrefs.begin("sanjeevni", false);
#if ENABLE_DHT
  sjDht.begin();
#endif
#if ENABLE_WATER_LEVEL
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
#endif
#if ENABLE_FLAME
  pinMode(FLAME_PIN, SJ_FLAME_PIN_MODE);
#endif
#if ENABLE_RAIN_GAUGE
  pinMode(RAIN_GAUGE_PIN, INPUT);  // external pull-up required on GPIO39
  attachInterrupt(digitalPinToInterrupt(RAIN_GAUGE_PIN), sjOnRainTip, FALLING);
#endif
#if ENABLE_MPU6050
  setupMpu6050();
#endif
#if ENABLE_PMS5003
  setupPms5003();
#endif
  analogSetAttenuation(ADC_11db);  // full 0-3.3 V input range on ADC pins
}
