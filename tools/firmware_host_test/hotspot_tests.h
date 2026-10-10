// Tests for the offline SOS Wi-Fi "SANJEEVNI-SOS": the LoRa SOS-message
// packet and its ACK (SjSosMsg in sj_packet.h), and everything in
// sj_hotspot.h - UTF-8 cleaning / truncation, the /api/ingest/sos JSON,
// form + HTTP parsing, the captive-portal routes, the per-access-point rate
// limit, one waiting request per phone, the outbox and its NVS copy, and
// the pages (escaping, no external resources). Included by
// test_firmware_logic.cpp (uses its CHECK and makeReading). Writes JSON
// samples and pages for run_tests.py's Python checks.
#pragma once
#include <cstdio>
#include <string>
#include <vector>

namespace hotspot {

// Hindi "बाढ़ में फँसे" (flood, trapped) as UTF-8: 3 bytes per letter.
const char* HINDI = "\xE0\xA4\xAC\xE0\xA4\xBE\xE0\xA4\xA2\xE0\xA4\xBC \xE0\xA4\xAE\xE0\xA5\x87\xE0\xA4\x82 "
                    "\xE0\xA4\xAB\xE0\xA4\x81\xE0\xA4\xB8\xE0\xA5\x87";

inline bool validUtf8(const char* s, size_t n) {
  for (size_t i = 0; i < n;) {
    uint32_t cp;
    uint8_t k = sjUtf8Seq((const uint8_t*)s + i, n - i, cp);
    if (!k) return false;
    i += k;
  }
  return true;
}

inline SjSosMsg makeMsg(const char* node, uint32_t session, uint32_t seq, const char* client, const char* note) {
  SjSosMsg m;
  std::memset(&m, 0, sizeof(m));
  m.magic = SJ_MAGIC;
  m.version = SJ_VERSION;
  m.type = SJ_TYPE_SOS_MSG;
  std::strncpy(m.node_id, node, SJ_NODE_ID_LEN);
  m.session = session;
  m.seq = seq;
  std::memcpy(m.client_id, client, std::strlen(client));
  m.note_len = (uint8_t)std::strlen(note);
  std::memcpy(m.note, note, m.note_len);
  return m;
}

// ---- the LoRa packet and its ACK ----------------------------------------------
inline void packetTests() {
  CHECK(sizeof(SjSosMsg) == 148 && SJ_SOS_MSG_HEADER_SIZE == 48);
  CHECK(offsetof(SjSosMsg, note) == SJ_SOS_MSG_HEADER_SIZE && offsetof(SjSosMsg, note_len) == 47);
  CHECK(sizeof(SjSosMsg) <= 255);  // LoRa payload limit

  SjSosMsg m = makeMsg("NODE-07", 3000000003u, 2, "ab12cd34", "near temple");
  m.people = 4;
  m.needs = SJ_NEED_TRAPPED | SJ_NEED_MEDICAL;
  m.flags = SJ_SOS_MSG_HAS_POS;
  m.lat_e6 = 30316500;
  m.lon_e6 = 78032200;
  m.age_s = 77;
  CHECK(sjSosMsgValid(m));
  CHECK(sjSosMsgSize(m) == 48 + 11);
  // variable length on air: only the used note bytes
  SjSosMsg back;
  CHECK(sjParseSosMsg((const uint8_t*)&m, sjSosMsgSize(m), back));
  CHECK(std::memcmp(&back, &m, sjSosMsgSize(m)) == 0 && back.note[11] == 0);
  CHECK(!sjParseSosMsg((const uint8_t*)&m, sjSosMsgSize(m) + 1, back));  // length and note_len disagree
  CHECK(!sjParseSosMsg((const uint8_t*)&m, sjSosMsgSize(m) - 1, back));
  CHECK(!sjParseSosMsg((const uint8_t*)&m, 47, back));
  // a full-length note, and an empty one
  std::string hundred(100, 'x');
  SjSosMsg full = makeMsg("NODE-07", 1, 1, "c", hundred.c_str());
  CHECK(sjSosMsgSize(full) == 148 && sjParseSosMsg((const uint8_t*)&full, 148, back));
  SjSosMsg empty = makeMsg("GW-01", 1, 1, "c", "");
  CHECK(sjSosMsgSize(empty) == 48 && sjParseSosMsg((const uint8_t*)&empty, 48, back) && back.note_len == 0);

  // everything a stranger's radio could put in it is checked
  auto bad = [&](void (*mutate)(SjSosMsg&)) {
    SjSosMsg x = m;
    mutate(x);
    return !sjSosMsgValid(x) && !sjParseSosMsg((const uint8_t*)&x, sjSosMsgSize(x), back);
  };
  CHECK(bad([](SjSosMsg& x) { x.magic = 0; }));
  CHECK(bad([](SjSosMsg& x) { x.version = 1; }));
  CHECK(bad([](SjSosMsg& x) { x.type = SJ_TYPE_READING; }));
  CHECK(bad([](SjSosMsg& x) { x.node_id[2] = '"'; }));             // would break out of the JSON string
  CHECK(bad([](SjSosMsg& x) { x.node_id[0] = '\0'; }));            // empty id
  CHECK(bad([](SjSosMsg& x) { x.node_id[9] = 'Z'; }));             // garbage after the NUL
  CHECK(bad([](SjSosMsg& x) { x.client_id[1] = '.'; }));           // client ids: no '.'
  CHECK(bad([](SjSosMsg& x) { std::memset(x.client_id, 0, 8); }));
  CHECK(bad([](SjSosMsg& x) { x.people = 1000; }));
  CHECK(bad([](SjSosMsg& x) { x.needs = 0x10; }));
  CHECK(bad([](SjSosMsg& x) { x.flags = 0x02; }));
  CHECK(bad([](SjSosMsg& x) { x.lat_e6 = 90000001; }));
  CHECK(bad([](SjSosMsg& x) { x.lon_e6 = -180000001; }));
  CHECK(bad([](SjSosMsg& x) { x.note_len = 101; }));
  {  // out-of-range coordinates without HAS_POS are not used, so not an error
    SjSosMsg x = m;
    x.flags = 0;
    x.lat_e6 = 999999999;
    CHECK(sjSosMsgValid(x));
  }
  // 12-char node id (no NUL in the field) and dots are fine
  SjSosMsg twelve = makeMsg("NODE.INDB-12", 1, 1, "Ab_-9", "");
  CHECK(sjSosMsgValid(twelve));

  // ACK: its own type, so it never answers a reading with the same numbers
  SjAck ack = sjMakeSosMsgAck(m);
  CHECK(ack.type == SJ_TYPE_SOS_MSG_ACK && sizeof(ack) == 23);
  CHECK(sjSosMsgAckMatches((const uint8_t*)&ack, sizeof(ack), m));
  SjReading sameNumbers = makeReading("NODE-07", 3000000003u, 2);
  CHECK(!sjAckMatches((const uint8_t*)&ack, sizeof(ack), sameNumbers));
  SjDownlink d;
  CHECK(!sjParseAck((const uint8_t*)&ack, sizeof(ack), sameNumbers, d, nullptr));
  SjAck readingAck = sjMakeAck(sameNumbers);
  CHECK(!sjSosMsgAckMatches((const uint8_t*)&readingAck, sizeof(readingAck), m));
  SjSosMsg next = m;
  next.seq = 3;
  CHECK(!sjSosMsgAckMatches((const uint8_t*)&ack, sizeof(ack), next));
  CHECK(!sjSosMsgAckMatches((const uint8_t*)&ack, sizeof(ack) + 1, m));
  // a reading is not taken for an SOS message, nor the other way round
  CHECK(!sjParseSosMsg((const uint8_t*)&sameNumbers, sizeof(sameNumbers), back));
  CHECK(!sjIsValidReading((const uint8_t*)&full, sizeof(SjReading)));
}

// ---- UTF-8 cleaning + truncation ----------------------------------------------
inline std::string clean(const std::string& in, size_t max, bool& cut) {
  std::vector<char> b(in.begin(), in.end());
  b.push_back('\0');
  size_t n = sjCleanText(b.data(), in.size(), max, cut);
  CHECK(std::strlen(b.data()) == n);
  return std::string(b.data(), n);
}

inline void utf8Tests() {
  bool cut;
  CHECK(clean("  help   me \r\n\tplease  ", 100, cut) == "help me please" && !cut);
  CHECK(clean("a\x01" "b\x7f" "c", 100, cut) == "a b c");
  CHECK(clean("ok\xC2\x85x", 100, cut) == "ok x");                       // C1 control (NEL)
  CHECK(clean("x\xE2\x80\xAEy\xE2\x81\xA6z", 100, cut) == "x y z");     // bidi overrides
  CHECK(clean("x\xE2\x80\xA8y", 100, cut) == "x y");                     // U+2028
  CHECK(clean("bad\xFF\xC0\xAF", 100, cut) == "bad???");                 // invalid byte + overlong '/'
  CHECK(clean("\xED\xA0\x80z", 100, cut) == "???z");                     // a UTF-16 surrogate in UTF-8
  CHECK(clean("cut\xE0\xA4", 100, cut) == "cut??");                      // a character cut off by the sender
  CHECK(clean("", 100, cut) == "" && !cut);
  CHECK(clean("   ", 100, cut) == "" && !cut);

  // the cap never splits a character: Hindi (3 bytes) into 100 bytes = 33 letters
  std::string hindi;
  for (int i = 0; i < 40; i++) hindi += "\xE0\xA4\x95";  // क x 40 = 120 bytes
  std::string c = clean(hindi, 100, cut);
  CHECK(c.size() == 99 && cut && validUtf8(c.data(), c.size()));
  std::string emoji = std::string(98, 'a') + "\xF0\x9F\x86\x98";  // 98 + a 4-byte character
  c = clean(emoji, 100, cut);
  CHECK(c.size() == 98 && cut);
  c = clean(std::string(99, 'a') + " b", 100, cut);  // the space would be the 100th byte, 'b' does not fit
  CHECK(c.size() == 99 && cut);
  // every cap 0..len: valid UTF-8, within the cap, a prefix of the full text
  std::string mixed = std::string("Flood ") + HINDI + " \xF0\x9F\x86\x98 ok";
  std::string whole = clean(mixed, 1000, cut);
  for (size_t cap = 0; cap <= mixed.size(); cap++) {
    std::string part = clean(mixed, cap, cut);
    CHECK(part.size() <= cap && validUtf8(part.data(), part.size()));
    CHECK(whole.compare(0, part.size(), part) == 0);
    CHECK(cut == (part.size() < whole.size()));
  }
}

// ---- JSON ---------------------------------------------------------------------
inline void jsonTests(std::FILE* jf) {
  String s;
  sjJsonAppendText(s, "a\"b\\c\x01", 6);
  CHECK(std::string(s.c_str()) == "\"a\\\"b\\\\c\\u0001\"");
  s = "";
  sjJsonAppendText(s, HINDI, std::strlen(HINDI));
  CHECK(std::string(s.c_str()).rfind("\"\\u092c\\u093e\\u0922\\u093c \\u092e", 0) == 0);
  for (size_t i = 0; i < s.length(); i++) CHECK((unsigned char)s[i] < 0x80);  // ASCII only
  s = "";
  sjJsonAppendText(s, "\xF0\x9F\x86\x98", 4);  // U+1F198 SOS -> surrogate pair
  CHECK(std::string(s.c_str()) == "\"\\ud83c\\udd98\"");
  s = "";
  sjJsonAppendText(s, "x\xFFy", 3);  // invalid bytes never reach the server raw
  CHECK(std::string(s.c_str()) == "\"x\\ufffdy\"");

  s = "";
  sjAppendE6(s, -12000500);
  sjAppendE6(s, 0);
  sjAppendE6(s, 90000000);
  sjAppendE6(s, -500);
  CHECK(std::string(s.c_str()) == "-12.0005000.00000090.000000-0.000500");

  // the full body: everything given...
  SjSosMsg m = makeMsg("NODE-07", 3000000003u, 2, "ab12cd34", "");
  m.people = 4;
  m.needs = SJ_NEED_TRAPPED | SJ_NEED_INJURED | SJ_NEED_MEDICAL | SJ_NEED_FIRE;
  m.flags = SJ_SOS_MSG_HAS_POS;
  m.lat_e6 = 30316500;
  m.lon_e6 = -78032200;
  std::string note = std::string("Near \"temple\" <b> ") + HINDI;
  m.note_len = (uint8_t)note.size();
  std::memcpy(m.note, note.data(), note.size());
  String all;
  sjAppendSosMsgJson(all, m, 125);
  CHECK(std::strstr(all.c_str(), "\"sos_uid\":\"3000000003-h2\""));
  CHECK(std::strstr(all.c_str(), "\"needs\":[\"trapped\",\"injured\",\"medical\",\"fire\"]"));
  CHECK(std::strstr(all.c_str(), "\"latitude\":30.316500,\"longitude\":-78.032200"));
  CHECK(std::strstr(all.c_str(), "\"age_seconds\":125}"));
  // ...and nothing given: nulls and an empty list, as the contract says
  SjSosMsg bare = makeMsg("GW-01", 7, 1, "zz", "");
  String none;
  sjAppendSosMsgJson(none, bare, -1);
  CHECK(std::string(none.c_str()) ==
        "{\"node_id\":\"GW-01\",\"sos_uid\":\"7-h1\",\"client_id\":\"zz\",\"people\":null,\"needs\":[],\"note\":\"\","
        "\"latitude\":null,\"longitude\":null,\"age_seconds\":null}");
  SjSosMsg twelve = makeMsg("NODE.INDB-12", 4294967295u, 4294967295u, "abcdefgh", "x");
  String t;
  sjAppendSosMsgJson(t, twelve, 0);
  CHECK(std::strstr(t.c_str(), "\"node_id\":\"NODE.INDB-12\",\"sos_uid\":\"4294967295-h4294967295\","
                               "\"client_id\":\"abcdefgh\""));
  // for run_tests.py: json.loads + the contract's keys and types
  std::fprintf(jf, "%s\n%s\n%s\n", all.c_str(), none.c_str(), t.c_str());

  // the SOS endpoint next to the batch one (secrets.h needs no new entry)
  CHECK(std::string(sjSiblingUrl("https://x.ngrok-free.app/api/ingest/batch", "sos").c_str()) ==
        "https://x.ngrok-free.app/api/ingest/sos");
  CHECK(std::string(sjSiblingUrl("/api/ingest/batch", "sos").c_str()) == "/api/ingest/sos");
  CHECK(std::string(sjSiblingUrl("batch", "sos").c_str()) == "/sos");
}

// ---- form + HTTP parsing --------------------------------------------------------
inline SjHotspotForm form(const char* body) {
  SjHotspotForm f;
  sjHotspotParseForm(body, std::strlen(body), f);
  return f;
}

inline void parseTests() {
  char out[32];
  bool full;
  CHECK(sjUrlDecode("a+b%20c%41%zz%4", 15, out, sizeof(out), full) == 11 && !full &&
        std::string(out) == "a b cA%zz%4");
  CHECK(sjUrlDecode("abcdef", 6, out, 4, full) == 3 && full && std::string(out) == "abc");
  CHECK(sjFormGet("x=1&p=12&p=99", 13, "p", out, sizeof(out), full) && std::string(out) == "12");
  CHECK(!sjFormGet("pp=1&xp=2", 9, "p", out, sizeof(out), full) && out[0] == '\0');
  CHECK(sjFormGet("&&p&q=", 6, "p", out, sizeof(out), full) && out[0] == '\0');  // key without '='

  CHECK(sjParsePeople("12") == 12 && sjParsePeople(" 3 ") == 3 && sjParsePeople("999") == 999);
  CHECK(sjParsePeople("") == 0 && sjParsePeople("abc") == 0 && sjParsePeople("-2") == 0 && sjParsePeople("1.5") == 0);
  CHECK(sjParsePeople("1000") == 999 && sjParsePeople("99999999999999999999") == 999);  // capped, no overflow
  CHECK(sjParsePeople("0") == 0);

  int32_t v;
  CHECK(sjParseCoordE6("30.3165", 90, v) && v == 30316500);
  CHECK(sjParseCoordE6(" -78.0322 ", 180, v) && v == -78032200);
  CHECK(sjParseCoordE6("+30", 90, v) && v == 30000000);
  CHECK(sjParseCoordE6("30.12345678", 90, v) && v == 30123456);  // past the 6th decimal: dropped
  CHECK(sjParseCoordE6("90", 90, v) && sjParseCoordE6("-180.0", 180, v) && v == -180000000);
  CHECK(!sjParseCoordE6("90.000001", 90, v) && !sjParseCoordE6("181", 180, v));
  CHECK(!sjParseCoordE6("", 90, v) && !sjParseCoordE6("-", 90, v) && !sjParseCoordE6(".", 90, v));
  CHECK(!sjParseCoordE6("30,31", 90, v) && !sjParseCoordE6("30.3N", 90, v) && !sjParseCoordE6("1e2", 90, v));
  CHECK(!sjParseCoordE6("99999999999999999", 90, v));

  char id[SJ_SOS_CLIENT_LEN + 1];
  sjCleanClientId("ab\"<c>d-e_f9xyz", id);
  CHECK(std::string(id) == "abcd-e_f");
  sjHotspotNewClientId(id, 0x12345678u, 0x9abcdef0u);
  char id2[SJ_SOS_CLIENT_LEN + 1];
  sjHotspotNewClientId(id2, 0x12345678u, 0x9abcdef1u);
  CHECK(std::strlen(id) == 8 && std::strcmp(id, id2) != 0);
  for (char ch : std::string(id)) CHECK(sjIdChar(ch, false));

  // the whole form
  SjHotspotForm f = form("c=ab12cd34&p=4&n=trapped&n=fire&n=bogus&t=Near+%22temple%22%0A2nd+floor&la=30.3165&lo=78.0322");
  CHECK(f.people == 4 && f.needs == (SJ_NEED_TRAPPED | SJ_NEED_FIRE));
  CHECK(std::string(f.note) == "Near \"temple\" 2nd floor" && f.noteLen == 23 && !f.noteCut);
  CHECK(f.hasPos && !f.posIgnored && f.lat_e6 == 30316500 && f.lon_e6 == 78032200);
  CHECK(std::string(f.client) == "ab12cd34");
  // nothing filled in is still an SOS
  f = form("");
  CHECK(f.people == 0 && f.needs == 0 && f.noteLen == 0 && !f.hasPos && !f.posIgnored && f.client[0] == '\0');
  f = form("la=&lo=+");  // empty boxes: not "typed"
  CHECK(!f.hasPos && !f.posIgnored);
  f = form("la=30.3");  // one of the two
  CHECK(!f.hasPos && f.posIgnored && f.lat_e6 == 0);
  f = form("la=95&lo=78");
  CHECK(!f.hasPos && f.posIgnored);
  // a long Hindi note percent-encoded (9 bytes per letter): cut at 100 bytes, valid UTF-8
  std::string body = "t=";
  for (int i = 0; i < 60; i++) body += "%E0%A4%95";
  f = form(body.c_str());
  CHECK(f.noteLen == 99 && f.noteCut && validUtf8(f.note, f.noteLen));
  // percent-encoded garbage is cleaned, never raw
  f = form("t=%FF%00%3Cscript%3E");
  CHECK(std::string(f.note) == "? <script>" && validUtf8(f.note, f.noteLen));
  // a huge field only fills the buffer
  std::string huge = "t=" + std::string(5000, 'a') + "&p=2";
  f = form(huge.c_str());
  CHECK(f.noteLen == 100 && f.noteCut && f.people == 2);

  // ---- HTTP head ----
  SjHttpReq r;
  const char* head =
      "POST /sos?x=1 HTTP/1.1\r\nHost: 192.168.4.1:80\r\ncontent-LENGTH: 42\r\n"
      "Cookie: theme=dark; xsjc=evil; sjc=ab12cd34\r\nUser-Agent: test\r\n\r\n";
  CHECK(sjHttpParseHead(head, std::strlen(head), r));
  CHECK(std::string(r.method) == "POST" && std::string(r.path) == "/sos" && std::string(r.query) == "x=1");
  CHECK(std::string(r.host) == "192.168.4.1" && r.contentLength == 42 && std::string(r.cookieClient) == "ab12cd34");
  const char* lf = "GET /generate_204 HTTP/1.1\nHost: connectivitycheck.gstatic.com\n\n";
  CHECK(sjHttpParseHead(lf, std::strlen(lf), r) && std::string(r.host) == "connectivitycheck.gstatic.com" &&
        r.contentLength == -1 && r.cookieClient[0] == '\0');
  const char* badLen = "POST /sos HTTP/1.1\r\nContent-Length: 12x\r\n\r\n";
  CHECK(sjHttpParseHead(badLen, std::strlen(badLen), r) && r.contentLength == -2);
  const char* hugeLen = "POST /sos HTTP/1.1\r\nContent-Length: 99999999999999\r\n\r\n";
  CHECK(sjHttpParseHead(hugeLen, std::strlen(hugeLen), r) && r.contentLength == -2);
  const char* cookie = "GET / HTTP/1.1\r\nCookie: sjc=\"><script>\r\n\r\n";
  CHECK(sjHttpParseHead(cookie, std::strlen(cookie), r) && std::string(r.cookieClient) == "script");
  std::string longPath = "GET /" + std::string(100, 'a') + " HTTP/1.1\r\n\r\n";
  CHECK(sjHttpParseHead(longPath.c_str(), longPath.size(), r) && r.path[0] == '\0');
  for (const char* junk : {"", "\r\n\r\n", "GET\r\n\r\n", "GET / FTP/1.0\r\n\r\n", "GETTTTTTTTTT / HTTP/1.1\r\n\r\n",
                           "GET /\r\n\r\n"}) {
    CHECK(!sjHttpParseHead(junk, std::strlen(junk), r));
  }
}

inline SjHttpReq req(const char* method, const char* path, const char* host, const char* query = "",
                     const char* cookie = "", const char* body = nullptr, uint32_t peer = 0) {
  SjHttpReq r;
  std::memset(&r, 0, sizeof(r));
  std::strcpy(r.method, method);
  std::strcpy(r.path, path);
  std::strcpy(r.host, host);
  std::strcpy(r.query, query);
  std::strcpy(r.cookieClient, cookie);
  r.contentLength = body ? (long)std::strlen(body) : -1;
  r.body = body;
  r.bodyLen = body ? std::strlen(body) : 0;
  r.peer = peer;
  return r;
}

inline void routeTests() {
  const char* ip = "192.168.4.1";
  CHECK(sjHotspotRoute(req("GET", "/", ip), ip) == SJ_HS_ROUTE_FORM);
  CHECK(sjHotspotRoute(req("GET", "/", ""), ip) == SJ_HS_ROUTE_FORM);  // HTTP/1.0 without Host
  CHECK(sjHotspotRoute(req("POST", "/sos", ip), ip) == SJ_HS_ROUTE_SUBMIT);
  CHECK(sjHotspotRoute(req("GET", "/s", ip, "c=ab"), ip) == SJ_HS_ROUTE_STATUS);
  // the phones' connectivity probes -> the portal
  CHECK(sjHotspotRoute(req("GET", "/generate_204", "connectivitycheck.gstatic.com"), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("GET", "/hotspot-detect.html", "captive.apple.com"), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("GET", "/connecttest.txt", "www.msftconnecttest.com"), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("GET", "/", "example.com"), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("POST", "/sos", "evil.example"), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("GET", "/sos", ip), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("POST", "/", ip), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("GET", "/favicon.ico", ip), ip) == SJ_HS_ROUTE_PORTAL);
  CHECK(sjHotspotRoute(req("GET", "", ip), ip) == SJ_HS_ROUTE_PORTAL);  // path too long
  String out;
  sjHttpRedirect(out, ip);
  CHECK(std::strstr(out.c_str(), "302 Found\r\nLocation: http://192.168.4.1/\r\n"));
}

// ---- rate limit + one request per phone + the whole request ------------------------
struct Store {
  std::vector<SjSosMsg> got;
  bool accept = true;
};
inline Store g_store;
inline bool storeFn(SjSosMsg& m) {
  if (!g_store.accept) return false;
  g_store.got.push_back(m);
  return true;
}

inline std::string bodyOf(const String& resp) {
  const char* p = std::strstr(resp.c_str(), "\r\n\r\n");
  return p ? std::string(p + 4) : std::string();
}

inline bool lengthHeaderRight(const String& resp) {
  const char* cl = std::strstr(resp.c_str(), "Content-Length: ");
  return cl && std::strtoul(cl + 16, nullptr, 10) == bodyOf(resp).size();
}

inline void rateTests() {
  SjHotspotApp app;
  sjHotspotBegin(app);
  const SjHotspotLimits lim = {3, 600, 120};
  CHECK(sjHotspotRateAllow(app, 100, lim) && sjHotspotRateAllow(app, 101, lim) && sjHotspotRateAllow(app, 102, lim));
  CHECK(!sjHotspotRateAllow(app, 103, lim) && !sjHotspotRateAllow(app, 699, lim));
  CHECK(sjHotspotRateAllow(app, 700, lim));   // the first one left the window
  CHECK(!sjHotspotRateAllow(app, 700, lim));  // the second (101) is still in it
  CHECK(sjHotspotRateAllow(app, 701, lim) && sjHotspotRateAllow(app, 702, lim) && !sjHotspotRateAllow(app, 703, lim));
  // refused requests are not counted: a flood does not push the window on
  SjHotspotApp a2;
  sjHotspotBegin(a2);
  const SjHotspotLimits one = {1, 600, 0};
  CHECK(sjHotspotRateAllow(a2, 0, one));
  for (uint32_t t = 1; t < 600; t += 7) CHECK(!sjHotspotRateAllow(a2, t, one));
  CHECK(sjHotspotRateAllow(a2, 600, one));
  // a larger setting than the ring is clamped, 0 refuses
  SjHotspotApp a3;
  sjHotspotBegin(a3);
  const SjHotspotLimits big = {200, 600, 0};
  int allowed = 0;
  for (int i = 0; i < 100; i++) allowed += sjHotspotRateAllow(a3, 5, big);
  CHECK(allowed == SJ_HS_RATE_SLOTS);
  const SjHotspotLimits zero = {0, 600, 0};
  CHECK(!sjHotspotRateAllow(a3, 10000, zero));
}

inline void handleTests(const std::string& dir) {
  const char* ip = "192.168.4.1";
  SjHotspotApp app;
  sjHotspotBegin(app);
  SjHotspotSite gw = {"GW-01", 0xA1B2C3D4u, ip, true};
  SjHotspotSite node = {"NODE-07", 77, ip, false};
  const SjHotspotLimits lim = {3, 600, 120};
  g_store = Store();
  String out;

  // GET / : the form, with a client id in it and in a cookie
  CHECK(sjHotspotHandle(app, gw, lim, req("GET", "/", ip), 1000, "fresh001", storeFn, out) == SJ_HS_OUT_PAGE);
  std::string page = bodyOf(out);
  CHECK(std::strstr(out.c_str(), "HTTP/1.1 200 OK\r\n") == out.c_str() && lengthHeaderRight(out));
  CHECK(std::strstr(out.c_str(), "Set-Cookie: sjc=fresh001;"));
  CHECK(std::strstr(out.c_str(), "Content-Security-Policy: default-src 'none'"));
  CHECK(page.find("name=\"c\" value=\"fresh001\"") != std::string::npos);
  CHECK(page.find("action=\"/sos\"") != std::string::npos && page.find("maxlength=\"100\"") != std::string::npos);
  // self-contained: nothing loaded from anywhere, no script
  CHECK(page.find("http") == std::string::npos && page.find("src=") == std::string::npos &&
        page.find("<script") == std::string::npos && page.find("<link") == std::string::npos);
  CHECK(validUtf8(page.data(), page.size()) && page.find("lang=\"hi\"") != std::string::npos);
  CHECK(page.size() < 6000);  // tiny: it goes out on a weak link
  std::FILE* pf = std::fopen((dir + "/hotspot_form.html").c_str(), "wb");
  if (pf) {
    std::fwrite(page.data(), 1, page.size(), pf);
    std::fclose(pf);
  }
  // a phone with our cookie keeps its id
  sjHotspotHandle(app, gw, lim, req("GET", "/", ip, "", "keep0001"), 1000, "fresh002", storeFn, out);
  CHECK(bodyOf(out).find("value=\"keep0001\"") != std::string::npos);

  // POST: stored, the page says so and echoes the words ESCAPED
  const char* body1 = "c=phone001&p=3&n=trapped&n=injured&t=%3Cscript%3Ealert(1)%3C%2Fscript%3E+%22hi%22&la=30.5";
  SjHsOutcome o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", body1), 1010, "fresh003", storeFn, out);
  CHECK(o == SJ_HS_OUT_STORED && g_store.got.size() == 1);
  const SjSosMsg& m1 = g_store.got[0];
  CHECK(sjSosMsgValid(m1) && std::strncmp(m1.node_id, "GW-01", 12) == 0 && m1.session == 0xA1B2C3D4u && m1.seq == 1);
  CHECK(m1.people == 3 && m1.needs == (SJ_NEED_TRAPPED | SJ_NEED_INJURED) && !(m1.flags & SJ_SOS_MSG_HAS_POS));
  CHECK(std::strncmp(m1.client_id, "phone001", 8) == 0 && m1.age_s == 0);
  CHECK(std::string(m1.note, m1.note_len) == "<script>alert(1)</script> \"hi\"");
  page = bodyOf(out);
  CHECK(lengthHeaderRight(out) && std::strstr(out.c_str(), "Set-Cookie: sjc=phone001;"));
  CHECK(page.find("<script") == std::string::npos);
  CHECK(page.find("&lt;script&gt;alert(1)&lt;/script&gt; &quot;hi&quot;") != std::string::npos);
  CHECK(page.find("SAVED") != std::string::npos && page.find("url=/s?c=phone001") != std::string::npos);
  CHECK(page.find("coordinates could not be read") != std::string::npos);  // only la was typed
  CHECK(app.seq == 1);
  std::FILE* sf = std::fopen((dir + "/hotspot_status.html").c_str(), "wb");
  if (sf) {
    std::fwrite(page.data(), 1, page.size(), sf);
    std::fclose(sf);
  }

  // the same phone again while it waits: not stored twice (cookie or form id)
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "phone001", "p=9"), 1020, "fresh004", storeFn, out);
  CHECK(o == SJ_HS_OUT_PENDING && g_store.got.size() == 1 && bodyOf(out).find("still waiting") != std::string::npos);
  // its status page, before and after the next hop took it
  sjHotspotHandle(app, gw, lim, req("GET", "/s", ip, "c=phone001"), 1030, "fresh005", storeFn, out);
  CHECK(bodyOf(out).find("SAVED") != std::string::npos && bodyOf(out).find("refresh") != std::string::npos);
  sjHotspotMarkSent(app, 0xA1B2C3D4u, 1, 1035);  // the gap runs from here, not from 1010
  sjHotspotHandle(app, gw, lim, req("GET", "/s", ip, "c=phone001"), 1040, "fresh006", storeFn, out);
  CHECK(bodyOf(out).find("the control room has your request") != std::string::npos &&
        bodyOf(out).find("refresh") == std::string::npos);
  sjHotspotHandle(app, node, lim, req("GET", "/", ip, "", "phone001"), 1040, "fresh007", storeFn, out);
  CHECK(bodyOf(out).find("SENT to the gateway") != std::string::npos);  // a node's wording
  // "new request" link shows the form even though the phone is known
  sjHotspotHandle(app, gw, lim, req("GET", "/", ip, "n=1", "phone001"), 1040, "fresh008", storeFn, out);
  CHECK(bodyOf(out).find("<form") != std::string::npos && bodyOf(out).find("value=\"phone001\"") != std::string::npos);
  // sent, but within the gap (120 s from SENDING at 1035, not from submitting at 1010): not stored
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=phone001"), 1154, "fresh009", storeFn, out);
  CHECK(o == SJ_HS_OUT_TOO_SOON && g_store.got.size() == 1);
  // after the gap: a second request, seq 2
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=phone001&la=30.3&lo=78.1"), 1155, "x",
                      storeFn, out);
  CHECK(o == SJ_HS_OUT_STORED && g_store.got.size() == 2 && g_store.got[1].seq == 2);
  CHECK((g_store.got[1].flags & SJ_SOS_MSG_HAS_POS) && g_store.got[1].lat_e6 == 30300000);
  // a phone with no id at all gets the fresh one
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", ""), 1156, "fresh010", storeFn, out);
  CHECK(o == SJ_HS_OUT_STORED && std::strncmp(g_store.got[2].client_id, "fresh010", 8) == 0);
  CHECK(std::strstr(out.c_str(), "Set-Cookie: sjc=fresh010;"));
  // the access point's limit (3 per 600 s): the 4th is refused, nothing stored
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=other001"), 1157, "y", storeFn, out);
  CHECK(o == SJ_HS_OUT_RATE_LIMITED && g_store.got.size() == 3 && std::strstr(out.c_str(), "HTTP/1.1 429 "));
  CHECK(lengthHeaderRight(out) && bodyOf(out).find("Too many requests") != std::string::npos);
  // a full outbox: 503, the seq is not used up, the phone is not marked waiting
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=other002"), 1700, "z", [](SjSosMsg&) {
    return false;
  }, out);
  CHECK(o == SJ_HS_OUT_FULL && std::strstr(out.c_str(), "HTTP/1.1 503 ") && app.seq == 3);
  CHECK(sjHotspotFindClient(app, "other002") == nullptr);
  // an invalid site id never produces a message (it would be refused or worse)
  SjHotspotSite badSite = {"GW \"01", 1, ip, true};
  SjHotspotApp fresh;
  sjHotspotBegin(fresh);
  o = sjHotspotHandle(fresh, badSite, lim, req("POST", "/sos", ip, "", "", "c=other003"), 1701, "z", storeFn, out);
  CHECK(o == SJ_HS_OUT_INVALID && g_store.got.size() == 3);
  // the captive portal answers foreign hosts with a redirect, POSTs included
  o = sjHotspotHandle(app, gw, lim, req("POST", "/sos", "evil.example", "", "", "c=x"), 1702, "z", storeFn, out);
  CHECK(o == SJ_HS_OUT_PAGE && std::strstr(out.c_str(), "302 Found") && g_store.got.size() == 3);
  // the outcome texts exist for every refusal
  for (SjHsOutcome x : {SJ_HS_OUT_STORED, SJ_HS_OUT_PENDING, SJ_HS_OUT_TOO_SOON, SJ_HS_OUT_RATE_LIMITED,
                        SJ_HS_OUT_FULL, SJ_HS_OUT_INVALID})
    CHECK(sjHotspotOutcomeText(x) != nullptr);
  CHECK(sjHotspotOutcomeText(SJ_HS_OUT_PAGE) == nullptr);

  // refused for good by the server: the phone is forgotten (form again, not "saved" for ever)
  sjHotspotForget(app, 0xA1B2C3D4u, 3);
  sjHotspotHandle(app, gw, lim, req("GET", "/", ip, "", "fresh010"), 1703, "q", storeFn, out);
  CHECK(bodyOf(out).find("<form") != std::string::npos);

  // the client table: full of waiting phones, a new one still gets in
  SjHotspotApp t;
  sjHotspotBegin(t);
  for (uint32_t i = 0; i < SJ_HS_CLIENTS; i++) {
    char cid[9];
    std::snprintf(cid, sizeof(cid), "p%07u", (unsigned)i);
    sjHotspotNoteClient(t, cid, 0, 1, i + 1, i % 2 ? SJ_HS_SENT : SJ_HS_STORED, 100 + i);
  }
  sjHotspotNoteClient(t, "newcomer", 0, 1, 99, SJ_HS_STORED, 500);
  CHECK(sjHotspotFindClient(t, "newcomer") && !sjHotspotFindClient(t, "p0000001"));  // the oldest SENT went
  CHECK(sjHotspotFindClient(t, "p0000000"));  // waiting ones are kept
  CHECK(sjHotspotFindClient(t, "") == nullptr);
}

