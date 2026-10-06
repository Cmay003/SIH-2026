#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>

// =====================================================
// *** NEW *** ON-DEVICE EDGE AI (TensorFlow Lite Micro)
// =====================================================
// Requires the "Arduino_TensorFlowLite" or "Chirale_TensorFlowLite"
// library (either works - both wrap Google's tflite-micro for Arduino).
// Install via Library Manager before compiling this file.
//
// WHY THIS EXISTS: closes the problem statement's core requirement -
// "local (on device) AI inference" - so this node keeps classifying
// hazards INSTANTLY, with ZERO network round-trip, even during a total
// outage. The cloud backend (backend_server.py) still runs the full,
// more sophisticated multi-hazard/SHAP/calibrated pipeline when
// reachable - this edge model is a fast, tiny, ALWAYS-AVAILABLE local
// pre-screen: NORMAL / WATCH / URGENT, trained and verified (98%
// accuracy, zero dangerous URGENT-as-NORMAL misses after int8
// quantization - see this repo's edge_ai/ training scripts) on the
// same domain thresholds the cloud backend uses.
#include <TensorFlowLite.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/micro/micro_log.h>
#include <tensorflow/lite/schema/schema_generated.h>
#include "edge_model_data.h"

// Declared here, before any function, because sendData() takes it as a
// parameter and the Arduino IDE auto-generates function prototypes above
// the first function - declaring it further down failed to compile.
enum EdgeRiskLevel { EDGE_NORMAL = 0, EDGE_WATCH = 1, EDGE_URGENT = 2 };

// =====================================================
// WIFI
// =====================================================

const char* WIFI_SSID = "IQOO Z10X";
const char* WIFI_PASSWORD = "123456789";

// =====================================================
// BACKEND
// =====================================================

const char* BACKEND_URL =
  "https://crusader-equate-spoon.ngrok-free.dev/api/ingest";

const char* DEVICE_ID = "NODE-04";

// =====================================================
// PIN DEFINITIONS
// =====================================================

#define DHT_PIN 4
#define DHT_TYPE DHT22

#define ULTRASONIC_TRIG 5
#define ULTRASONIC_ECHO 18

#define IR_PIN 19

#define MQ135_PIN 34

#define LED_PIN 2

// =====================================================
// *** NEW *** NODE HEALTH TELEMETRY
// =====================================================
// Signal strength (WiFi.RSSI()) works immediately, no extra hardware -
// real dBm value from the WiFi radio already on this board.
//
// Battery percentage REQUIRES a voltage divider circuit (two resistors)
// wired from your battery's positive terminal into an ADC-capable pin,
// stepping the voltage down into the ESP32's 0-3.3V ADC range - this is
// NOT optional software, it's a real physical circuit I cannot verify
// without your actual hardware. GPIO35 is used here since it's a free
// ADC1 pin (ADC1 pins work correctly alongside WiFi; ADC2 pins like
// GPIO2's neighbors can conflict with WiFi and are best avoided for
// this). Calibrate BATTERY_ADC_MIN/MAX below to YOUR actual divider
// ratio - the defaults assume a common 2:1 divider (two equal
// resistors) for a single-cell Li-ion (3.0V empty - 4.2V full).
#define BATTERY_PIN 35
const float BATTERY_ADC_MIN = 1.5;  // ADC voltage at your divider when battery is at 3.0V (empty)
const float BATTERY_ADC_MAX = 2.1;  // ADC voltage at your divider when battery is at 4.2V (full)

// =====================================================
// DHT
// =====================================================

DHT dht(DHT_PIN, DHT_TYPE);

// =====================================================
// ALERT THRESHOLDS
// =====================================================

float TEMPERATURE_LIMIT = 50.0;
float HUMIDITY_LIMIT = 85.0;
float GAS_PPM_LIMIT = 800.0; // ppm - matches backend GAS_LEAK_THRESHOLD_PPM (was 1300 raw ADC counts)
float DISTANCE_LIMIT = 40.0;

