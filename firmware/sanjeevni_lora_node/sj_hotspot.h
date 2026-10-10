// =====================================================================
// SANJEEVNI - offline SOS Wi-Fi "SANJEEVNI-SOS": the page, the form, the
// abuse limits and the SOS outbox (hardware-independent, so it is
// unit-tested on a PC: tools/firmware_host_test). The Wi-Fi / DNS / socket
// part is sj_hotspot_ap.h.
// KEEP IDENTICAL in firmware/sanjeevni_lora_node/ and
// firmware/sanjeevni_lora_gateway/ (run_tests.py checks the copies match).
//
// For people whose phone has Wi-Fi but no mobile data: an open access
// point with a captive portal (every web address leads to the SOS page)
// and a tiny bilingual EN/HI form - no external files, no JavaScript, so
// it works in the "sign in to network" window of any phone.
//  - LOCATION: browsers give a plain-http page no GPS position, so the SOS
//    is placed at the registered position of the device running the
//    hotspot (the person is within its Wi-Fi range); the person can add
//    "where exactly" in words and, if they know them, typed coordinates.
//  - ABUSE LIMITS: the network is open to anyone in range, so every input
//    is capped and cleaned (sjCleanText), every byte echoed back is
//    HTML-escaped and every byte forwarded is JSON-escaped; one waiting
//    request per phone, and a gap after it was SENT before the same phone
//    may send another. "The same phone" = the same client id (a cookie, or
//    the id in the form) OR the same Wi-Fi address on this access point:
//    the id comes from the phone itself, and a fresh or empty one in every
//    POST used to count as a new phone each time - one person could then
//    use up the access point's window and lock everyone else out (review).
//    The address keeps that person to one request per gap; changing it
//    means re-joining the network with another MAC address each time. At
//    most maxPerWindow new requests per window on the whole access point,
//    as the backstop against many phones.
//  - DELIVERY: a request is stored in an outbox (RAM + NVS) BEFORE the
//    page says "stored", and retried until the next hop has it: on a node
//    the gateway (LoRa, SjSosMsg in sj_packet.h), on the gateway the
//    server (POST /api/ingest/sos). The status page refreshes itself and
//    turns to "sent" when that happened.
// Times are seconds since boot from the 64-bit esp_timer: no wrap.
//
// HINDI TEXT IN THIS FILE NEEDS REVIEW BY A NATIVE SPEAKER before field use
// (written by the developers, not by a translator).
// =====================================================================
#pragma once
#ifndef SJ_HOTSPOT_H_
#define SJ_HOTSPOT_H_
#include <Arduino.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "sj_packet.h"

// ---- UTF-8 -------------------------------------------------------------------
// Length of the valid UTF-8 sequence at s (n bytes available), 0 if it is
// not one: a stray continuation byte, an overlong form, a surrogate, a
// value above U+10FFFF or a sequence cut off by the end.
inline uint8_t sjUtf8Seq(const uint8_t* s, size_t n, uint32_t& cp) {
  uint8_t b = s[0];
  if (b < 0x80) {
    cp = b;
    return 1;
  }
  uint8_t len;
  uint32_t min;
  if ((b & 0xE0) == 0xC0) {
    len = 2, cp = b & 0x1F, min = 0x80;
  } else if ((b & 0xF0) == 0xE0) {
    len = 3, cp = b & 0x0F, min = 0x800;
  } else if ((b & 0xF8) == 0xF0) {
    len = 4, cp = b & 0x07, min = 0x10000;
  } else {
    return 0;
  }
  if (n < len) return 0;
  for (uint8_t i = 1; i < len; i++) {
    if ((s[i] & 0xC0) != 0x80) return 0;
    cp = (cp << 6) | (s[i] & 0x3F);
  }
  if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
  return len;
}

// Characters that become a space: control characters (newlines too - the
// officer views show one line), and the invisible line / bidi-override
// characters that can make a note display as something it is not.
inline bool sjUtf8Blank(uint32_t cp) {
  return cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || cp == 0x2028 || cp == 0x2029 || (cp >= 0x202A && cp <= 0x202E) ||
         (cp >= 0x2066 && cp <= 0x2069);
}

// Cleans text typed on a stranger's phone, in place (s needs len+1 bytes):
// invalid UTF-8 -> '?', blanks -> one space, runs of spaces -> one, no
// leading / trailing space, and at most maxBytes bytes WITHOUT splitting a
// character (a half character would be invalid UTF-8 in the JSON / page).
// Returns the new length; `cut` = text was dropped by the cap.
inline size_t sjCleanText(char* s, size_t len, size_t maxBytes, bool& cut) {
  cut = false;
  size_t w = 0;
  bool lastSpace = true;  // drops leading spaces
  for (size_t r = 0; r < len;) {
    uint32_t cp;
    uint8_t n = sjUtf8Seq((const uint8_t*)s + r, len - r, cp);
    char repl = 0;
    if (n == 0) {
      repl = '?';
      n = 1;
    } else if (sjUtf8Blank(cp) || cp == ' ') {
      repl = ' ';
    }
    if (repl == ' ') {
      r += n;
      if (lastSpace) continue;
      if (w + 1 > maxBytes) {
        cut = true;
        break;
      }
      s[w++] = ' ';
      lastSpace = true;
      continue;
    }
    size_t outLen = repl ? 1 : n;
    if (w + outLen > maxBytes) {
      cut = true;
      break;
    }
    if (repl) {
      s[w++] = repl;
    } else {
      memmove(s + w, s + r, n);  // w <= r: never overwrites what is still to be read
      w += n;
    }
    r += n;
    lastSpace = false;
  }
  while (w > 0 && s[w - 1] == ' ') w--;
  s[w] = '\0';
  return w;
}

// ---- JSON for POST /api/ingest/sos ----------------------------------------------
// A JSON string of (already cleaned) UTF-8, quotes included. ASCII-only
// output: everything outside printable ASCII becomes \uXXXX (a surrogate
// pair above U+FFFF), so the body survives any hop - the SIM7020 sends it
// hex-encoded inside an AT command - and an invalid byte becomes U+FFFD.
inline void sjJsonAppendText(String& out, const char* s, size_t len) {
  static const char* hex = "0123456789abcdef";
  out += '"';
  for (size_t i = 0; i < len;) {
    uint32_t cp;
    uint8_t n = sjUtf8Seq((const uint8_t*)s + i, len - i, cp);
    if (n == 0) {
      cp = 0xFFFD;
      n = 1;
    }
    i += n;
    if (cp == '"' || cp == '\\') {
      out += '\\';
      out += (char)cp;
    } else if (cp >= 0x20 && cp < 0x7F) {
      out += (char)cp;
    } else {
      uint32_t units[2] = {cp, 0};
      int count = 1;
      if (cp > 0xFFFF) {
        units[0] = 0xD800 + ((cp - 0x10000) >> 10);
        units[1] = 0xDC00 + ((cp - 0x10000) & 0x3FF);
        count = 2;
      }
      for (int k = 0; k < count; k++) {
        out += "\\u";
        for (int sh = 12; sh >= 0; sh -= 4) out += hex[(units[k] >> sh) & 0xF];
      }
    }
  }
  out += '"';
}

