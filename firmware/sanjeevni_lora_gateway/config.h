// =====================================================================
// SANJEEVNI LoRa gateway - configuration.
// CHECK EVERY PIN AGAINST YOUR WIRING BEFORE FLASHING.
// WiFi / backend URLs / APN live in secrets.h (git-ignored) - copy
// secrets.example.h to secrets.h and fill it in.
// =====================================================================
#pragma once

// ---- LoRa SX1278 - MUST match every node's config.h ------------------
#define LORA_FREQUENCY_MHZ 433.0
#define LORA_BANDWIDTH_KHZ 125.0
#define LORA_SPREADING_FACTOR 9
#define LORA_CODING_RATE 7
#define LORA_SYNC_WORD 0x34
#define LORA_TX_POWER_DBM 10  // ACK power; confirm legal limits (see node config.h)

#define LORA_SCK 18
#define LORA_MISO 19
#define LORA_MOSI 23
#define LORA_NSS 5
#define LORA_RST 14
#define LORA_DIO0 26

// ---- Queue (LittleFS) -----------------------------------------------
// Readings are acknowledged to nodes only AFTER they are saved here, then
// forwarded to the backend. 4000 x ~64 B = ~256 KB.
#define QUEUE_CAPACITY 4000

// ---- Backhaul -------------------------------------------------------
// WiFi is tried first; NB-IoT is used when WiFi is not connected.
#define ENABLE_WIFI 1
#define ENABLE_NBIOT 1

#define FORWARD_RETRY_INTERVAL_MS 15000UL
#define WIFI_MAX_BATCH 20  // readings per HTTPS request
// SIM7020 sends the body hex-encoded inside one AT command, so keep NB-IoT
// requests small. Raise only after testing larger bodies on your module.
#define NBIOT_MAX_BATCH 1

// SIM7020E on UART1. PWRKEY pin optional (-1 if the board powers on by itself).
#define NBIOT_RX_PIN 32  // ESP32 RX  <- SIM7020 TX
#define NBIOT_TX_PIN 33  // ESP32 TX  -> SIM7020 RX
#define NBIOT_PWRKEY_PIN 25
#define NBIOT_BAUD 115200
#define NBIOT_ATTACH_TIMEOUT_MS 60000UL
#define NBIOT_RETRY_INTERVAL_MS 300000UL  // after a failed attach, wait 5 min before trying NB-IoT again

#define LED_PIN 2
