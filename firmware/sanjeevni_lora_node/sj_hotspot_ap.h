// =====================================================================
// SANJEEVNI - offline SOS Wi-Fi, the ESP32 part: the open access point,
// the captive-portal DNS (every name -> us) and a minimal HTTP server.
// Everything it decides is in sj_hotspot.h (unit-tested on a PC); this
// file only moves bytes, so it is not host-tested - CHECK ON THE BOARD:
// join "SANJEEVNI-SOS" with an Android phone and an iPhone, the "sign in
// to network" page must open by itself.
// KEEP IDENTICAL in firmware/sanjeevni_lora_node/ and
// firmware/sanjeevni_lora_gateway/ (run_tests.py checks the copies match).
//
// Why not the core's WebServer library: an open network means any phone in
// range can send anything, and here every limit is ours - the head and
// body sizes (a bigger request is refused before it is read), the time one
// request may take, one request at a time out of a static buffer (no
// allocation an attacker controls) - in about 100 lines.
// =====================================================================
#pragma once
#include <WiFi.h>
#include <DNSServer.h>
#include "sj_hotspot.h"

#define SJ_HS_HEAD_MAX 1536         // request line + headers: phones send roughly 400-900 bytes
#define SJ_HS_BODY_MAX 1024         // the form is ~100 bytes + the note (Hindi: 9 bytes per letter when %-encoded)
#define SJ_HS_READ_TIMEOUT_MS 2000  // a phone slower than this (or a client that never finishes) is dropped

class SjHotspotAp {
 public:
  // An OPEN network: anyone in need must get on without asking for a
  // password. `channel` holds while the gateway's own Wi-Fi client is not
  // connected; the ESP32 has one radio, so a connected client moves the
  // access point to its router's channel (phones follow, they may drop
  // off for a moment).
  bool begin(const char* ssid, uint8_t channel, uint8_t maxClients) {
    if (!WiFi.softAP(ssid, nullptr, channel, 0, maxClients)) return false;
    ip_ = WiFi.softAPIP().toString();
    dns_.start(53, "*", WiFi.softAPIP());  // every name -> this page (captive portal)
    server_.begin();
    up_ = true;
    return true;
  }

  bool up() const { return up_; }
  const char* ip() const { return ip_.c_str(); }
  uint8_t stations() const { return up_ ? WiFi.softAPgetStationNum() : 0; }

  // One pass: pending DNS questions, then at most one HTTP request.
  // respond(const SjHttpReq&, String& out) builds the complete response.
  template <typename RespondFn>
  void poll(RespondFn respond) {
    if (!up_) return;
    dns_.processNextRequest();  // a no-op on cores whose DNSServer answers by itself
    WiFiClient client = server_.accept();
    if (client) serve(client, respond);
  }

 private:
  template <typename RespondFn>
  void serve(WiFiClient& client, RespondFn respond) {
    // Static, not on the task stack; poll() is only ever called from one task.
    static char buf[SJ_HS_HEAD_MAX + SJ_HS_BODY_MAX + 1];
    size_t n = 0, headEnd = 0;
    uint32_t start = millis();
    while (!headEnd && n < SJ_HS_HEAD_MAX && millis() - start < SJ_HS_READ_TIMEOUT_MS) {
      int c = client.read();
      if (c < 0) {
        if (!client.connected()) break;
        delay(2);
        continue;
      }
      buf[n++] = (char)c;
      if (n >= 2 && buf[n - 1] == '\n' && (buf[n - 2] == '\n' || (n >= 4 && memcmp(buf + n - 4, "\r\n\r\n", 4) == 0)))
        headEnd = n;
    }
    SjHttpReq req;
    if (!headEnd || !sjHttpParseHead(buf, headEnd, req)) {
      plain(client, "400 Bad Request");
      return;
    }
    size_t bodyLen = 0;
    if (strcmp(req.method, "POST") == 0) {
      if (req.contentLength < 0) {
        plain(client, "411 Length Required");
        return;
      }
      if (req.contentLength > SJ_HS_BODY_MAX) {
        plain(client, "413 Payload Too Large");
        return;
      }
      while (bodyLen < (size_t)req.contentLength && millis() - start < SJ_HS_READ_TIMEOUT_MS) {
        int c = client.read();
        if (c < 0) {
          if (!client.connected()) break;
          delay(2);
          continue;
        }
        buf[headEnd + bodyLen++] = (char)c;
      }
      if (bodyLen < (size_t)req.contentLength) {
        plain(client, "408 Request Timeout");
        return;
      }
    }
    buf[headEnd + bodyLen] = '\0';
    req.body = buf + headEnd;
    req.bodyLen = bodyLen;
    // The phone's address on our network: with the client id it tells
    // "the same phone" for the per-phone limits (sj_hotspot.h).
    IPAddress ip = client.remoteIP();  // operator[]: in every core version, unlike the uint32_t cast
    req.peer = (uint32_t)ip[0] << 24 | (uint32_t)ip[1] << 16 | (uint32_t)ip[2] << 8 | (uint32_t)ip[3];
    String out;
    respond(req, out);
    client.write((const uint8_t*)out.c_str(), out.length());
    client.stop();
  }

  static void plain(WiFiClient& client, const char* status) {
    client.print("HTTP/1.1 ");
    client.print(status);
    client.print("\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    client.stop();
  }

  DNSServer dns_;
  WiFiServer server_{80};
  String ip_;
  bool up_ = false;
};