// Degrees x 1e6 as an exact decimal ("-12.000500"), no float rounding.
inline void sjAppendE6(String& out, int32_t v) {
  char buf[16];
  uint32_t a = v < 0 ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
  snprintf(buf, sizeof(buf), "%s%lu.%06lu", v < 0 ? "-" : "", (unsigned long)(a / 1000000u),
           (unsigned long)(a % 1000000u));
  out += buf;
}

// The id field as a C string (it is NUL-padded, maybe without a final NUL).
inline void sjIdString(char* out, const char* field, size_t len) {
  memcpy(out, field, len);
  out[len] = '\0';
}

// "<session>-h<seq>": unique per node (the session is random per board and
// changes every boot, sj_session.h) - the server dedups on (node_id, sos_uid).
inline void sjSosUid(char* out, size_t cap, const SjSosMsg& m) {
  snprintf(out, cap, "%lu-h%lu", (unsigned long)m.session, (unsigned long)m.seq);
}

// The request body the server's POST /api/ingest/sos takes (the contract:
// people / latitude / longitude / age_seconds null when not known).
// ageSeconds < 0 = unknown. Only call with an sjSosMsgValid() message: the
// ids are written as they are (that check allows only [A-Za-z0-9._-]).
inline void sjAppendSosMsgJson(String& out, const SjSosMsg& m, long ageSeconds) {
  char id[SJ_NODE_ID_LEN + 1], client[SJ_SOS_CLIENT_LEN + 1], uid[24];
  sjIdString(id, m.node_id, SJ_NODE_ID_LEN);
  sjIdString(client, m.client_id, SJ_SOS_CLIENT_LEN);
  sjSosUid(uid, sizeof(uid), m);
  out += "{\"node_id\":\"";
  out += id;
  out += "\",\"sos_uid\":\"";
  out += uid;
  out += "\",\"client_id\":\"";
  out += client;
  out += "\",\"people\":";
  out += m.people ? String((unsigned long)m.people) : String("null");
  out += ",\"needs\":[";
  bool first = true;
  for (int i = 0; i < 4; i++) {
    if (!(m.needs & (1 << i))) continue;
    if (!first) out += ",";
    out += "\"";
    out += SJ_NEED_NAMES[i];
    out += "\"";
    first = false;
  }
  out += "],\"note\":";
  sjJsonAppendText(out, m.note, m.note_len <= SJ_SOS_NOTE_MAX ? m.note_len : SJ_SOS_NOTE_MAX);
  if (m.flags & SJ_SOS_MSG_HAS_POS) {
    out += ",\"latitude\":";
    sjAppendE6(out, m.lat_e6);
    out += ",\"longitude\":";
    sjAppendE6(out, m.lon_e6);
  } else {
    out += ",\"latitude\":null,\"longitude\":null";
  }
  out += ",\"age_seconds\":";
  out += ageSeconds >= 0 ? String(ageSeconds) : String("null");
  out += "}";
}

// The gateway's URL / path for the SOS endpoint, from the batch one it
// already has ("https://x/api/ingest/batch" -> ".../api/ingest/sos"), so a
// secrets.h written before this feature needs no new entry. The last path
// segment is replaced.
inline String sjSiblingUrl(const char* url, const char* leaf) {
  const char* slash = strrchr(url, '/');
  String out;
  if (!slash) {
    out = "/";
  } else {
    for (const char* p = url; p <= slash; p++) out += *p;
  }
  out += leaf;
  return out;
}

// ---- form + HTTP parsing ----------------------------------------------------------
inline int sjHexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// application/x-www-form-urlencoded value -> bytes: '+' = space, %XX = a
// byte (a broken % sequence is kept as typed). Writes at most cap-1 bytes
// and a NUL; `full` = the rest did not fit. Returns the length.
inline size_t sjUrlDecode(const char* in, size_t len, char* out, size_t cap, bool& full) {
  size_t w = 0;
  full = false;
  for (size_t i = 0; i < len; i++) {
    char c = in[i];
    if (c == '+') {
      c = ' ';
    } else if (c == '%' && i + 2 < len && sjHexDigit(in[i + 1]) >= 0 && sjHexDigit(in[i + 2]) >= 0) {
      c = (char)(sjHexDigit(in[i + 1]) * 16 + sjHexDigit(in[i + 2]));
      i += 2;
    }
    if (w + 1 >= cap) {
      full = true;
      break;
    }
    out[w++] = c;
  }
  if (cap) out[w] = '\0';
  return w;
}

// The next "key=value" pair of a form / query string. false = no more.
inline bool sjFormNext(const char*& p, const char* end, const char*& key, size_t& keyLen, const char*& val,
                       size_t& valLen) {
  while (p < end && *p == '&') p++;
  if (p >= end) return false;
  const char* amp = p;
  while (amp < end && *amp != '&') amp++;
  const char* eq = p;
  while (eq < amp && *eq != '=') eq++;
  key = p;
  keyLen = (size_t)(eq - p);
  val = eq < amp ? eq + 1 : amp;
  valLen = (size_t)(amp - val);
  p = amp;
  return true;
}

inline bool sjFormKeyIs(const char* key, size_t keyLen, const char* name) {
  return keyLen == strlen(name) && memcmp(key, name, keyLen) == 0;
}

// The first value of field `name`, decoded into out. false = not present.
// `outLen` (optional) gets the decoded length - the value may contain a
// NUL byte (%00), so strlen(out) can be shorter.
inline bool sjFormGet(const char* data, size_t len, const char* name, char* out, size_t cap, bool& full,
                      size_t* outLen = nullptr) {
  const char *p = data, *end = data + len, *key, *val;
  size_t keyLen, valLen;
  full = false;
  if (cap) out[0] = '\0';
  if (outLen) *outLen = 0;
  while (sjFormNext(p, end, key, keyLen, val, valLen)) {
    if (!sjFormKeyIs(key, keyLen, name)) continue;
    size_t n = sjUrlDecode(val, valLen, out, cap, full);
    if (outLen) *outLen = n;
    return true;
  }
  return false;
}