// =====================================================
// *** NEW *** ULTRASONIC MOUNTING CALIBRATION
// =====================================================
// CHANGED: this is the one new constant added by this fix.
//
// The HC-SR04 measures distance FROM the sensor TO whatever surface is
// below it - as water rises TOWARD the sensor, that distance SHRINKS.
// Previously this raw, uninverted distance was sent directly as
// "river_level_m", which is backwards: an EMPTY container (large
// distance) was sent as a LARGE "water level", and a FULL container
// (small distance) was sent as a SMALL "water level".
//
// ULTRASONIC_MOUNT_HEIGHT_CM is the distance from the sensor to the
// EMPTY container's floor - i.e. what getDistance() reads when there is
// no water at all. Defaulted to the same 40.0 already used for
// DISTANCE_LIMIT below, since that's the number this firmware already
// treats as "the alert-worthy close distance". MEASURE YOUR OWN RIG:
// point the sensor at the empty container and read the Serial Monitor's
// "Ultrasonic: ... cm" line - use that value here instead if different.
float ULTRASONIC_MOUNT_HEIGHT_CM = 2.34; // measured on the bench rig (was 40.0 default); the ONLY mount-height setting - backend no longer re-inverts

// =====================================================
// MQ135 -> GAS PPM (CO2-equivalent)
// =====================================================
// The backend, its anomaly model and the edge model all expect gas in
// ppm (clean air ~400). analogRead() gives raw 0-4095 ADC counts, which
// were being sent as "gas_ppm" - wrong units everywhere downstream.
//
// Conversion: sensor resistance Rs from the load-resistor divider, then
// the standard MQ135 CO2 curve ppm = PARA * (Rs/R0)^-PARB (datasheet fit,
// as used by the common GeorgK MQ135 library). This is a CO2-equivalent
// estimate, NOT a calibrated reading of LPG/NH3/smoke specifically.
//
// CALIBRATE BEFORE TRUSTING THE NUMBERS:
// 1. Burn the sensor in (24h+ powered), then leave it ~10 min in clean
//    outdoor air.
// 2. Read the "MQ-135 R0" value printed on the Serial Monitor and put it
//    in MQ135_R0_KOHM below.
// 3. Check MQ135_RL_KOHM against your module's load resistor (marked
//    "102" = 1k, "103" = 10k on most breakout boards).
// 4. MQ135 modules run at 5V, so AO can exceed the ESP32's 3.3V ADC limit.
//    Use a divider (e.g. 10k/20k) and set MQ135_ADC_DIVIDER_RATIO to
//    (R1+R2)/R2 - 1.5 for 10k/20k. 1.0 means AO is wired directly.
const float MQ135_VCC = 5.0;
const float MQ135_RL_KOHM = 1.0;
const float MQ135_R0_KOHM = 76.63;          // library default - replace with your measured R0
const float MQ135_ADC_DIVIDER_RATIO = 1.0;
const float MQ135_PARA = 116.6020682;
const float MQ135_PARB = 2.769034857;
const float MQ135_ATMOSPHERIC_CO2_PPM = 420.0; // for R0 calibration in clean air

float readMq135ResistanceKohm()
{
  // analogReadMilliVolts() applies the ESP32's factory ADC calibration;
  // raw analogRead() counts are noticeably non-linear on ESP32.
  float vOut = analogReadMilliVolts(MQ135_PIN) / 1000.0 * MQ135_ADC_DIVIDER_RATIO;
  if (vOut < 0.01) return -1; // no signal - sensor unpowered/disconnected
  return MQ135_RL_KOHM * (MQ135_VCC - vOut) / vOut;
}

float readMq135Ppm()
{
  float rs = readMq135ResistanceKohm();
  if (rs <= 0) return 0;
  return MQ135_PARA * pow(rs / MQ135_R0_KOHM, -MQ135_PARB);
}

// R0 this sensor would need for the current air to read as
// MQ135_ATMOSPHERIC_CO2_PPM - only meaningful in clean outdoor air.
float calibrateMq135R0Kohm()
{
  float rs = readMq135ResistanceKohm();
  if (rs <= 0) return -1;
  return rs * pow(MQ135_ATMOSPHERIC_CO2_PPM / MQ135_PARA, 1.0 / MQ135_PARB);
}

// =====================================================
// LED BLINK
// =====================================================

unsigned long previousLEDMillis = 0;
const unsigned long LED_BLINK_TIME = 300;

bool ledState = false;

// =====================================================
// DATA SEND TIMER
// =====================================================

unsigned long previousSendMillis = 0;
const unsigned long SEND_INTERVAL = 5000;

// =====================================================
// ULTRASONIC FUNCTION
// =====================================================
// UNCHANGED - still returns the raw distance in cm. Kept as-is
// deliberately: the local alert logic below (ultrasonicAlert) and the
// Serial Monitor debug print both correctly use raw distance already
// ("close = alert"), so this function itself doesn't need to change -
// only what gets SENT to the backend does (see sendData() below).

