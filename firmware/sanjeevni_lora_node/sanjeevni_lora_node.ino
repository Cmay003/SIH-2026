/*
 * SANJEEVNI - LoRa sensor node (Phase 2)
 * =====================================================================
 * Samples every sensor every 5 s, runs an edge-AI model on the device
 * (edge_ai.h: the MAIN model with water + DHT + gas + flame fitted, the
 * LITE one on any other kit - deep-sleep wakes included; config.h
 * EDGE_MODEL), and decides locally what to send (sj_report.h):
 *   - urgent (edge AI WATCH/URGENT, a local threshold, a fast river rise,
 *     a newly raised sensor anomaly, an SOS): send NOW, and ahead of any
 *     queued backlog (urgent outbox; its queued copy is not sent twice)
 *   - normal: one report per NORMAL_REPORT_INTERVAL_MS (5 min without a
 *     siren, 1 min with one - config.h) - the latest sample plus a SUMMARY
 *     (min / max / mean, highest edge verdict) of every sample since the
 *     previous report (SUMMARY_ENABLE)
 * Every reading to send goes into a LittleFS queue first and is removed
 * only after the gateway (LoRa) or backend (WiFi) acknowledges it - so
 * readings survive link outages and reboots (store-and-forward).
 * MQ135 gas and PMS5003 PM values are left out (and can't trigger the
 * local alert) until MQ135_WARMUP_S / PMS5003_WARMUP_S after each boot:
 * a cold heater / fan gives false values (sj_warmup.h).
 * Optional for solar nodes (MQ135_DUTY_CYCLE / PMS5003_DUTY_CYCLE, off by
 * default; sj_duty.h): the heater / fan are switched on only around the
 * reports that carry their value, and stay on while the node is elevated.
 *
 * SOS button (SOS_BUTTON_PIN, config.h) - for people with no phone: held
 * for SOS_HOLD_MS it measures at once and sends that reading flagged as an
 * SOS BEFORE any queued backlog (sj_sos.h, SjPriorityOutbox in
 * sj_packet.h); it is queued on flash as well, so it is retried until
 * acknowledged and survives a reboot. The server raises an SOS at the
 * node's registered position. It also wakes a deep-sleeping node.
 *
 * Village siren (SIREN_PIN, config.h; sj_siren.h): sounds when the server
 * commands it - the command comes in the gateway's ACK of one of our
 * readings (SjAckCmd) - or, only as an offline fallback, when the gateway
 * has not answered for SIREN_OFFLINE_AFTER_S and the water level or gas is
 * at its siren danger level on consecutive samples (evacuation hazards
 * only - never heat, PM, tilt, flame or an edge-AI verdict on its own;
 * decision 2026-10-09). Every reading says whether it is fitted /
 * sounding / why, and a change is reported at once. A command over LoRa is
 * obeyed only if its MAC checks out with this node's SIREN_CMD_KEY
 * (secrets.h; sj_auth.h) - without a key the node still acknowledges and
 * still has its offline fallback, but no LoRa command can sound it.
 *
 * Flash flood + sensor anomalies (sj_anomaly.h): every regular sample
 * updates the river's rate of rise (cm/min over RISE_WINDOW_S); a fast rise
 * is flagged (fast_rise) and sent at once. Per-sensor checks - stuck value,
 * spike, physically impossible rate, dropouts - go into every reading as
 * edge_anomaly for the backend; a value they doubt never sounds the
 * offline siren on its own.
 *
 * Offline SOS Wi-Fi (SOS_HOTSPOT_ENABLE, mains/solar LoRa nodes; sj_hotspot.h):
 * an open access point "SANJEEVNI-SOS" with a captive SOS page. A request
 * is kept in an outbox (RAM + NVS) and sent to the gateway as an SjSosMsg
 * packet, ahead of everything else, until the gateway ACKs it.
 *
 * DEEP_SLEEP_ENABLED 1 (config.h, battery nodes without MQ135/PMS5003):
 * each wake measures once, queues, sends, and sleeps again - every
 * DEEP_SLEEP_INTERVAL_S, or DEEP_SLEEP_ELEVATED_INTERVAL_S after an
 * elevated reading. A rain-gauge tip wakes the node just long enough to
 * count it. After a real power-on the node first runs always-on for
 * DEEP_SLEEP_SETUP_WINDOW_MS so the Serial commands below can be used.
 *
 * Libraries (Arduino Library Manager): RadioLib (jgromes), DHT sensor
 * library (Adafruit), Chirale_TensorFLowLite. Board: ESP32 Dev Module
 * (esp32 by Espressif 3.3.x). Partition scheme must include a
 * SPIFFS/LittleFS partition (the default one does).
 *
 * Compiles for ESP32 (checked with arduino-cli), but NOT YET FLASHED -
 * test on your board, starting with the Serial Monitor at 115200 baud.
 *
 * Serial commands: t = self-test (every sensor + radio + queue, OK/WAIT/
 * WARN/FAIL with a wiring hint; also runs once after power-on), z = re-zero
 * tilt, r = MQ135 R0 calibration value, s = soil millivolts, p = pH
 * millivolts, q = queue status, c = clear queue
 */
#include <Arduino.h>
#include <esp_sleep.h>
#include <esp_timer.h>
#include <sys/time.h>
#include "config.h"
#if DEEP_SLEEP_ENABLED && SOS_BUTTON_PIN >= 0
#include <driver/rtc_io.h>  // the button's pull-up has to stay on in deep sleep
#endif
#include "sj_packet.h"
#include "sj_file_queue.h"
#include "sj_sleep.h"
#include "sj_session.h"
#include "sj_selftest.h"
#include "sj_warmup.h"
#include "sj_duty.h"
#include "sj_sos.h"
#include "sj_siren.h"
#include "sj_anomaly.h"
#include "sj_report.h"
#include "sj_hotspot.h"
#include "sensors.h"
#include "edge_ai.h"

#if TRANSPORT == TRANSPORT_LORA
#include <SPI.h>
#include <RadioLib.h>
// secrets.h is optional on a LoRa node: only SIREN_CMD_KEY is read from it.
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#elif TRANSPORT == TRANSPORT_WIFI
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "secrets.h"
#else
#error "Set TRANSPORT in config.h"
#endif
#if SOS_HOTSPOT_ENABLE
#include <WiFi.h>
#include "sj_hotspot_ap.h"
#endif

// One queued reading + when it was measured (device seconds since boot) +
// its summary (used only with SJ_X_SUMMARY). The summary is last: the
// queue upgrade (sjUpgradeRecord) converts the older layouts without it.
struct QueuedReading {
  SjReading reading;
  uint32_t takenAtS;
  SjSummary summary;
};

static SjFileQueue<QueuedReading> queue;
static uint32_t session = 0;  // random start per board, +1 every power-on, persisted in NVS (sj_session.h)
static uint32_t seq = 0;

static uint32_t lastSampleMs = 0;
static uint32_t lastReportMs = 0;
static uint32_t nextFlushMs = 0;
static float pendingRainMm = 0;  // rain since the last REPORTED reading
static bool elevated = false;
static uint32_t lastSerialMs = 0;  // deep sleep: a Serial command keeps the node awake

// What setup() managed to start - reported by the self-test
static bool queueOk = false;
static bool edgeOk = false;

// Survives deep sleep and resets (not a power-on) - see sj_sleep.h
RTC_DATA_ATTR static SjSleepState sleepState;
static bool resumedFromSleep = false;

// SOS readings waiting to be sent before the backlog (sj_packet.h). Two:
// a second SOS after the cooldown while the first is still unsent.
static SjPriorityOutbox<QueuedReading, 2> sosOutbox;
// Urgent readings (SJ_X_PRIORITY) waiting to go ahead of the backlog, right
// after the SOS ones; full = the oldest falls back to its place in the
// queue. And the readings that went ahead, so their queued copies are not
// sent again (sj_packet.h). Both RAM: lost in deep sleep / a reset, which
// costs at worst one duplicate packet per reading, never a reading.
static SjPriorityOutbox<QueuedReading, URGENT_OUTBOX_SLOTS> urgentOutbox;
static SjSentAhead<SENT_AHEAD_SLOTS> sentAhead;
// The regular samples since the last regular report (sj_report.h)
static SjSummaryAcc summaryAcc;
static bool sosRequested = false;      // the button was held: measure + send an SOS reading
static uint32_t sosConfirmedAtMs = 0;  // the gateway has the SOS: LED on for SOS_LED_CONFIRM_MS from here
static bool sosConfirmed = false;

#if SIREN_PIN >= 0
static const SjSirenTiming SIREN_TIMING = {SIREN_OFFLINE_AFTER_S * 1000UL, SIREN_OFFLINE_URGENT_SAMPLES,
                                           SIREN_ON_S * 1000UL, SIREN_MAX_ON_S * 1000UL, SIREN_COOLDOWN_S * 1000UL};
static SjSiren siren;
#endif
#if SIREN_PIN >= 0 && TRANSPORT == TRANSPORT_LORA
#ifndef SIREN_CMD_KEY
#define SIREN_CMD_KEY ""  // no secrets.h entry: LoRa siren commands are refused (setupSiren() says so)
#endif
static uint8_t sirenCmdKey[SJ_CMD_KEY_LEN];
static bool sirenCmdKeyOk = false;  // SIREN_CMD_KEY parsed: commands in the gateway's ACK are checked with it
#endif
static bool sirenReportDue = false;  // the siren started / stopped: measure and report now

// River rise rate + sensor anomaly checks (sj_anomaly.h). On a deep-sleep
// node in RTC memory, so the history survives the sleeps (magic-checked;
// a power-on starts it over).
#if DEEP_SLEEP_ENABLED
RTC_DATA_ATTR
#endif
static SjEdgeTrack edgeTrack;
static SjEdgeConfig edgeConfig;

// Seconds on the RTC clock. Unlike esp_timer (which restarts at 0 on every
// wake), it keeps counting through deep sleep, so a reading queued before
// a sleep still gets its true age when it is finally sent. It restarts on
// a power-on - the new session number then marks old readings' age as
// unknown.
static uint32_t deviceSeconds() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint32_t)tv.tv_sec;
}

// Seconds since this boot, for the gas/PM warm-up (sj_warmup.h) and the
// self-test. The 64-bit esp_timer restarts at every reset - right, because
// a reset is when the warm-up starts. millis() / 1000 would wrap after
// 49.7 days and switch the gas/PM values off again for minutes.
static uint32_t uptimeSeconds() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }

// Milliseconds on the same RTC clock as deviceSeconds() - it keeps running
// through deep sleep, so the rise rate spans wakes. Wraps after 49.7 days;
// sj_anomaly.h only takes differences.
static uint32_t deviceMillis() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint32_t)((uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL);
}

// =====================================================================
// Gas / PM duty cycle (solar nodes; sj_duty.h, config.h) - off by default.
// Off: the sensors are always powered and "warm" means past the boot
// warm-up only - exactly the behaviour without the duty cycle.
// =====================================================================
#if MQ135_DUTY_CYCLE
static const SjDutyCfg GAS_DUTY =
    sjDutyConfig(MQ135_WARMUP_S, DUTY_MARGIN_S, NORMAL_REPORT_INTERVAL_MS, SJ_DUTY_EVERY_N(MQ135_DUTY_PERIOD_S));