// Keeps only [A-Za-z0-9_-], at most SJ_SOS_CLIENT_LEN of them.
inline void sjCleanClientId(const char* in, char* out /* SJ_SOS_CLIENT_LEN + 1 */) {
  size_t w = 0;
  for (const char* p = in; *p && w < SJ_SOS_CLIENT_LEN; p++)
    if (sjIdChar(*p, false)) out[w++] = *p;
  out[w] = '\0';
}

// A new client id from two random words: 8 of [a-z2-7] (40 bits).
inline void sjHotspotNewClientId(char* out /* SJ_SOS_CLIENT_LEN + 1 */, uint32_t r1, uint32_t r2) {
  static const char* abc = "abcdefghijklmnopqrstuvwxyz234567";
  uint64_t v = ((uint64_t)r1 << 32) | r2;
  for (int i = 0; i < SJ_SOS_CLIENT_LEN; i++, v >>= 5) out[i] = abc[v & 31];
  out[SJ_SOS_CLIENT_LEN] = '\0';
}

// "12", " 12 " -> 12; empty / not a number -> 0 (not given); above
// SJ_SOS_PEOPLE_MAX -> the cap ("very many" is still worth sending).
inline uint16_t sjParsePeople(const char* s) {
  while (*s == ' ') s++;
  uint32_t v = 0;
  bool any = false;
  for (; *s >= '0' && *s <= '9'; s++) {
    any = true;
    v = v * 10 + (uint32_t)(*s - '0');
    if (v > SJ_SOS_PEOPLE_MAX) v = SJ_SOS_PEOPLE_MAX + 1;  // capped every digit: no overflow
  }
  while (*s == ' ') s++;
  if (!any || *s) return 0;
  return v > SJ_SOS_PEOPLE_MAX ? SJ_SOS_PEOPLE_MAX : (uint16_t)v;
}

// A typed coordinate in decimal degrees ("30.3165", "-78.03", " 30 ") ->
// degrees x 1e6, within +-limitDeg. Decimals past the 6th are dropped
// (0.1 m). false = empty, not a plain decimal number, or out of range.
inline bool sjParseCoordE6(const char* s, int32_t limitDeg, int32_t& out) {
  while (*s == ' ') s++;
  bool neg = *s == '-';
  if (*s == '-' || *s == '+') s++;
  int64_t whole = 0, frac = 0;
  int digits = 0, fracDigits = 0;
  for (; *s >= '0' && *s <= '9'; s++, digits++) {
    whole = whole * 10 + (*s - '0');
    if (whole > 1000) return false;
  }
  if (*s == '.') {
    for (s++; *s >= '0' && *s <= '9'; s++, digits++) {
      if (fracDigits < 6) {
        frac = frac * 10 + (*s - '0');
        fracDigits++;
      }
    }
  }
  while (*s == ' ') s++;
  if (!digits || *s) return false;
  while (fracDigits < 6) {
    frac *= 10;
    fracDigits++;
  }
  int64_t v = whole * 1000000 + frac;
  if (v > (int64_t)limitDeg * 1000000) return false;
  out = (int32_t)(neg ? -v : v);
  return true;
}

// What the SOS form sent, cleaned.
struct SjHotspotForm {
  uint16_t people;
  uint8_t needs;
  uint8_t hasPos;
  uint8_t posIgnored;  // coordinates were typed but not usable (one missing / not a number / out of range)
  uint8_t noteCut;     // the description was shortened to SJ_SOS_NOTE_MAX bytes
  uint8_t noteLen;
  int32_t lat_e6, lon_e6;
  char client[SJ_SOS_CLIENT_LEN + 1];
  char note[SJ_SOS_NOTE_MAX + 1];
};

// Field names: p = people, n = need (repeated), t = text, la / lo =
// latitude / longitude, c = client id. Unknown fields and need values are
// ignored. Never fails: an SOS with nothing filled in is still an SOS.
inline void sjHotspotParseForm(const char* body, size_t len, SjHotspotForm& f) {
  memset(&f, 0, sizeof(f));
  char buf[4 * SJ_SOS_NOTE_MAX];  // a long Hindi text: up to ~130 letters decoded before the cap
  bool full;
  if (sjFormGet(body, len, "p", buf, 16, full)) f.people = sjParsePeople(buf);  // a cut-off number is still > 999
  const char *p = body, *end = body + len, *key, *val;
  size_t keyLen, valLen;
  while (sjFormNext(p, end, key, keyLen, val, valLen)) {
    if (!sjFormKeyIs(key, keyLen, "n")) continue;
    char v[12];
    sjUrlDecode(val, valLen, v, sizeof(v), full);
    for (int i = 0; i < 4; i++)
      if (!full && strcmp(v, SJ_NEED_NAMES[i]) == 0) f.needs |= (uint8_t)(1 << i);
  }
  size_t decoded;
  if (sjFormGet(body, len, "t", buf, sizeof(buf), full, &decoded)) {
    bool cut;
    size_t n = sjCleanText(buf, decoded, SJ_SOS_NOTE_MAX, cut);  // a %00 becomes a space, not the end
    memcpy(f.note, buf, n + 1);
    f.noteLen = (uint8_t)n;
    f.noteCut = cut || full;
  }
  char la[24] = "", lo[24] = "";
  bool laFull = false, loFull = false;
  sjFormGet(body, len, "la", la, sizeof(la), laFull);
  sjFormGet(body, len, "lo", lo, sizeof(lo), loFull);
  bool laBlank = true, loBlank = true;  // "typed" = anything but spaces in either box
  for (const char* q = la; *q; q++) laBlank &= *q == ' ';
  for (const char* q = lo; *q; q++) loBlank &= *q == ' ';
  if (!(laBlank && loBlank)) {
    f.hasPos = !laFull && !loFull && sjParseCoordE6(la, 90, f.lat_e6) && sjParseCoordE6(lo, 180, f.lon_e6);
    f.posIgnored = !f.hasPos;
    if (!f.hasPos) f.lat_e6 = f.lon_e6 = 0;
  }
  char c[24];
  if (sjFormGet(body, len, "c", c, sizeof(c), full)) sjCleanClientId(c, f.client);
}