float getDistance()
{
  // Make sure TRIG starts LOW
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(5);

  // Send 10 microsecond trigger pulse
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // Wait for ECHO
  unsigned long duration =
    pulseIn(ULTRASONIC_ECHO, HIGH, 50000);

  // No echo received
  if (duration == 0)
  {
    Serial.println("Ultrasonic: NO ECHO");
    return -1;
  }

  // Calculate distance in cm
  float distance = duration * 0.0343 / 2.0;

  return distance;
}

// =====================================================
// *** NEW *** CONVERT RAW DISTANCE -> ACTUAL WATER LEVEL
// =====================================================
// CHANGED: this function is new. Inverts + clamps raw distance into an
// actual water-level reading: 0 = empty, ULTRASONIC_MOUNT_HEIGHT_CM/100
// (in meters) = full (water touching the sensor). Returns -1 unchanged
// if there was no echo at all, so the backend's existing "-1 = no valid
// reading" handling keeps working exactly as before.

float distanceToWaterLevelMeters(float distanceCm)
{
  if (distanceCm < 0)
  {
    return -1.0; // no echo - pass the sentinel through unchanged
  }

  float waterLevelCm = ULTRASONIC_MOUNT_HEIGHT_CM - distanceCm;

  if (waterLevelCm < 0) waterLevelCm = 0;
  if (waterLevelCm > ULTRASONIC_MOUNT_HEIGHT_CM) waterLevelCm = ULTRASONIC_MOUNT_HEIGHT_CM;

  return waterLevelCm / 100.0; // cm -> meters
}

// =====================================================
// *** NEW *** BATTERY PERCENTAGE (requires voltage divider - see
// BATTERY_PIN comment above for the physical circuit requirement)
// =====================================================
float readBatteryPercent()
{
  int rawAdc = analogRead(BATTERY_PIN);
  float adcVoltage = (rawAdc / 4095.0) * 3.3; // ESP32 ADC: 12-bit, 0-3.3V reference

  float percent = (adcVoltage - BATTERY_ADC_MIN) / (BATTERY_ADC_MAX - BATTERY_ADC_MIN) * 100.0;

  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;

  return percent;
}

// =====================================================
// SEND DATA TO BACKEND
// =====================================================

void sendData(
  float temperature,
  float humidity,
  float gasPpm,
  float distance,
  bool irDetected,
  EdgeRiskLevel edgeRisk
)
{
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("WiFi not connected.");
    return;
  }

  // HTTPS client
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  if (!http.begin(client, BACKEND_URL))
  {
    Serial.println("HTTP connection failed!");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  // REQUIRED for ngrok's free tier: without this header, ngrok shows an
  // interstitial "browser warning" page to non-browser clients too (like
  // this ESP32's HTTPClient) - your POST gets intercepted by ngrok itself
  // and never reaches server.js at all. This is very likely why no
  // "POST /api/ingest" ever showed up in the ngrok request log.
  http.addHeader("ngrok-skip-browser-warning", "true");

  // ===================================================
  // BUILD JSON
  // ===================================================

  String json = "{";

  json += "\"node_id\":\"";
  json += DEVICE_ID;
  json += "\",";

  json += "\"temp_c\":";
  json += String(temperature, 2);
  json += ",";

  json += "\"humidity_pct\":";
  json += String(humidity, 2);
  json += ",";

  json += "\"gas_ppm\":";
  json += String(gasPpm, 1);
  json += ",";

  // CHANGED: previously sent raw (uninverted) distance/100.0 here.
  // Now sends the actual, correctly-inverted water level instead, so
  // "more water = bigger number" everywhere downstream, with no backend
  // correction needed.
  json += "\"river_level_m\":";

  float waterLevel = distanceToWaterLevelMeters(distance);

  if (waterLevel >= 0)
  {
    json += String(waterLevel, 3);
  }
  else
  {
    json += "-1";
  }

  json += ",";

  json += "\"flame_reading\":";
  json += irDetected ? "1.0" : "0.0";
  json += ",";

  // Currently no rain sensor
  json += "\"rainfall_mm_since_last\":0.0,";

  // *** NEW *** Node health telemetry
  json += "\"signal_strength_dbm\":";
  json += String(WiFi.RSSI());
  json += ",";

  json += "\"battery_pct\":";
  json += String(readBatteryPercent(), 1);
  json += ",";

  // *** NEW *** Edge AI's own local classification, sent alongside the
  // raw readings so the cloud can log/compare what the edge model
  // concluded vs. its own more sophisticated pipeline - useful for
  // validating the edge model's real-world accuracy over time.
  json += "\"edge_risk_level\":\"";
  if (edgeRisk == EDGE_URGENT) json += "URGENT";
  else if (edgeRisk == EDGE_WATCH) json += "WATCH";
  else json += "NORMAL";
  json += "\"";

  json += "}";

  // ===================================================
  // PRINT DATA
  // ===================================================

  Serial.println();
  Serial.println("Sending to backend:");
  Serial.println(json);

  // ===================================================
  // POST
  // ===================================================

  int responseCode = http.POST(json);

  Serial.print("HTTP Response: ");
  Serial.println(responseCode);

  if (responseCode > 0)
  {
    String response = http.getString();

    Serial.println("Backend response:");
    Serial.println(response);
  }
  else
  {
    Serial.print("Error sending POST: ");
    Serial.println(http.errorToString(responseCode));
  }

  http.end();
}