static SjDuty gasDuty;
static void setGasHeater(bool on) { digitalWrite(MQ135_HEATER_PIN, on ? MQ135_HEATER_ON : !MQ135_HEATER_ON); }
#endif
#if PMS5003_DUTY_CYCLE
static const SjDutyCfg PM_DUTY =
    sjDutyConfig(PMS5003_WARMUP_S, DUTY_MARGIN_S, NORMAL_REPORT_INTERVAL_MS, SJ_DUTY_EVERY_N(PMS5003_DUTY_PERIOD_S));
static SjDuty pmDuty;
static uint32_t pmsCmdMs = 0;  // last sleep / wake command
static void pmsSetAwake(bool awake) {
#if PMS5003_SET_PIN >= 0
  digitalWrite(PMS5003_SET_PIN, awake ? HIGH : LOW);  // datasheet: LOW = sleeping mode
#else
  uint8_t cmd[7];
  sjPmsCommand(cmd, SJ_PMS_CMD_SLEEP_SET, awake ? 1 : 0);
  Serial2.write(cmd, sizeof(cmd));
#endif
  pmsCmdMs = millis();
}
#endif

#if ENABLE_GAS
static bool gasPowered() {
#if MQ135_DUTY_CYCLE
  return gasDuty.powered;
#else
  return true;
#endif
}
// Seconds the heater has been on - the self-test's "warming up (Ns of Ws)"
static uint32_t gasPoweredS() {
  uint32_t s = uptimeSeconds();
#if MQ135_DUTY_CYCLE
  uint32_t on = sjDutyPoweredMs(gasDuty, millis()) / 1000;
  if (on < s) s = on;
#endif
  return s;
}
// A value read now counts: past the boot warm-up and, with the duty cycle,
// MQ135_WARMUP_S since the heater was last switched on.
static bool gasWarm() {
  bool warm = !sjWarmingUp(uptimeSeconds(), MQ135_WARMUP_S);
#if MQ135_DUTY_CYCLE
  warm = warm && sjDutyWarm(gasDuty, GAS_DUTY, millis(), 0);
#endif
  return warm;
}
#endif
#if ENABLE_PMS5003
static bool pmPowered() {
#if PMS5003_DUTY_CYCLE
  return pmDuty.powered;
#else
  return true;
#endif
}
static uint32_t pmPoweredS() {
  uint32_t s = uptimeSeconds();
#if PMS5003_DUTY_CYCLE
  uint32_t on = sjDutyPoweredMs(pmDuty, millis()) / 1000;
  if (on < s) s = on;
#endif
  return s;
}
// A frame received frameAgeMs ago counts: it was measured past the boot
// warm-up (sjWarmWhenMeasured) and, with the duty cycle, after the fan had
// run PMS5003_WARMUP_S since it was last switched on.
static bool pmWarm(uint32_t frameAgeMs) {
  bool warm = sjWarmWhenMeasured(uptimeSeconds(), frameAgeMs, PMS5003_WARMUP_S);
#if PMS5003_DUTY_CYCLE
  warm = warm && sjDutyWarm(pmDuty, PM_DUTY, millis(), frameAgeMs);
#endif
  return warm;
}
// readPm() found no frame for 10 s: a dropout once the PMS5003 should be
// streaming - past the boot warm-up and, with the duty cycle,
// PMS5003_WARMUP_S since it was switched ON (sjDutyMissIsDropout: counted
// from the wake, so the repeated wake commands to a dead module do not
// hide it). A slow first frame after a wake is not a dropout.
static bool pmMissIsDropout() {
  bool due = !sjWarmingUp(uptimeSeconds(), PMS5003_WARMUP_S);
#if PMS5003_DUTY_CYCLE
  due = due && sjDutyMissIsDropout(pmDuty, PM_DUTY, millis());
#endif
  return due;
}
#endif

static void setupDutyCycle() {
#if MQ135_DUTY_CYCLE
  pinMode(MQ135_HEATER_PIN, OUTPUT);
  setGasHeater(true);  // on at boot: the first warm-up starts with the node
  sjDutyBegin(gasDuty, millis());
  Serial.printf("[duty] MQ135 heater duty cycle: gas in every %u. report (warm-up %us)\n", (unsigned)GAS_DUTY.everyN,
                (unsigned)MQ135_WARMUP_S);
#endif
#if PMS5003_DUTY_CYCLE
#if PMS5003_SET_PIN >= 0
  pinMode(PMS5003_SET_PIN, OUTPUT);
#endif
  pmsSetAwake(true);  // a reset of the ESP32 does not wake a PMS5003 slept by the serial command
  sjDutyBegin(pmDuty, millis());
  Serial.printf("[duty] PMS5003 duty cycle (%s): PM in every %u. report (fan settles %us)\n",
                PMS5003_SET_PIN >= 0 ? "SET pin" : "serial command", (unsigned)PM_DUTY.everyN,
                (unsigned)PMS5003_WARMUP_S);
#endif
}

// Every loop(): switch the heater / fan for the next report that should
// carry their value; both stay on while the node is elevated.
static void serviceDutyCycle() {
#if MQ135_DUTY_CYCLE || PMS5003_DUTY_CYCLE
  uint32_t now = millis();
#endif
#if MQ135_DUTY_CYCLE
  SjDutyAction g = sjDutyStep(gasDuty, GAS_DUTY, now, lastReportMs, NORMAL_REPORT_INTERVAL_MS, elevated);
  if (g != SJ_DUTY_STAY) {
    setGasHeater(g == SJ_DUTY_WAKE);
    Serial.println(g == SJ_DUTY_WAKE ? "[duty] MQ135 heater on - warming up" : "[duty] MQ135 heater off");
  }
#endif
#if PMS5003_DUTY_CYCLE
  SjDutyAction p = sjDutyStep(pmDuty, PM_DUTY, now, lastReportMs, NORMAL_REPORT_INTERVAL_MS, elevated);
  if (p != SJ_DUTY_STAY) {
    pmsSetAwake(p == SJ_DUTY_WAKE);
    Serial.println(p == SJ_DUTY_WAKE ? "[duty] PMS5003 awake - fan settling" : "[duty] PMS5003 asleep");
  }
#if PMS5003_SET_PIN < 0
  // The serial command can be missed (e.g. sent while the module was
  // sending): repeat it while the PMS5003 does not obey (sj_duty.h).
  // A repeated wake restarts the warm-up: the fan may only start now.
  else if (sjPmsResendDue(pmDuty, now, pmsCmdMs, sjPmEverSeen, sjPmLastFrameMs)) {
    pmsSetAwake(pmDuty.powered);
    sjDutyRestartWarmUp(pmDuty, now);
  }
#endif
#endif
}

// After every reading that went out as a report: did it carry a warm value?
static void dutyOnReport(const SjReading& r) {
#if MQ135_DUTY_CYCLE
  sjDutyOnReport(gasDuty, (r.flags & SJ_HAS_GAS) != 0);
#endif
#if PMS5003_DUTY_CYCLE
  sjDutyOnReport(pmDuty, (r.flags & SJ_HAS_PM) != 0);
#endif
  (void)r;
}

// =====================================================================
// Reading
// =====================================================================
// Every sensor is optional (modular nodes): one that is disabled or fails
// is simply left out, so e.g. a dead DHT22 no longer throws away a good
// water level. Returns false only if NOTHING could be measured - the
// backend rejects such a reading, so it isn't queued.
// failed: bit (1 << SJ_AF_*) per watched sensor that is fitted but did not
// answer this time - the anomaly checks count these as dropouts (a sensor
// still warming up is not a failure).
static bool takeReading(SjReading& r, bool& localAlert, uint8_t& failed) {
  memset(&r, 0, sizeof(r));
  r.magic = SJ_MAGIC;
  r.version = SJ_VERSION;
  r.type = SJ_TYPE_READING;
  strncpy(r.node_id, NODE_ID, SJ_NODE_ID_LEN);
  r.edge_risk = SJ_EDGE_NONE;
  localAlert = false;
  failed = 0;

  float waterM = 0, tempC = 0, humidity = 0, gasPpm = 0;
  bool flame = false;
#if ENABLE_WATER_LEVEL
  if (readWaterLevelM(waterM)) {
    r.flags |= SJ_HAS_WATER;
    r.water_level_mm = sjClampU16(waterM * 1000.0f);
    localAlert |= waterM >= LOCAL_WATER_FRACTION_LIMIT * ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f;
  } else {
    failed |= 1u << SJ_AF_WATER;
    Serial.println("[sensor] water level: no echo");
  }
#endif
#if ENABLE_DHT
  if (readDht(tempC, humidity)) {
    r.flags |= SJ_HAS_DHT;
    r.temp_c_x100 = sjClampI16(tempC * 100);
    r.humidity_x100 = sjClampU16(humidity * 100);
    localAlert |= tempC >= LOCAL_TEMP_LIMIT_C;
  } else {
    failed |= (1u << SJ_AF_TEMP) | (1u << SJ_AF_HUMIDITY);
    Serial.println("[sensor] DHT22 read failed");
  }
#endif
#if ENABLE_GAS
  // Still read during the warm-up, so a missing sensor is reported at once;
  // the value itself is only used once warm (sj_warmup.h). Heater off (duty
  // cycle): not read at all - no value, and not a dropout.
  if (!gasPowered()) {
  } else if (readGasPpm(gasPpm)) {
    localAlert |= sjAddGasValueIfWarm(r, gasPpm, gasWarm(), LOCAL_GAS_LIMIT_PPM);
  } else {
    failed |= 1u << SJ_AF_GAS;
    Serial.println("[sensor] MQ135: no signal");
  }
#endif
#if ENABLE_FLAME
  flame = readFlameDetected();
  r.flags |= SJ_HAS_FLAME;
  if (flame) r.flags |= SJ_FLAME_DETECTED;
  localAlert |= flame;
#endif

#if ENABLE_RAIN_GAUGE
  pendingRainMm += readRainSinceLastMm();
  r.flags |= SJ_HAS_RAIN;
  r.rain_mm_x100 = sjClampU16(pendingRainMm * 100);
#endif
#if ENABLE_SOIL
  float soil;
  if (readSoilMoisturePct(soil)) {
    r.flags |= SJ_HAS_SOIL;
    r.soil_moisture_x10 = sjClampU16(soil * 10);
  }
#endif
#if ENABLE_MPU6050
  float tilt, vibration;
  if (readTiltAndVibration(tilt, vibration)) {
    r.flags |= SJ_HAS_TILT;
    r.tilt_deg_x100 = sjClampI16(tilt * 100);
    r.vibration_g_x1000 = sjClampU16(vibration * 1000);
    localAlert |= tilt >= LOCAL_TILT_LIMIT_DEG;
  } else {
    failed |= 1u << SJ_AF_TILT;
  }
#endif
#if ENABLE_PMS5003
  uint16_t pm25, pm10;
  if (!pmPowered()) {
    // asleep (duty cycle): no value, and not a dropout
  } else if (readPm(pm25, pm10)) {  // left out until the fan has settled (sj_warmup.h)
    localAlert |= sjAddPmValuesIfWarm(r, pm25, pm10, pmWarm(millis() - sjPmLastFrameMs), LOCAL_PM25_LIMIT,
                                      LOCAL_PM10_LIMIT);
  } else if (pmMissIsDropout()) {
    failed |= 1u << SJ_AF_PM25;  // no frame for 10 s after the warm-up: not just a slow first frame
  }
#endif
#if ENABLE_PH
  float ph;
  if (readPh(ph)) {
    r.flags |= SJ_HAS_PH;
    r.ph_x100 = sjClampU16(ph * 100);
  }
#endif
#if ENABLE_TURBIDITY
  float ntu;
  if (readTurbidityNtu(ntu)) {
    r.flags |= SJ_HAS_TURBIDITY;
    r.turbidity_ntu_x10 = sjClampU16(ntu * 10);
  }
#endif
#if ENABLE_BATTERY
  float battery;
  if (readBatteryPct(battery)) {
    r.flags |= SJ_HAS_BATTERY;
    r.battery_x10 = sjClampU16(battery * 10);
  }
#endif
  (void)waterM, (void)tempC, (void)humidity, (void)gasPpm, (void)flame;  // unused when their sensor is off
  return (r.flags & SJ_MEASUREMENT_FLAGS) != 0;
}