// One HTTP request, as much as the hotspot needs of it.
struct SjHttpReq {
  char method[8];
  char path[48];    // without the query; "" = too long / missing
  char query[64];   // after '?', "" if none or too long
  char host[64];    // Host header without the port
  char cookieClient[SJ_SOS_CLIENT_LEN + 1];  // the "sjc" cookie, cleaned
  long contentLength;  // -1 = no header, -2 = not a number
  const char* body;    // set by the reader (not by sjHttpParseHead)
  size_t bodyLen;
  uint32_t peer;       // the phone's IPv4 address on our access point, set by the reader; 0 = unknown
};

inline bool sjHeaderIs(const char* line, size_t len, const char* name) {
  size_t n = strlen(name);
  if (len <= n || line[n] != ':') return false;
  for (size_t i = 0; i < n; i++) {
    char a = line[i], b = name[i];
    if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
}

// A header's value (after "Name:" and spaces), into out (cut to fit).
inline void sjHeaderValue(const char* line, size_t len, size_t nameLen, char* out, size_t cap) {
  size_t i = nameLen + 1;
  while (i < len && line[i] == ' ') i++;
  size_t w = 0;
  for (; i < len && w + 1 < cap; i++) out[w++] = line[i];
  while (w > 0 && out[w - 1] == ' ') w--;
  out[w] = '\0';
}

// The request line and the headers we use, from the head (everything
// before the blank line, CRLF or LF). false = not an HTTP request line.
inline bool sjHttpParseHead(const char* head, size_t len, SjHttpReq& req) {
  memset(&req, 0, sizeof(req));
  req.contentLength = -1;
  size_t eol = 0;
  while (eol < len && head[eol] != '\n') eol++;
  size_t lineLen = eol > 0 && head[eol - 1] == '\r' ? eol - 1 : eol;
  // METHOD SP TARGET SP HTTP/x
  size_t sp1 = 0;
  while (sp1 < lineLen && head[sp1] != ' ') sp1++;
  if (sp1 == 0 || sp1 >= sizeof(req.method) || sp1 >= lineLen) return false;
  memcpy(req.method, head, sp1);
  size_t t = sp1 + 1, sp2 = t;
  while (sp2 < lineLen && head[sp2] != ' ') sp2++;
  if (sp2 >= lineLen || strncmp(head + sp2 + 1, "HTTP/", 5) != 0) return false;
  size_t q = t;
  while (q < sp2 && head[q] != '?') q++;
  if (q - t < sizeof(req.path)) memcpy(req.path, head + t, q - t);
  if (q < sp2 && sp2 - q - 1 < sizeof(req.query)) memcpy(req.query, head + q + 1, sp2 - q - 1);
  for (size_t pos = eol + 1; pos < len;) {
    size_t e = pos;
    while (e < len && head[e] != '\n') e++;
    size_t l = e > pos && head[e - 1] == '\r' ? e - 1 - pos : e - pos;
    const char* line = head + pos;
    if (sjHeaderIs(line, l, "host")) {
      sjHeaderValue(line, l, 4, req.host, sizeof(req.host));
      char* colon = strchr(req.host, ':');
      if (colon) *colon = '\0';
    } else if (sjHeaderIs(line, l, "content-length")) {
      char v[12];
      sjHeaderValue(line, l, 14, v, sizeof(v));
      long n = 0;
      bool ok = v[0] != '\0';
      for (const char* d = v; *d && ok; d++) {
        ok = *d >= '0' && *d <= '9' && n < 100000000L;
        n = n * 10 + (*d - '0');
      }
      req.contentLength = ok ? n : -2;
    } else if (sjHeaderIs(line, l, "cookie")) {
      char v[160];
      sjHeaderValue(line, l, 6, v, sizeof(v));
      for (char* c = strstr(v, "sjc="); c; c = strstr(c + 1, "sjc=")) {
        if (c != v && c[-1] != ' ' && c[-1] != ';') continue;  // "xsjc=" is another cookie
        char id[24];  // cleaned AFTER the copy: junk in it must not use up the 8 characters
        size_t w = 0;
        for (const char* s = c + 4; *s && *s != ';' && w + 1 < sizeof(id); s++) id[w++] = *s;
        id[w] = '\0';
        sjCleanClientId(id, req.cookieClient);
        break;
      }
    }
    pos = e + 1;
  }
  return true;
}

enum SjHsRoute : uint8_t {
  SJ_HS_ROUTE_FORM = 0,  // GET /            the SOS form (or the phone's status)
  SJ_HS_ROUTE_SUBMIT,    // POST /sos        a new request
  SJ_HS_ROUTE_STATUS,    // GET /s?c=<id>    how that phone's request is doing
  SJ_HS_ROUTE_PORTAL,    // anything else    302 to our page (captive portal)
};

// Phones probe a known address (connectivitycheck.gstatic.com/generate_204,
// captive.apple.com/hotspot-detect.html, ...) right after joining; the DNS
// answers every name with our IP, and redirecting every request that is
// not for our own address / pages makes the phone open its "sign in to
// network" window on the SOS page.
inline SjHsRoute sjHotspotRoute(const SjHttpReq& r, const char* apIp) {
  if (r.host[0] && strcmp(r.host, apIp) != 0) return SJ_HS_ROUTE_PORTAL;
  bool post = strcmp(r.method, "POST") == 0;
  if (post && strcmp(r.path, "/sos") == 0) return SJ_HS_ROUTE_SUBMIT;
  if (post) return SJ_HS_ROUTE_PORTAL;
  if (strcmp(r.path, "/") == 0) return SJ_HS_ROUTE_FORM;
  if (strcmp(r.path, "/s") == 0) return SJ_HS_ROUTE_STATUS;
  return SJ_HS_ROUTE_PORTAL;
}

// ---- requests per phone + the per-access-point limit -----------------------------
enum SjHsState : uint8_t {
  SJ_HS_NONE = 0,
  SJ_HS_STORED,  // in the outbox, not yet taken by the next hop
  SJ_HS_SENT,    // the next hop has it (node: the gateway; gateway: the server)
};

struct SjHotspotClient {
  char id[SJ_SOS_CLIENT_LEN + 1];
  uint8_t state;  // SjHsState
  uint8_t reserved[2];
  uint32_t session;  // which request (SjSosMsg session / seq)
  uint32_t seq;
  uint32_t atS;      // when it was submitted
  uint32_t sentAtS;  // when the next hop took it (state SENT): the gap runs from here
  uint32_t peer;     // the phone's address when it submitted (SjHttpReq.peer), 0 = unknown
};

#define SJ_HS_CLIENTS 16    // phones whose last request's status is remembered
#define SJ_HS_RATE_SLOTS 32  // the most maxPerWindow can be

struct SjHotspotLimits {
  uint8_t maxPerWindow;  // new requests on this access point per window (<= SJ_HS_RATE_SLOTS)
  uint32_t windowS;      // ...and how long an address match counts for a still-waiting request
  uint32_t clientGapS;   // after a request was sent, the same phone waits this long for another
};

// Who is running this hotspot, for the SOS and the page wording.
struct SjHotspotSite {
  const char* nodeId;    // "node_id" of the SOS: this node / the gateway's GATEWAY_ID
  uint32_t session;      // with the app's seq: the sos_uid
  const char* apIp;      // "192.168.4.1"
  bool nextHopIsServer;  // gateway: "sent" = the control room has it; node: the gateway has it
};

struct SjHotspotApp {
  SjHotspotClient clients[SJ_HS_CLIENTS];
  uint32_t rateAtS[SJ_HS_RATE_SLOTS];  // ring of the last maxPerWindow request times
  uint8_t rateNext;
  uint8_t rateFilled;
  uint8_t reserved[2];
  uint32_t seq;  // last SOS message number used in this session
};

inline void sjHotspotBegin(SjHotspotApp& app) { memset(&app, 0, sizeof(app)); }

// Sliding window: allowed if fewer than maxPerWindow requests in the last
// windowS seconds; an allowed one is counted.
inline bool sjHotspotRateAllow(SjHotspotApp& app, uint32_t nowS, const SjHotspotLimits& lim) {
  uint8_t max = lim.maxPerWindow < SJ_HS_RATE_SLOTS ? lim.maxPerWindow : SJ_HS_RATE_SLOTS;
  if (max == 0) return false;
  if (app.rateNext >= max) app.rateNext = 0;
  if (app.rateFilled >= max && nowS - app.rateAtS[app.rateNext] < lim.windowS) return false;
  app.rateAtS[app.rateNext] = nowS;
  app.rateNext = (uint8_t)((app.rateNext + 1) % max);
  if (app.rateFilled < max) app.rateFilled++;
  return true;
}

inline SjHotspotClient* sjHotspotFindClient(SjHotspotApp& app, const char* id) {
  if (!id[0]) return nullptr;
  for (auto& c : app.clients)
    if (c.state != SJ_HS_NONE && strcmp(c.id, id) == 0) return &c;
  return nullptr;
}

// The request a phone at Wi-Fi address `peer` made under ANY id that still
// limits it: one still waiting (submitted less than windowS ago), else the
// last one sent less than clientGapS ago. nullptr = none (or peer unknown).
// Time-bound because the access point's DHCP may hand the address to
// another phone once the first one's lease has run out - that phone must
// not inherit a stranger's limit for ever.
inline SjHotspotClient* sjHotspotFindPeer(SjHotspotApp& app, uint32_t peer, uint32_t nowS,
                                          const SjHotspotLimits& lim) {
  if (peer == 0) return nullptr;
  SjHotspotClient* sent = nullptr;
  for (auto& c : app.clients) {
    if (c.peer != peer) continue;
    if (c.state == SJ_HS_STORED && nowS - c.atS < lim.windowS) return &c;
    if (c.state == SJ_HS_SENT && nowS - c.sentAtS < lim.clientGapS && (!sent || c.sentAtS > sent->sentAtS)) sent = &c;
  }
  return sent;
}

// Remembers a phone's new request. A full table forgets the oldest SENT
// one first (its status is final); only if every one is still waiting the
// oldest of those - its request is still in the outbox and still sent,
// only the page can no longer show it.
inline void sjHotspotNoteClient(SjHotspotApp& app, const char* id, uint32_t peer, uint32_t session, uint32_t seq,
                                uint8_t state, uint32_t nowS) {
  SjHotspotClient* slot = sjHotspotFindClient(app, id);
  for (int pass = 0; !slot && pass < 3; pass++) {
    for (auto& c : app.clients) {
      bool fits = pass == 0 ? c.state == SJ_HS_NONE : pass == 1 ? c.state == SJ_HS_SENT : true;
      if (fits && (!slot || c.atS < slot->atS)) slot = &c;
      if (fits && pass == 0) break;
    }
  }
  memset(slot, 0, sizeof(*slot));
  strncpy(slot->id, id, SJ_SOS_CLIENT_LEN);
  slot->state = state;
  slot->session = session;
  slot->seq = seq;
  slot->atS = nowS;
  slot->sentAtS = nowS;  // only read in state SENT (a restored or test entry noted as SENT)
  slot->peer = peer;
}

// The next hop has request (session, seq) as of nowS: its phone's page
// says "sent", and the phone's gap starts now.
inline void sjHotspotMarkSent(SjHotspotApp& app, uint32_t session, uint32_t seq, uint32_t nowS) {
  for (auto& c : app.clients) {
    if (c.state == SJ_HS_STORED && c.session == session && c.seq == seq) {
      c.state = SJ_HS_SENT;
      c.sentAtS = nowS;
    }
  }
}

// ---- the outbox: SOS messages until the next hop has them -----------------------
struct SjSosMsgQueued {
  SjSosMsg msg;     // age_s: as received (0 for one typed here)
  uint32_t rxAtS;   // seconds since boot when it was stored
  uint32_t bootId;  // which boot rxAtS belongs to (node: session; gateway: its boot counter)
  uint8_t local;    // typed on THIS device's hotspot (its phone's status page waits for it)
  uint8_t reserved[3];
};

template <uint8_t N>
struct SjSosMsgOutbox {
  SjSosMsgQueued items[N];
  uint8_t count;  // no initialisers: a plain aggregate, zero as a static
};

inline bool sjSosMsgSame(const SjSosMsg& a, const SjSosMsg& b) {
  return a.session == b.session && a.seq == b.seq && strncmp(a.node_id, b.node_id, SJ_NODE_ID_LEN) == 0;
}

// 1 = added, 0 = already there (a resend), -1 = full. Never evicts: every
// entry is a person asking for help - a full outbox refuses the new one
// (the page says "try again"; a node gets no ACK and resends later).
template <uint8_t N>
inline int sjSosMsgOutboxAdd(SjSosMsgOutbox<N>& o, const SjSosMsgQueued& e) {
  if (o.count > N) o.count = 0;  // never trust a corrupted count
  for (uint8_t i = 0; i < o.count; i++)
    if (sjSosMsgSame(o.items[i].msg, e.msg)) return 0;
  if (o.count >= N) return -1;
  o.items[o.count++] = e;
  return 1;
}

// By identity: another task may add while the front one is being sent.
template <uint8_t N>
inline bool sjSosMsgOutboxRemove(SjSosMsgOutbox<N>& o, const SjSosMsg& m) {
  for (uint8_t i = 0; i < o.count && i < N; i++) {
    if (!sjSosMsgSame(o.items[i].msg, m)) continue;
    for (uint8_t j = i + 1; j < o.count; j++) o.items[j - 1] = o.items[j];
    o.count--;
    return true;
  }
  return false;
}

// From the NVS copy at boot: only entries that are still valid messages (a
// copy from another firmware layout or a damaged one restores nothing
// rather than an SOS nobody sent). Returns how many came back.
template <uint8_t N>
inline uint8_t sjSosMsgOutboxRestore(SjSosMsgOutbox<N>& o, const SjSosMsgOutbox<N>& saved) {
  o.count = 0;
  if (saved.count > N) return 0;
  uint8_t n = 0;
  for (uint8_t i = 0; i < saved.count; i++) {
    if (!sjSosMsgValid(saved.items[i].msg) || saved.items[i].local > 1) continue;
    if (sjSosMsgOutboxAdd(o, saved.items[i]) == 1) n++;
  }
  return n;
}

// Seconds since the person sent `e`, as of nowS on boot `bootId`; -1 =
// unknown (stored before a reboot, or the node did not know).
inline long sjSosMsgAge(const SjSosMsgQueued& e, uint32_t nowS, uint32_t bootId) {
  if (e.msg.age_s == SJ_AGE_UNKNOWN || e.bootId != bootId || nowS < e.rxAtS) return -1;
  return (long)e.msg.age_s + (long)(nowS - e.rxAtS);
}

// ---- pages ---------------------------------------------------------------------
inline void sjHtmlAppend(String& out, const char* s) {
  for (; *s; s++) {
    switch (*s) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += *s;
    }
  }
}

