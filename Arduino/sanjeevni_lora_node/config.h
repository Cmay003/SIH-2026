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
//  - normal readings: one every NORMAL_REPORT_INTERVAL_MS (heartbeat, so
//    the backend's missing-node check works - set the node's
//    report_interval_seconds to 60 via the admin API to match)
//  - elevated readings (edge AI WATCH/URGENT or a local threshold): every
//    sample, immediately
#define SAMPLE_INTERVAL_MS 5000UL
#define NORMAL_REPORT_INTERVAL_MS 60000UL
#define FLUSH_RETRY_INTERVAL_MS 10000UL  // after a failed send, wait before retrying
#define MAX_SENDS_PER_FLUSH 10           // bound time spent flushing a backlog per loop

// ---- Queue (LittleFS) -----------------------------------------------
// 2000 x ~58 B = ~116 KB. At one report a minute that is ~33 hours of
// outage before the oldest readings start being overwritten.
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
// The backend currently REQUIRES water level, temperature/humidity, gas
// and flame on every reading, so those four stay enabled on every node
// for now (see static_assert below). The rest are optional per node.
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

static_assert(ENABLE_WATER_LEVEL && ENABLE_DHT && ENABLE_GAS && ENABLE_FLAME,
              "backend_server.py RawReading requires water level, DHT, gas and flame on every reading");

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
#define MQ135_ADC_DIVIDER_RATIO 1.0f  // (R1+R2)/R2 if AO goes through a divider (5 V module!)

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

// ---- Local alert thresholds (LED + "send now") ----------------------
#define LOCAL_TEMP_LIMIT_C 45.0f        // IMD severe heat wave
#define LOCAL_GAS_LIMIT_PPM 800.0f      // = backend GAS_LEAK_THRESHOLD_PPM
#define LOCAL_WATER_FRACTION_LIMIT 0.4f  // of mount height = backend bench MEDIUM threshold
#define LOCAL_TILT_LIMIT_DEG 5.0f
#define LOCAL_PM25_LIMIT 60.0f          // CPCB "moderate" upper bound

// ---- Edge AI --------------------------------------------------------
// Bench tank vs river scale - see edgeModelRiverLevelM() in edge_ai.h.
#define EDGE_BENCH_SCALE_MODEL true
#define EDGE_RIVER_EMPTY_M 1.5f
#define EDGE_RIVER_FULL_M 4.0f
