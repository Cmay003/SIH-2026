// Host-side tests for the firmware's hardware-independent logic.
// Build + run via tools/firmware_host_test/run_tests.py.
#include <cassert>
#include <cstdio>
#include <vector>
#include "Arduino.h"
#include "LittleFS.h"
#include "../../firmware/sanjeevni_lora_node/sj_packet.h"
#include "../../firmware/sanjeevni_lora_node/sj_file_queue.h"
#include "../../firmware/sanjeevni_lora_node/sj_sleep.h"
#include "../../firmware/sanjeevni_lora_node/sj_session.h"
#include "../../firmware/sanjeevni_lora_node/sj_selftest.h"
#include "../../firmware/sanjeevni_lora_node/sj_warmup.h"
#include "../../firmware/sanjeevni_lora_node/config.h"  // the shipped warm-up times + alert limits
#include "../../firmware/sanjeevni_lora_gateway/sj_forward.h"
#include <cstddef>
#include <set>

static int failures = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);       \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static SjReading makeReading(const char* node, uint32_t session, uint32_t seq) {
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

#include "queue_tests.h"  // segment-file queue: wrap, reboot, corruption, capacity change, power cuts

// The bytes a version-1 firmware put on air / into its queue: same as v2
// up to the node id, then a 16-bit session and the rest unchanged.
static std::vector<uint8_t> v1Bytes(const SjReading& v2) {
  std::vector<uint8_t> b(SJ_V1_READING_SIZE);
  std::memcpy(b.data(), &v2, SJ_V1_SESSION_OFFSET);
  b[1] = SJ_VERSION_V1;
  uint16_t s16 = (uint16_t)v2.session;
  std::memcpy(b.data() + SJ_V1_SESSION_OFFSET, &s16, 2);
  std::memcpy(b.data() + SJ_V1_SESSION_OFFSET + 2, (const uint8_t*)&v2 + SJ_V1_SESSION_OFFSET + 4,
              SJ_V1_READING_SIZE - SJ_V1_SESSION_OFFSET - 2);
  return b;
}

// reading_uid sessions (sj_session.h) + protocol v1 compatibility (sj_packet.h)
static void sessionAndProtocolTests() {
  // ---- a new board / erased NVS must not restart at 1 (review B) ------
  CHECK(sjNextSession(true, 41, 0) == 42);                 // same board: +1 per power-on
  CHECK(sjNextSession(true, 0xFFFFFFFFu, 0) == 1);         // wrap skips 0
  CHECK(sjNextSession(false, 0, 123456789u) == 123456789u); // no counter in NVS: fresh random start
  CHECK(sjNextSession(false, 0, 0) == 1);
  uint64_t mac = 0x0000A4CF12345678ull;
  CHECK(sjFreshSession(mac, 7, 9) == sjFreshSession(mac, 7, 9));  // pure function of its inputs
  CHECK(sjFreshSession(mac, 7, 9) != sjFreshSession(mac, 8, 9));  // erased NVS, same board: new random -> new start
  CHECK(sjFreshSession(mac, 7, 9) != sjFreshSession(mac, 7, 10));
  // Board swap even if both RNGs returned the same words: the eFuse MAC
  // alone separates the starts, and none of them is near the old 1, 2, 3.
  std::set<uint32_t> starts;
  bool farFromOld = true;
  for (uint32_t i = 0; i < 2000; i++) {
    uint32_t s = sjFreshSession(mac + i, 0, 0);
    starts.insert(s);
    farFromOld &= s > 100000;  // the old 16-bit counter's range is 1..65535
  }
  CHECK(starts.size() == 2000);
  CHECK(farFromOld);
  CHECK(sjFreshSession(0, 0, 0) != 0);

  // ---- the session survives deep sleep as 32 bits ---------------------
  SjSleepState st;
  sjSleepStateReset(st, 4000000000u);
  CHECK(sjSleepStateValid(st) && st.session == 4000000000u);

  // ---- version 1 packets from nodes not re-flashed yet -----------------
  SjReading orig = makeReading("NODE-OLD", 517, 77);
  orig.flags = SJ_HAS_WATER | SJ_HAS_BATTERY;
  orig.water_level_mm = 4321;
  orig.battery_x10 = 655;
  orig.age_s = 90;
  orig.edge_risk = 1;
  std::vector<uint8_t> v1 = v1Bytes(orig);
  CHECK(sjIsValidReadingV1(v1.data(), v1.size()));
  CHECK(!sjIsValidReading(v1.data(), v1.size()));          // 54 bytes: not a v2 packet
  CHECK(!sjIsValidReadingV1((uint8_t*)&orig, sizeof(orig)));
  SjReading up = sjReadingFromV1(v1.data());
  CHECK(up.version == SJ_VERSION && up.session == 517 && up.seq == 77 && up.age_s == 90);
  CHECK(up.water_level_mm == 4321 && up.battery_x10 == 655 && up.edge_risk == 1 && up.flags == orig.flags);
  CHECK(std::memcmp(&up, &orig, sizeof(up)) == 0);
  String uidOld, uidNew;
  sjAppendJson(uidOld, up, -1, -90, "lora");
  CHECK(std::strstr(uidOld.c_str(), "\"reading_uid\":\"517-77\""));  // same uid the v1 firmware produced
  // the v1 node only accepts a 21-byte v1 ACK for its 16-bit session
  SjAckV1 a1 = sjMakeAckV1(up);
  CHECK(sizeof(a1) == 21 && a1.version == SJ_VERSION_V1 && a1.session == 517 && a1.seq == 77);
  CHECK(std::memcmp(a1.node_id, orig.node_id, SJ_NODE_ID_LEN) == 0);

  // ---- a record queued on flash by v1 firmware, read after the update ----
  {
    struct RecV1 {  // the old QueuedReading: 54-byte packed reading, then takenAtS
      uint8_t reading[SJ_V1_READING_SIZE];
      uint32_t t;
    };
    static_assert(sizeof(RecV1) == sizeof(Rec), "same record size -> the queue keeps v1 records");
    static_assert(offsetof(RecV1, t) == offsetof(Rec, t), "takenAtS did not move");
    {
      SjFileQueue<RecV1> q;
      CHECK(q.begin("/upg.bin", "/upg.hdr", 10));
      q.clear();
      RecV1 r1;
      std::memset(&r1, 0, sizeof(r1));
      std::memcpy(r1.reading, v1.data(), v1.size());
      r1.t = 1234;
      CHECK(q.push(r1));
    }
    SjFileQueue<Rec> q;
    CHECK(q.begin("/upg.bin", "/upg.hdr", 10));
    Rec got;
    CHECK(q.count() == 1 && q.peek(0, got));
    CHECK(got.r.version == SJ_VERSION_V1);  // still v1 bytes until upgraded
    sjUpgradeQueuedReading(got.r);
    CHECK(std::memcmp(&got.r, &orig, sizeof(orig)) == 0 && got.t == 1234);
    SjReading cur = makeReading("NODE-NEW", 3000000000u, 5);
    SjReading copy = cur;
    sjUpgradeQueuedReading(copy);  // current records are left alone
    CHECK(std::memcmp(&copy, &cur, sizeof(cur)) == 0);
  }

  // ---- a 32-bit session is a v2 ACK's business ------------------------
  SjReading big = makeReading("NODE-04", 4000000001u, 3);
  SjAck bigAck = sjMakeAck(big);
  CHECK(sjAckMatches((uint8_t*)&bigAck, sizeof(bigAck), big));
  SjReading low16 = makeReading("NODE-04", 4000000001u & 0xFFFF, 3);
  CHECK(!sjAckMatches((uint8_t*)&bigAck, sizeof(bigAck), low16));  // no 16-bit truncation anywhere
  CHECK(!sjAckMatches((uint8_t*)&a1, sizeof(a1), up));             // a v1 ACK never satisfies a v2 node
  sjAppendJson(uidNew, big, -1, -90, "lora");
  CHECK(std::strstr(uidNew.c_str(), "\"reading_uid\":\"4000000001-3\""));
}

// Deep-sleep drain budget (sj_sleep.h, review B: the WiFi node drained a
// whole backlog in one wake regardless of DEEP_SLEEP_MAX_AWAKE_MS)
static void drainBudgetTests() {
  uint32_t nowMs = 0, queued = 0, flushes = 0;
  auto hasMore = [&] { return queued > 0; };
  auto now = [&] { return nowMs; };
  auto slowFlush = [&] {  // one TLS POST of 10 readings: 3 s
    nowMs += 3000;
    queued = queued > 10 ? queued - 10 : 0;
    flushes++;
    return true;
  };
  queued = 2000;  // backlog after a WiFi outage
  nowMs = 4000;   // WiFi took 4 s to connect after the wake
  CHECK(sjDrainWithinBudget(hasMore, slowFlush, now, 0, 30000) == 9);
  CHECK(nowMs < 30000 + 3000);  // never more than one batch past the budget
  CHECK(queued == 2000 - 90);   // the rest waits for the next wakes

  queued = 25;  // small backlog: drained completely
  nowMs = 0;
  flushes = 0;
  CHECK(sjDrainWithinBudget(hasMore, slowFlush, now, 0, 30000) == 3 && queued == 0);

  queued = 50;  // first flush fails (no link) -> stop at once
  nowMs = 0;
  CHECK(sjDrainWithinBudget(hasMore, [&] { nowMs += 100; return false; }, now, 0, 30000) == 1 && queued == 50);

  // budget measured from a start time, across a millis() wrap
  queued = 1000;
  nowMs = 0xFFFFFFFFu - 5000;
  uint32_t start = nowMs;
  CHECK(sjDrainWithinBudget(hasMore, slowFlush, now, start, 30000) == 10);
  CHECK((uint32_t)(nowMs - start) == 30000);

  queued = 0;  // nothing queued: no flush at all
  CHECK(sjDrainWithinBudget(hasMore, slowFlush, now, nowMs, 30000) == 0);
}

// Gateway: popping after an upload that ran without the queue lock
// (sj_forward.h, review B - the LoRa radio is served during uploads now)
static void forwardPopTests() {
  CHECK(sjPopAfterUpload(20, 5, 5, 0, 0) == 20);  // nothing happened meanwhile
  CHECK(sjPopAfterUpload(20, 5, 8, 0, 0) == 17);  // 3 overflow pushes overwrote 3 of the sent ones
  CHECK(sjPopAfterUpload(20, 5, 25, 0, 0) == 0);  // all of them overwritten
  CHECK(sjPopAfterUpload(20, 5, 40, 0, 0) == 0);
  CHECK(sjPopAfterUpload(20, 5, 0, 0, 1) == 0);   // 'c' cleared the queue (dropped reset to 0)
  CHECK(sjPopAfterUpload(1, 7, 7, 2, 2) == 1);    // DROP_ONE
  CHECK(sjPopAfterUpload(0, 7, 7, 2, 2) == 0);    // RETRY / SPLIT pop nothing

  // The real queue: a full ring keeps receiving while 3 readings are "in flight"
  SjFileQueue<Rec> q;
  CHECK(q.begin("/fwd.bin", "/fwd.hdr", 5));
  q.clear();
  for (uint32_t i = 1; i <= 5; i++) CHECK(q.push({makeReading("NODE-04", 1, i), i}));
  const uint32_t sent = 3;  // batch = seq 1, 2, 3
  uint32_t droppedAtBuild = q.dropped(), clears = 0;
  for (uint32_t i = 6; i <= 7; i++) CHECK(q.push({makeReading("NODE-04", 1, i), i}));  // overwrite 1, 2
  CHECK(q.pop(sjPopAfterUpload(sent, droppedAtBuild, q.dropped(), clears, clears)));
  Rec out;
  CHECK(q.count() == 4 && q.peek(0, out) && out.r.seq == 4);  // 3 popped; 4 and 5 were never sent: kept
  CHECK(q.peek(3, out) && out.r.seq == 7);

  // 'c' during the upload, then new readings: none of them may be popped
  droppedAtBuild = q.dropped();
  q.clear();
  clears++;
  CHECK(q.push({makeReading("NODE-04", 1, 8), 8}));
  uint32_t n = sjPopAfterUpload(sent, droppedAtBuild, q.dropped(), 0, clears);
  CHECK(n == 0 && q.count() == 1);
}

// Gas / PM warm-up gate after a boot (sj_warmup.h, upgrade gas-pm-warmup-gate):
// a cold MQ135 after a power cut must neither be sent nor raise the local
// alert, and the self-test's WAIT must cover exactly the same window.
static void warmUpTests() {
  // The shipped times: the PMS5003 datasheet asks for >= 30 s; the MQ135
  // needs minutes ("several minutes" - 120 s was the self-test's old value)
  CHECK(PMS5003_WARMUP_S >= 30);
  CHECK(MQ135_WARMUP_S >= 120);

  CHECK(sjWarmingUp(0, 180) && sjWarmingUp(179, 180) && !sjWarmingUp(180, 180) && !sjWarmingUp(0xFFFFFFFFu, 180));
  CHECK(!sjWarmingUp(0, 0));  // 0 = gate off

  // 2000 ppm from a cold heater, 10 s after a power cut: left out, no alert
  SjReading r = makeReading("NODE-04", 1, 1);
  CHECK(!sjAddGasValue(r, 2000, 10, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM));
  CHECK(!(r.flags & SJ_HAS_GAS) && r.gas_ppm == 0);
  CHECK(!sjAddGasValue(r, 2000, MQ135_WARMUP_S - 1, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM) && !(r.flags & SJ_HAS_GAS));
  // ...the same value once warm: sent and alerting
  CHECK(sjAddGasValue(r, 2000, MQ135_WARMUP_S, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM));
  CHECK((r.flags & SJ_HAS_GAS) && r.gas_ppm == 2000);
  SjReading clean = makeReading("NODE-04", 1, 2);  // warm, clean air: sent, no alert
  CHECK(!sjAddGasValue(clean, 420, 130 + MQ135_WARMUP_S, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM));
  CHECK((clean.flags & SJ_HAS_GAS) && clean.gas_ppm == 420);
  CHECK(sjAddGasValue(clean, LOCAL_GAS_LIMIT_PPM, MQ135_WARMUP_S, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM));  // >= limit
  SjReading huge = makeReading("NODE-04", 1, 3);
  CHECK(sjAddGasValue(huge, 1e9f, MQ135_WARMUP_S, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM) && huge.gas_ppm == 65535);

  // Without the gas flag the edge model (needs water+DHT+gas+flame) can't run
  const uint16_t edgeInputs = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME;
  SjReading cold = makeReading("NODE-04", 1, 4);
  cold.flags = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_FLAME;
  sjAddGasValue(cold, 5000, 5, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM);
  CHECK((cold.flags & edgeInputs) != edgeInputs);
  CHECK((cold.flags & SJ_MEASUREMENT_FLAGS) != 0);  // the other sensors are still sent

  // PMS5003: fan settling -> left out, no alert; afterwards CPCB limits apply ('>')
  SjReading pm = makeReading("NODE-04", 1, 5);
  CHECK(!sjAddPmValues(pm, 400, 600, 10, PMS5003_WARMUP_S, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT));
  CHECK(!(pm.flags & SJ_HAS_PM) && pm.pm25 == 0 && pm.pm10 == 0);
  CHECK(sjAddPmValues(pm, 400, 600, PMS5003_WARMUP_S, PMS5003_WARMUP_S, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT));
  CHECK((pm.flags & SJ_HAS_PM) && pm.pm25 == 400 && pm.pm10 == 600);
  CHECK(!sjAddPmValues(pm, 60, 100, 60, PMS5003_WARMUP_S, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT));  // band top: no alert
  CHECK(sjAddPmValues(pm, 61, 20, 60, PMS5003_WARMUP_S, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT));
  CHECK(sjAddPmValues(pm, 10, 101, 60, PMS5003_WARMUP_S, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT));  // dust: PM10 alone

  // Self-test WAIT <=> value not sent, second by second (one shared rule)
  for (uint32_t s = 0; s <= MQ135_WARMUP_S + 5; s++) {
    SjReading g = makeReading("NODE-04", 1, 6);
    sjAddGasValue(g, 420, s, MQ135_WARMUP_S, LOCAL_GAS_LIMIT_PPM);
    bool wait = sjCheckMq135(500, 2.0f, 9.0f, 420, s, MQ135_WARMUP_S).status == SJ_CHECK_WAIT;
    CHECK(wait == !(g.flags & SJ_HAS_GAS));
  }
  for (uint32_t s = 0; s <= PMS5003_WARMUP_S + 5; s++) {
    SjReading p = makeReading("NODE-04", 1, 7);
    sjAddPmValues(p, 12, 20, s, PMS5003_WARMUP_S, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT);
    bool wait = sjCheckPms(true, 500, 12, 20, s, PMS5003_WARMUP_S).status == SJ_CHECK_WAIT;
    CHECK(wait == !(p.flags & SJ_HAS_PM));
  }
  CHECK(std::strstr(sjCheckMq135(500, 2.0f, 9.0f, 8000, 10, MQ135_WARMUP_S).detail, "not sent yet"));
  CHECK(std::strstr(sjCheckPms(true, 500, 12, 20, 10, PMS5003_WARMUP_S).detail, "not sent yet"));
}

int main(int argc, char** argv) {
  g_fsRoot = argc > 1 ? argv[1] : ".";
  const char* jsonOut = argc > 2 ? argv[2] : "samples.jsonl";

  // ---- packet layout ------------------------------------------------
  CHECK(sizeof(SjReading) == 56);  // v2: 32-bit session
  CHECK(sizeof(SjAck) == 23);
  CHECK(offsetof(SjReading, session) == SJ_V1_SESSION_OFFSET);
  // The queue record sizes did not change (the 2 new bytes took the old
  // padding), so queued v1 records survive an update and get converted.
  CHECK(sizeof(Rec) == 60);

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

  // ---- deep-sleep state + timing (sj_sleep.h) -------------------------
  {
    SjSleepState s;
    std::memset(&s, 0xA5, sizeof(s));  // RTC memory after a power-on: garbage
    CHECK(!sjSleepStateValid(s));
    std::memset(&s, 0, sizeof(s));     // ...or all zeros
    CHECK(!sjSleepStateValid(s));
    sjSleepStateReset(s, 42);
    CHECK(sjSleepStateValid(s) && s.session == 42 && s.seq == 0 && s.pendingRainMm == 0.0f);
    s.seq = 17;                        // changed but not sealed -> rejected
    CHECK(!sjSleepStateValid(s));
    sjSleepStateSeal(s);
    CHECK(sjSleepStateValid(s) && s.seq == 17);
    s.magic ^= 1;                      // struct layout changed in a newer firmware
    CHECK(!sjSleepStateValid(s));

    CHECK(sjPlanSleepS(false, 300, 30) == 300);
    CHECK(sjPlanSleepS(true, 300, 30) == 30);   // elevated: watch closely
    CHECK(sjRemainingS(1000, 1300) == 300);
    CHECK(sjRemainingS(1300, 1000) == 0);       // overdue
    CHECK(sjRainWakeShouldResleep(1000, 1300, 2));   // tip mid-interval: count it, sleep 300 s more
    CHECK(!sjRainWakeShouldResleep(1299, 1300, 2));  // measurement due in 1 s: measure now
    CHECK(!sjRainWakeShouldResleep(1400, 1300, 2));  // overdue: measure now
  }

  // ---- self-test verdicts (sj_selftest.h) -----------------------------
  // FAIL must line up with the readX() rules in sensors.h that leave a
  // value out of the reading; OK means the value is sent.
  {
    // HC-SR04: readWaterLevelM() needs 3 of 5 echoes
    CHECK(sjCheckUltrasonic(0, 5, 0, 0, 0, 100).status == SJ_CHECK_FAIL);
    CHECK(sjCheckUltrasonic(2, 5, 50, 50, 51, 100).status == SJ_CHECK_FAIL);
    CHECK(sjCheckUltrasonic(5, 5, 49, 50, 51, 100).status == SJ_CHECK_OK);
    CHECK(std::strstr(sjCheckUltrasonic(5, 5, 49, 50, 51, 100).detail, "level 0.500 m (5/5 echoes)"));
    CHECK(sjCheckUltrasonic(4, 5, 49, 50, 51, 100).status == SJ_CHECK_WARN);      // sent, but a ping was lost
    CHECK(sjCheckUltrasonic(3, 5, 49, 50, 51, 100).status == SJ_CHECK_WARN);
    CHECK(sjCheckUltrasonic(5, 5, 1.0f, 1.5f, 1.8f, 100).status == SJ_CHECK_WARN);  // below 2 cm
    CHECK(sjCheckUltrasonic(5, 5, 119, 120, 121, 100).status == SJ_CHECK_WARN);     // past the zero surface
    CHECK(sjCheckUltrasonic(5, 5, 103, 104, 104.5f, 100).status == SJ_CHECK_OK);    // within 5 % of mount
    CHECK(std::strstr(sjCheckUltrasonic(5, 5, 103, 104, 104.5f, 100).detail, "level 0.000 m"));
    CHECK(sjCheckUltrasonic(5, 5, 30, 50, 80, 100).status == SJ_CHECK_WARN);        // multipath spread

    // DHT22
    CHECK(sjCheckDht(false, 0, 0).status == SJ_CHECK_FAIL);
    CHECK(sjCheckDht(true, 25.0f, 60.0f).status == SJ_CHECK_OK);
    CHECK(sjCheckDht(true, 85.0f, 60.0f).status == SJ_CHECK_WARN);

    // MQ135 (readGasPpm(): AO < 0.01 V or Rs <= 0 -> left out)
    CHECK(sjCheckMq135(0, 2.0f, -1, 0, 300, 120).status == SJ_CHECK_FAIL);
    // clipped with the 2:1 divider -> AO "6.3 V" > MQ135_VCC -> Rs < 0 -> NOT sent (review finding)
    CHECK(sjCheckMq135(3150, 2.0f, 1.0f * (5 - 6.3f) / 6.3f, 0, 300, 120).status == SJ_CHECK_FAIL);
    CHECK(std::strstr(sjCheckMq135(3150, 2.0f, -0.2f, 0, 300, 120).detail, "divider missing"));
    CHECK(sjCheckMq135(3150, 1.0f, 0.59f, 900, 300, 120).status == SJ_CHECK_WARN);  // clipped, still sent
    // pin at the ADC floor (~142 mV for 0 V): unpowered and clean air look alike -> WARN
    CHECK(sjCheckMq135(142, 2.0f, 16.6f, 8050, 300, 120).status == SJ_CHECK_WARN);
    CHECK(sjCheckMq135(2000, 3.0f, -0.2f, 0, 300, 120).status == SJ_CHECK_FAIL);    // AO 6 V > MQ135_VCC
    CHECK(sjCheckMq135(500, 2.0f, 9.0f, 420, 60, 120).status == SJ_CHECK_WAIT);     // heater still cold
    CHECK(sjCheckMq135(500, 2.0f, 9.0f, 420, 300, 120).status == SJ_CHECK_OK);
    CHECK(sjCheckMq135(500, 2.0f, 9.0f, 50000, 300, 120).status == SJ_CHECK_WARN);  // uncalibrated R0

    // IR flame: a loose wire follows the internal pulls
    CHECK(sjCheckFlame(false, true, true).status == SJ_CHECK_FAIL);
    CHECK(sjCheckFlame(true, true, true).status == SJ_CHECK_OK);
    CHECK(sjCheckFlame(false, false, false).status == SJ_CHECK_WARN);  // module pulls LOW: sees flame

    // rain gauge
    CHECK(sjCheckRain(true, 0).status == SJ_CHECK_OK);
    CHECK(sjCheckRain(false, 3).status == SJ_CHECK_WARN);

    // soil (readSoilMoisturePct(): < 100 mV -> left out), calibration 2600 dry / 1100 wet
    CHECK(sjCheckSoil(50, 2600, 1100).status == SJ_CHECK_FAIL);
    CHECK(sjCheckSoil(142, 2600, 1100).status == SJ_CHECK_FAIL);  // 0 V reads ~142 mV on the ESP32
    CHECK(sjCheckSoil((uint32_t)SJ_ADC_FLOOR_MV, 2600, 1100).status == SJ_CHECK_FAIL);
    CHECK(sjCheckSoil((uint32_t)SJ_ADC_FLOOR_MV + 1, 2600, 1100).status != SJ_CHECK_FAIL);
    CHECK(sjCheckSoil(2000, 2600, 1100).status == SJ_CHECK_OK);
    CHECK(std::strstr(sjCheckSoil(2000, 2600, 1100).detail, "-> 40 %"));
    CHECK(sjCheckSoil(2700, 2600, 1100).status == SJ_CHECK_OK);     // a bit drier than calibrated: 0 %
    CHECK(sjCheckSoil(2900, 2600, 1100).status == SJ_CHECK_WARN);   // way outside the calibration
    CHECK(sjCheckSoil(850, 2600, 1100).status == SJ_CHECK_WARN);
    CHECK(sjCheckSoil(3150, 2600, 1100).status == SJ_CHECK_WARN);   // clipped

    // MPU6050
    CHECK(sjCheckMpu(true, false, -1, false, 0, 0, 5).status == SJ_CHECK_FAIL);   // no I2C answer
    CHECK(sjCheckMpu(false, true, 0x68, false, 0, 0, 5).status == SJ_CHECK_FAIL); // plugged in after boot
    CHECK(sjCheckMpu(true, true, 0x68, false, 0, 0, 5).status == SJ_CHECK_FAIL);  // read failed
    CHECK(sjCheckMpu(true, true, 0x68, true, 1.01f, 0.4f, 5).status == SJ_CHECK_OK);
    CHECK(sjCheckMpu(true, true, 0x70, true, 1.01f, 0.4f, 5).status == SJ_CHECK_OK);  // MPU6500 clone
    CHECK(sjCheckMpu(true, true, 0x12, true, 1.01f, 0.4f, 5).status == SJ_CHECK_WARN);
    CHECK(sjCheckMpu(true, true, 0x68, true, 1.30f, 0.4f, 5).status == SJ_CHECK_WARN);
    CHECK(sjCheckMpu(true, true, 0x68, true, 1.00f, 6.0f, 5).status == SJ_CHECK_WARN);

    // PMS5003 (readPm(): no frame in 10 s -> left out)
    CHECK(sjCheckPms(false, 0, 0, 0, 100, 30).status == SJ_CHECK_FAIL);
    CHECK(sjCheckPms(true, 12000, 10, 20, 100, 30).status == SJ_CHECK_FAIL);
    CHECK(sjCheckPms(true, 500, 10, 20, 10, 30).status == SJ_CHECK_WAIT);
    CHECK(sjCheckPms(true, 500, 30, 20, 100, 30).status == SJ_CHECK_WARN);
    CHECK(sjCheckPms(true, 500, 12, 20, 100, 30).status == SJ_CHECK_OK);

    // pH (readPh(): < 100 mV or outside 0-14 -> left out), calibration 2500 mV @7, 3030 @4
    CHECK(sjCheckPh(50, 1.5f, 2500, 3030).status == SJ_CHECK_FAIL);
    CHECK(sjCheckPh(2500 / 1.5f, 1.5f, 2500, 3030).status == SJ_CHECK_OK);
    CHECK(std::strstr(sjCheckPh(2500 / 1.5f, 1.5f, 2500, 3030).detail, "pH 7.00"));
    CHECK(sjCheckPh(1000 / 1.5f, 1.5f, 2500, 3030).status == SJ_CHECK_FAIL);  // pH 15.5
    CHECK(sjCheckPh(142, 1.5f, 2500, 3030).status == SJ_CHECK_FAIL);          // ADC floor: unpowered
    // clipped with this calibration -> pH -5.6 -> readPh() drops it (review finding)
    CHECK(sjCheckPh(3150, 1.5f, 2500, 3030).status == SJ_CHECK_FAIL);
    CHECK(std::strstr(sjCheckPh(3150, 1.5f, 2500, 3030).detail, "bigger divider"));
    CHECK(sjCheckPh(3150, 1.5f, 5000, 5530).status == SJ_CHECK_WARN);         // clipped but pH 8.6: sent

    // turbidity (< 0.1 V -> left out; < 2.5 V -> sent as 3000 NTU)
    CHECK(sjCheckTurbidity(50, 1.5f).status == SJ_CHECK_FAIL);
    CHECK(sjCheckTurbidity(142, 1.5f).status == SJ_CHECK_FAIL);  // ADC floor: unplugged
    CHECK(sjCheckTurbidity(1000, 1.5f).status == SJ_CHECK_WARN);
    CHECK(sjCheckTurbidity(2750, 1.5f).status == SJ_CHECK_OK);  // 4.1 V: clear water
    CHECK(sjCheckTurbidity(3150, 1.5f).status == SJ_CHECK_WARN);

    // battery (< 1 V -> left out), 3.0 V empty, 4.2 V full
    CHECK(sjCheckBattery(400, 2.0f, 3.0f, 4.2f).status == SJ_CHECK_FAIL);
    CHECK(sjCheckBattery(1900, 2.0f, 3.0f, 4.2f).status == SJ_CHECK_OK);
    CHECK(std::strstr(sjCheckBattery(1900, 2.0f, 3.0f, 4.2f).detail, "3.80 V -> 67 %"));
    CHECK(sjCheckBattery(2300, 2.0f, 3.0f, 4.2f).status == SJ_CHECK_WARN);  // 4.6 V: wrong ratio
    CHECK(sjCheckBattery(1400, 2.0f, 3.0f, 4.2f).status == SJ_CHECK_WARN);  // 2.8 V: empty

    // SX127x version register (same set RadioLib's SX1278 driver accepts)
    CHECK(sjCheckLora(0x12, 0).status == SJ_CHECK_OK);
    CHECK(sjCheckLora(0x13, 0).status == SJ_CHECK_OK);
    CHECK(sjCheckLora(0x11, 0).status == SJ_CHECK_OK);
    CHECK(sjCheckLora(0x00, 0).status == SJ_CHECK_FAIL);   // MISO stuck low
    CHECK(sjCheckLora(0xFF, 0).status == SJ_CHECK_FAIL);   // MISO floating / no power
    CHECK(sjCheckLora(0x22, 0).status == SJ_CHECK_FAIL);   // SX1272
    CHECK(sjCheckLora(-2, -2).status == SJ_CHECK_FAIL);    // RadioLib error code
    // wire fixed after boot -> RESET helps
    CHECK(sjCheckLora(0x12, SJ_LORA_ERR_CHIP_NOT_FOUND).status == SJ_CHECK_FAIL);
    CHECK(std::strstr(sjCheckLora(0x12, SJ_LORA_ERR_CHIP_NOT_FOUND).detail, "RESET"));
    // chip fine but a config.h value refused (e.g. 865 MHz on an SX1278) -> RESET won't help
    CHECK(sjCheckLora(0x12, -12).status == SJ_CHECK_FAIL);
    CHECK(std::strstr(sjCheckLora(0x12, -12).detail, "config.h") && !std::strstr(sjCheckLora(0x12, -12).detail, "RESET"));

    CHECK(sjCheckWifi(false, 0).status == SJ_CHECK_FAIL);
    CHECK(sjCheckWifi(true, -85).status == SJ_CHECK_WARN);
    CHECK(sjCheckWifi(true, -60).status == SJ_CHECK_OK);

    CHECK(sjCheckQueue(false, 0, 2000, 0).status == SJ_CHECK_FAIL);
    CHECK(sjCheckQueue(true, 1599, 2000, 0).status == SJ_CHECK_OK);
    CHECK(sjCheckQueue(true, 1600, 2000, 0).status == SJ_CHECK_WARN);  // 80 % full
    CHECK(sjCheckQueue(true, 0, 2000, 3).status == SJ_CHECK_WARN);

    CHECK(sjCheckEdge(false, true).status == SJ_CHECK_WARN);
    CHECK(sjCheckEdge(true, false).status == SJ_CHECK_OK);

    // long values never overflow the detail buffer
    SjCheckResult big = sjCheckUltrasonic(5, 5, 1e30f, 1e30f, 1e30f, 1e30f);
    CHECK(std::strlen(big.detail) < sizeof(big.detail));

    // summary line: the worst status decides
    SjSelfTestTally t;
    std::memset(&t, 0, sizeof(t));
    sjTallyAdd(t, SJ_CHECK_OK);
    CHECK(std::strcmp(sjTallyVerdict(t), "all good") == 0);
    sjTallyAdd(t, SJ_CHECK_WAIT);
    CHECK(std::strstr(sjTallyVerdict(t), "again"));
    sjTallyAdd(t, SJ_CHECK_WARN);
    CHECK(std::strstr(sjTallyVerdict(t), "WARN"));
    sjTallyAdd(t, SJ_CHECK_FAIL);
    CHECK(std::strstr(sjTallyVerdict(t), "FAIL") && t.counts[SJ_CHECK_OK] == 1 && t.counts[SJ_CHECK_FAIL] == 1);
  }

  sessionAndProtocolTests();
  drainBudgetTests();
  forwardPopTests();
  warmUpTests();

  // ---- JSON samples (validated against the backend in Python) --------
  FILE* jf = std::fopen(jsonOut, "w");
  // 1. full sensor set, known age, 12-char node id (no NUL in the packet),
  //    a 32-bit session above INT32_MAX (no sign/width truncation)
  SjReading full = makeReading("NODE-INDB-12", 3000000003u, 9);
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
  // 3. modular landslide node: MPU6050 + battery only, no core sensors (P2.7)
  SjReading tiltOnly = makeReading("NODE-HILL", 2, 4);
  tiltOnly.flags = SJ_HAS_TILT | SJ_HAS_BATTERY;
  tiltOnly.tilt_deg_x100 = 1250;
  tiltOnly.vibration_g_x1000 = 400;
  tiltOnly.battery_x10 = 900;
  CHECK((tiltOnly.flags & SJ_MEASUREMENT_FLAGS) != 0);
  SjReading batteryOnly = makeReading("NODE-HILL", 2, 5);
  batteryOnly.flags = SJ_HAS_BATTERY | SJ_HAS_RAIN;  // telemetry + rain only: not a measurement
  CHECK((batteryOnly.flags & SJ_MEASUREMENT_FLAGS) == 0);
  String s3;
  sjAppendJson(s3, tiltOnly, 30, -80, "lora");
  std::fprintf(jf, "%s\n", s3.c_str());
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
  qt::runQueueTests();

  std::printf(failures ? "\n%d C++ check(s) FAILED\n" : "\nall C++ checks passed\n", failures);
  return failures ? 1 : 0;
}