// One full HTTP response. The CSP is a second line of defence: even if
// something slipped through the escaping, no script runs and nothing loads.
inline void sjHttpRespond(String& out, int code, const char* status, const String& body, const char* clientCookie) {
  out = "HTTP/1.1 ";
  out += String(code);
  out += " ";
  out += status;
  out += "\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
         "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'\r\n"
         "Connection: close\r\nContent-Length: ";
  out += String((unsigned long)body.length());
  out += "\r\n";
  if (clientCookie && clientCookie[0]) {
    out += "Set-Cookie: sjc=";
    out += clientCookie;
    out += "; Path=/; Max-Age=86400; SameSite=Lax\r\n";
  }
  out += "\r\n";
  out += body;
}

inline void sjHttpRedirect(String& out, const char* apIp) {
  out = "HTTP/1.1 302 Found\r\nLocation: http://";
  out += apIp;
  out += "/\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
}

// The shared head: no external file, no script. `refreshTo` = reload there
// after 15 s (the status page while it waits).
inline void sjPageStart(String& b, const char* refreshTo) {
  b = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">";
  if (refreshTo) {
    b += "<meta http-equiv=\"refresh\" content=\"15;url=";
    sjHtmlAppend(b, refreshTo);
    b += "\">";
  }
  b += "<title>SOS</title><style>"
       "body{font:17px/1.4 sans-serif;margin:0 auto;max-width:34em;padding:12px 16px;background:#fff;color:#111}"
       "h1{color:#b00;margin:.2em 0}label,fieldset{display:block;margin:12px 0}"
       "input,textarea,button{font:inherit;box-sizing:border-box;width:100%;padding:8px}"
       "input[type=checkbox]{width:auto;transform:scale(1.4);margin:0 10px 0 4px}"
       "fieldset label{margin:8px 0}button{background:#b00;color:#fff;border:0;padding:14px;font-weight:bold}"
       ".s{font-size:15px;color:#444}.b{padding:12px;border-radius:6px;margin:12px 0;font-weight:bold}"
       ".ok{background:#e3f4e3}.wait{background:#fff4d6}.no{background:#fde2e2}"
       "</style></head><body><h1>SOS</h1>";
}