// =====================================================
// SETUP
// =====================================================


// =====================================================
// EDGE AI - model setup
// =====================================================
// These 5 pairs come DIRECTLY from scaler_params.json, generated when
// the model was trained (edge_ai/train_edge_model.py). If you retrain
// the model, regenerate these too - they must match exactly, since the
// model was trained on data normalized with these exact values.
const float EDGE_FEATURE_MEAN[5] = {1.9372822f, 30.2528999f, 60.0702352f, 527.8328722f, 0.0594403f};
const float EDGE_FEATURE_SCALE[5] = {0.9618157f, 7.8129314f, 23.1442541f, 215.4961791f, 0.1034814f};

// The edge model was trained on RIVER-scale levels (mean ~1.9 m, see
// EDGE_FEATURE_MEAN[0]), but the bench rig's tank only spans
// 0..ULTRASONIC_MOUNT_HEIGHT_CM (2.34 cm). Feeding the raw bench value made
// every reading look like a nearly-dry river, so the model could never
// flag a flood. In scale-model mode, the tank's fill fraction is mapped
// linearly onto a river range instead: empty tank = EDGE_RIVER_EMPTY_M,
// full tank = EDGE_RIVER_FULL_M. The upper end sits above the backend's
// FLOOD_CRITICAL_LEVEL_M (3.5 m) so a full tank represents a critical flood.
//
// Set EDGE_BENCH_SCALE_MODEL = false when the node reads a real river
// gauge in metres - the level is then passed to the model unchanged.
// NOTE: only the edge model's input is mapped. The backend still receives
// the real tank level and uses its own HARDWARE_TEST thresholds for it.
const bool EDGE_BENCH_SCALE_MODEL = true;
const float EDGE_RIVER_EMPTY_M = 1.5;
const float EDGE_RIVER_FULL_M = 4.0;

float edgeModelRiverLevelM(float waterLevelM)
{
  if (waterLevelM < 0) waterLevelM = 0; // no echo - treat as "no water detected"
  if (!EDGE_BENCH_SCALE_MODEL) return waterLevelM;
  float fraction = waterLevelM / (ULTRASONIC_MOUNT_HEIGHT_CM / 100.0);
  if (fraction > 1) fraction = 1;
  return EDGE_RIVER_EMPTY_M + fraction * (EDGE_RIVER_FULL_M - EDGE_RIVER_EMPTY_M);
}

namespace {
  const tflite::Model* edgeModel = nullptr;
  tflite::MicroInterpreter* edgeInterpreter = nullptr;
  TfLiteTensor* edgeInput = nullptr;
  TfLiteTensor* edgeOutput = nullptr;

  // Tensor arena - scratch RAM for the interpreter. 8KB is generous
  // headroom for this ~3.5KB model; reduce if your board is RAM-tight,
  // but verify inference still succeeds (interpreter->AllocateTensors()
  // returns non-OK if the arena is too small).
  constexpr int kTensorArenaSize = 8 * 1024;
  alignas(16) uint8_t tensorArena[kTensorArenaSize];
}

