// Host-side tests for the firmware's hardware-independent logic.
// Build + run via tools/firmware_host_test/run_tests.py.
#include <cassert>
#include <cstdio>
#include <vector>
#include "Arduino.h"
#include "LittleFS.h"
#include "../../Arduino/sanjeevni_lora_node/sj_packet.h"
#include "../../Arduino/sanjeevni_lora_node/sj_file_queue.h"

static int failures = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);       \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static SjReading makeReading(const char* node, uint16_t session, uint32_t seq) {
  SjReading r;
  std::memset(&r, 0, sizeof(r));
  r.magic = SJ_MAGIC;
  r.version = SJ_VERSION;
  r.type = SJ_TYPE_READING;
  std::strncpy(r.node_id, node, SJ_NODE_ID_LEN);
  r.session = session;
  r.seq = seq;
  r.edge_risk = SJ_EDGE_NONE;
  return r;
}

struct Rec {
  SjReading r;
  uint32_t t;
};

int main(int argc, char** argv) {
  g_fsRoot = argc > 1 ? argv[1] : ".";
  const char* jsonOut = argc > 2 ? argv[2] : "samples.jsonl";

  // ---- packet layout ------------------------------------------------
  CHECK(sizeof(SjReading) == 54);
  CHECK(sizeof(SjAck) == 21);

  // ---- ACK matching -------------------------------------------------
  SjReading a = makeReading("NODE-04", 7, 42);
  SjAck ack = sjMakeAck(a);
  CHECK(sjAckMatches((uint8_t*)&ack, sizeof(ack), a));
  SjReading other = makeReading("NODE-04", 7, 43);
  CHECK(!sjAckMatches((uint8_t*)&ack, sizeof(ack), other));     // wrong seq
  SjReading otherNode = makeReading("NODE-07", 7, 42);
  CHECK(!sjAckMatches((uint8_t*)&ack, sizeof(ack), otherNode));  // wrong node
  CHECK(sjIsValidReading((uint8_t*)&a, sizeof(a)));
  CHECK(!sjIsValidReading((uint8_t*)&ack, sizeof(ack)));
  CHECK(sjClampU16(-5) == 0 && sjClampU16(70000) == 65535 && sjClampI16(-12.6f) == -13);

  // ---- upload outcome -> queue action (review R2) ---------------------
  CHECK(sjUploadAction(200, 20) == SJ_UPLOAD_DONE);
  CHECK(sjUploadAction(422, 20) == SJ_UPLOAD_SPLIT);    // batch refused -> find the bad one
  CHECK(sjUploadAction(422, 1) == SJ_UPLOAD_DROP_ONE);  // that one really is invalid
  CHECK(sjUploadAction(400, 1) == SJ_UPLOAD_DROP_ONE);
  CHECK(sjUploadAction(413, 20) == SJ_UPLOAD_SPLIT);    // too big -> smaller requests
  CHECK(sjUploadAction(413, 1) == SJ_UPLOAD_RETRY);     // never drop for size
  // outages / config errors must NEVER delete readings
  for (int code : {404, 401, 403, 408, 429, 500, 502, 503, -1, -11, 0}) {
    CHECK(sjUploadAction(code, 20) == SJ_UPLOAD_RETRY);
    CHECK(sjUploadAction(code, 1) == SJ_UPLOAD_RETRY);
  }

  // ---- JSON samples (validated against the backend in Python) --------
  FILE* jf = std::fopen(jsonOut, "w");
  // 1. full sensor set, known age, 12-char node id (no NUL in the packet)
  SjReading full = makeReading("NODE-INDB-12", 3, 9);
  full.flags = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME | SJ_FLAME_DETECTED | SJ_HAS_RAIN | SJ_HAS_SOIL |
               SJ_HAS_TILT | SJ_HAS_PM | SJ_HAS_PH | SJ_HAS_TURBIDITY | SJ_HAS_BATTERY;
  full.water_level_mm = 1234;
  full.temp_c_x100 = -150;  // -1.5 C
  full.humidity_x100 = 6543;
  full.gas_ppm = 950;
  full.rain_mm_x100 = 279;
  full.soil_moisture_x10 = 456;
  full.tilt_deg_x100 = 712;
  full.vibration_g_x1000 = 85;
  full.pm25 = 140;
  full.pm10 = 210;
  full.ph_x100 = 612;
  full.turbidity_ntu_x10 = 87;
  full.battery_x10 = 823;
  full.edge_risk = 2;
  String s;
  sjAppendJson(s, full, 125, -97, "lora");
  std::fprintf(jf, "%s\n", s.c_str());
  // 2. core sensors only, unknown age (field must be omitted), no edge verdict
  SjReading core = makeReading("NODE-04", 1, 1);
  core.flags = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME;
  core.water_level_mm = 12;
  core.temp_c_x100 = 2750;
  core.humidity_x100 = 6000;
  core.gas_ppm = 420;
  String s2;
  sjAppendJson(s2, core, -1, -61, "wifi");
  std::fprintf(jf, "%s\n", s2.c_str());
  std::fclose(jf);

  // ---- persistent queue ---------------------------------------------
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin("/q.bin", "/q.hdr", 5));
    q.clear();
    for (uint32_t i = 1; i <= 3; i++) CHECK(q.push({makeReading("NODE-04", 1, i), i * 10}));
    Rec out;
    CHECK(q.count() == 3 && q.peek(0, out) && out.r.seq == 1 && out.t == 10);
    CHECK(q.peek(2, out) && out.r.seq == 3);
    CHECK(!q.peek(3, out));
    CHECK(q.pop(1) && q.count() == 2 && q.peek(0, out) && out.r.seq == 2);
    // wrap-around + overflow: capacity 5, push 6 more -> oldest overwritten
    for (uint32_t i = 4; i <= 9; i++) CHECK(q.push({makeReading("NODE-04", 1, i), i * 10}));
    CHECK(q.count() == 5);
    CHECK(q.dropped() == 3);
    CHECK(q.peek(0, out) && out.r.seq == 5);  // 2,3,4 were the oldest -> dropped
    CHECK(q.peek(4, out) && out.r.seq == 9);
    // update in place
    out.t = 999;
    CHECK(q.update(4, out) && q.peek(4, out) && out.t == 999);
  }
  {
    // "reboot": a fresh queue object on the same files keeps everything
    SjFileQueue<Rec> q;
    CHECK(q.begin("/q.bin", "/q.hdr", 5));
    Rec out;
    CHECK(q.count() == 5 && q.peek(0, out) && out.r.seq == 5 && q.peek(4, out) && out.t == 999);
    CHECK(q.pop(10) && q.count() == 0);  // pop more than available is clamped
  }
  {
    // record layout changed (different T) -> header reset, not misread
    SjFileQueue<SjAck> q2;
    CHECK(q2.begin("/q.bin", "/q.hdr", 5));
    CHECK(q2.count() == 0);
  }

  std::printf(failures ? "\n%d C++ check(s) FAILED\n" : "\nall C++ checks passed\n", failures);
  return failures ? 1 : 0;
}
