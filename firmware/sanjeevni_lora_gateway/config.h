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
// forwarded to the backend. 4000 x (64 B + 4 B CRC) = ~272 KB in 67
// small segment files (sj_file_queue.h). Changing this on a gateway that
// still holds readings is safe: the next boot moves them to the new size
// (newest kept if smaller), which briefly needs free flash for a second
// copy. Without that room (e.g. a much larger capacity on a full queue)
// the queue keeps the old size and its readings, and the move is retried
// at the next boot.
#define QUEUE_CAPACITY 4000

// ---- Backhaul -------------------------------------------------------
// WiFi is tried first; NB-IoT is used when WiFi is not connected.
#define ENABLE_WIFI 1
#define ENABLE_NBIOT 1

#define FORWARD_RETRY_INTERVAL_MS 15000UL
// Uploads run in their own FreeRTOS task so the LoRa radio is served
// during a request. 12 KB: the TLS handshake ran in Arduino's 8 KB loop
// task before; the rest is margin.
#define FORWARD_TASK_STACK_BYTES 12288
// How long a received packet waits for the queue while the forwarding task
// reads or pops a batch. Kept well under the node's ACK timeout - a packet
// not ACKed in time is simply resent by the node.
#define QUEUE_LOCK_WAIT_MS 500
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
