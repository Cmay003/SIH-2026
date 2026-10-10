// =====================================================================
// SANJEEVNI LoRa sensor node - configuration.
// CHECK EVERY PIN AGAINST YOUR WIRING BEFORE FLASHING.
// WiFi password / backend URL live in secrets.h (git-ignored) - copy
// secrets.example.h to secrets.h and fill it in.
// =====================================================================
#pragma once

// ---- Identity -------------------------------------------------------
// Must exist in the backend's node registry (admin API), max 12 chars.
#define NODE_ID "NODE-04"

// ---- Transport ------------------------------------------------------
// LORA: send to a SANJEEVNI gateway (sanjeevni_lora_gateway) - works with
//       no WiFi/internet at the node. This is the deployment mode.
// WIFI: post straight to the backend - single-board bench demo, no gateway.
#define TRANSPORT_LORA 1
#define TRANSPORT_WIFI 2
#define TRANSPORT TRANSPORT_LORA

// ---- Timing ---------------------------------------------------------
// The node SAMPLES often but only TRANSMITS often when something looks
// wrong ("detect locally, send critical alerts upstream" - PPT slide 3):
//  - normal readings: one every NORMAL_REPORT_INTERVAL_MS - the latest
//    sample plus a summary of every sample since the previous report
//    (SUMMARY_ENABLE). It is also the heartbeat of the backend's
//    missing-node check, which learns each node's interval from its
//    readings (or pin report_interval_seconds on the admin page: 300 for
//    a node without a siren, 60 for a siren node):
//      node WITHOUT a siren (SIREN_PIN -1): NO_SIREN_REPORT_INTERVAL_MS, 5 min
//      node WITH a siren: SIREN_REPORT_INTERVAL_MS, at most 1 min - its
//        siren commands only arrive in the gateway's ACK of a report
//        (checked in the siren section below)
//  - urgent readings (edge AI WATCH/URGENT, a local threshold, a fast
//    rise, a new anomaly, an SOS): every sample, immediately, whatever the
//    interval (sj_report.h)
// Deep-sleep nodes use DEEP_SLEEP_INTERVAL_S instead (one sample per wake).
// Airtime per hour of each choice: sj_report.h.
#define SAMPLE_INTERVAL_MS 5000UL
#define NO_SIREN_REPORT_INTERVAL_MS 300000UL  // decision 2026-10-09: 5-min summaries without a siren
#define SIREN_REPORT_INTERVAL_MS 60000UL      // must stay <= 60000 (static_assert below)
// The one in force (SIREN_PIN is defined further down - a macro is
// expanded where it is used, after this file is read).
#define NORMAL_REPORT_INTERVAL_MS (SIREN_PIN >= 0 ? SIREN_REPORT_INTERVAL_MS : NO_SIREN_REPORT_INTERVAL_MS)
#define FLUSH_RETRY_INTERVAL_MS 10000UL  // after a failed send, wait before retrying
#define MAX_SENDS_PER_FLUSH 10           // bound time spent flushing a backlog per loop

// ---- Smart sending (sj_report.h) ---------------------------------------
// 1 = each normal report also carries a SUMMARY of every sample since the
// previous one (min / max / mean of water, temperature, humidity, gas,
// PM2.5, tilt, and the highest edge verdict); its top-level values stay the
// latest sample. 32 bytes more on air at most (12 for a water-only node) -
// the airtime figures are in sj_report.h. 0 = the latest sample only.
#define SUMMARY_ENABLE 1
// Urgent readings (WATCH / URGENT, a local threshold, a fast rise, a new
// anomaly) go ahead of a queued backlog: the newest URGENT_OUTBOX_SLOTS of
// them wait in RAM before the queue (older ones keep their place in it).
// SENT_AHEAD_SLOTS readings that went ahead are remembered, so their
// queued copies are not sent a second time (~24 bytes of RAM each).
#define URGENT_OUTBOX_SLOTS 8
#define SENT_AHEAD_SLOTS 64

// The report-interval checks are in the siren section below (they need SIREN_PIN).
static_assert(URGENT_OUTBOX_SLOTS >= 1 && URGENT_OUTBOX_SLOTS <= 32, "URGENT_OUTBOX_SLOTS: 1..32");
static_assert(SENT_AHEAD_SLOTS >= URGENT_OUTBOX_SLOTS + 2 && SENT_AHEAD_SLOTS <= 255,
              "SENT_AHEAD_SLOTS: at least both outboxes' size, at most 255");

// ---- Deep sleep (battery / solar nodes) ------------------------------
// 1 = the node measures once, queues and sends, then deep-sleeps until
// the next measurement (instead of sampling every 5 s). On a real
// power-on it first stays awake DEEP_SLEEP_SETUP_WINDOW_MS (always-on
// behaviour) so the Serial calibration commands still work; each command
// keeps it awake for another window.
// Needs ENABLE_GAS 0 and ENABLE_PMS5003 0 (checked below): the MQ135
// heater needs minutes and the PMS5003 fan ~30 s before readings are
// valid. Set the node's "Reports every" on the admin page to
// DEEP_SLEEP_INTERVAL_S, or it is reported missing.
// POWER: a dev board's USB chip, LED and AMS1117 regulator can draw
// several mA even with the ESP32 asleep - MEASURE the sleep current with a
// meter; a bare module + low-quiescent regulator is needed for long runs.
#define DEEP_SLEEP_ENABLED 0
#define DEEP_SLEEP_INTERVAL_S 300            // normal: measure + send every 5 min
#define DEEP_SLEEP_ELEVATED_INTERVAL_S 30    // after an elevated reading: watch closely
#define DEEP_SLEEP_SETUP_WINDOW_MS 60000UL   // awake after power-on / last Serial command
#define DEEP_SLEEP_MAX_AWAKE_MS 30000UL      // a wake never lasts longer (radio hang etc.)
#define DEEP_SLEEP_RAIN_SLACK_S 2            // rain wake this close to a measurement: measure now
#define RAIN_WAKE_STUCK_MS 300               // reed still closed after this: don't wake on it again
#define WIFI_CONNECT_TIMEOUT_MS 10000UL      // TRANSPORT_WIFI: give up on this wake after this
// Optional: a GPIO that switches the sensors' power (MOSFET / load switch).
// -1 = sensors stay powered (HC-SR04 ~2 mA, soil sensor ~5 mA idle). Put a
// resistor on the switch input so it is OFF while the ESP32 sleeps (pins
// float in deep sleep). Don't use a strapping pin (0, 2, 5, 12, 15) - a
// load on GPIO12 can stop the board booting. GPIO17 is free when
// ENABLE_PMS5003 is 0.
#define SENSOR_POWER_PIN -1
#define SENSOR_POWER_ON HIGH
#define SENSOR_WARMUP_MS 2000  // DHT22 needs ~1-2 s after power-up