// ---- review: one phone, a fresh id in every POST ------------------------------
// The id comes from the phone (form field "c" before the cookie), so a new
// or empty one each time counted as a new phone: one person used up the
// access point's window and everyone else got "Too many requests". The
// phone's Wi-Fi address now ties its requests together.
inline void peerTests() {
  const char* ip = "192.168.4.1";
  SjHotspotSite gw = {"GW-01", 7, ip, true};
  const SjHotspotLimits lim = {SOS_HOTSPOT_MAX_PER_WINDOW, SOS_HOTSPOT_WINDOW_S, SOS_HOTSPOT_CLIENT_GAP_S};
  const uint32_t ABUSER = 0xC0A80402u, OTHER = 0xC0A80403u;  // 192.168.4.2 / .3
  SjHotspotApp app;
  sjHotspotBegin(app);
  g_store = Store();
  String out;
  char cbody[32];
  // the abuser: 200 POSTs in 10 minutes, each with a new id (or none)
  int stored = 0;
  for (int i = 0; i < 200; i++) {
    if (i % 3) {
      std::snprintf(cbody, sizeof(cbody), "c=ab%06d&p=1", i);
    } else {
      std::snprintf(cbody, sizeof(cbody), "p=1");
    }
    char fresh[9];
    std::snprintf(fresh, sizeof(fresh), "f%07d", i);
    SjHsOutcome o =
        sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", cbody, ABUSER), 1000 + 3 * i, fresh, storeFn, out);
    stored += o == SJ_HS_OUT_STORED;
    CHECK(o == SJ_HS_OUT_STORED || o == SJ_HS_OUT_PENDING);
  }
  CHECK(stored == 1);  // its first request is still waiting: everything else was "still waiting"
  // a real person on another phone still gets through
  CHECK(sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=real0001&p=4&n=trapped", OTHER), 1600,
                        "zz", storeFn, out) == SJ_HS_OUT_STORED);
  // the abuser's request goes out; the gap then runs from SENDING, whatever id it uses
  sjHotspotMarkSent(app, 7, 1, 2000);
  for (uint32_t t = 2001; t < 2000 + SOS_HOTSPOT_CLIENT_GAP_S; t += 7) {
    std::snprintf(cbody, sizeof(cbody), "c=x%07u", (unsigned)t);
    CHECK(sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", cbody, ABUSER), t, "q", storeFn, out) ==
          SJ_HS_OUT_TOO_SOON);
  }
  CHECK(g_store.got.size() == 2);
  // after the gap, one more - and it waits again
  CHECK(sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=y0000001", ABUSER),
                        2000 + SOS_HOTSPOT_CLIENT_GAP_S, "q", storeFn, out) == SJ_HS_OUT_STORED);
  CHECK(sjHotspotHandle(app, gw, lim, req("POST", "/sos", ip, "", "", "c=y0000002", ABUSER),
                        2001 + SOS_HOTSPOT_CLIENT_GAP_S, "q", storeFn, out) == SJ_HS_OUT_PENDING);
  // the page it gets is its OWN earlier request, under that request's id
  CHECK(std::strstr(out.c_str(), "Set-Cookie: sjc=y0000001;") && bodyOf(out).find("still waiting") != std::string::npos);
  // over a whole day the abuser gets at most one request per (send time + gap), the
  // others are never refused for the window: worst case one per gap if every send is instant
  SjHotspotApp day;
  sjHotspotBegin(day);
  g_store = Store();
  int abuserStored = 0, realRefused = 0, realStored = 0;
  for (uint32_t t = 10; t < 86400; t += 5) {
    std::snprintf(cbody, sizeof(cbody), "c=d%07u", (unsigned)t);
    if (sjHotspotHandle(day, gw, lim, req("POST", "/sos", ip, "", "", cbody, ABUSER), t, "q", storeFn, out) ==
        SJ_HS_OUT_STORED) {
      abuserStored++;
      sjHotspotMarkSent(day, 7, day.seq, t + 1);  // the link is fast: sent a second later
    }
    if (t % 3600 == 0) {  // a real person every hour, each on their own phone
      std::snprintf(cbody, sizeof(cbody), "c=r%07u&p=2", (unsigned)t);
      SjHsOutcome o = sjHotspotHandle(day, gw, lim, req("POST", "/sos", ip, "", "", cbody, 0x0A000000u + t), t, "r",
                                      storeFn, out);
      realStored += o == SJ_HS_OUT_STORED;
      realRefused += o == SJ_HS_OUT_RATE_LIMITED;
      sjHotspotMarkSent(day, 7, day.seq, t + 1);
    }
  }
  CHECK(realRefused == 0 && realStored == 23);
  CHECK(abuserStored <= 86400 / (int)SOS_HOTSPOT_CLIENT_GAP_S + 1);
  // a phone that later gets an address another phone used long ago is not held by it
  SjHotspotApp reuse;
  sjHotspotBegin(reuse);
  CHECK(sjHotspotHandle(reuse, gw, lim, req("POST", "/sos", ip, "", "", "c=first001", ABUSER), 100, "q", storeFn,
                        out) == SJ_HS_OUT_STORED);
  CHECK(sjHotspotHandle(reuse, gw, lim, req("POST", "/sos", ip, "", "", "c=second01", ABUSER),
                        100 + SOS_HOTSPOT_WINDOW_S, "q", storeFn, out) == SJ_HS_OUT_STORED);
  // an unknown address (0) never ties two phones together
  SjHotspotApp unknown;
  sjHotspotBegin(unknown);
  CHECK(sjHotspotHandle(unknown, gw, lim, req("POST", "/sos", ip, "", "", "c=one00001", 0), 100, "q", storeFn, out) ==
        SJ_HS_OUT_STORED);
  CHECK(sjHotspotHandle(unknown, gw, lim, req("POST", "/sos", ip, "", "", "c=two00001", 0), 101, "q", storeFn, out) ==
        SJ_HS_OUT_STORED);
}