// The edge model's verdict (edge_ai.h; main or lite, config.h EDGE_MODEL),
// stamped into the reading. After edgeChecks(): the lite model reads the
// rise rate, and ignores it while the water level is in doubt. From the
// reading's own fixed-point values, so the verdict matches what is sent.
static EdgeRiskLevel edgeVerdict(SjReading& r) {
  const SjEdgeScale scale = {EDGE_BENCH_SCALE_MODEL, ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f, EDGE_RIVER_EMPTY_M,
                             EDGE_RIVER_FULL_M, edgeConfig.fastRiseCmPerMin};
  EdgeRiskLevel edge = runEdgeInference(r, scale);
  r.edge_risk = edge <= EDGE_URGENT ? (uint8_t)edge : SJ_EDGE_NONE;
  return edge;
}

static void printReading(const SjReading& r, EdgeRiskLevel edge, bool localAlert) {
  Serial.printf("[%s #%lu-%lu]%s%s", NODE_ID, (unsigned long)r.session, (unsigned long)r.seq,
                (r.flags & SJ_SOS_PRESSED) ? " SOS" : "", (r.flags & SJ_SIREN_ON) ? " SIREN" : "");
  if (r.flags & SJ_HAS_WATER) Serial.printf(" water=%.3fm", r.water_level_mm / 1000.0f);
  if (r.flags & SJ_HAS_DHT) Serial.printf(" temp=%.1fC hum=%.0f%%", r.temp_c_x100 / 100.0f, r.humidity_x100 / 100.0f);
  if (r.flags & SJ_HAS_GAS) Serial.printf(" gas=%uppm", r.gas_ppm);
#if ENABLE_GAS
  // says why gas is missing in the first minutes (not sent, not alerting)
  else if (!gasPowered()) Serial.print(" gas=heater-off");
  else if (!gasWarm()) Serial.print(" gas=warming-up");
#endif
  if (r.flags & SJ_HAS_FLAME) Serial.printf(" flame=%d", (r.flags & SJ_FLAME_DETECTED) ? 1 : 0);
  if (r.flags & SJ_HAS_RAIN) Serial.printf(" rain=%.2fmm", r.rain_mm_x100 / 100.0f);
  if (r.flags & SJ_HAS_SOIL) Serial.printf(" soil=%.0f%%", r.soil_moisture_x10 / 10.0f);
  if (r.flags & SJ_HAS_TILT) Serial.printf(" tilt=%.2fdeg vib=%.3fg", r.tilt_deg_x100 / 100.0f, r.vibration_g_x1000 / 1000.0f);
  if (r.flags & SJ_HAS_PM) Serial.printf(" pm2.5=%u pm10=%u", r.pm25, r.pm10);
#if ENABLE_PMS5003
  else if (!pmPowered()) Serial.print(" pm=asleep");
  else if ((!sjPmEverSeen || millis() - sjPmLastFrameMs > 10000) && pmMissIsDropout()) Serial.print(" pm=no-frame");
  else if (!pmWarm(0)) Serial.print(" pm=warming-up");
#endif
  if (r.flags & SJ_HAS_PH) Serial.printf(" pH=%.2f", r.ph_x100 / 100.0f);
  if (r.flags & SJ_HAS_TURBIDITY) Serial.printf(" turb=%.0fNTU", r.turbidity_ntu_x10 / 10.0f);
  if (r.flags & SJ_HAS_BATTERY) Serial.printf(" batt=%.0f%%", r.battery_x10 / 10.0f);
  if (r.xflags & SJ_X_RISE_RATE)
    Serial.printf(" rise=%+.2fcm/min%s", r.rise_cm_min_x100 / 100.0f, (r.xflags & SJ_X_FAST_RISE) ? " FAST-RISE" : "");
  for (uint8_t c = 0; c < SJ_AC_COUNT; c++)
    for (uint8_t f = 0; f < SJ_AF_COUNT; f++)
      if (r.anomaly[c] & (1u << f)) Serial.printf(" ?%s:%s", SJ_AC_NAMES[c], SJ_AF_NAMES[f]);
  Serial.printf(" | edge=%s local_alert=%d queued=%u%s\n", edge <= EDGE_URGENT ? SJ_EDGE_NAMES[edge] : "n/a",
                localAlert, queue.count(), (r.xflags & SJ_X_PRIORITY) ? " -> sent FIRST" : "");
}

// =====================================================================
// Flash flood rise rate + anomaly checks (sj_anomaly.h - unit-tested on a PC)
// =====================================================================
static void setupEdgeChecks() {
  sjEdgeDefaultLimits(edgeConfig.field, RISE_BENCH_SCALE, ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f);
  edgeConfig.staleMs = EDGE_STALE_S * 1000UL;
  edgeConfig.riseWindowMs = RISE_WINDOW_S * 1000UL;
  edgeConfig.fastRiseCmPerMin =
      RISE_BENCH_SCALE ? FAST_RISE_BENCH_FRACTION_PER_MIN * ULTRASONIC_MOUNT_HEIGHT_CM : FAST_RISE_CM_PER_MIN;
  edgeConfig.riseMinSamples = RISE_MIN_SAMPLES;
  edgeConfig.fastRiseSamples = FAST_RISE_SAMPLES;
  edgeConfig.riseNoiseK = RISE_NOISE_K;
  if (!resumedFromSleep || !sjEdgeValid(edgeTrack)) sjEdgeBegin(edgeTrack);
}

// Stamps the reading with the checks' verdict. Only a REGULAR sample is
// checked (and updates the history); an extra one for an SOS / a siren
// report a moment later carries the last regular verdict - over a step of
// a second or two a "rate" or "spike" would be noise. Runs before the
// siren looks at the reading: a doubtful value must not sound it.
// Returns true when this regular sample raised an anomaly the previous one
// did not have - that reading goes at once (sj_report.h); one that stays
// flagged rides with the normal reports.
static bool edgeChecks(SjReading& r, uint8_t failed, bool regular) {
  SjEdgeResult e;
  uint8_t before[SJ_AC_COUNT];
  memcpy(before, sjEdgeLast(edgeTrack).anomaly, sizeof(before));
  if (regular) {
    SjSample s;
    sjSampleFromReading(r, failed, s);
    sjEdgeSample(edgeTrack, s, deviceMillis(), edgeConfig, e);
  } else {
    e = sjEdgeLast(edgeTrack);
  }
#if !EDGE_ANOMALY_ENABLE
  memset(e.anomaly, 0, sizeof(e.anomaly));  // not reported (spikes are still kept out of the rise rate)
  memset(before, 0, sizeof(before));
#endif
  sjEdgeStamp(r, e);
  return regular && sjNewAnomaly(before, r.anomaly);
}

// =====================================================================
// SOS button (sj_sos.h - the press rules are unit-tested on a PC)
// =====================================================================
#if SOS_BUTTON_PIN >= 0
static const SjSosTiming SOS_TIMING = {SOS_HOLD_MS, SOS_COOLDOWN_MS, SOS_STUCK_MS, SOS_DEBOUNCE_MS};
static SjSosButton sosButton;  // shared by the interrupt and loop(): only touched under sosMux
static portMUX_TYPE sosMux = portMUX_INITIALIZER_UNLOCKED;

// Every edge, so a press is seen even while loop() is blocked - a backlog
// flush (up to ~20 s), an HTTPS timeout, sensor reads. sjSosUpdate() is a
// few comparisons. Arduino's GPIO interrupt service is not registered as
// IRAM-only (it waits while the flash cache is off, e.g. during a LittleFS
// write), so it may call this inline function even if it lands in flash.
static void IRAM_ATTR onSosEdge() {
  portENTER_CRITICAL_ISR(&sosMux);
  sjSosUpdate(sosButton, digitalRead(SOS_BUTTON_PIN) == LOW, millis(), SOS_TIMING);
  portEXIT_CRITICAL_ISR(&sosMux);
}

static void setupSosButton(bool wokeByButton) {
  pinMode(SOS_BUTTON_PIN, INPUT_PULLUP);
  delay(1);  // let the pull-up charge the cable before the first read
  bool pressed = digitalRead(SOS_BUTTON_PIN) == LOW;
  // The cooldown spans deep-sleep wakes (RTC clock); a power-on starts fresh.
  uint32_t since = sjSosSinceLastMs(resumedFromSleep && sleepState.sosEver, sleepState.sosAtS, deviceSeconds());
  portENTER_CRITICAL(&sosMux);
  sjSosBegin(sosButton, pressed, wokeByButton, millis(), since, SOS_TIMING);
  portEXIT_CRITICAL(&sosMux);
  attachInterrupt(digitalPinToInterrupt(SOS_BUTTON_PIN), onSosEdge, CHANGE);
  if (pressed && !wokeByButton) {
    Serial.printf("[sos] button on GPIO%d is pressed at start-up - SOS off until it is released\n", SOS_BUTTON_PIN);
  }
}

// Samples the button (a hold that is still going on has no edge) and turns
// a finished SOS press into sosRequested. Called from loop() and between
// the sends of a long flush.
static SjSosPhase pollSosButton() {
  portENTER_CRITICAL(&sosMux);
  SjSosPhase phase = sjSosUpdate(sosButton, digitalRead(SOS_BUTTON_PIN) == LOW, millis(), SOS_TIMING);
  bool trigger = sjSosTakeTrigger(sosButton);
  bool refused = sosButton.refused;
  sosButton.refused = 0;
  portEXIT_CRITICAL(&sosMux);
  if (trigger) {
    sosRequested = true;
    sleepState.sosEver = 1;
    sleepState.sosAtS = deviceSeconds();  // the cooldown must survive deep sleep
    Serial.println("[sos] button held - measuring and sending an SOS now");
  }
  if (refused) Serial.printf("[sos] pressed again within %lus of the last SOS - already sent\n", SOS_COOLDOWN_MS / 1000);
  return phase;
}

static bool sosButtonStuck(uint32_t& heldMs) {
  portENTER_CRITICAL(&sosMux);
  bool stuck = sosButton.stuck;
  heldMs = sjSosHeldMs(sosButton, millis());
  portEXIT_CRITICAL(&sosMux);
  return stuck;
}
#else
static void setupSosButton(bool) {}
static SjSosPhase pollSosButton() { return SJ_SOS_IDLE; }
#endif

// LED for the person at the node: -1 = nothing SOS-related to show
static int sosLed(SjSosPhase phase) {
  bool confirmed = sjSosConfirmShowing(sosConfirmed, sosConfirmedAtMs, millis(), SOS_LED_CONFIRM_MS);
  return sjSosLed(phase, !sosOutbox.empty(), confirmed, millis());
}