// ---- Gas / PM warm-up after a power-on or reset ----------------------
// Until this long after boot the value is left OUT of every reading (its
// flag unset, as for an absent sensor), it does not trigger the local
// alert, and the self-test shows WAIT (sj_warmup.h). A cold MQ135 heater
// reads far too high, which would otherwise report a false gas leak after
// every power cut. The cost: a real leak in this window is not reported by
// the MQ135 (the flame sensor still works). Counted from every reset, not
// only a power loss - a little conservative after a watchdog reset.
//  - MQ135: the Hanwei MQ-135 datasheet only gives "Preheat time: Over 24
//    hour" (its burn-in for rated accuracy - calibrate R0 with 'r' after
//    that). It gives NO figure for re-warming after a short power cut, so
//    180 s is an engineering estimate. TUNE IN THE FIELD: power-cycle the
//    node, watch the self-test's MQ135 line ('t') until the ppm settles.
//  - PMS5003: Plantower PMS5003 datasheet PTQ3004-2015 V1.0 (2019-07-31):
//    "Stable data should be got at least 30 seconds after the sensor
//    wakeup from the sleep mode because of the fan's performance." Applied
//    to power-on too (the fan starts from rest either way); keep >= 30.
#define MQ135_WARMUP_S 180
#define PMS5003_WARMUP_S 30
static_assert(PMS5003_WARMUP_S >= 30, "PMS5003_WARMUP_S: the datasheet asks for at least 30 s");

// ---- Self-test --------------------------------------------------------
// 1 = run the sensor/radio self-test once after every power-on or reset
// (never on a deep-sleep wake). Send 't' on Serial to run it any time.
#define SELF_TEST_ON_POWER_ON 1

// ---- Queue (LittleFS) -----------------------------------------------
// 2000 x (100 B + 4 B CRC) = ~203 KB in 52 small segment files
// (sj_file_queue.h; a record is the 64-byte reading, its time and its
// 32-byte summary). At one report a minute (siren node) that is ~33 hours
// of outage before the oldest readings start being overwritten; at one
// per 5 min (no siren) ~166 hours (6.9 days) - fewer if urgent readings
// (one per 5-s sample while they last) fill it meanwhile. Changing this with
// readings still queued is safe: the next boot moves them to the new size
// (as it converts readings queued by the previous firmware's layouts).
// The move needs free flash for a second copy; without that room the
// queue keeps the old size and its readings until the next boot retries.
#define QUEUE_CAPACITY 2000

// ---- LoRa SX1278 (433 MHz, e.g. Ai-Thinker Ra-02) -------------------
// LEGAL NOTE: confirm the band and max power you may use in India
// (WPC rules) before field use. The 865-867 MHz LoRa band common in India
// needs an SX1276/RFM95 868 MHz module, not an SX1278.
#define LORA_FREQUENCY_MHZ 433.0
#define LORA_BANDWIDTH_KHZ 125.0
#define LORA_SPREADING_FACTOR 9  // 7 = fastest/shortest range ... 12 = slowest/longest
#define LORA_CODING_RATE 7       // 4/7
#define LORA_SYNC_WORD 0x34      // private network - MUST match the gateway
#define LORA_TX_POWER_DBM 10
#define LORA_ACK_TIMEOUT_MS 1500  // must cover gateway flash write + ACK airtime at this SF

// SPI (VSPI) + control pins for the SX1278
#define LORA_SCK 18
#define LORA_MISO 19
#define LORA_MOSI 23
#define LORA_NSS 5
#define LORA_RST 14
#define LORA_DIO0 26

// ---- Sensors: enable/disable + pins ----------------------------------
// Every sensor is optional (modular nodes): set 0 for anything not fitted.
// A reading carries only the sensors that answered; the backend skips the
// models that need a missing one. The MAIN edge model needs all of water,
// DHT, gas and flame; any other kit gets the LITE model (Edge AI below).
// A node WITHOUT the MQ135 (ENABLE_GAS 0) draws far less power - that is
// the precondition for deep sleep on battery nodes.
#define ENABLE_WATER_LEVEL 1  // HC-SR04
#define ENABLE_DHT 1          // DHT22
#define ENABLE_GAS 1          // MQ135
#define ENABLE_FLAME 1        // IR flame module
#define ENABLE_RAIN_GAUGE 1   // tipping bucket (reed switch)
#define ENABLE_SOIL 1         // capacitive soil moisture v1.2
#define ENABLE_MPU6050 1      // tilt + vibration (landslide)
#define ENABLE_PMS5003 1      // PM2.5 / PM10
#define ENABLE_PH 1           // analog pH board (e.g. PH-4502C)
#define ENABLE_TURBIDITY 1    // analog turbidity (e.g. DFRobot SEN0189)
#define ENABLE_BATTERY 1      // voltage divider on the 18650

static_assert(ENABLE_WATER_LEVEL || ENABLE_DHT || ENABLE_GAS || ENABLE_FLAME || ENABLE_SOIL || ENABLE_MPU6050 ||
                  ENABLE_PMS5003 || ENABLE_PH || ENABLE_TURBIDITY,
              "enable at least one measuring sensor - the backend rejects readings with no sensor values");

#define DHT_PIN 4
#define DHT_TYPE DHT22

// HC-SR04 ECHO is a 5 V signal: use a divider (e.g. 1k/2k) into GPIO27.
#define ULTRASONIC_TRIG 25
#define ULTRASONIC_ECHO 27
// Distance from the sensor face down to the EMPTY / zero-water surface.
// 2.34 cm was measured on the bench rig; for a river gauge, measure the
// sensor height above the riverbed/gauge zero and enter it here (max ~400 cm).
#define ULTRASONIC_MOUNT_HEIGHT_CM 2.34f

#define FLAME_PIN 13  // most IR flame modules pull LOW when they see flame