// One message in both languages. HINDI: needs native-speaker review.
inline void sjPageBox(String& b, const char* cls, const char* en, const char* hi) {
  b += "<div class=\"b ";
  b += cls;
  b += "\">";
  b += en;
  b += "<br><span lang=\"hi\">";
  b += hi;
  b += "</span></div>";
}

inline void sjPageEnd(String& b) {
  b += "<p class=\"s\">If you can make a phone call, also call 112. / <span lang=\"hi\">अगर फ़ोन कर सकते हैं, तो 112 "
       "पर भी कॉल करें।</span></p></body></html>";
}

// The form. Labels in English and Hindi together: no language switch to
// look for under stress. HINDI: needs native-speaker review.
inline void sjHotspotFormPage(String& b, const char* clientId) {
  sjPageStart(b, nullptr);
  b += "<p>Emergency help without internet: your request goes by radio to the control room.<br><span lang=\"hi\">"
       "बिना इंटरनेट आपातकालीन मदद: आपका अनुरोध रेडियो से नियंत्रण कक्ष तक जाता है।</span></p>"
       "<form method=\"post\" action=\"/sos\"><input type=\"hidden\" name=\"c\" value=\"";
  sjHtmlAppend(b, clientId);
  b += "\"><label>How many people need help? / <span lang=\"hi\">कितने लोगों को मदद चाहिए?</span>"
       "<input name=\"p\" type=\"number\" min=\"1\" max=\"999\" inputmode=\"numeric\"></label>"
       "<fieldset><legend>What is happening? / <span lang=\"hi\">क्या हो रहा है?</span></legend>"
       "<label><input type=\"checkbox\" name=\"n\" value=\"trapped\">Trapped / <span lang=\"hi\">फँसे हुए</span></label>"
       "<label><input type=\"checkbox\" name=\"n\" value=\"injured\">Injured / <span lang=\"hi\">घायल</span></label>"
       "<label><input type=\"checkbox\" name=\"n\" value=\"medical\">Medical help / <span lang=\"hi\">चिकित्सा सहायता"
       "</span></label>"
       "<label><input type=\"checkbox\" name=\"n\" value=\"fire\">Fire / <span lang=\"hi\">आग</span></label></fieldset>"
       "<label>Where exactly are you? Landmark, house, floor - short / <span lang=\"hi\">आप ठीक कहाँ हैं? निशानी, घर, "
       "मंज़िल - छोटा</span><textarea name=\"t\" maxlength=\"100\" rows=\"3\"></textarea></label>"
       "<p class=\"s\">Your position: we send the position of this SOS point - you are within its Wi-Fi range. If you "
       "know your exact coordinates (e.g. from a map app), type them. / <span lang=\"hi\">आपकी जगह: हम इस SOS पॉइंट की "
       "जगह भेजते हैं - आप इसके वाई-फ़ाई दायरे में हैं। अगर आपको अपने सटीक निर्देशांक पता हैं (जैसे मैप ऐप से), तो "
       "लिखें।</span></p>"
       "<label>Latitude / <span lang=\"hi\">अक्षांश</span><input name=\"la\" inputmode=\"decimal\" maxlength=\"16\" "
       "placeholder=\"30.3165\"></label>"
       "<label>Longitude / <span lang=\"hi\">देशांतर</span><input name=\"lo\" inputmode=\"decimal\" maxlength=\"16\" "
       "placeholder=\"78.0322\"></label>"
       "<button>Send SOS / <span lang=\"hi\">SOS भेजें</span></button></form>";
  sjPageEnd(b);
}