bool setupEdgeAI() {
  edgeModel = tflite::GetModel(edge_model_data);
  if (edgeModel->version() != TFLITE_SCHEMA_VERSION) {
    Serial.println("EDGE AI: model schema version mismatch!");
    return false;
  }

  // Only the ops this specific model actually uses (FullyConnected +
  // Softmax, since it's a plain Dense/Dense/Dense-softmax network) -
  // keeps the resolver's memory footprint minimal versus registering
  // every possible op.
  static tflite::MicroMutableOpResolver<3> resolver;
  resolver.AddFullyConnected();
  resolver.AddRelu();
  resolver.AddSoftmax();

  static tflite::MicroInterpreter staticInterpreter(
    edgeModel, resolver, tensorArena, kTensorArenaSize
  );
  edgeInterpreter = &staticInterpreter;

  if (edgeInterpreter->AllocateTensors() != kTfLiteOk) {
    Serial.println("EDGE AI: AllocateTensors() failed - tensor arena too small?");
    return false;
  }

  edgeInput = edgeInterpreter->input(0);
  edgeOutput = edgeInterpreter->output(0);
  Serial.println("EDGE AI: model loaded and ready for local inference.");
  return true;
}

// Runs inference LOCALLY - no network involved. Returns EDGE_NORMAL,
// EDGE_WATCH, or EDGE_URGENT. Takes the same 5 raw sensor values this
// node already reads every loop - see loop() for how this plugs in.
EdgeRiskLevel runEdgeInference(float riverLevelM, float tempC, float humidityPct, float gasPpm, float flameReading) {
  float rawFeatures[5] = {riverLevelM, tempC, humidityPct, gasPpm, flameReading};

  float inputScale = edgeInput->params.scale;
  int inputZeroPoint = edgeInput->params.zero_point;

  for (int i = 0; i < 5; i++) {
    float normalized = (rawFeatures[i] - EDGE_FEATURE_MEAN[i]) / EDGE_FEATURE_SCALE[i];
    int32_t quantized = (int32_t)round(normalized / inputScale) + inputZeroPoint;
    // clamp to int8 range - explicit comparisons instead of max()/min(),
    // which fail to compile on ESP32 core 3.x where int32_t is long, not int
    if (quantized < -128) quantized = -128;
    if (quantized > 127) quantized = 127;
    edgeInput->data.int8[i] = (int8_t)quantized;
  }

  if (edgeInterpreter->Invoke() != kTfLiteOk) {
    Serial.println("EDGE AI: inference failed - defaulting to WATCH (fail-safe, not silently NORMAL)");
    return EDGE_WATCH;
  }

  float outputScale = edgeOutput->params.scale;
  int outputZeroPoint = edgeOutput->params.zero_point;

  float scores[3];
  int bestIdx = 0;
  for (int i = 0; i < 3; i++) {
    scores[i] = (edgeOutput->data.int8[i] - outputZeroPoint) * outputScale;
    if (scores[i] > scores[bestIdx]) bestIdx = i;
  }

  return (EdgeRiskLevel)bestIdx;
}