#define MQ135_PIN 34
#define MQ135_VCC 5.0f
#define MQ135_RL_KOHM 1.0f            // load resistor on your module ("102" = 1k, "103" = 10k)
#define MQ135_R0_KOHM 76.63f          // CALIBRATE: send 'r' on Serial in clean outdoor air
// The 5 V MQ135 module's AO reaches ~5 V - straight into GPIO34 that can
// damage the ESP32 (3.3 V max). Fit a 10k (AO side) / 10k (GND side)
// divider: ratio 2.0. Must match the real resistors: (R1+R2)/R2.
#define MQ135_ADC_DIVIDER_RATIO 2.0f

// Tipping-bucket rain gauge: reed switch between pin and GND.
// GPIO39 is input-only with NO internal pull-up: fit an external 10k
// pull-up to 3.3 V.
#define RAIN_GAUGE_PIN 39
#define RAIN_MM_PER_TIP 0.2794f  // common 0.011" bucket - check your gauge's datasheet
#define RAIN_DEBOUNCE_MS 80

// Capacitive soil moisture: calibrate by reading Serial output in dry
// air and in a glass of water ('s' command prints the raw millivolts).
#define SOIL_PIN 32
#define SOIL_DRY_MV 2600
#define SOIL_WET_MV 1100

// MPU6050 on I2C (address 0x68 with AD0 low). Tilt is measured relative to
// the orientation stored at installation - send 'z' on Serial to re-zero.
#define I2C_SDA 21
#define I2C_SCL 22
#define MPU6050_ADDR 0x68

// PMS5003 on UART2 at 9600 baud. PMS TX -> ESP32 RX pin. Needs 5 V power,
// 3.3 V logic.
#define PMS_RX_PIN 16
#define PMS_TX_PIN 17

// Analog pH board. Most output up to ~5 V: divide down to <3.3 V and set
// the ratio. Two-point calibration: dip in pH 7 and pH 4 buffer, note the
// millivolts printed by the 'p' command, enter them below.
#define PH_PIN 33
#define PH_ADC_DIVIDER_RATIO 1.5f
#define PH_MV_AT_7 2500.0f
#define PH_MV_AT_4 3030.0f

// Analog turbidity (DFRobot SEN0189-style, 0-4.5 V output -> divider!).
#define TURBIDITY_PIN 36
#define TURBIDITY_ADC_DIVIDER_RATIO 1.5f

// Battery: 18650 through a 2:1 divider into an ADC1 pin.
#define BATTERY_PIN 35
#define BATTERY_DIVIDER_RATIO 2.0f
#define BATTERY_EMPTY_V 3.0f
#define BATTERY_FULL_V 4.2f

#define LED_PIN 2

// ---- SOS push-button (for people with no phone) ----------------------
// A push-button between SOS_BUTTON_PIN and GND (pressed = LOW, the ESP32's
// internal pull-up - no resistor to 3V3 needed). Holding it SOS_HOLD_MS
// sends one reading flagged as an SOS at once, ahead of any queued backlog;
// the server raises an SOS at this node's registered position (sj_sos.h).
// LED: fast blink while held, slow blink until the gateway has the SOS,
// then on for SOS_LED_CONFIRM_MS. It also wakes a deep-sleeping node.
// -1 = no button.
// Why GPIO15: the pin needs an internal pull-up and must be an RTC GPIO
// (deep-sleep wake). Every such pin that is not a strapping pin is taken
// above (4, 13, 14, 25, 26, 27, 32, 33); 34-39 have no pull-ups. Of the
// strapping pins, 15 is the harmless one: held LOW at a reset it only
// silences the ROM boot log, while 0 LOW = download mode (node hangs),
// 12 decides the flash voltage and 2 is the LED. Put a 1k resistor in
// series with the button (ESD on a long outdoor cable).
#define SOS_BUTTON_PIN 15
#define SOS_HOLD_MS 2000UL           // hold this long: a bump or a knock is not an SOS
#define SOS_COOLDOWN_MS 60000UL      // after an SOS, presses are ignored this long
#define SOS_STUCK_MS 30000UL         // pressed longer (or at power-on) = stuck button, SOS off until released
#define SOS_DEBOUNCE_MS 50UL         // a release shorter than this is contact bounce
#define SOS_LED_CONFIRM_MS 10000UL   // LED stays on this long once the gateway has the SOS
#define SOS_QUEUE_SCAN 32            // after a power-on (RTC copy lost): newest queued records searched for an unsent SOS

// ---- Village siren + strobe (sj_siren.h) -------------------------------
// A 12 V siren / strobe switched by SIREN_PIN through a logic-level
// N-MOSFET (low side) or a relay board with an active-HIGH 3.3 V input;
// they run from their OWN 12 V supply, common GND with the ESP32. Wiring
// and parts: docs/wiring.html (tools/wiring/generate_wiring.py).
// It sounds when the server commands it (officer button, or the server's
// rule for a CONFIRMED CRITICAL hazard here) - the command arrives in the
// gateway's ACK of one of this node's readings, so at most one report
// interval late. On its own the node sounds it ONLY as an offline fallback:
// no gateway ACK for SIREN_OFFLINE_AFTER_S and the water level or gas at its
// siren danger level (below) on SIREN_OFFLINE_URGENT_SAMPLES consecutive
// samples - evacuation hazards only (decision 2026-10-09): never heat, PM,
// tilt, flame or the edge-AI verdict on their own. -1 = no siren (the node
// then sends its normal summary every NO_SIREN_REPORT_INTERVAL_MS, 5 min,
// instead of every SIREN_REPORT_INTERVAL_MS).
// Why GPIO12: every other output-capable pin is taken above (with all
// sensors on). GPIO12 is a strapping pin that must be LOW at reset (HIGH
// selects 1.8 V flash and the board won't boot) - which is exactly what the
// MOSFET's 10k gate pull-down does anyway, and it keeps the siren off
// while the ESP32 resets. So: the 10k gate-to-GND resistor is REQUIRED,
// and NEVER put an active-LOW relay board on it (its input pulls the pin
// HIGH). On a node with fewer sensors, a non-strapping pin is the
// simpler choice (e.g. GPIO17 without the PMS5003).
#define SIREN_PIN 12
#define SIREN_ACTIVE_LEVEL HIGH
// The offline fallback and its limits. These are configurable demo
// defaults, not values from a standard - set them with the district.
#define SIREN_OFFLINE_AFTER_S 900        // no gateway ACK this long = the node may act alone
#define SIREN_OFFLINE_URGENT_SAMPLES 2   // consecutive URGENT samples (SAMPLE_INTERVAL_MS apart)
#define SIREN_ON_S 180                   // one trigger sounds this long (also a command without for_s)
#define SIREN_MAX_ON_S 900               // a command's for_s is capped at this (= server siren.js MAX_ON_SECONDS)
#define SIREN_COOLDOWN_S 300             // quiet at least this long before the node re-arms itself
// The offline siren's danger levels (0 = off) - the only offline triggers
// (sj_siren.h sjSirenLocalUrgent). AT OR ABOVE the LOCAL_* "send now"
// limits below, not always above: the water level is above (0.8 vs 0.4 of
// the mount), the gas level EQUALS LOCAL_GAS_LIMIT_PPM (both 800 ppm = the
// backend's GAS_CRITICAL_PPM) - the siren's extra margin for gas is only
// SIREN_OFFLINE_URGENT_SAMPLES consecutive samples, not a higher level.
#define SIREN_LOCAL_WATER_FRACTION 0.8f  // of ULTRASONIC_MOUNT_HEIGHT_CM - demo default, use the site's danger level
#define SIREN_LOCAL_GAS_PPM 800          // = backend GAS_CRITICAL_PPM (backend_server.py)

