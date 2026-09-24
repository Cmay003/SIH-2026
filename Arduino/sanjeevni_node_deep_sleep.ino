/*
 * SANJEEVNI - ESP32 DEEP-SLEEP FIRMWARE VARIANT
 * =====================================================
 * For solar/battery-powered nodes where power budget matters. This is a
 * SEPARATE file from sanjeevni_node.ino, not a drop-in replacement -
 * deep sleep fundamentally changes the control flow, so merging both
 * modes into one file would make either one harder to reason about.
 *
 * HOW THIS DIFFERS FROM THE MAIN FIRMWARE:
 * The main sanjeevni_node.ino runs loop() continuously - always awake,
 * always drawing power for WiFi + sensors. This variant instead: wakes
 * up, connects WiFi, takes ONE reading, sends it, then goes into deep
 * sleep for SLEEP_DURATION_SECONDS - during which the ESP32 draws only
 * ~10 microamps instead of ~150+ milliamps when the WiFi is idle-active.
 * This is genuinely the difference between a solar node lasting days vs
 * weeks, per the upgrade brief.
 *
 * WHAT DEEP SLEEP MEANS FOR YOUR CODE:
 * Deep sleep resets the ESP32 (RAM is cleared) - only RTC memory
 * survives. That means setup() runs from scratch on every single wake,
 * including reconnecting to WiFi every cycle (there's no way around
 * this in deep sleep - it's the tradeoff for the power savings). If you
 * need something to persist across sleep cycles (like a boot counter),
 * it must be declared RTC_DATA_ATTR, as shown below.
 *
 * IMPORTANT LIMITATION - honest about what I can't verify:
 * I cannot compile or flash this. Deep-sleep timing and wake behavior
 * are notoriously easy to get subtly wrong on real hardware (brownout
 * resets, WiFi reconnect timing, sensor warm-up time) - test this
 * thoroughly on your actual node before relying on it, ideally with a
 * USB power meter to confirm the actual sleep current draw.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>

const char* WIFI_SSID = "IQOO Z10X";
const char* WIFI_PASSWORD = "123456789";
const char* BACKEND_URL = "https://crusader-equate-spoon.ngrok-free.dev/api/ingest";
const char* DEVICE_ID = "NODE-04";

#define DHT_PIN 4
#define DHT_TYPE DHT22
#define ULTRASONIC_TRIG 5
#define ULTRASONIC_ECHO 18
#define IR_PIN 19
#define MQ135_PIN 34
#define BATTERY_PIN 35

const float BATTERY_ADC_MIN = 1.5;
const float BATTERY_ADC_MAX = 2.1;
float ULTRASONIC_MOUNT_HEIGHT_CM = 40.0; // measure and set for your actual rig

// How long to sleep between readings. Tune this against your actual
// power budget - shorter = more responsive but more power used;
// longer = better battery life but slower to detect a fast-rising flood.
// 5 minutes is a reasonable starting point for a non-time-critical node;
// consider a SHORTER interval during active monsoon season.
#define SLEEP_DURATION_SECONDS (5 * 60)

// Survives deep sleep (RTC memory) - RAM does not.
RTC_DATA_ATTR int bootCount = 0;

DHT dht(DHT_PIN, DHT_TYPE);

float getDistance() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(5);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 50000);
  if (duration == 0) return -1;
  return duration * 0.0343 / 2.0;
}

float distanceToWaterLevelMeters(float distanceCm) {
  if (distanceCm < 0) return -1.0;
  float waterLevelCm = ULTRASONIC_MOUNT_HEIGHT_CM - distanceCm;
  if (waterLevelCm < 0) waterLevelCm = 0;
  if (waterLevelCm > ULTRASONIC_MOUNT_HEIGHT_CM) waterLevelCm = ULTRASONIC_MOUNT_HEIGHT_CM;
  return waterLevelCm / 100.0;
}

float readBatteryPercent() {
  int rawAdc = analogRead(BATTERY_PIN);
  float adcVoltage = (rawAdc / 4095.0) * 3.3;
  float percent = (adcVoltage - BATTERY_ADC_MIN) / (BATTERY_ADC_MAX - BATTERY_ADC_MIN) * 100.0;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  return percent;
}

bool connectWiFi(unsigned long timeoutMs) {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(250);
  }
  return WiFi.status() == WL_CONNECTED;
}

void sendReadingAndSleep() {
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();
  int mq135 = analogRead(MQ135_PIN);
  float distance = getDistance();
  bool irDetected = (digitalRead(IR_PIN) == LOW);
  float waterLevel = distanceToWaterLevelMeters(distance);
  float batteryPct = readBatteryPercent();

  Serial.printf("Boot #%d - Temp:%.1f Hum:%.1f Gas:%d Water:%.3fm Battery:%.1f%%\n",
                bootCount, temperature, humidity, mq135, waterLevel, batteryPct);

  if (connectWiFi(15000)) {
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    if (http.begin(client, BACKEND_URL)) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("ngrok-skip-browser-warning", "true");

      String json = "{";
      json += "\"node_id\":\"" + String(DEVICE_ID) + "\",";
      json += "\"temp_c\":" + String(temperature, 2) + ",";
      json += "\"humidity_pct\":" + String(humidity, 2) + ",";
      json += "\"gas_ppm\":" + String(mq135) + ",";
      json += "\"river_level_m\":" + (waterLevel >= 0 ? String(waterLevel, 3) : String("-1")) + ",";
      json += "\"flame_reading\":" + String(irDetected ? "1.0" : "0.0") + ",";
      json += "\"rainfall_mm_since_last\":0.0,";
      json += "\"signal_strength_dbm\":" + String(WiFi.RSSI()) + ",";
      json += "\"battery_pct\":" + String(batteryPct, 1);
      json += "}";

      int responseCode = http.POST(json);
      Serial.printf("POST response: %d\n", responseCode);
      http.end();
    }
    WiFi.disconnect(true);
  } else {
    Serial.println("WiFi connect failed this cycle - skipping send, will retry next wake.");
  }

  Serial.printf("Going to sleep for %d seconds...\n", SLEEP_DURATION_SECONDS);
  Serial.flush();
  esp_sleep_enable_timer_wakeup((uint64_t)SLEEP_DURATION_SECONDS * 1000000ULL);
  esp_deep_sleep_start();
  // Execution never reaches here - the chip resets and setup() runs again on wake.
}

void setup() {
  Serial.begin(115200);
  delay(500);
  bootCount++;

  dht.begin();
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(IR_PIN, INPUT);
  pinMode(MQ135_PIN, INPUT);

  sendReadingAndSleep();
}

void loop() {
  // Intentionally empty - all work happens once per wake in setup(),
  // ending in deep sleep. loop() is never reached.
}
