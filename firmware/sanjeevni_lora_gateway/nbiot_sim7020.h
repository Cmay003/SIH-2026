// =====================================================================
// SANJEEVNI gateway - minimal SIM7020 NB-IoT HTTP client (AT commands).
//
// UNVERIFIED ON HARDWARE. Written against the SIM7020 Series AT Command
// Manual's HTTP commands (AT+CHTTPCREATE / CHTTPCON / CHTTPSEND /
// CHTTPDISCON / CHTTPDESTROY, response code in the +CHTTPNMIH URC).
// Check command names/arguments against the manual for YOUR firmware
// version - use the gateway's 'a' Serial command (AT pass-through) to try
// each step by hand first:
//   AT                      -> OK
//   AT+CPIN?                -> +CPIN: READY        (SIM inserted)
//   AT+CSQ                  -> +CSQ: <rssi>,..     (99 = no signal)
//   AT+CGATT?               -> +CGATT: 1           (attached to NB-IoT)
//   AT+CHTTPCREATE="http://host/"  -> +CHTTPCREATE: 0
// SIM7020 CHTTPSEND takes the custom header and body as HEX strings.
// =====================================================================
#pragma once
#include <Arduino.h>
#include "config.h"

class Sim7020 {
 public:
  void begin() {
    serial_.begin(NBIOT_BAUD, SERIAL_8N1, NBIOT_RX_PIN, NBIOT_TX_PIN);
    if (NBIOT_PWRKEY_PIN >= 0) pinMode(NBIOT_PWRKEY_PIN, OUTPUT);
  }

  HardwareSerial& serial() { return serial_; }

  // Powers the module up if needed, checks the SIM, sets the APN once,
  // and waits for network attach. Cheap to call when already attached.
  bool ensureAttached(const char* apn) {
    if (attached_ && command("AT+CGATT?", "+CGATT: 1", 2000)) return true;
    attached_ = false;
    if (!command("AT", "OK", 1000) && !powerOn()) {
      Serial.println("[nbiot] module not responding");
      return false;
    }
    command("ATE0", "OK", 1000);  // no echo - simpler parsing
    if (!command("AT+CPIN?", "+CPIN: READY", 5000)) {
      Serial.println("[nbiot] SIM not ready");
      return false;
    }
    if (!apnSet_) {
      // SIM7020: the default PDP context APN is set with AT*MCGDEFCONT while
      // the radio is off (CFUN=0).
      command("AT+CFUN=0", "OK", 10000);
      String cmd = String("AT*MCGDEFCONT=\"IP\",\"") + apn + "\"";
      command(cmd.c_str(), "OK", 5000);
      command("AT+CFUN=1", "OK", 10000);
      apnSet_ = true;
    }
    uint32_t start = millis();
    while (millis() - start < NBIOT_ATTACH_TIMEOUT_MS) {
      if (command("AT+CGATT?", "+CGATT: 1", 2000)) {
        attached_ = true;
        String csq;
        command("AT+CSQ", "OK", 2000, &csq);
        Serial.printf("[nbiot] attached, %s\n", csq.c_str());
        return true;
      }
      delay(2000);
    }
    Serial.println("[nbiot] not attached - check APN / NB-IoT coverage / band");
    return false;
  }

  // POSTs a JSON body. Returns the HTTP status code, or -1 on a module /
  // network error (caller keeps the readings queued). `responseBody`
  // (optional) gets the body of a 200 - see readBody() - or stays empty.
  int httpPost(const char* base, const char* path, const String& json, const char* deviceKey,
               String* responseBody = nullptr) {
    String resp;
    String create = String("AT+CHTTPCREATE=\"") + base + "\"";
    if (!command(create.c_str(), "+CHTTPCREATE:", 10000, &resp)) return -1;
    int id = parseIntAfter(resp, "+CHTTPCREATE:");
    if (id < 0) return -1;

    int code = -1;
    String con = "AT+CHTTPCON=" + String(id);
    if (command(con.c_str(), "OK", 20000)) {
      String send = "AT+CHTTPSEND=" + String(id) + ",1,\"" + path + "\",\"" +
                    toHex(String("ngrok-skip-browser-warning: true\r\nX-Device-Key: ") + deviceKey + "\r\n") +
                    "\",\"application/json\",\"" + toHex(json) + "\"";
      String urc;
      if (command(send.c_str(), "+CHTTPNMIH:", 30000, &urc)) {
        // +CHTTPNMIH: <id>,<response_code>,<header_length>,<header>
        int afterId = urc.indexOf(',', urc.indexOf("+CHTTPNMIH:"));
        if (afterId > 0) code = urc.substring(afterId + 1).toInt();
        if (code == 200 && responseBody) readBody(urc, *responseBody);
      }
      command(("AT+CHTTPDISCON=" + String(id)).c_str(), "OK", 5000);
    }
    command(("AT+CHTTPDESTROY=" + String(id)).c_str(), "OK", 5000);
    if (code <= 0) attached_ = false;  // re-check attach next time
    return code > 0 ? code : -1;
  }