// =====================================================================
// Village siren (sj_siren.h - the rules are unit-tested on a PC)
// =====================================================================
#if SIREN_PIN >= 0
static const uint8_t SIREN_OFF_LEVEL = SIREN_ACTIVE_LEVEL == HIGH ? LOW : HIGH;
static const uint32_t SIREN_WATER_LIMIT_MM =
    (uint32_t)(SIREN_LOCAL_WATER_FRACTION * ULTRASONIC_MOUNT_HEIGHT_CM * 10.0f + 0.5f);

static void setupSiren() {
  digitalWrite(SIREN_PIN, SIREN_OFF_LEVEL);  // level first, so switching to output gives no blip
  pinMode(SIREN_PIN, OUTPUT);
  sjSirenBegin(siren, millis());
#if TRANSPORT == TRANSPORT_LORA
  sirenCmdKeyOk = sjParseHexKey(SIREN_CMD_KEY, sirenCmdKey, SJ_CMD_KEY_LEN);
  if (!sirenCmdKeyOk) {
    Serial.println("[siren] SIREN_CMD_KEY missing or not 32 hex characters (secrets.h) - siren commands from the "
                   "gateway are REFUSED; the offline fallback still works. See secrets.example.h");
  }
#endif
}

// Drives the pin; a start / stop is logged and reported at once (the
// server re-sends a command until a reading shows it took effect).
static void noteSirenChange() {
  digitalWrite(SIREN_PIN, siren.on ? SIREN_ACTIVE_LEVEL : SIREN_OFF_LEVEL);
  if (!sjSirenTakeChanged(siren)) return;
  sirenReportDue = true;
  if (!siren.on) {
    Serial.println("[siren] off");
  } else if (siren.reason == SJ_SIREN_COMMAND) {
    Serial.printf("[siren] ON by server command for %lus\n", (unsigned long)(siren.onForMs / 1000));
  } else {
    Serial.printf("[siren] ON by this node: no gateway for %us and URGENT on %u samples\n",
                  (unsigned)SIREN_OFFLINE_AFTER_S, (unsigned)SIREN_OFFLINE_URGENT_SAMPLES);
  }
}

// Every loop() pass and between the sends of a long flush: ends a sounding
// on time even while the node is busy.
static void serviceSiren() {
  sjSirenTick(siren, millis(), SIREN_TIMING);
  noteSirenChange();
}

// One regular sample's verdict for the offline fallback (measured = the
// reading has values; a failed one counts as "not urgent").
static void sirenSample(const SjReading& r, bool measured) {
  bool urgent = measured && sjSirenLocalUrgent(r, SIREN_WATER_LIMIT_MM, SIREN_LOCAL_GAS_PPM);
  sjSirenSample(siren, urgent, millis(), SIREN_TIMING);
  noteSirenChange();
}

// The next hop took a reading: we are online, and its answer may carry a command.
static void onLinkAck(const SjDownlink& d) {
  if (d.refused) {
    Serial.println("[siren] a siren command in the ACK was IGNORED: its MAC did not match SIREN_CMD_KEY (or no key "
                   "is set) - a foreign transmitter, or the key differs from the gateway's SIREN_MASTER_KEY");
  }
  sjSirenAck(siren, millis());
  sjSirenApplyDownlink(siren, d, millis(), SIREN_TIMING);
  noteSirenChange();
}

static uint16_t sirenFlags() { return sjSirenFlags(siren); }
static uint8_t sirenTxState() { return sjSirenTxState(siren); }
#else
static void setupSiren() {}
static void serviceSiren() {}
static void sirenSample(const SjReading&, bool) {}
static void onLinkAck(const SjDownlink&) {}
static uint16_t sirenFlags() { return 0; }
static uint8_t sirenTxState() { return SJ_TX_VALID; }
#endif

// Mirrors the outbox's newest SOS into RTC memory (sj_sleep.h), so it goes
// first again after a deep sleep or a reset however many readings were
// queued since - even one whose flash push failed. Called only when an SOS
// is queued or delivered (rare).
static void keepPendingSos() {
  const QueuedReading* q = sosOutbox.empty() ? nullptr : &sosOutbox.items[sosOutbox.count - 1];
  sjSleepKeepSos(sleepState, q ? &q->reading : nullptr, q ? q->takenAtS : 0);
}

static void onSosDelivered(const QueuedReading& q) {
  sosConfirmed = true;
  sosConfirmedAtMs = millis();
  keepPendingSos();  // the outbox has already removed it
  Serial.printf("[sos] SOS #%lu-%lu delivered\n", (unsigned long)q.reading.session, (unsigned long)q.reading.seq);
}

// Gives a measured reading its uid and queues it, as sjPlanReport() said:
// `p.summary` attaches the summary window (if it has one) and starts a new
// one. An SOS reading also goes into the SOS outbox and an urgent one
// (`p.priority`) into the urgent outbox, so the next flush sends it before
// the backlog; if the flash queue fails, the outbox copy is still retried
// until acknowledged.
static bool queueReading(SjReading& r, bool sos, const SjReportPlan& p) {
  r.session = session;
  r.seq = ++seq;
  if (sos) r.flags |= SJ_SOS_PRESSED;
  r.flags |= sirenFlags();  // the siren's state at this measurement
  if (p.priority) r.xflags |= SJ_X_PRIORITY;
  QueuedReading q;
  memset(&q, 0, sizeof(q));
#if SUMMARY_ENABLE
  if (p.summary && sjSummaryBuild(summaryAcc, q.summary)) r.xflags |= SJ_X_SUMMARY;
#endif
  q.reading = r;
  q.takenAtS = deviceSeconds();
  bool queued = queue.push(q);
  if (queued) pendingRainMm = 0;  // this rain is now in a queued reading
  if (queued && p.summary) sjSummaryReset(summaryAcc);  // a failed push keeps the window for the next report
  if (p.priority && !sos) {
    urgentOutbox.add(q);  // full: its oldest entry still waits in the queue, in order
    nextFlushMs = millis();  // send now - not 0, see sjFlushDue()
  }
  if (sos) {
    sosOutbox.add(q);
    keepPendingSos();
    sosConfirmed = false;
    nextFlushMs = millis();  // send now - not 0, see sjFlushDue()
    Serial.printf("[sos] SOS reading #%lu-%lu goes out before %u queued reading(s)%s\n", (unsigned long)r.session,
                  (unsigned long)r.seq, queue.count() - (queued ? 1 : 0),
                  queued ? "" : " - flash queue FAILED, kept in RAM + RTC memory only");
  }
  return queued;
}

// =====================================================================
// Offline SOS Wi-Fi (sj_hotspot.h - the page, limits and outbox are
// unit-tested on a PC). Served from loop() and between the sends of a
// long flush; the requests go to the gateway in flushQueue().
// =====================================================================
#if SOS_HOTSPOT_ENABLE
static SjHotspotAp hotspot;
static SjHotspotApp hotspotApp;
static SjHotspotSite hotspotSite;
static const SjHotspotLimits HOTSPOT_LIMITS = {SOS_HOTSPOT_MAX_PER_WINDOW, SOS_HOTSPOT_WINDOW_S,
                                               SOS_HOTSPOT_CLIENT_GAP_S};
static SjSosMsgOutbox<SOS_MSG_SLOTS> sosMsgOutbox;  // waiting for the gateway's ACK; NVS copy "sos_msgs"
static bool sosMsgArrived = false;  // a new request during a flush: it goes before the rest of the backlog

// Written when a request is stored (before the page says "saved") or
// delivered - rare, so NVS wear does not matter.
static void saveSosMsgs() {
  if (sjPrefs.putBytes("sos_msgs", &sosMsgOutbox, sizeof(sosMsgOutbox)) != sizeof(sosMsgOutbox)) {
    Serial.println("[sos-wifi] NVS copy of the SOS requests NOT saved - a reset now would lose them");
  }
}

static void restoreSosMsgs() {
  if (!sjPrefs.isKey("sos_msgs") || sjPrefs.getBytesLength("sos_msgs") != sizeof(sosMsgOutbox)) return;
  SjSosMsgOutbox<SOS_MSG_SLOTS> saved;
  if (sjPrefs.getBytes("sos_msgs", &saved, sizeof(saved)) != sizeof(saved)) return;
  uint8_t n = sjSosMsgOutboxRestore(sosMsgOutbox, saved);
  if (n) Serial.printf("[sos-wifi] %u SOS request(s) from before the reset - sending them first\n", n);
}

// sjHotspotHandle()'s store step: the outbox and its NVS copy, then "send now".
static bool storeLocalSos(SjSosMsg& m) {
  SjSosMsgQueued e;
  memset(&e, 0, sizeof(e));
  e.msg = m;
  e.rxAtS = uptimeSeconds();
  e.bootId = session;
  e.local = 1;
  if (sjSosMsgOutboxAdd(sosMsgOutbox, e) != 1) return false;
  saveSosMsgs();
  sosMsgArrived = true;
  nextFlushMs = millis();  // send now - not 0, see sjFlushDue()
  return true;
}

static void respondHotspot(const SjHttpReq& req, String& out) {
  char fresh[SJ_SOS_CLIENT_LEN + 1];
  sjHotspotNewClientId(fresh, esp_random(), esp_random());  // true random: the Wi-Fi radio is on
  SjHsOutcome o =
      sjHotspotHandle(hotspotApp, hotspotSite, HOTSPOT_LIMITS, req, uptimeSeconds(), fresh, storeLocalSos, out);
  const char* what = sjHotspotOutcomeText(o);
  if (what) Serial.printf("[sos-wifi] %s (%u waiting for the gateway)\n", what, sosMsgOutbox.count);
}

// After the session is known (it is part of every request's sos_uid).
static void setupHotspot() {
  sjHotspotBegin(hotspotApp);
  restoreSosMsgs();
  WiFi.mode(WIFI_AP);
  if (!hotspot.begin(SOS_HOTSPOT_SSID, SOS_HOTSPOT_CHANNEL, SOS_HOTSPOT_MAX_CLIENTS)) {
    Serial.println("[sos-wifi] access point did NOT start - no offline SOS page on this node");
    return;
  }
  hotspotSite = {NODE_ID, session, hotspot.ip(), false};
  sjHotspotRememberOutbox(hotspotApp, sosMsgOutbox, uptimeSeconds());
  Serial.printf("[sos-wifi] open Wi-Fi '%s' at http://%s/ - requests go to the gateway over LoRa\n", SOS_HOTSPOT_SSID,
                hotspot.ip());
}

static void serviceHotspot() { hotspot.poll(respondHotspot); }
static bool sosMsgsWaiting() { return sosMsgOutbox.count > 0; }
#else
static void setupHotspot() {}
static void serviceHotspot() {}
static bool sosMsgsWaiting() { return false; }
#endif

// =====================================================================
// Transport
// =====================================================================
#if TRANSPORT == TRANSPORT_LORA
static SX1278 radio = new Module(LORA_NSS, LORA_DIO0, LORA_RST);
static volatile bool loraIrq = false;
static void IRAM_ATTR onLoraDio0() { loraIrq = true; }
static int16_t loraBeginState = RADIOLIB_ERR_UNKNOWN;  // radio.begin() result, for the self-test
static_assert(RADIOLIB_ERR_CHIP_NOT_FOUND == SJ_LORA_ERR_CHIP_NOT_FOUND, "sj_selftest.h mirrors this RadioLib code");

static bool setupTransport() {
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int state = radio.begin(LORA_FREQUENCY_MHZ, LORA_BANDWIDTH_KHZ, LORA_SPREADING_FACTOR, LORA_CODING_RATE,
                          LORA_SYNC_WORD, LORA_TX_POWER_DBM);
  loraBeginState = state;
  if (state != RADIOLIB_ERR_NONE) {
    Serial.printf("[lora] init failed, code %d - check wiring/frequency\n", state);
    return false;
  }
  radio.setCRC(true);
  radio.setDio0Action(onLoraDio0, RISING);
  Serial.println("[lora] ready");
  return true;
}