void setup()
{
  Serial.begin(115200);

  delay(1000);

  // ===================================================
  // SENSOR INITIALIZATION
  // ===================================================

  dht.begin();

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);

  pinMode(IR_PIN, INPUT);

  pinMode(MQ135_PIN, INPUT);

  // ===================================================
  // LED
  // ===================================================

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // ===================================================
  // WIFI
  // ===================================================

  Serial.println();
  Serial.println("================================");
  Serial.println("SANJEEVNI ESP32 NODE");
  Serial.println("================================");

  Serial.println();
  Serial.println("Connecting to WiFi...");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 40)
  {
    delay(500);
    Serial.print(".");

    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("WiFi Connected!");

    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  }
  else
  {
    Serial.println("WiFi connection FAILED!");
    Serial.println("Check WiFi name/password.");
    Serial.println("(Edge AI still works below - this node keeps");
    Serial.println(" classifying hazards locally even with no WiFi.)");
  }

  Serial.println();

  // Edge AI init happens regardless of WiFi status - it's meant to work
  // WITHOUT connectivity, so it must not depend on WiFi having succeeded.
  setupEdgeAI();

  Serial.println();
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop()
{
  // ===================================================
  // READ SENSORS
  // ===================================================

  float temperature = dht.readTemperature();

  float humidity = dht.readHumidity();

  float gasPpm = readMq135Ppm();

  float distance = getDistance();

  int irValue = digitalRead(IR_PIN);

  // Most IR modules output LOW when detecting
  bool irDetected = (irValue == LOW);

  // ===================================================
  // DHT ERROR CHECK
  // ===================================================

  if (isnan(temperature) || isnan(humidity))
  {
    Serial.println("DHT22 reading error!");

    delay(2000);

    return;
  }

  // ===================================================
  // *** NEW *** EDGE AI - LOCAL INFERENCE, ZERO NETWORK NEEDED
  // ===================================================
  // Runs BEFORE any network activity below, and its local action (the
  // immediate LED response for EDGE_URGENT) does NOT wait for or
  // depend on the backend send succeeding - this is what makes it a
  // real edge/offline capability, not just "also runs the same model
  // in two places". Inputs are in the units the model was trained on:
  // gas in ppm (readMq135Ppm) and water level mapped onto river scale
  // (edgeModelRiverLevelM - see EDGE_BENCH_SCALE_MODEL).
  float edgeWaterLevel = edgeModelRiverLevelM(distanceToWaterLevelMeters(distance));

  EdgeRiskLevel edgeRisk = runEdgeInference(edgeWaterLevel, temperature, humidity, gasPpm, irDetected ? 1.0f : 0.0f);

  Serial.print("EDGE AI risk level: ");
  if (edgeRisk == EDGE_URGENT) Serial.println("URGENT");
  else if (edgeRisk == EDGE_WATCH) Serial.println("WATCH");
  else Serial.println("NORMAL");

  if (edgeRisk == EDGE_URGENT)
  {
    // Immediate local response - fast, distinct blink pattern, fires
    // instantly regardless of whether WiFi/backend is reachable at all.
    for (int i = 0; i < 6; i++)
    {
      digitalWrite(LED_PIN, HIGH);
      delay(80);
      digitalWrite(LED_PIN, LOW);
      delay(80);
    }
  }

  // ===================================================
  // ALERT CONDITIONS
  // ===================================================

  bool temperatureAlert =
    temperature >= TEMPERATURE_LIMIT;

  bool humidityAlert =
    humidity >= HUMIDITY_LIMIT;

  bool gasAlert =
    gasPpm >= GAS_PPM_LIMIT;

  bool ultrasonicAlert =
    (distance > 0 && distance <= DISTANCE_LIMIT);

  bool irAlert =
    irDetected;

  bool anyAlert =
    temperatureAlert ||
    humidityAlert ||
    gasAlert ||
    ultrasonicAlert ||
    irAlert;

  // ===================================================
  // LED ALERT
  // ===================================================

  if (anyAlert)
  {
    unsigned long currentMillis = millis();

    if (currentMillis - previousLEDMillis >= LED_BLINK_TIME)
    {
      previousLEDMillis = currentMillis;

      ledState = !ledState;

      digitalWrite(LED_PIN, ledState);
    }
  }
  else
  {
    ledState = false;

    digitalWrite(LED_PIN, LOW);
  }

  // ===================================================
  // SERIAL MONITOR
  // ===================================================

  Serial.println();
  Serial.println("================================");

  Serial.print("Temperature : ");
  Serial.print(temperature);
  Serial.println(" °C");

  Serial.print("Humidity    : ");
  Serial.print(humidity);
  Serial.println(" %");

  Serial.print("MQ-135      : ");
  Serial.print(gasPpm, 0);
  Serial.print(" ppm CO2-eq  (R0 if clean air: ");
  Serial.print(calibrateMq135R0Kohm(), 2);
  Serial.println(" kOhm)");

  Serial.print("Ultrasonic  : ");

  if (distance < 0)
  {
    Serial.println("NO ECHO");
  }
  else
  {
    Serial.print(distance);
    Serial.print(" cm  (water level: ");
    Serial.print(distanceToWaterLevelMeters(distance), 3);
    Serial.println(" m)");
  }

  Serial.print("IR          : ");

  if (irDetected)
  {
    Serial.println("DETECTED");
  }
  else
  {
    Serial.println("CLEAR");
  }

  // ===================================================
  // ALERT STATUS
  // ===================================================

  if (anyAlert)
  {
    Serial.println("STATUS      : ⚠ ALERT");

    if (temperatureAlert)
      Serial.println("Alert: HIGH TEMPERATURE");

    if (humidityAlert)
      Serial.println("Alert: HIGH HUMIDITY");

    if (gasAlert)
      Serial.println("Alert: HIGH GAS READING");

    if (ultrasonicAlert)
      Serial.println("Alert: WATER LEVEL HIGH");

    if (irAlert)
      Serial.println("Alert: IR DETECTION");
  }
  else
  {
    Serial.println("STATUS      : NORMAL");
  }

  // ===================================================
  // SEND TO BACKEND EVERY 5 SECONDS
  // ===================================================

  if (millis() - previousSendMillis >= SEND_INTERVAL)
  {
    previousSendMillis = millis();

    sendData(
      temperature,
      humidity,
      gasPpm,
      distance,
      irDetected,
      edgeRisk
    );
  }

  // Small delay
  delay(100);
}