static_assert(SIREN_PIN < 0 || (SIREN_PIN != 0 && SIREN_PIN != 1 && SIREN_PIN != 3 && SIREN_PIN < 34 &&
                                !(SIREN_PIN >= 6 && SIREN_PIN <= 11)),
              "SIREN_PIN: needs an output-capable GPIO; not 0 (a gate pull-down = download mode), 1/3 (USB "
              "Serial), 6-11 (flash) or 34-39 (input-only)");
static_assert(SIREN_PIN < 0 || !DEEP_SLEEP_ENABLED,
              "SIREN_PIN needs DEEP_SLEEP_ENABLED 0: an asleep node can neither time the siren nor hear a "
              "command (they arrive in the ACK window after each report)");
// Report interval (Timing, top of this file). A siren node must stay at
// one report a minute: an officer's "sound it" / "stop" waits for its next
// ACK. A node without a siren has no commands to wait for: 5-min summaries
// (decision 2026-10-09); urgent readings go at once either way.
static_assert(SIREN_PIN < 0 || SIREN_REPORT_INTERVAL_MS <= 60000UL,
              "SIREN_PIN: a siren node must report at least every 60 s (SIREN_REPORT_INTERVAL_MS) - its "
              "commands only arrive in the gateway's ACK of a reading");
static_assert(NORMAL_REPORT_INTERVAL_MS >= SAMPLE_INTERVAL_MS, "the report interval is at least one sample");
static_assert(NORMAL_REPORT_INTERVAL_MS <= 600000UL,
              "NORMAL_REPORT_INTERVAL_MS: at most 10 min - it is also the backend's missing-node heartbeat");
static_assert(NORMAL_REPORT_INTERVAL_MS / SAMPLE_INTERVAL_MS <= 255, "a summary counts at most 255 samples");
static_assert(SIREN_OFFLINE_URGENT_SAMPLES >= 2, "SIREN_OFFLINE_URGENT_SAMPLES: at least 2 - one sample is a glitch");
static_assert(SIREN_OFFLINE_AFTER_S * 1000ULL >= 3ULL * NORMAL_REPORT_INTERVAL_MS,
              "SIREN_OFFLINE_AFTER_S: a few missed ACKs are not 'offline' - at least 3 report intervals");
static_assert(SIREN_ON_S >= 1 && SIREN_ON_S <= SIREN_MAX_ON_S && SIREN_MAX_ON_S <= 3600,
              "SIREN_ON_S must be 1 .. SIREN_MAX_ON_S (at most an hour)");