// Transmits `len` bytes and listens LORA_ACK_TIMEOUT_MS for the gateway's
// answer. Returns the answer's length in `reply` (0 = none, or too long to
// be one of ours).
static size_t loraExchange(uint8_t* data, size_t len, uint8_t* reply, size_t replyCap) {
  if (radio.transmit(data, len) != RADIOLIB_ERR_NONE) return 0;
  loraIrq = false;  // DIO0 also fires on TX done
  radio.startReceive();
  uint32_t start = millis();
  while (!loraIrq && millis() - start < LORA_ACK_TIMEOUT_MS) delay(1);
  size_t got = 0;
  if (loraIrq) {
    size_t n = radio.getPacketLength();
    if (n <= replyCap && radio.readData(reply, n) == RADIOLIB_ERR_NONE) got = n;
  }
  radio.standby();
  return got;
}

// Sends one reading and waits for the gateway's ACK (which it only sends
// after saving the reading to its own flash queue). The ACK may carry a
// siren command (SjAckCmd) - applied at once if its MAC checks out.
static bool sendOne(QueuedReading& q) {
  SjReading r = q.reading;
  r.age_s = (r.session == session) ? deviceSeconds() - q.takenAtS : SJ_AGE_UNKNOWN;
  r.tx_state = sirenTxState();  // the siren NOW - the flags are from the measurement
  uint8_t packet[SJ_READING_MAX_PACKET];  // + the summary when it has one (sj_packet.h)
  size_t packetLen = sjEncodeReading(r, q.summary, packet);
  uint8_t buf[sizeof(SjAckCmd)];
  size_t len = loraExchange(packet, packetLen, buf, sizeof(buf));
  SjDownlink cmd = {SJ_CMD_NONE, 0, 0};
#if SIREN_PIN >= 0
  const uint8_t* key = sirenCmdKeyOk ? sirenCmdKey : nullptr;
#else
  const uint8_t* key = nullptr;  // no siren: nothing to command
#endif
  bool acked = len > 0 && sjParseAck(buf, len, r, cmd, key);
  if (acked) onLinkAck(cmd);
  return acked;
}

#if SOS_HOTSPOT_ENABLE
// The offline-Wi-Fi requests, oldest first, each until the gateway ACKs it
// (SJ_TYPE_SOS_MSG_ACK - it stored it on its side first). false = no ACK:
// everything stays, the next flush tries again.
static bool sendSosMsgs() {
  sosMsgArrived = false;
  while (sosMsgOutbox.count > 0) {
    const SjSosMsgQueued e = sosMsgOutbox.items[0];
    SjSosMsg m = e.msg;
    long age = sjSosMsgAge(e, uptimeSeconds(), session);
    m.age_s = age >= 0 ? (uint32_t)age : SJ_AGE_UNKNOWN;
    uint8_t buf[sizeof(SjAck)];
    size_t len = loraExchange((uint8_t*)&m, sjSosMsgSize(m), buf, sizeof(buf));
    if (len == 0 || !sjSosMsgAckMatches(buf, len, m)) return false;
    sjSosMsgOutboxRemove(sosMsgOutbox, m);
    saveSosMsgs();
    sjHotspotMarkSent(hotspotApp, m.session, m.seq, uptimeSeconds());  // the phone's page turns to "sent"
    SjDownlink none = {SJ_CMD_NONE, 0, 0};
    onLinkAck(none);  // the gateway answered: we are online
    char uid[24];
    sjSosUid(uid, sizeof(uid), m);
    Serial.printf("[sos-wifi] request %s delivered to the gateway\n", uid);
  }
  return true;
}
#else
static bool sendSosMsgs() { return true; }
#endif

// SOS readings first, then urgent ones, then up to MAX_SENDS_PER_FLUSH of
// the backlog (sjFlushOnce() in sj_sos.h; copies that went ahead are
// popped unsent). A button hold during the urgent readings / the backlog
// stops the flush so loop() can measure and send the SOS at once.
// false = the gateway didn't acknowledge (readings stay queued)
static bool flushQueue() {
  // Requests from the SOS Wi-Fi page first: a person typed them. If they
  // get no ACK the readings still go - a gateway with older firmware
  // ignores these packets, and must not stall the whole queue.
  bool msgsSent = sendSosMsgs();
  if (!msgsSent) {
    Serial.println("[lora] no ACK for an SOS request from the Wi-Fi page - kept and retried (gateway firmware "
                   "too old for SOS_HOTSPOT_ENABLE nodes?)");
  }
  SjFlushResult res = sjFlushOnce(
      queue, sosOutbox, urgentOutbox, sentAhead, MAX_SENDS_PER_FLUSH, [](QueuedReading& q) { return sendOne(q); },
      [] {
        pollSosButton();
        serviceSiren();    // a sounding ends on time during a long backlog flush too
        serviceHotspot();  // phones are answered during a long backlog flush too
#if SOS_HOTSPOT_ENABLE
        if (sosMsgArrived) return true;  // a new request: stop, the next flush sends it first
#endif
        return sosRequested;
      },
      [](const QueuedReading& q) { onSosDelivered(q); });
  switch (res) {
    case SJ_FLUSH_DONE:
    case SJ_FLUSH_SOS_WAITING:
      if (msgsSent) return true;
      break;  // the readings went, an SOS request did not: retry it after the back-off
    case SJ_FLUSH_NO_ACK:
#if DEEP_SLEEP_ENABLED
      Serial.printf("[lora] no ACK - %u reading(s) kept in queue for the next wake\n", queue.count());
#else
      Serial.printf("[lora] no ACK - %u reading(s) kept in queue, retrying in %lus\n", queue.count(),
                    FLUSH_RETRY_INTERVAL_MS / 1000);
#endif
      break;
    case SJ_FLUSH_STUCK:  // the oldest record can't be read (flash failing): back off, don't spin
      break;
  }
  nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
  return false;
}

static bool waitForLink() { return true; }  // LoRa needs no connection

// 32 bits of radio noise for a fresh session (sj_session.h): the ESP32's
// own RNG is only fully random while WiFi/BT is on, which a LoRa node never
// turns on. RadioLib reads the SX1278's wideband RSSI LSBs.
static uint32_t transportEntropy() {
  if (loraBeginState != RADIOLIB_ERR_NONE) return 0;
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) v = (v << 8) | radio.randomByte();
  radio.standby();
  return v;
}
static void transportSleep() { radio.sleep(); }  // SX1278 sleep: ~1 uA instead of ~1.6 mA standby

#elif TRANSPORT == TRANSPORT_WIFI
static bool setupTransport() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // reconnects automatically afterwards
  Serial.println("[wifi] connecting in the background");
  return true;
}

static bool singleMode = false;  // a refused batch is resent one reading at a time

// `answer` gets the response body of a 200 (it may carry siren commands).
static int postBody(const String& body, String& answer) {
  WiFiClientSecure client;
  client.setInsecure();  // TODO: pin the backend certificate for real deployments
  HTTPClient http;
  if (!http.begin(client, BACKEND_BATCH_URL)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("ngrok-skip-browser-warning", "true");
  http.addHeader("X-Device-Key", DEVICE_KEY);  // the backend refuses readings without a valid key
  http.setTimeout(15000);
  int code = http.POST(body);
  if (code == 200) answer = http.getString();
  http.end();
  return code;
}

// The backend took our readings (200): we are online - the siren's offline
// fallback stands down - and its answer may hold a command for this node
// (sjParseSirenCommands, sj_packet.h), the WiFi node's "ACK window".
static void onBackendAnswer(const String& answer) {
  SjDownlink d = {SJ_CMD_NONE, 0, 0};
#if SIREN_PIN >= 0
  SjSirenCommand cmds[4];
  int n = sjParseSirenCommands(answer.c_str(), cmds, 4);
  for (int i = 0; i < n; i++) {
    if (strcmp(cmds[i].node_id, NODE_ID) != 0) continue;
    d.cmd = cmds[i].on ? SJ_CMD_SIREN_ON : SJ_CMD_SIREN_OFF;
    d.arg = cmds[i].forS;
  }
#endif
  onLinkAck(d);
}

static void appendQueued(String& body, const QueuedReading& q) {
  long age = (q.reading.session == session) ? (long)(deviceSeconds() - q.takenAtS) : -1;
  sjAppendJson(body, q.reading, age, WiFi.RSSI(), "wifi", &q.summary);
}

// Posts up to `n` oldest readings as one batch (fewer if it reaches a
// reading that already went ahead - that one is popped unsent first, see
// sjCollectBatch). Backend answers per reading; any HTTP 200 means every
// reading in the batch is final (stored, duplicate or rejected) and can
// leave the queue. `n` becomes the number in the batch.
static int postBatch(uint32_t& n, String& answer) {
  String body = "{\"readings\":[";
  bool first = true;
  n = sjCollectBatch<QueuedReading>(queue, sentAhead, n, [&](const QueuedReading& q) {
    if (!first) body += ",";
    first = false;
    appendQueued(body, q);
  });
  if (n == 0) {
    // If the queue could not rebuild itself (flash full or failing) the
    // bad record is still there, and only peek(0) can skip it without a
    // copy: go one at a time until it is the oldest. -1 = retry later.
    singleMode = true;
    return -1;
  }
  body += "]}";
  return postBody(body, answer);
}

// One outbox reading (SOS or urgent) on its own, ahead of the batches.
static int postOne(const QueuedReading& q, String& answer) {
  String body = "{\"readings\":[";
  appendQueued(body, q);
  body += "]}";
  return postBody(body, answer);
}

// The front of an outbox, alone. false = keep it, retry after the back-off.
// 200, or 400/422 for the reading itself (an SOS with no sensor value):
// final either way - the server has seen it.
static bool postOutboxFront(const QueuedReading& q, const char* what) {
  String answer;
  int code = postOne(q, answer);
  if (code == 200) onBackendAnswer(answer);
  if (sjUploadAction(code, 1) == SJ_UPLOAD_RETRY) {
    Serial.printf("[wifi] %s send failed (HTTP %d) - kept, retrying first\n", what, code);
    nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
    return false;
  }
  sentAhead.add(q.reading);  // its queued copy is not posted again
  return true;
}

// Sends ONE batch (up to MAX_SENDS_PER_FLUSH readings), like the LoRa
// flushQueue(). Callers repeat it: loop() on its next pass (nextFlushMs is
// left alone after a success), a deep-sleep wake via sjDrainWithinBudget()
// until DEEP_SLEEP_MAX_AWAKE_MS. It used to loop until the queue was empty,
// which kept a battery node awake for minutes on a backlog (review B).
// false = not connected / the backend didn't take them (readings stay queued)
static bool flushQueue() {
  if (WiFi.status() != WL_CONNECTED) {
    nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
    return false;
  }
  // SOS first, then urgent readings, alone - one request per call, like the batches
  if (!sosOutbox.empty()) {
    QueuedReading q = sosOutbox.front();
    if (!postOutboxFront(q, "SOS")) return false;
    sosOutbox.remove(q.reading);
    onSosDelivered(q);
    return true;
  }
  if (!urgentOutbox.empty()) {
    QueuedReading q = urgentOutbox.front();
    if (!postOutboxFront(q, "urgent reading")) return false;
    urgentOutbox.remove(q.reading);
    return true;
  }
  sjPopSentAhead<QueuedReading>(queue, sentAhead);  // already posted from an outbox
  if (queue.count() == 0) return true;
  uint32_t n = singleMode ? 1 : min<uint32_t>(queue.count(), MAX_SENDS_PER_FLUSH);
  String answer;
  int code = postBatch(n, answer);
  switch (sjUploadAction(code, n)) {  // shared rule, see sj_packet.h
    case SJ_UPLOAD_DONE:
      queue.pop(n);
      singleMode = false;
      onBackendAnswer(answer);
      break;
    case SJ_UPLOAD_SPLIT:
      singleMode = true;  // the next call sends one reading at a time
      break;
    case SJ_UPLOAD_DROP_ONE:
      Serial.printf("[wifi] backend rejected a reading as invalid (HTTP %d) - dropping it\n", code);
      queue.pop(1);
      singleMode = false;
      break;
    case SJ_UPLOAD_RETRY:
      if (code == 401 || code == 403) {
        Serial.printf("[wifi] HTTP %d: DEVICE_KEY in secrets.h is missing, wrong, revoked or not allowed for %s\n", code, NODE_ID);
      } else {
        Serial.printf("[wifi] send failed (HTTP %d) - %u reading(s) kept in queue\n", code, queue.count());
      }
      nextFlushMs = millis() + FLUSH_RETRY_INTERVAL_MS;
      return false;
  }
  return true;
}

// Deep sleep: WiFi starts from scratch on every wake, so wait for it once
// (also used by the self-test just after power-on).
static bool waitForLink() {
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) delay(50);
#if DEEP_SLEEP_ENABLED
  if (WiFi.status() != WL_CONNECTED) Serial.println("[wifi] not connected - readings stay queued until the next wake");
#else
  if (WiFi.status() != WL_CONNECTED) Serial.println("[wifi] not connected yet - readings stay queued, retried automatically");
#endif
  return WiFi.status() == WL_CONNECTED;
}