enum SjHsNotice : uint8_t {
  SJ_HS_NOTICE_NONE = 0,
  SJ_HS_NOTICE_PENDING,   // they sent again while their request still waits
  SJ_HS_NOTICE_TOO_SOON,  // they sent again just after theirs went out
};

// How the phone's request is doing. `form`: what was just submitted (its
// words are echoed, escaped), nullptr on a later look. Refreshes itself
// every 15 s while it waits.
inline void sjHotspotStatusPage(String& b, const SjHotspotSite& site, const SjHotspotClient& c, uint8_t notice,
                                const SjHotspotForm* form) {
  String refresh;
  if (c.state == SJ_HS_STORED) {
    refresh = "/s?c=";
    refresh += c.id;
  }
  sjPageStart(b, c.state == SJ_HS_STORED ? refresh.c_str() : nullptr);
  if (notice == SJ_HS_NOTICE_PENDING) {
    sjPageBox(b, "wait", "Your earlier request is still waiting to be sent - it is not lost.",
              "आपका पिछला अनुरोध अभी भेजे जाने की प्रतीक्षा में है - वह खोया नहीं है।");
  } else if (notice == SJ_HS_NOTICE_TOO_SOON) {
    sjPageBox(b, "wait", "Your request was already sent. You can send another one in a few minutes.",
              "आपका अनुरोध पहले ही भेजा जा चुका है। कुछ मिनट बाद आप एक और भेज सकते हैं।");
  }
  if (c.state == SJ_HS_STORED) {
    sjPageBox(b, "wait",
              "SAVED on this device. It is sent as soon as the link to the control room works - you do not need to "
              "send it again. This page updates by itself.",
              "इस उपकरण पर सहेजा गया। संपर्क मिलते ही यह भेज दिया जाएगा - दोबारा भेजने की ज़रूरत नहीं है। यह पेज "
              "अपने-आप अपडेट होता है।");
  } else if (site.nextHopIsServer) {
    sjPageBox(b, "ok", "SENT: the control room has your request.",
              "भेज दिया गया: नियंत्रण कक्ष को आपका अनुरोध मिल गया है।");
  } else {
    sjPageBox(b, "ok", "SENT to the gateway, which passes it on to the control room.",
              "गेटवे को भेज दिया गया, वह इसे नियंत्रण कक्ष तक पहुँचाता है।");
  }
  if (form) {
    if (form->noteLen) {
      b += "<p>Your words / <span lang=\"hi\">आपके शब्द</span>: <q>";
      sjHtmlAppend(b, form->note);
      b += "</q></p>";
    }
    if (form->noteCut) {
      b += "<p class=\"s\">Your description was shortened. / <span lang=\"hi\">आपका विवरण छोटा कर दिया गया।</span></p>";
    }
    if (form->posIgnored) {
      b += "<p class=\"s\">The coordinates could not be read - the position of this SOS point is used. / <span "
           "lang=\"hi\">निर्देशांक पढ़े नहीं जा सके - इस SOS पॉइंट की जगह भेजी गई है।</span></p>";
    }
  }
  b += "<p class=\"s\">Request / <span lang=\"hi\">अनुरोध</span> ";
  b += String((unsigned long)c.seq);
  b += " &middot; <a href=\"/?n=1\">New request / <span lang=\"hi\">नया अनुरोध</span></a></p>";
  sjPageEnd(b);
}

// Refused for now: too many requests on this access point, or the outbox is full.
inline void sjHotspotBusyPage(String& b, bool outboxFull) {
  sjPageStart(b, nullptr);
  if (outboxFull) {
    sjPageBox(b, "no", "This SOS point cannot store more requests right now. Try again in a minute.",
              "यह SOS पॉइंट अभी और अनुरोध नहीं रख सकता। एक मिनट बाद फिर कोशिश करें।");
  } else {
    sjPageBox(b, "no", "Too many requests on this SOS point right now. Wait a few minutes and try again.",
              "इस SOS पॉइंट पर अभी बहुत अनुरोध हैं। कुछ मिनट रुककर फिर कोशिश करें।");
  }
  b += "<p><a href=\"/\">Back / <span lang=\"hi\">वापस</span></a></p>";
  sjPageEnd(b);
}

// ---- one request -----------------------------------------------------------------
enum SjHsOutcome : uint8_t {
  SJ_HS_OUT_PAGE = 0,      // form / status / captive-portal redirect
  SJ_HS_OUT_STORED,        // a new SOS is in the outbox
  SJ_HS_OUT_PENDING,       // not stored: this phone's earlier request still waits
  SJ_HS_OUT_TOO_SOON,      // not stored: this phone's request went out moments ago
  SJ_HS_OUT_RATE_LIMITED,  // refused: maxPerWindow reached on this access point
  SJ_HS_OUT_FULL,          // refused: the outbox is full (store() returned false)
  SJ_HS_OUT_INVALID,       // refused: the SOS failed sjSosMsgValid() - a config error (the site's node id)
};