// ---- Gas / PM duty cycle for solar nodes (sj_duty.h) --------------------
// 0 (default) = the MQ135 heater and the PMS5003 fan run continuously, as
// before. 1 = the sensor is powered only around the normal reports that
// carry its value: it wakes (warm-up + DUTY_MARGIN_S) before such a report,
// its values count only once it has been powered for its warm-up
// (MQ135_WARMUP_S / PMS5003_WARMUP_S - the same gate as after a boot,
// sj_warmup.h; never a cold reading), and it sleeps again once a report
// has carried a warm value. One wake per *_DUTY_PERIOD_S, rounded down to
// whole report intervals (at least every report): 5-min reports -> PMS5003
// every report, MQ135 every 2nd; 1-min reports (siren node) -> PMS5003
// every 5th. While the node is elevated (a local alert - flame included -,
// edge WATCH/URGENT, a fast rise) both stay on and measure every sample.
// NOT on a siren node: MQ135_DUTY_CYCLE (static_assert below). Gas is one
// of the offline siren's two triggers (sj_siren.h) and a gas leak is an
// evacuation hazard (decision 2026-10-09): with the heater off between
// wakes, neither the server nor the offline fallback would see a leak for
// up to MQ135_DUTY_PERIOD_S. A siren node is mains / 12 V powered anyway
// (it cannot deep-sleep). The PMS5003 duty cycle is allowed there (PM is
// not a siren trigger).
// THE COST: between wakes that sensor does not measure - a gas leak or smoke
// starting then is seen at the next wake (up to one period later; the
// flame sensor and every other sensor still run every 5 s), and with the
// MQ135 asleep the edge-AI model (needs gas) does not run either. Readings
// between wakes carry no gas / PM value (flag unset, as during the boot
// warm-up). So: only where the panel cannot carry the continuous load.
// MQ135 re-warm: the Hanwei datasheet gives no figure for re-heating after
// a short off-time (only "Preheat time: Over 24 hour"), and the MQ135 is not
// specified for pulsed heating - whether 180 s is enough after minutes off
// is UNVERIFIED: compare duty-cycled readings with a continuously heated
// sensor before relying on them.
//
// ENERGY (ESTIMATE, to be MEASURED; 5 V rail, before the boost converter's
// loss, ESP32 + radio not included - they do not change). For CLEAN-AIR
// days (no local alert): while the node is elevated both sensors stay on,
// so a day with sustained "send now" levels saves nothing - duty_tests.h
// prints a polluted day (PM2.5 80 / PM10 180, "Moderately polluted") and a
// "Very Poor" day next to the clean one:
//   MQ135 heater: 5 V / 33 ohm = ~150 mA (Hanwei MQ-135 technical data:
//     RH 33 ohm +-5 %, heating consumption "less than 800mw"; the module's
//     LED / comparator add a little - not in the datasheet)
//   PMS5003: active <= 100 mA, standby <= 200 uA (Plantower PMS5003
//     datasheet PTQ3004-2015 V1.0, 2019-07-31)
//   On-time: by design 45 s per 300 s (PMS5003) and 195 s per 600 s (MQ135);
//     in the host simulation (duty_tests.h, a clean-air day of 5-min
//     reports with loop jitter, PMS5003 frames every 2.3 s) 15.4 % and
//     32.7 % - the report sample comes a little after its due time. Siren
//     node (1-min reports, PMS5003 only): 15.1 %.
//                      continuous       duty cycle (defaults below)
//   MQ135 heater       ~3,640 mAh/day   ~1,190 mAh/day
//   PMS5003            <=2,400 mAh/day  <=375 mAh/day (incl. standby)
//   together           ~6,040 mAh/day   ~1,560 mAh/day (~74 % less)
// The PMS5003 alone (needs no new pin, see PMS5003_SET_PIN) saves ~2,030
// mAh/day of that. The MQ135 module's LED and comparator are switched off
// with it (same switched GND).
#define PMS5003_DUTY_CYCLE 0
#define PMS5003_DUTY_PERIOD_S 300
// How the PMS5003 is slept: -1 = the datasheet's serial command (CMD 0xE4)
// over the PMS RX line the node already drives (PMS_TX_PIN) - no new pin.
// >= 0 = the module's SET pin on this GPIO (LOW = sleep, HIGH = work; 3.3 V
// level, pulled up inside the module - so never GPIO0, 2 or 12, checked
// below). With every sensor fitted no GPIO is free for it (tools/wiring).
#define PMS5003_SET_PIN -1
#define MQ135_DUTY_CYCLE 0
#define MQ135_DUTY_PERIOD_S 600
// The heater needs a switch: a logic-level N-MOSFET in the MQ135 module's
// GND lead (low side; Rds(on) specified at 3.3 V gate drive or less), 100R
// gate resistor, 10k gate-to-GND so it is OFF while the ESP32 resets. Off,
// the module's AO rises towards 5 V - the 10k/10k divider keeps GPIO34 near
// 2.5 V, and the firmware does not read it then. -1 = no switch.
// PINS: with every sensor of this file fitted, NO output-capable GPIO is
// free (tools/wiring/generate_wiring.py --check lists the free ones). On an
// air-quality node drop the pH probe (ENABLE_PH 0 frees GPIO33) or the soil
// sensor (ENABLE_SOIL 0 frees GPIO32); GPIO12 only without the siren.
#define MQ135_HEATER_PIN -1
#define MQ135_HEATER_ON HIGH
#define DUTY_MARGIN_S 15  // the sensor is warm this long before its report (3 samples for the summary)

// ---- Offline SOS Wi-Fi "SANJEEVNI-SOS" (sj_hotspot.h) --------------------
// 1 = this node also runs an OPEN Wi-Fi with a captive SOS page (EN/HI) for
// people whose phone has no mobile data. A request goes to the gateway over
// LoRa (SjSosMsg, retried until the gateway ACKs it, kept in NVS) and from
// there to the server, placed at THIS node's registered position (browsers
// give a plain-http page no GPS) plus what the person typed.
// For MAINS / SOLAR nodes only: the access point keeps the Wi-Fi radio on
// (on the order of 100 mA - measure yours), so no deep sleep (checked
// below). LoRa transport only. Update the GATEWAY first: older gateway
// firmware ignores the SOS packet (the node keeps retrying).
// FLASH: this links the Wi-Fi stack into a LoRa node, which otherwise has
// none - if the sketch no longer fits, pick a partition scheme with a
// bigger app partition (the LittleFS queue still needs its ~210 KB, and
// twice that once while a firmware update converts it).
// The limits are configurable demo defaults, not values from a standard.
#define SOS_HOTSPOT_ENABLE 0
#define SOS_HOTSPOT_SSID "SANJEEVNI-SOS"
#define SOS_HOTSPOT_CHANNEL 1          // 1, 6 or 11 - pick the least crowded where the node stands
#define SOS_HOTSPOT_MAX_CLIENTS 8      // phones connected at once (the ESP32 allows up to 10)
// Per phone - recognised by its page id AND its Wi-Fi address, so a fresh
// id from the same phone does not count as a new phone: one open request,
// then SOS_HOTSPOT_CLIENT_GAP_S after it went out. The access-point-wide
// window is only the backstop against many phones (or a phone that keeps
// re-joining with a new address), so it is set well above what one phone
// can use.
#define SOS_HOTSPOT_MAX_PER_WINDOW 20  // new requests per window on the whole access point (<= 32)
#define SOS_HOTSPOT_WINDOW_S 600
#define SOS_HOTSPOT_CLIENT_GAP_S 120   // after a phone's request went out, it waits this long to send another
#define SOS_MSG_SLOTS 4                // requests waiting for the gateway (RAM + NVS); full = "try again" page

static_assert(!SOS_HOTSPOT_ENABLE || !DEEP_SLEEP_ENABLED,
              "SOS_HOTSPOT_ENABLE needs DEEP_SLEEP_ENABLED 0: the access point must stay on (mains / solar nodes)");
static_assert(!SOS_HOTSPOT_ENABLE || TRANSPORT == TRANSPORT_LORA,
              "SOS_HOTSPOT_ENABLE needs TRANSPORT_LORA: the WiFi transport is the single-board bench demo");
static_assert(SOS_HOTSPOT_MAX_PER_WINDOW >= 1 && SOS_HOTSPOT_MAX_PER_WINDOW <= 32,
              "SOS_HOTSPOT_MAX_PER_WINDOW must be 1..32 (sj_hotspot.h SJ_HS_RATE_SLOTS)");
static_assert(SOS_HOTSPOT_MAX_CLIENTS >= 1 && SOS_HOTSPOT_MAX_CLIENTS <= 10, "SOS_HOTSPOT_MAX_CLIENTS: 1..10 (ESP32)");
static_assert(SOS_MSG_SLOTS >= 1 && SOS_MSG_SLOTS <= 16, "SOS_MSG_SLOTS: 1..16 (each is ~160 bytes of RAM and NVS)");