static void transportSleep() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

// setupTransport() has switched the WiFi radio on, and with it the ESP32's
// RNG is fully random (ESP-IDF: true random while WiFi/BT is enabled).
static uint32_t transportEntropy() { return esp_random(); }
#endif

#if DEEP_SLEEP_ENABLED
// Sends what the link takes within `budgetMs` from `startMs`, one batch
// per flushQueue() call (sj_sleep.h).
static void drainQueueWithin(uint32_t startMs, uint32_t budgetMs) {
  sjDrainWithinBudget(
      [] {
        pollSosButton();  // a hold during the drain: stop, runSleepCycle() sends the SOS next
        return (queue.count() > 0 || !sosOutbox.empty() || !urgentOutbox.empty()) && !sosRequested;
      },
      [] { return flushQueue(); }, [] { return (uint32_t)millis(); }, startMs, budgetMs);
}
#endif

// =====================================================================
// Self-test ('t', and once after a power-on): every enabled sensor plus
// the radio, queue and edge model in one go - OK / WAIT / WARN / FAIL and
// a wiring hint, for the first flash and for field checks. The verdict
// rules are in sj_selftest.h (unit-tested on a PC).
// =====================================================================
static SjSelfTestTally selfTestTally;

static const char* selfTestHint(const char* fmt, ...) {
  static char buf[128];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  return buf;
}

static void selfTestLine(const char* name, const SjCheckResult& r, const char* hint) {
  sjTallyAdd(selfTestTally, r.status);
  Serial.printf("  %s %-11s %s\n", SJ_CHECK_NAMES[r.status], name, r.detail);
  if (r.status >= SJ_CHECK_WARN) Serial.printf("       check: %s\n", hint);
}

static void selfTestOff(const char* name, const char* flag) { Serial.printf("  --   %-11s off (%s 0)\n", name, flag); }

static void runSelfTest() {
  memset(&selfTestTally, 0, sizeof(selfTestTally));
  uint32_t uptimeS = uptimeSeconds();  // same clock as the gas/PM warm-up gate
  Serial.printf("\n=== SELF-TEST %s (up %lus) ===\n", NODE_ID, (unsigned long)uptimeS);

#if ENABLE_WATER_LEVEL
  {
    float d[SJ_ULTRASONIC_PINGS];
    int n = pingDistancesCm(d);
    selfTestLine("water", sjCheckUltrasonic(n, SJ_ULTRASONIC_PINGS, n ? d[0] : 0, n ? d[n / 2] : 0, n ? d[n - 1] : 0,
                                            ULTRASONIC_MOUNT_HEIGHT_CM),
                 selfTestHint("HC-SR04 VCC 5 V, TRIG GPIO%d, ECHO via 1k/2k divider to GPIO%d, aim at the surface",
                              ULTRASONIC_TRIG, ULTRASONIC_ECHO));
  }
#else
  selfTestOff("water", "ENABLE_WATER_LEVEL");
#endif
#if ENABLE_DHT
  {
    float t = 0, h = 0;
    bool ok = readDht(t, h);
    selfTestLine("DHT22", sjCheckDht(ok, t, h),
                 selfTestHint("DATA to GPIO%d with a 10k pull-up to 3.3 V, VCC 3.3 V, GND", DHT_PIN));
  }
#else
  selfTestOff("DHT22", "ENABLE_DHT");
#endif
#if ENABLE_GAS
  {
    float pinMv = analogReadMilliVolts(MQ135_PIN);
    float rs = mq135ResistanceKohm(pinMv);
    if (!gasPowered())  // duty cycle: the AO of an unheated module means nothing
      selfTestLine("MQ135 gas", sjResult(SJ_CHECK_WAIT, "heater off (duty cycle) - on again before its next report"),
                   "");
    else
      selfTestLine("MQ135 gas",
                   sjCheckMq135(pinMv, MQ135_ADC_DIVIDER_RATIO, rs, rs > 0 ? mq135Ppm(rs) : 0, gasPoweredS(),
                                MQ135_WARMUP_S),
                   selfTestHint("AO via 10k/10k divider to GPIO%d (MQ135_ADC_DIVIDER_RATIO %.1f), VCC 5 V", MQ135_PIN,
                                MQ135_ADC_DIVIDER_RATIO));
  }
#else
  selfTestOff("MQ135 gas", "ENABLE_GAS");
#endif
#if ENABLE_FLAME
  {
    bool highPullDown, highPullUp;
    probeFlamePin(highPullDown, highPullUp);
    selfTestLine("flame", sjCheckFlame(highPullDown, highPullUp, digitalRead(FLAME_PIN) == HIGH),
                 selfTestHint("module DO to GPIO%d, VCC 3.3 V; its pot sets the sensitivity", FLAME_PIN));
  }
#else
  selfTestOff("flame", "ENABLE_FLAME");
#endif
#if ENABLE_RAIN_GAUGE
  selfTestLine("rain gauge", sjCheckRain(digitalRead(RAIN_GAUGE_PIN) == HIGH, sjRainTipsSinceBoot),
               selfTestHint("reed switch between GPIO%d and GND, 10k pull-up GPIO%d to 3.3 V", RAIN_GAUGE_PIN,
                            RAIN_GAUGE_PIN));
#else
  selfTestOff("rain gauge", "ENABLE_RAIN_GAUGE");
#endif
#if ENABLE_SOIL
  selfTestLine("soil", sjCheckSoil(readSoilMillivolts(), SOIL_DRY_MV, SOIL_WET_MV),
               selfTestHint("AOUT to GPIO%d, VCC 3.3 V; 's' prints mV for SOIL_DRY_MV / SOIL_WET_MV", SOIL_PIN));
#else
  selfTestOff("soil", "ENABLE_SOIL");
#endif
#if ENABLE_MPU6050
  {
    bool acks = mpuAcks();
    int who = acks ? mpuWhoAmI() : -1;
    bool readOk = false;
    float gravityG = 0, tilt = 0, vibration = 0;
    if (acks && sjMpuOk) {
      readOk = true;
      for (int i = 0; i < 10 && readOk; i++) {
        float a[3];
        readOk = mpuReadAccelG(a);
        gravityG += sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) / 10.0f;
        delay(4);
      }
      readOk = readOk && readTiltAndVibration(tilt, vibration);
    }
    selfTestLine("MPU6050", sjCheckMpu(sjMpuOk, acks, who, readOk, gravityG, tilt, LOCAL_TILT_LIMIT_DEG),
                 selfTestHint("SDA GPIO%d, SCL GPIO%d, VCC 3.3 V, AD0 to GND (address 0x%02X)", I2C_SDA, I2C_SCL,
                              MPU6050_ADDR));
  }
#else
  selfTestOff("MPU6050", "ENABLE_MPU6050");
#endif
#if ENABLE_PMS5003
  {
    uint32_t start = millis();  // just powered on: give it time for a first frame
    while (pmPowered() && !sjPmEverSeen && millis() - start < 2500) {
      pollPms5003();
      delay(20);
    }
    pollPms5003();
    if (!pmPowered())
      selfTestLine("PMS5003", sjResult(SJ_CHECK_WAIT, "asleep (duty cycle) - awake again before its next report"), "");
    else
      selfTestLine("PMS5003",
                   sjCheckPms(sjPmEverSeen, millis() - sjPmLastFrameMs, sjPm25, sjPm10, pmPoweredS(), PMS5003_WARMUP_S),
                   selfTestHint("PMS TX to GPIO%d, VCC 5 V, GND; the fan should be audible", PMS_RX_PIN));
  }
#else
  selfTestOff("PMS5003", "ENABLE_PMS5003");
#endif
#if ENABLE_PH
  selfTestLine("pH", sjCheckPh(readPhMillivolts() / PH_ADC_DIVIDER_RATIO, PH_ADC_DIVIDER_RATIO, PH_MV_AT_7, PH_MV_AT_4),
               selfTestHint("PO via divider to GPIO%d (PH_ADC_DIVIDER_RATIO %.1f); 'p' prints mV for calibration",
                            PH_PIN, PH_ADC_DIVIDER_RATIO));
#else
  selfTestOff("pH", "ENABLE_PH");
#endif
#if ENABLE_TURBIDITY
  selfTestLine("turbidity", sjCheckTurbidity(analogReadMilliVolts(TURBIDITY_PIN), TURBIDITY_ADC_DIVIDER_RATIO),
               selfTestHint("OUT via divider to GPIO%d (TURBIDITY_ADC_DIVIDER_RATIO %.1f), VCC 5 V", TURBIDITY_PIN,
                            TURBIDITY_ADC_DIVIDER_RATIO));
#else
  selfTestOff("turbidity", "ENABLE_TURBIDITY");
#endif
#if ENABLE_BATTERY
  selfTestLine("battery", sjCheckBattery(analogReadMilliVolts(BATTERY_PIN), BATTERY_DIVIDER_RATIO, BATTERY_EMPTY_V,
                                         BATTERY_FULL_V),
               selfTestHint("18650 + via a 2:1 divider (e.g. 100k/100k) to GPIO%d", BATTERY_PIN));
#else
  selfTestOff("battery", "ENABLE_BATTERY");
#endif
#if SOS_BUTTON_PIN >= 0
  {
    pollSosButton();
    uint32_t heldMs;
    bool stuck = sosButtonStuck(heldMs);
    selfTestLine("SOS button", sjCheckSosButton(digitalRead(SOS_BUTTON_PIN) == LOW, stuck, heldMs, SOS_HOLD_MS),
                 selfTestHint("push-button between GPIO%d and GND (1k in series), nothing else on the pin; "
                              "dry it / check the cable", SOS_BUTTON_PIN));
  }