  // Sends `cmd`, collects output until `expect` appears (true), "ERROR"
  // appears (false) or the timeout passes (false).
  bool command(const char* cmd, const char* expect, uint32_t timeoutMs, String* out = nullptr) {
    while (serial_.available()) serial_.read();  // drop stale URCs
    serial_.print(cmd);
    serial_.print("\r\n");
    String buf;
    uint32_t start = millis();
    while (millis() - start < timeoutMs) {
      while (serial_.available()) buf += (char)serial_.read();
      if (buf.indexOf(expect) >= 0) {
        // keep reading briefly so the full line is captured
        uint32_t tail = millis();
        while (millis() - tail < 50) {
          while (serial_.available()) buf += (char)serial_.read();
        }
        if (out) *out = buf;
        return true;
      }
      if (buf.indexOf("ERROR") >= 0) break;
      delay(5);
    }
    if (out) *out = buf;
    return false;
  }

 private:
  // The response body (it may carry siren commands for the nodes). EVEN
  // LESS VERIFIED than the rest of this file: written for the content URC
  //   +CHTTPNMIC: <id>,<flag>,<total_len>,<len>,<content>
  // (flag 0 = last part) as we read the SIM7020 manual, with the content
  // taken as hex if it is all hex digits and as text otherwise. Gives up
  // after NBIOT_BODY_WAIT_MS - the upload's status code is not affected,
  // only a siren command waits for a WiFi upload or the server's re-send.
  // Check with the 'a' pass-through what your module really prints.
  void readBody(const String& already, String& body) {
    String buf = already;
    body = "";
    uint32_t start = millis();
    int from = 0;
    while (millis() - start < NBIOT_BODY_WAIT_MS) {
      while (serial_.available()) buf += (char)serial_.read();
      int at = buf.indexOf("+CHTTPNMIC:", from);
      int eol = at >= 0 ? buf.indexOf('\n', at) : -1;
      if (at < 0 || eol < 0) {  // nothing (complete) yet
        delay(5);
        continue;
      }
      String line = buf.substring(at + 11, eol);
      line.trim();
      from = eol + 1;
      // <id>,<flag>,<total>,<len>,<content>
      int c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1), c3 = line.indexOf(',', c2 + 1),
          c4 = line.indexOf(',', c3 + 1);
      if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) return;
      int flag = line.substring(c1 + 1, c2).toInt();
      String part = line.substring(c4 + 1);
      body += isHex(part) ? fromHex(part) : part;
      if (flag == 0) return;
    }
  }

  static bool isHex(const String& s) {
    if (s.length() == 0 || s.length() % 2) return false;
    for (size_t i = 0; i < s.length(); i++)
      if (!isxdigit((unsigned char)s[i])) return false;
    return true;
  }

  static String fromHex(const String& s) {
    String out;
    out.reserve(s.length() / 2);
    for (size_t i = 0; i + 1 < s.length(); i += 2) {
      char hex[3] = {s[i], s[i + 1], 0};
      out += (char)strtol(hex, nullptr, 16);
    }
    return out;
  }

  HardwareSerial serial_{1};
  bool attached_ = false;
  bool apnSet_ = false;

  bool powerOn() {
    if (NBIOT_PWRKEY_PIN < 0) return false;
    digitalWrite(NBIOT_PWRKEY_PIN, LOW);  // PWRKEY low pulse (check your board's polarity)
    delay(1200);
    digitalWrite(NBIOT_PWRKEY_PIN, HIGH);
    delay(5000);
    return command("AT", "OK", 2000);
  }

  static int parseIntAfter(const String& s, const char* tag) {
    int i = s.indexOf(tag);
    if (i < 0) return -1;
    return s.substring(i + strlen(tag)).toInt();
  }

  static String toHex(const String& s) {
    static const char* digits = "0123456789ABCDEF";
    String hex;
    hex.reserve(s.length() * 2);
    for (size_t i = 0; i < s.length(); i++) {
      uint8_t b = (uint8_t)s[i];
      hex += digits[b >> 4];
      hex += digits[b & 0x0F];
    }
    return hex;
  }
};