// ---- Deep-sleep checks -------------------------------------------------
// Only RTC GPIOs can wake the ESP32 (classic ESP32: 0,2,4,12-15,25-27,32-39).
constexpr bool sjIsRtcGpio(int pin) {
  return pin == 0 || pin == 2 || pin == 4 || (pin >= 12 && pin <= 15) || (pin >= 25 && pin <= 27) ||
         (pin >= 32 && pin <= 39);
}
static_assert(SOS_BUTTON_PIN < 34,
              "SOS_BUTTON_PIN: GPIO34-39 have no internal pull-up, the button needs INPUT_PULLUP");
static_assert(SOS_BUTTON_PIN < 0 || (SOS_HOLD_MS >= 500 && SOS_HOLD_MS < SOS_STUCK_MS),
              "SOS_HOLD_MS: at least 0.5 s (bumps) and shorter than SOS_STUCK_MS");

// ---- Gas / PM duty-cycle checks ------------------------------------------
// A GPIO already used by an enabled part (the duty-cycle pins must be new).
constexpr bool sjPinUsed(int p) {
  return p >= 0 &&
         ((TRANSPORT == TRANSPORT_LORA && (p == LORA_SCK || p == LORA_MISO || p == LORA_MOSI || p == LORA_NSS ||
                                           p == LORA_RST || p == LORA_DIO0)) ||
          (ENABLE_DHT && p == DHT_PIN) || (ENABLE_WATER_LEVEL && (p == ULTRASONIC_TRIG || p == ULTRASONIC_ECHO)) ||
          (ENABLE_FLAME && p == FLAME_PIN) || (ENABLE_GAS && p == MQ135_PIN) ||
          (ENABLE_RAIN_GAUGE && p == RAIN_GAUGE_PIN) || (ENABLE_SOIL && p == SOIL_PIN) ||
          (ENABLE_MPU6050 && (p == I2C_SDA || p == I2C_SCL)) ||
          (ENABLE_PMS5003 && (p == PMS_RX_PIN || p == PMS_TX_PIN)) || (ENABLE_PH && p == PH_PIN) ||
          (ENABLE_TURBIDITY && p == TURBIDITY_PIN) || (ENABLE_BATTERY && p == BATTERY_PIN) || p == LED_PIN ||
          p == SOS_BUTTON_PIN || p == SIREN_PIN || p == SENSOR_POWER_PIN);
}
constexpr bool sjOutputPin(int p) { return p >= 0 && p != 1 && p != 3 && p < 34 && !(p >= 6 && p <= 11); }
// whole report intervals per wake (at least 1)
#define SJ_DUTY_EVERY_N(periodS) \
  ((periodS) * 1000UL / NORMAL_REPORT_INTERVAL_MS < 1 ? 1UL : (periodS) * 1000UL / NORMAL_REPORT_INTERVAL_MS)
static_assert(!PMS5003_DUTY_CYCLE || ENABLE_PMS5003, "PMS5003_DUTY_CYCLE needs ENABLE_PMS5003 1");
static_assert(!MQ135_DUTY_CYCLE || ENABLE_GAS, "MQ135_DUTY_CYCLE needs ENABLE_GAS 1");
static_assert(!MQ135_DUTY_CYCLE || SIREN_PIN < 0,
              "MQ135_DUTY_CYCLE needs SIREN_PIN -1: gas is an offline-siren trigger - with the heater off between "
              "wakes a leak would go unseen for up to MQ135_DUTY_PERIOD_S (a siren node is mains-powered anyway)");
static_assert(!MQ135_DUTY_CYCLE || MQ135_HEATER_PIN >= 0,
              "MQ135_DUTY_CYCLE needs MQ135_HEATER_PIN: a MOSFET that switches the heater (config.h)");
static_assert(MQ135_HEATER_PIN < 0 || (sjOutputPin(MQ135_HEATER_PIN) && MQ135_HEATER_PIN != 0),
              "MQ135_HEATER_PIN: an output-capable GPIO; not 0 (the gate pull-down = download mode), 1/3, 6-11, "
              "34-39");
static_assert(MQ135_HEATER_PIN < 0 || MQ135_DUTY_CYCLE,
              "MQ135_HEATER_PIN without MQ135_DUTY_CYCLE: the gate pull-down would keep the heater OFF while the "
              "values count as warm - set MQ135_DUTY_CYCLE 1 or MQ135_HEATER_PIN -1");
static_assert(!sjPinUsed(MQ135_HEATER_PIN),"MQ135_HEATER_PIN: that GPIO is already used - free one first (config.h)");
static_assert(PMS5003_SET_PIN < 0 || (sjOutputPin(PMS5003_SET_PIN) && PMS5003_SET_PIN != 0 && PMS5003_SET_PIN != 2 &&
                                      PMS5003_SET_PIN != 12),
              "PMS5003_SET_PIN: an output-capable GPIO; not 0, 2 or 12 (the module's pull-up on SET would hold "
              "the strapping pin HIGH at reset), 1/3, 6-11, 34-39");
static_assert(!sjPinUsed(PMS5003_SET_PIN) && (PMS5003_SET_PIN < 0 || PMS5003_SET_PIN != MQ135_HEATER_PIN),
              "PMS5003_SET_PIN: that GPIO is already used - free one first (config.h)");
static_assert(!PMS5003_DUTY_CYCLE || PMS5003_DUTY_PERIOD_S * 1000ULL > (PMS5003_WARMUP_S + DUTY_MARGIN_S) * 1000ULL,
              "PMS5003_DUTY_PERIOD_S: longer than PMS5003_WARMUP_S + DUTY_MARGIN_S, or nothing is saved");
static_assert(!MQ135_DUTY_CYCLE || MQ135_DUTY_PERIOD_S * 1000ULL > (MQ135_WARMUP_S + DUTY_MARGIN_S) * 1000ULL,
              "MQ135_DUTY_PERIOD_S: longer than MQ135_WARMUP_S + DUTY_MARGIN_S, or nothing is saved");