#else
  Serial.printf("  --   %-11s off (SOS_BUTTON_PIN -1)\n", "SOS button");
#endif
#if SIREN_PIN >= 0
  // Not sounded by the self-test (it runs at every power-on, and a village
  // siren at every reboot would teach people to ignore it).
  Serial.printf("  --   %-11s GPIO%d, %s - not tested automatically: check it with the server's siren button\n",
                "siren", SIREN_PIN, siren.on ? "SOUNDING" : "silent");
#else
  Serial.printf("  --   %-11s off (SIREN_PIN -1)\n", "siren");
#endif
#if SOS_HOTSPOT_ENABLE
  Serial.printf("  --   %-11s '%s' %s, %u phone(s) on it, %u request(s) waiting for the gateway\n", "SOS Wi-Fi",
                SOS_HOTSPOT_SSID, hotspot.up() ? hotspot.ip() : "NOT RUNNING", hotspot.stations(), sosMsgOutbox.count);
#else
  Serial.printf("  --   %-11s off (SOS_HOTSPOT_ENABLE 0)\n", "SOS Wi-Fi");
#endif

#if TRANSPORT == TRANSPORT_LORA
  // A radio not found at boot makes RadioLib end the SPI bus; restart it
  // (no-op when it is running) so a since-fixed wire is seen.
  if (loraBeginState != RADIOLIB_ERR_NONE) SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  selfTestLine("LoRa radio", sjCheckLora(radio.getChipVersion(), loraBeginState),
               selfTestHint("Ra-02 on 3.3 V only: SCK %d MISO %d MOSI %d NSS %d RST %d DIO0 %d; antenna on", LORA_SCK,
                            LORA_MISO, LORA_MOSI, LORA_NSS, LORA_RST, LORA_DIO0));
#elif TRANSPORT == TRANSPORT_WIFI
  waitForLink();  // just after power-on WiFi is usually still connecting
  selfTestLine("WiFi", sjCheckWifi(WiFi.status() == WL_CONNECTED, WiFi.RSSI()),
               selfTestHint("WIFI_SSID / WIFI_PASSWORD in secrets.h; 2.4 GHz networks only"));
#endif
  selfTestLine("queue", sjCheckQueue(queueOk, queue.count(), QUEUE_CAPACITY, queue.dropped()),
               selfTestHint("Tools > Partition Scheme must include a SPIFFS/LittleFS partition"));
  uint8_t goldenPassed, goldenTotal;
  edgeGoldenResult(goldenPassed, goldenTotal);
  selfTestLine("edge AI", sjCheckEdge(SJ_EDGE_MODEL_NAME, edgeOk, goldenPassed, goldenTotal),
               selfTestHint("re-flash; the edge_*model_data.h header must match the TFLite library version"));

  const uint8_t* n = selfTestTally.counts;
  Serial.printf("=== %u OK, %u WAIT, %u WARN, %u FAIL - %s ===\n\n", n[SJ_CHECK_OK], n[SJ_CHECK_WAIT],
                n[SJ_CHECK_WARN], n[SJ_CHECK_FAIL], sjTallyVerdict(selfTestTally));
}

// =====================================================================
// Serial commands (calibration helpers)
// =====================================================================
static void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  lastSerialMs = millis();  // deep sleep: someone is calibrating - stay awake
  switch (c) {
    case 't': runSelfTest(); break;
    case 'z': Serial.println(zeroTiltBaseline() ? "[mpu6050] tilt re-zeroed" : "[mpu6050] re-zero failed"); break;
    case 'r': Serial.printf("[mq135] R0 for clean air = %.2f kOhm -> MQ135_R0_KOHM\n", calibrateMq135R0Kohm()); break;
    case 's': Serial.printf("[soil] %u mV (dry -> SOIL_DRY_MV, in water -> SOIL_WET_MV)\n", readSoilMillivolts()); break;
    case 'p': Serial.printf("[ph] %.0f mV (in pH7 -> PH_MV_AT_7, in pH4 -> PH_MV_AT_4)\n", readPhMillivolts()); break;
    case 'q':
      Serial.printf("[queue] %u waiting (+%u SOS, %u urgent sent first), %u dropped (overflow or unreadable) since queue creation\n", queue.count(), sosOutbox.count, urgentOutbox.count, queue.dropped());
#if SOS_HOTSPOT_ENABLE
      Serial.printf("[sos-wifi] %u request(s) waiting for the gateway (max %u)\n", sosMsgOutbox.count, (unsigned)SOS_MSG_SLOTS);
#endif
      break;
    case 'c': queue.clear(); Serial.println("[queue] cleared"); break;
  }
}

// =====================================================================
// Deep sleep (DEEP_SLEEP_ENABLED)
// =====================================================================
#if DEEP_SLEEP_ENABLED
// Sleeps for `seconds` (timer), or until the rain gauge tips. Never returns:
// the next wake starts again at setup().
static void enterDeepSleep(uint32_t seconds) {
  if (seconds < 1) seconds = 1;
  esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
#if ENABLE_RAIN_GAUGE
  // Reed switch to GND with a pull-up: a tip pulls the pin LOW. Not armed
  // while it is stuck closed, or every wake would end instantly.
  if (!sleepState.rainWakeOff && digitalRead(RAIN_GAUGE_PIN) == HIGH) {
    esp_sleep_enable_ext0_wakeup((gpio_num_t)RAIN_GAUGE_PIN, 0);
  }
#endif
#if SOS_BUTTON_PIN >= 0
  // ext1 (ext0 is the rain gauge's), on the pin going LOW. The digital
  // pull-up is off in deep sleep: the RTC pull-up holds the pin HIGH, and
  // it needs the RTC peripherals powered. Not armed while the button is
  // pressed / stuck, or every wake would end at once - the timer wakes
  // re-check it. pinMode first: after a rain wake that sleeps again the
  // pin is still an RTC pad from the last sleep.
  pinMode(SOS_BUTTON_PIN, INPUT_PULLUP);
  delay(1);
  if (digitalRead(SOS_BUTTON_PIN) == HIGH) {
    esp_sleep_enable_ext1_wakeup(1ULL << SOS_BUTTON_PIN, ESP_EXT1_WAKEUP_ALL_LOW);
    rtc_gpio_pullup_en((gpio_num_t)SOS_BUTTON_PIN);
    rtc_gpio_pulldown_dis((gpio_num_t)SOS_BUTTON_PIN);
    esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);
  } else {
    Serial.println("[sos] button pressed / stuck - not armed as a wake-up this sleep");
  }
#endif
  sjSleepStateSeal(sleepState);
  Serial.printf("[sleep] %lu s\n", (unsigned long)seconds);
  Serial.flush();
  esp_deep_sleep_start();
}

// Woken by a bucket tip: count it and go back to sleep for whatever is
// left until the next measurement - no sensors, radio or flash touched.
// Returns only if a measurement is due anyway.
static void handleRainWake() {
#if ENABLE_RAIN_GAUGE
  sleepState.pendingRainMm += RAIN_MM_PER_TIP;
  sleepState.rainTipsTotal++;
  pinMode(RAIN_GAUGE_PIN, INPUT);  // external pull-up (GPIO39 has none)
  uint32_t start = millis();
  while (digitalRead(RAIN_GAUGE_PIN) == LOW && millis() - start < RAIN_WAKE_STUCK_MS) delay(5);
  if (digitalRead(RAIN_GAUGE_PIN) == LOW) {
    sleepState.rainWakeOff = 1;  // stuck closed (debris?) - timer wakes only until the next measurement
    Serial.println("[rain] reed switch stays closed - rain wake-up paused until the next measurement");
  }
  uint32_t now = deviceSeconds();
  if (sjRainWakeShouldResleep(now, sleepState.nextWakeS, DEEP_SLEEP_RAIN_SLACK_S)) {
    enterDeepSleep(sjRemainingS(now, sleepState.nextWakeS));
  }
#endif
}

// Lets a press in progress decide - an SOS (sosRequested) or a release -
// before the node sleeps: asleep, a held button is not armed as a wake-up,
// so a hold that began just before the sleep would be lost.
static SjSosPhase finishSosHold() {
  uint32_t start = millis();
  SjSosPhase phase = pollSosButton();
  while (!sosRequested && phase == SJ_SOS_HOLDING && millis() - start < SOS_HOLD_MS + 1000) {
    digitalWrite(LED_PIN, sosLed(phase) > 0);  // fast blink: keep holding
    delay(10);
    phase = pollSosButton();
  }
  digitalWrite(LED_PIN, LOW);
  return phase;
}

// Woken by the SOS button: a real hold or a bump? A hold returns with
// sosRequested set - runSleepCycle() then measures and sends the SOS first.
// A bump goes back to sleep for whatever is left, like a rain tip, unless a
// measurement is due anyway. The hold counts from the wake (millis() 0), so
// the boot time is part of it.
static void handleSosWake() {
#if SOS_BUTTON_PIN >= 0
  pinMode(LED_PIN, OUTPUT);
  SjSosPhase phase = finishSosHold();
  if (sosRequested) return;
  if (phase == SJ_SOS_IDLE) Serial.println("[sos] released before SOS_HOLD_MS - not an SOS");
  uint32_t now = deviceSeconds();
  if (sjRainWakeShouldResleep(now, sleepState.nextWakeS, DEEP_SLEEP_RAIN_SLACK_S)) {
    enterDeepSleep(sjRemainingS(now, sleepState.nextWakeS));
  }
#endif
}

// The person at the node should see that the SOS got through before the
// node goes dark: LED on for SOS_LED_CONFIRM_MS (a rare event - the energy
// does not matter).
static void showSosConfirmation() {
  while (sjSosConfirmShowing(sosConfirmed, sosConfirmedAtMs, millis(), SOS_LED_CONFIRM_MS)) {
    digitalWrite(LED_PIN, HIGH);
    delay(20);
  }
}

// Everything that would keep drawing current while the ESP32 sleeps
static void sleepPeripherals() {
  transportSleep();
#if ENABLE_MPU6050
  mpuSleep();
#endif
  sensorPowerOff();
  digitalWrite(LED_PIN, LOW);
}

// Save what the next wake needs, power down, sleep. Never returns.
static void sleepUntilNextMeasurement() {
#if ENABLE_RAIN_GAUGE
  pendingRainMm += readRainSinceLastMm();  // tips the interrupt counted while awake
#endif
  // An SOS the gateway hasn't acknowledged: retry soon, and first - the
  // next wake takes it from RTC memory (the outbox is RAM).
  bool unsent = !sosOutbox.empty();
  uint32_t interval = sjPlanSleepS(elevated || unsent, DEEP_SLEEP_INTERVAL_S, DEEP_SLEEP_ELEVATED_INTERVAL_S);
  keepPendingSos();
  sleepState.session = session;
  sleepState.seq = seq;
  sleepState.pendingRainMm = pendingRainMm;
  sleepState.elevated = elevated;
  sleepState.nextWakeS = deviceSeconds() + interval;
  sleepPeripherals();
  enterDeepSleep(interval);
}