// ---- the outbox and its NVS copy --------------------------------------------------
inline void outboxTests() {
  SjSosMsgOutbox<3> o;
  std::memset(&o, 0, sizeof(o));
  auto entry = [](uint32_t seq, const char* node = "NODE-07") {
    SjSosMsgQueued e;
    std::memset(&e, 0, sizeof(e));
    e.msg = makeMsg(node, 5, seq, "cid", "x");
    e.rxAtS = 100;
    e.bootId = 9;
    return e;
  };
  CHECK(sjSosMsgOutboxAdd(o, entry(1)) == 1 && sjSosMsgOutboxAdd(o, entry(2)) == 1);
  CHECK(sjSosMsgOutboxAdd(o, entry(1)) == 0 && o.count == 2);  // a node's resend: kept once
  CHECK(sjSosMsgOutboxAdd(o, entry(1, "NODE-08")) == 1);        // same numbers, other node
  CHECK(sjSosMsgOutboxAdd(o, entry(3)) == -1 && o.count == 3);  // full: refused, nobody evicted
  CHECK(sjSosMsgOutboxRemove(o, entry(2).msg) && o.count == 2 && o.items[0].msg.seq == 1 && o.items[1].msg.seq == 1);
  CHECK(!sjSosMsgOutboxRemove(o, entry(2).msg));
  CHECK(sjSosMsgOutboxAdd(o, entry(3)) == 1 && o.items[2].msg.seq == 3);  // order kept: oldest first

  // NVS copy: valid entries back, damaged ones skipped, a wild count = nothing
  SjSosMsgOutbox<3> saved = o, back;
  CHECK(sjSosMsgOutboxRestore(back, saved) == 3 && back.count == 3 &&
        std::memcmp(&back.items[1], &saved.items[1], sizeof(SjSosMsgQueued)) == 0);
  saved.items[1].msg.node_id[0] = '"';
  saved.items[2].msg.type = SJ_TYPE_READING;
  CHECK(sjSosMsgOutboxRestore(back, saved) == 1 && back.count == 1 && back.items[0].msg.seq == 1);
  saved = o;
  saved.count = 200;
  CHECK(sjSosMsgOutboxRestore(back, saved) == 0 && back.count == 0);
  saved = o;
  saved.items[0].local = 7;
  CHECK(sjSosMsgOutboxRestore(back, saved) == 2);
  SjSosMsgOutbox<3> zero;
  std::memset(&zero, 0, sizeof(zero));
  CHECK(sjSosMsgOutboxRestore(back, zero) == 0);  // a fresh NVS read of zeros
  // a corrupted count in RAM is reset, not trusted
  o.count = 250;
  CHECK(sjSosMsgOutboxAdd(o, entry(9)) == 1 && o.count == 1);

  // the restored phones get their status page again
  SjSosMsgOutbox<3> mine;
  std::memset(&mine, 0, sizeof(mine));
  SjSosMsgQueued l = entry(4);
  l.local = 1;
  sjSosMsgOutboxAdd(mine, l);
  sjSosMsgOutboxAdd(mine, entry(5));  // from a node over LoRa: no phone here
  SjHotspotApp app;
  sjHotspotBegin(app);
  sjHotspotRememberOutbox(app, mine, 50);
  SjHotspotClient* c = sjHotspotFindClient(app, "cid");
  CHECK(c && c->state == SJ_HS_STORED && c->seq == 4 && c->session == 5);

  // age at forwarding
  SjSosMsgQueued a = entry(1);
  a.msg.age_s = 30;  // the node held it 30 s before the gateway got it
  CHECK(sjSosMsgAge(a, 160, 9) == 90);
  CHECK(sjSosMsgAge(a, 160, 10) == -1);  // stored before a reboot: unknown
  a.msg.age_s = SJ_AGE_UNKNOWN;
  CHECK(sjSosMsgAge(a, 160, 9) == -1);
  a.msg.age_s = 0;
  CHECK(sjSosMsgAge(a, 100, 9) == 0 && sjSosMsgAge(a, 99, 9) == -1);
}

inline void runHotspotTests(const std::string& dir) {
  packetTests();
  utf8Tests();
  std::FILE* jf = std::fopen((dir + "/hotspot_samples.jsonl").c_str(), "wb");
  CHECK(jf != nullptr);
  if (jf) {
    jsonTests(jf);
    std::fclose(jf);
  }
  parseTests();
  routeTests();
  rateTests();
  handleTests(dir);
  peerTests();
  outboxTests();
}

}  // namespace hotspot