static_assert(SJ_DUTY_EVERY_N(PMS5003_DUTY_PERIOD_S) <= 255 && SJ_DUTY_EVERY_N(MQ135_DUTY_PERIOD_S) <= 255,
              "*_DUTY_PERIOD_S: at most 255 report intervals");
static_assert(DUTY_MARGIN_S * 1000UL >= 2 * SAMPLE_INTERVAL_MS && DUTY_MARGIN_S <= 120,
              "DUTY_MARGIN_S: at least 2 samples (so the report finds a warm value), at most 120 s");
#if DEEP_SLEEP_ENABLED
static_assert(!ENABLE_GAS, "DEEP_SLEEP_ENABLED needs ENABLE_GAS 0: the MQ135 heater must run continuously");
static_assert(!ENABLE_PMS5003, "DEEP_SLEEP_ENABLED needs ENABLE_PMS5003 0: its fan needs ~30 s per reading");
static_assert(!ENABLE_RAIN_GAUGE || sjIsRtcGpio(RAIN_GAUGE_PIN),
              "RAIN_GAUGE_PIN must be an RTC GPIO so a bucket tip can wake the node");
static_assert(SOS_BUTTON_PIN < 0 || sjIsRtcGpio(SOS_BUTTON_PIN),
              "SOS_BUTTON_PIN must be an RTC GPIO so the button can wake the node");
static_assert(DEEP_SLEEP_ELEVATED_INTERVAL_S >= 10 && DEEP_SLEEP_ELEVATED_INTERVAL_S <= DEEP_SLEEP_INTERVAL_S,
              "DEEP_SLEEP_ELEVATED_INTERVAL_S must be 10 s .. DEEP_SLEEP_INTERVAL_S");
#endif

// ---- Local alert thresholds (LED + "send now") ----------------------
// Temperature: IMD heat wave on the PLAINS = actual maximum >= 45 C (severe
// heat wave >= 47 C - the edge models' URGENT); a heat wave is considered
// only from 40 C (backend MEDIUM, not "send now" here: an ordinary summer
// afternoon, carried by the 5-min summary's max). Sources: IMD heat-wave
// definition / heat bulletin legend, cited and graded in
// backend/hazard_classification.py (IMD_HEAT_WAVE_ACTUAL_C). One node is
// one instantaneous reading, not IMD's daily maximum - never "IMD declared".
// Before 2026-10-09 this line called 45 C the SEVERE heat wave - wrong.
#define LOCAL_TEMP_LIMIT_C 45.0f        // IMD heat wave (plains) = backend HIGH
#define LOCAL_GAS_LIMIT_PPM 800.0f      // = backend GAS_LEAK_THRESHOLD_PPM
#define LOCAL_WATER_FRACTION_LIMIT 0.4f  // of mount height = backend bench MEDIUM threshold
#define LOCAL_TILT_LIMIT_DEG 5.0f
// PM: "send now" from the backend's HIGH band, as for heat (the edge
// models' WATCH = backend HIGH): above the top of CPCB NAQI "Poor" (PM2.5
// 91-120, PM10 251-350 ug/m3, 24-h), i.e. from "Very Poor" (PM2.5 121-250,
// PM10 351-430) - backend PM25_BAND_TOPS / PM10_BAND_TOPS (60, 120, 250) /
// (100, 350, 430), CPCB table cited in backend/hazard_classification.py.
// "Moderately polluted" / "Poor" (backend MEDIUM) is NOT sent at once: it
// is an ordinary day in many Indian cities for weeks, and every 5-s sample
// sent at once would cancel the 5-min summary (decision 2026-10-09: only
// WATCH/URGENT, a fast rise, a new anomaly and SOS go at once) and keep
// the duty-cycled PMS5003 / MQ135 on all day (elevated = the duty hold).
// It still reaches the backend: the report's latest values, and the
// summary's PM2.5 min / mean / max (the smoke trend). Until 2026-10-09 the
// limits were 60 / 100 (top of "Satisfactory") - see duty_tests.h for the
// polluted-day airtime and on-time before / after.
#define LOCAL_PM25_LIMIT 120.0f         // CPCB "Poor" upper bound (above = Very Poor = backend HIGH)
#define LOCAL_PM10_LIMIT 350.0f         // CPCB "Poor" upper bound (above = Very Poor = backend HIGH)

// ---- Edge AI (edge_ai.h, sj_edge_input.h) -------------------------------
// Two int8 TFLite Micro models, both NORMAL / WATCH / URGENT, both trained
// on SYNTHETIC readings labelled by fixed rules on the backend's own
// thresholds (ml/make_edge_dataset.py - its table maps every rule to the
// backend's severity). The node runs one, picked at compile time:
//  - MAIN (edge_model_data.h, 5 inputs): water level, temperature,
//    humidity, gas, flame. Needs all of ENABLE_WATER_LEVEL, ENABLE_DHT,
//    ENABLE_GAS and ENABLE_FLAME, and a continuously heated MQ135.
//  - LITE (edge_lite_model_data.h, 7 inputs): water level, rise rate,
//    temperature, gas, flame, tilt, vibration - each sensor group may be
//    missing (a calm stand-in value, as in training). For every node the
//    main model cannot serve: deep-sleep battery nodes (no MQ135), gas-free
//    or tilt-only kits, an MQ135 on the duty cycle (between its wakes the
//    lite model still judges the other sensors). Runs on every deep-sleep
//    wake too.
//  - NONE: no model (e.g. a soil / pH / turbidity-only node) - the TFLite
//    library is not linked at all.
// EDGE_MODEL_AUTO picks MAIN when its four sensors are fitted, else LITE
// when any of water / DHT / gas / flame / tilt is, else NONE.
// The verdict (edge_risk_level) makes a reading "send now" from WATCH up;
// it is NOT a siren trigger - the offline siren decides from the water
// level and gas alone (sj_siren.h, decision 2026-10-09). Heat: WATCH from
// 45 C (IMD heat wave, plains), URGENT from 47 C (IMD severe heat wave).
#define EDGE_MODEL_NONE 0
#define EDGE_MODEL_MAIN 1
#define EDGE_MODEL_LITE 2
#define EDGE_MODEL_AUTO 3
#define EDGE_MODEL EDGE_MODEL_AUTO
#define SJ_EDGE_MAIN_FITS (ENABLE_WATER_LEVEL && ENABLE_DHT && ENABLE_GAS && ENABLE_FLAME && !MQ135_DUTY_CYCLE)
#define SJ_EDGE_LITE_FITS (ENABLE_WATER_LEVEL || ENABLE_DHT || ENABLE_GAS || ENABLE_FLAME || ENABLE_MPU6050)
#define EDGE_MODEL_IN_USE                                                                         \
  (EDGE_MODEL == EDGE_MODEL_AUTO                                                                  \
       ? (SJ_EDGE_MAIN_FITS ? EDGE_MODEL_MAIN : (SJ_EDGE_LITE_FITS ? EDGE_MODEL_LITE : EDGE_MODEL_NONE)) \
       : EDGE_MODEL)