// One measurement wake: measure, queue, send what the link takes, sleep.
// sos = this reading carries the SOS flag (sent even if nothing could be
// measured: the server raises the SOS from the flag alone). regular = the
// wake's own measurement (not a second one for an SOS held meanwhile).
static void measureAndQueue(bool sos, bool regular) {
  SjReading r;
  EdgeRiskLevel edge;
  bool localAlert;
  uint8_t failed;
  bool measured = takeReading(r, localAlert, failed);
  bool newAnomaly = edgeChecks(r, failed, regular);
  edge = edgeVerdict(r);
  // a fast rise also shortens the sleep: the next wakes watch closely
  bool elev = localAlert || edge == EDGE_WATCH || edge == EDGE_URGENT || (r.xflags & SJ_X_FAST_RISE);
  elevated = measured && elev;
  // Every wake reports (one sample per wake: nothing to summarise); an
  // urgent one goes ahead of whatever is still queued.
  if (regular && measured) sjSummaryAdd(summaryAcc, r, millis());
  const SjReportInput in = {regular, measured, sos, false, elev, newAnomaly, true};
  SjReportPlan plan = sjPlanReport(in);
  if (plan.send) {
    queueReading(r, sos, plan);
  } else {
    Serial.println("[sensor] nothing could be measured - no reading this wake");
  }
  printReading(r, edge, localAlert);
}

static void runSleepCycle() {
  sleepState.rainWakeOff = 0;  // re-arm the rain wake-up every measurement
  bool sos = sosRequested;     // woken by a real SOS hold (handleSosWake)
  sosRequested = false;
  measureAndQueue(sos, true);
  bool linked = waitForLink();
  if (linked) drainQueueWithin(0, DEEP_SLEEP_MAX_AWAKE_MS);  // millis() counts from this wake
  finishSosHold();
  if (sosRequested) {  // held while this wake was measuring / sending
    sosRequested = false;
    measureAndQueue(true, false);
    if (linked) drainQueueWithin(millis(), DEEP_SLEEP_MAX_AWAKE_MS);
  }
  showSosConfirmation();
  sleepUntilNextMeasurement();
}
#endif

// =====================================================================
void setup() {
  Serial.begin(115200);
#if DEEP_SLEEP_ENABLED
  esp_sleep_wakeup_cause_t wake = esp_sleep_get_wakeup_cause();
  resumedFromSleep = wake != ESP_SLEEP_WAKEUP_UNDEFINED && sjSleepStateValid(sleepState);
  if (resumedFromSleep && wake == ESP_SLEEP_WAKEUP_EXT0) handleRainWake();  // usually sleeps again here
#if SOS_BUTTON_PIN >= 0
  bool sosWake = resumedFromSleep && wake == ESP_SLEEP_WAKEUP_EXT1 &&
                 (esp_sleep_get_ext1_wakeup_status() & (1ULL << SOS_BUTTON_PIN));
#else
  bool sosWake = false;
#endif
  setupSosButton(sosWake);
  if (sosWake) handleSosWake();  // a bump usually sleeps again here
#else
  setupSosButton(false);
#endif
  if (!resumedFromSleep) delay(500);  // give the Serial Monitor a moment after a power-on
  Serial.printf("\n=== SANJEEVNI LoRa node %s ===\n", NODE_ID);
  pinMode(LED_PIN, OUTPUT);
  setupSiren();  // early: the pin is driven to "off" before anything slow runs

  setupSensors();
  setupDutyCycle();  // off by default; never with deep sleep (that needs no MQ135 / PMS5003)
  if (resumedFromSleep) {
    // Same session across wakes: reading_uid stays unique and queued
    // readings keep their age - and no flash write every few minutes.
    session = sleepState.session;
    seq = sleepState.seq;
    pendingRainMm = sleepState.pendingRainMm;
  }

  // Readings queued by the protocol-v2 firmware are converted, not dropped
  // (sjUpgradeRecord, sj_packet.h), at the first boot after the update -
  // and so are the 68-byte records of the v3 firmware before summaries.
  queueOk = queue.begin("/node_queue.bin", "/node_queue.hdr", QUEUE_CAPACITY, sjUpgradeRecord<QueuedReading>);
  if (!queueOk) {
    Serial.println("[queue] LittleFS unavailable - readings will NOT survive outages");
  }
  Serial.printf("[queue] %u reading(s) left from before reboot\n", queue.count());
#if SOS_BUTTON_PIN >= 0
  {
    // An SOS sent before this wake / reset but not acknowledged goes first
    // again. Its copy in RTC memory (keepPendingSos()) survives deep sleep
    // and resets, whatever was queued since. A power-on loses RTC memory:
    // then the newest SOS among the last SOS_QUEUE_SCAN queued records
    // (maybe already delivered - then a duplicate the server ignores).
    // A wake with nothing in RTC memory has nothing pending.
    QueuedReading pendingSos;
    memset(&pendingSos, 0, sizeof(pendingSos));  // no summary: an SOS reading never carries one
    bool found = sjSleepPendingSos(sleepState, pendingSos.reading, pendingSos.takenAtS);
    if (!found && !resumedFromSleep) found = sjFindQueuedSos(queue, SOS_QUEUE_SCAN, 0, 0, pendingSos);
    if (found) {
      sosOutbox.add(pendingSos);
      Serial.printf("[sos] SOS #%lu-%lu not acknowledged yet - sending it first\n",
                    (unsigned long)pendingSos.reading.session, (unsigned long)pendingSos.reading.seq);
    }
  }
#endif
  setupEdgeChecks();
  sjSummaryReset(summaryAcc);  // "no edge verdict yet" is not the zero a static starts with
  edgeOk = setupEdgeAI();  // EDGE_MODEL_IN_USE: main / lite / none (config.h)
  Serial.printf("[edge] %s model %s\n", SJ_EDGE_MODEL_NAME,
                edgeOk ? "ready" : "unavailable - sending without edge verdict");
  setupTransport();  // LoRa: result kept in loraBeginState for the self-test
  if (!resumedFromSleep) {
    // New session every power-on -> unique reading_uid, also across board
    // swaps and NVS erases (sj_session.h). After setupTransport() so the
    // radio's noise is available. "sess32" is new: a board updated from the
    // 16-bit counter ("session") also gets a random start, away from 1, 2, 3.
    bool stored = sjPrefs.isKey("sess32");
    uint32_t fresh = stored ? 0 : sjFreshSession(ESP.getEfuseMac(), esp_random(), transportEntropy());
    session = sjNextSession(stored, sjPrefs.getULong("sess32", 0), fresh);
    sjPrefs.putULong("sess32", session);
    sjSleepStateReset(sleepState, session);
    keepPendingSos();  // the reset wiped the RTC copy of an SOS recovered above
  }
  Serial.printf("[boot] session %lu%s\n", (unsigned long)session, resumedFromSleep ? " (woke from deep sleep)" : "");
#if !DEEP_SLEEP_ENABLED
  Serial.printf("[boot] normal report every %lus (%s); urgent readings at once\n",
                (unsigned long)(NORMAL_REPORT_INTERVAL_MS / 1000), SIREN_PIN >= 0 ? "siren node" : "no siren");
#endif
  setupHotspot();  // never with deep sleep (config.h)
#if DEEP_SLEEP_ENABLED
  if (resumedFromSleep) runSleepCycle();  // never returns
#endif
  // Only after a power-on / reset from here on (deep-sleep wakes never get here)
#if SELF_TEST_ON_POWER_ON
  runSelfTest();
#endif
  Serial.println("[serial] t = self-test, z = re-zero tilt, r = MQ135 R0, s = soil mV, p = pH mV, q = queue, "
                 "c = clear queue");
#if DEEP_SLEEP_ENABLED
  Serial.printf("[sleep] power-on: always-on for %lus (Serial commands work; each one adds time), "
                "then one reading every %us\n", DEEP_SLEEP_SETUP_WINDOW_MS / 1000, (unsigned)DEEP_SLEEP_INTERVAL_S);
#endif
}

void loop() {
  handleSerial();
#if ENABLE_PMS5003
  pollPms5003();  // keep the UART buffer drained
#endif
  SjSosPhase sosPhase = pollSosButton();
  serviceDutyCycle();
  serviceSiren();
  serviceHotspot();

  uint32_t now = millis();
  bool sos = sosRequested;  // SOS: measure now, don't wait for the next sample
  bool sirenDue = sirenReportDue;  // siren started / stopped: report it now
  bool regular = now - lastSampleMs >= SAMPLE_INTERVAL_MS;
  if (sos || sirenDue || regular) {
    sosRequested = false;
    lastSampleMs = now;
    SjReading r;
    EdgeRiskLevel edge;
    bool localAlert;
    uint8_t failed;
    bool ok = takeReading(r, localAlert, failed);
    bool newAnomaly = edgeChecks(r, failed, regular);
    edge = edgeVerdict(r);
    // A fast river rise is sent at once - every sample while it lasts.
    elevated = localAlert || edge == EDGE_WATCH || edge == EDGE_URGENT || (r.xflags & SJ_X_FAST_RISE);
    // Only samples on the regular schedule count towards the siren's
    // "URGENT on N consecutive samples": an extra one taken a moment later
    // for an SOS / a siren report sees the same glitch, not a confirmation.
    // A start here goes out in this very reading. A value the anomaly
    // checks doubt is never URGENT here (sjSirenLocalUrgent).
    if (regular) sirenSample(r, ok);
    sirenDue = sirenDue || sirenReportDue;
    sirenReportDue = false;
#if SUMMARY_ENABLE
    if (regular && ok) sjSummaryAdd(summaryAcc, r, now);  // every regular sample, sent now or summarised later
#endif
    // What to send, and how urgently (sj_report.h): urgent readings at once
    // and ahead of the backlog, otherwise one report per interval carrying
    // the summary of the samples since the last one. An SOS reading goes
    // even if no sensor answered: the server raises the SOS from the flag
    // (the backend then refuses the reading itself and the gateway drops
    // just that one - sjUploadAction()).
    const SjReportInput in = {regular, ok, sos, sirenDue, elevated, newAnomaly,
                              now - lastReportMs >= NORMAL_REPORT_INTERVAL_MS || lastReportMs == 0};
    SjReportPlan plan = sjPlanReport(in);
    if (plan.send) {
      if (queueReading(r, sos, plan)) {
        lastReportMs = now;
        dutyOnReport(r);
        if (plan.priority || sirenDue) nextFlushMs = millis();  // try to send immediately
      }
    }
    printReading(r, edge, localAlert);
  }

  if ((queue.count() > 0 || !sosOutbox.empty() || !urgentOutbox.empty() || sosMsgsWaiting()) &&
      sjFlushDue(millis(), nextFlushMs, FLUSH_RETRY_INTERVAL_MS))
    flushQueue();

  // LED: SOS feedback first (sjSosLed), else fast blink while elevated
  int led = sosLed(sosPhase);
  digitalWrite(LED_PIN, led >= 0 ? led : elevated && (millis() / 150) % 2);

#if DEEP_SLEEP_ENABLED
  // Setup window after a power-on is over and nobody is typing commands:
  // send what is queued, then start the measure-and-sleep cycle.
  if (millis() >= DEEP_SLEEP_SETUP_WINDOW_MS && millis() - lastSerialMs >= DEEP_SLEEP_SETUP_WINDOW_MS) {
    Serial.println("[sleep] setup window over - starting the deep-sleep cycle");
    drainQueueWithin(millis(), DEEP_SLEEP_MAX_AWAKE_MS);
    finishSosHold();
    // A hold during that drain: loop() measures and sends the SOS on its
    // next pass and comes back here - never sleep on a requested SOS.
    if (!sosRequested) {
      showSosConfirmation();
      sleepUntilNextMeasurement();
    }
  }
#endif
  delay(10);
}