// Builds the complete HTTP response for `req` in `out`. `freshId`: a new
// random client id (sjHotspotNewClientId) for a phone without one.
// `store(SjSosMsg&)` puts a new SOS in the outbox (and its NVS copy) and
// returns false if it could not - the page says "saved" only after that.
// On the gateway the caller holds the lock that guards the app and the outbox.
template <typename StoreFn>
inline SjHsOutcome sjHotspotHandle(SjHotspotApp& app, const SjHotspotSite& site, const SjHotspotLimits& lim,
                                   const SjHttpReq& req, uint32_t nowS, const char* freshId, StoreFn store,
                                   String& out) {
  String body;
  SjHsRoute route = sjHotspotRoute(req, site.apIp);
  if (route == SJ_HS_ROUTE_PORTAL) {
    sjHttpRedirect(out, site.apIp);
    return SJ_HS_OUT_PAGE;
  }
  char id[SJ_SOS_CLIENT_LEN + 1];
  char raw[24];
  bool full;
  if (route == SJ_HS_ROUTE_FORM || route == SJ_HS_ROUTE_STATUS) {
    bool wantNew = route == SJ_HS_ROUTE_FORM && sjFormGet(req.query, strlen(req.query), "n", raw, sizeof(raw), full);
    id[0] = '\0';
    if (route == SJ_HS_ROUTE_STATUS && sjFormGet(req.query, strlen(req.query), "c", raw, sizeof(raw), full))
      sjCleanClientId(raw, id);
    if (!id[0]) strcpy(id, req.cookieClient);
    SjHotspotClient* c = wantNew ? nullptr : sjHotspotFindClient(app, id);
    if (c) {
      sjHotspotStatusPage(body, site, *c, SJ_HS_NOTICE_NONE, nullptr);
    } else {
      if (!id[0]) sjCleanClientId(freshId, id);
      sjHotspotFormPage(body, id);
    }
    sjHttpRespond(out, 200, "OK", body, id);
    return SJ_HS_OUT_PAGE;
  }

  // a new SOS
  SjHotspotForm f;
  sjHotspotParseForm(req.body ? req.body : "", req.body ? req.bodyLen : 0, f);
  strcpy(id, f.client[0] ? f.client : req.cookieClient);
  if (!id[0]) sjCleanClientId(freshId, id);
  // The same phone: by its id, or by its Wi-Fi address under any id. The
  // page shown is that request's (the id goes back to the phone with it).
  SjHotspotClient* c = sjHotspotFindClient(app, id);
  SjHotspotClient* byPeer = sjHotspotFindPeer(app, req.peer, nowS, lim);
  SjHotspotClient* waiting = c && c->state == SJ_HS_STORED ? c
                             : byPeer && byPeer->state == SJ_HS_STORED ? byPeer
                                                                        : nullptr;
  if (waiting) {
    sjHotspotStatusPage(body, site, *waiting, SJ_HS_NOTICE_PENDING, nullptr);
    sjHttpRespond(out, 200, "OK", body, waiting->id);
    return SJ_HS_OUT_PENDING;
  }
  SjHotspotClient* recent = c && c->state == SJ_HS_SENT && nowS - c->sentAtS < lim.clientGapS ? c : byPeer;
  if (recent) {
    sjHotspotStatusPage(body, site, *recent, SJ_HS_NOTICE_TOO_SOON, nullptr);
    sjHttpRespond(out, 200, "OK", body, recent->id);
    return SJ_HS_OUT_TOO_SOON;
  }
  if (!sjHotspotRateAllow(app, nowS, lim)) {
    sjHotspotBusyPage(body, false);
    sjHttpRespond(out, 429, "Too Many Requests", body, id);
    return SJ_HS_OUT_RATE_LIMITED;
  }
  SjSosMsg m;
  memset(&m, 0, sizeof(m));
  m.magic = SJ_MAGIC;
  m.version = SJ_VERSION;
  m.type = SJ_TYPE_SOS_MSG;
  strncpy(m.node_id, site.nodeId, SJ_NODE_ID_LEN);
  m.session = site.session;
  m.seq = app.seq + 1;
  m.age_s = 0;
  m.people = f.people;
  m.needs = f.needs;
  if (f.hasPos) {
    m.flags |= SJ_SOS_MSG_HAS_POS;
    m.lat_e6 = f.lat_e6;
    m.lon_e6 = f.lon_e6;
  }
  memcpy(m.client_id, id, strlen(id));
  m.note_len = f.noteLen;
  memcpy(m.note, f.note, f.noteLen);
  bool valid = sjSosMsgValid(m);
  if (!valid || !store(m)) {
    sjHotspotBusyPage(body, true);
    sjHttpRespond(out, 503, "Service Unavailable", body, id);
    return valid ? SJ_HS_OUT_FULL : SJ_HS_OUT_INVALID;
  }
  app.seq = m.seq;
  sjHotspotNoteClient(app, id, req.peer, m.session, m.seq, SJ_HS_STORED, nowS);
  sjHotspotStatusPage(body, site, *sjHotspotFindClient(app, id), SJ_HS_NOTICE_NONE, &f);
  sjHttpRespond(out, 200, "OK", body, id);
  return SJ_HS_OUT_STORED;
}

// For the sketch's Serial log (nullptr = nothing worth a line).
inline const char* sjHotspotOutcomeText(SjHsOutcome o) {
  switch (o) {
    case SJ_HS_OUT_STORED: return "new SOS request stored";
    case SJ_HS_OUT_PENDING: return "phone sent again while its request still waits - not stored twice";
    case SJ_HS_OUT_TOO_SOON: return "phone sent again right after its request went out - not stored";
    case SJ_HS_OUT_RATE_LIMITED: return "request REFUSED: SOS_HOTSPOT_MAX_PER_WINDOW reached on this access point";
    case SJ_HS_OUT_FULL: return "request REFUSED: the SOS outbox is full (SOS_MSG_SLOTS) - is the link down?";
    case SJ_HS_OUT_INVALID: return "request REFUSED: invalid SOS - check the node / gateway id (letters, digits, - _ .)";
    default: return nullptr;
  }
}

// The next hop refused request (session, seq) for good: forget its phone,
// whose page then offers the form again instead of "saved" for ever.
inline void sjHotspotForget(SjHotspotApp& app, uint32_t session, uint32_t seq) {
  for (auto& c : app.clients)
    if (c.state != SJ_HS_NONE && c.session == session && c.seq == seq) c.state = SJ_HS_NONE;
}

// After a reboot: the phones whose requests came back from NVS still get
// their status page ("saved", then "sent").
template <uint8_t N>
inline void sjHotspotRememberOutbox(SjHotspotApp& app, const SjSosMsgOutbox<N>& o, uint32_t nowS) {
  for (uint8_t i = 0; i < o.count && i < N; i++) {
    if (!o.items[i].local) continue;
    char id[SJ_SOS_CLIENT_LEN + 1];
    sjIdString(id, o.items[i].msg.client_id, SJ_SOS_CLIENT_LEN);
    sjHotspotNoteClient(app, id, 0, o.items[i].msg.session, o.items[i].msg.seq, SJ_HS_STORED, nowS);  // address unknown
  }
}

#endif  // SJ_HOTSPOT_H_