static_assert(EDGE_MODEL >= EDGE_MODEL_NONE && EDGE_MODEL <= EDGE_MODEL_AUTO,
              "EDGE_MODEL: EDGE_MODEL_AUTO, EDGE_MODEL_MAIN, EDGE_MODEL_LITE or EDGE_MODEL_NONE");
static_assert(EDGE_MODEL != EDGE_MODEL_MAIN || SJ_EDGE_MAIN_FITS,
              "EDGE_MODEL_MAIN needs water level, DHT, gas and flame, and no MQ135_DUTY_CYCLE - use "
              "EDGE_MODEL_LITE (or EDGE_MODEL_AUTO)");
static_assert(EDGE_MODEL != EDGE_MODEL_LITE || SJ_EDGE_LITE_FITS,
              "EDGE_MODEL_LITE needs at least one of water level, DHT, gas, flame or MPU6050");
// Bench tank vs river scale - see sjEdgeModelLevelM() in sj_edge_input.h.
#define EDGE_BENCH_SCALE_MODEL true
#define EDGE_RIVER_EMPTY_M 1.5f
#define EDGE_RIVER_FULL_M 4.0f

// ---- Flash flood: the river's rate of rise (sj_anomaly.h) ---------------
// From every regular sample the node works out how fast the river is
// rising (cm per minute over the last RISE_WINDOW_S, from the medians of
// the older and the newer half - one misread sample can't fake it). At or
// above the fast-rise limit the reading is flagged fast_rise and sent at
// once (it counts as elevated: every sample goes while it lasts), and the
// rate goes into every reading that has a water level.
//  - River scale: FAST_RISE_CM_PER_MIN = the backend's flash-flood MEDIUM
//    rate (hazard_classification.py FLASH_FLOOD_MEDIUM_RATE_M_PER_HR,
//    0.6 m/h = 1 cm/min).
//  - Bench rig (RISE_BENCH_SCALE, follows EDGE_BENCH_SCALE_MODEL): a
//    tabletop tank never rises at river speed in cm, so the limit is
//    FAST_RISE_BENCH_FRACTION_PER_MIN of ULTRASONIC_MOUNT_HEIGHT_CM per
//    minute = the backend's bench MEDIUM (FLASH_FLOOD_BENCH_FRACTIONS_PER_MIN).
// Configurable demo defaults, not a published standard: calibrate them per
// river from the node's own history before field use.
#define RISE_BENCH_SCALE EDGE_BENCH_SCALE_MODEL
#define FAST_RISE_CM_PER_MIN 1.0f
#define FAST_RISE_BENCH_FRACTION_PER_MIN 0.10f
// 3 min on an always-on node (36 samples): long enough that a few mm of
// gauge noise is far below the limit (anomaly_tests.h), short enough to
// flag a rise within about a minute or two. A gauge noisier than ~1 cm
// (waves, no stilling well) needs a longer window or a higher limit. A
// deep-sleep node needs several wakes in the window: 4 sleep intervals.
#define RISE_WINDOW_S (DEEP_SLEEP_ENABLED ? 4 * DEEP_SLEEP_INTERVAL_S : 180)
#define RISE_MIN_SAMPLES 4  // levels needed in the window (two per half, at least)
// Not on the limit alone (review: ~2 cm of gauge noise crossed 1 cm/min
// often, and the backend raises a flash-flood alert on the node's flag):
// the rise must hold on FAST_RISE_SAMPLES consecutive regular samples and
// be at least RISE_NOISE_K standard errors above the gauge's own noise in
// the window (sj_anomaly.h). A noisy gauge then needs a clearer rise
// (about 1.3 cm/min at 1 cm of noise, 2.6 cm/min at 2 cm); anomaly_tests.h
// checks days of 1 - 2 cm noise for no false flag. Configurable demo
// defaults, chosen on simulated Gaussian noise - check them against the
// site's own gauge record.
// A deep-sleep node samples rarely: 2 wakes instead of 3 samples.
#define FAST_RISE_SAMPLES (DEEP_SLEEP_ENABLED ? 2 : 3)
#define RISE_NOISE_K 5.0f

static_assert(RISE_WINDOW_S >= 60, "RISE_WINDOW_S: at least a minute - shorter is mostly sensor noise");
static_assert(FAST_RISE_SAMPLES >= 1 && FAST_RISE_SAMPLES <= 12, "FAST_RISE_SAMPLES: 1..12 consecutive samples");
static_assert(DEEP_SLEEP_ENABLED || RISE_WINDOW_S * 1000UL / SAMPLE_INTERVAL_MS < 40,
              "RISE_WINDOW_S: at most 39 samples fit in the rise history (sj_anomaly.h SJ_RISE_SLOTS)");
static_assert(!DEEP_SLEEP_ENABLED || RISE_WINDOW_S >= 3 * DEEP_SLEEP_INTERVAL_S,
              "RISE_WINDOW_S: a deep-sleep node needs at least 3 wakes in the window");

// ---- On-device anomaly checks (sj_anomaly.h) -----------------------------
// Per sensor (water, temperature, humidity, gas, PM2.5, tilt): stuck value,
// spike, physically impossible rate, dropouts. Sent as edge_anomaly
// ("spike:river_level_m" ...) in every reading; the backend treats them as
// a fault signal, and a doubtful value never sounds the offline siren on
// its own. The limits are configurable demo defaults in
// sjEdgeDefaultLimits() (sj_anomaly.h). 0 = nothing reported.
#define EDGE_ANOMALY_ENABLE 1
// A sensor silent this long (or a node asleep this long) starts its
// statistics over: older values are no baseline for the next one.
#define EDGE_STALE_S (DEEP_SLEEP_ENABLED ? 3 * DEEP_SLEEP_INTERVAL_S : 60)
