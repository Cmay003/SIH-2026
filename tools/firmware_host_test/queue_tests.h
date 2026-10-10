// Tests for sj_file_queue.h's segment-file layout (review B41 + B61):
// wrap-around against a reference model, reboots, flash wear per push,
// corruption, QUEUE_CAPACITY / layout changes, the old single-file
// format, and a simulated power cut at every flash commit of each
// operation. Included by test_firmware_logic.cpp (uses its CHECK).
#pragma once
#include <deque>
#include <functional>
#include <vector>

namespace qt {

// 1000-byte record: 4 per 4 KB segment, so a capacity of 10 already
// spans 3 segment files (4 + 4 + 2) and wraps across file boundaries.
struct Big {
  uint32_t id;
  uint32_t tag;
  uint8_t pad[992];
};
using BigQ = SjFileQueue<Big>;

inline Big makeBig(uint32_t id) {
  Big b;
  std::memset(&b, 0, sizeof(b));
  b.id = id;
  b.tag = id * 7 + 1;
  std::memset(b.pad, (int)(id & 0xFF), sizeof(b.pad));
  return b;
}
// a torn or mixed-up record fails this
inline bool intact(const Big& b) {
  if (b.tag != b.id * 7 + 1) return false;
  for (uint8_t v : b.pad)
    if (v != (uint8_t)(b.id & 0xFF)) return false;
  return true;
}

// Same layout as the gateway's GatewayQueued (72 bytes)
struct Gw {  // the gateway's GatewayQueued
  SjReading reading;
  uint32_t rxAtS;
  uint16_t gwSession;
  int16_t rssi;
  SjSummary summary;
};

// Direct access to the stand-in's stored files, behind the queue's back
inline bool hostExists(const std::string& p) { return g_fsFiles.count(p) > 0; }
inline std::vector<uint8_t> hostRead(const std::string& p) {
  auto it = g_fsFiles.find(p);
  return it == g_fsFiles.end() ? std::vector<uint8_t>() : it->second;
}
inline void hostWrite(const std::string& p, const std::vector<uint8_t>& d) { g_fsFiles[p] = d; }
inline void hostRemove(const std::string& p) { g_fsFiles.erase(p); }
inline void flipByte(const std::string& p, size_t off) {
  std::vector<uint8_t>& d = g_fsFiles[p];
  if (off < d.size()) d[off] ^= 0x5A;
}
inline std::string seg(const std::string& data, int gen, int n) {
  return data + "." + std::to_string(gen) + "." + std::to_string(n);
}
inline int countSegs(const std::string& data, int gen) {
  int n = 0;
  for (int k = 0; k < 300; k++) n += hostExists(seg(data, gen, k));
  return n;
}
inline void wipe(const std::string& data, const std::string& hdr) {
  hostRemove(data);
  hostRemove(hdr);
  for (int g = 0; g < 2; g++)
    for (int k = 0; k < 300; k++) hostRemove(seg(data, g, k));
}
inline bool logged(const char* text) { return g_serialLog.find(text) != std::string::npos; }

// Ids oldest first; {0xFFFFFFFF} if any record can't be read intact.
template <typename Q>
std::vector<uint32_t> ids(Q& q) {
  std::vector<uint32_t> v;
  for (uint32_t i = 0; i < q.count(); i++) {
    Big b;
    if (!q.peek(i, b) || !intact(b)) return {0xFFFFFFFFu};
    v.push_back(b.id);
  }
  return v;
}
inline std::vector<uint32_t> range(uint32_t from, uint32_t to) {
  std::vector<uint32_t> v;
  for (uint32_t i = from; i <= to; i++) v.push_back(i);
  return v;
}
inline void fill(BigQ& q, uint32_t from, uint32_t to) {
  for (uint32_t i = from; i <= to; i++) q.push(makeBig(i));
}

// ---- wrap-around + reboots against a std::deque model ----------------
inline void testModel() {
  const std::string d = "/m.bin", h = "/m.hdr";
  wipe(d, h);
  const uint32_t cap = 10;
  auto q = std::make_unique<BigQ>();
  CHECK(q->begin(d.c_str(), h.c_str(), cap));
  CHECK(countSegs(d, 0) == 3 && countSegs(d, 1) == 0);
  std::deque<uint32_t> model;
  uint32_t next = 1, dropped = 0, rng = 12345;
  bool allOk = true;
  for (int step = 0; step < 1500; step++) {
    rng = rng * 1103515245u + 12345u;
    uint32_t r = (rng >> 16) % 100;
    if (r < 55) {
      allOk &= q->push(makeBig(next));
      model.push_back(next++);
      if (model.size() > cap) {
        model.pop_front();
        dropped++;
      }
    } else if (r < 75) {
      uint32_t n = (rng >> 8) % 4;
      allOk &= q->pop(n);
      for (uint32_t k = 0; k < n && !model.empty(); k++) model.pop_front();
    } else if (r < 82 && !model.empty()) {
      // update in place keeps the id, so the model is unchanged
      uint32_t i = (rng >> 4) % model.size();
      Big b;
      allOk &= q->peek(i, b) && q->update(i, b);
    } else if (r < 92) {
      q = std::make_unique<BigQ>();  // reboot
      allOk &= q->begin(d.c_str(), h.c_str(), cap);
    }
    std::vector<uint32_t> want(model.begin(), model.end());
    if (ids(*q) != want || q->dropped() != dropped) {
      std::printf("FAIL queue model diverged at step %d\n", step);
      failures++;
      break;
    }
  }
  CHECK(allOk);
  CHECK(countSegs(d, 0) == 3 && countSegs(d, 1) == 0);  // no stray files
}

// ---- flash wear per push (B41) ---------------------------------------
inline void testWear() {
  // The stand-in charges copy-on-write like LittleFS: an in-place write
  // near the start of the old 256 KB single ring file rewrites all of it.
  const std::string big = "/wear_old.bin";
  {
    File f = LittleFS.open(big.c_str(), "w");
    std::vector<uint8_t> zeros(4000 * 64, 0);
    f.write(zeros.data(), zeros.size());
    f.close();
  }
  unsigned long before = g_fsBytesProgrammed;
  {
    File f = LittleFS.open(big.c_str(), "r+");
    uint8_t rec[64] = {1};
    f.seek(64);
    f.write(rec, sizeof(rec));
    f.close();
  }
  CHECK(g_fsBytesProgrammed - before == 4000 * 64);  // what one old-layout push cost
  hostRemove(big);

  // Gateway-sized queue (4000 x 104 B): every push now rewrites one
  // segment (<= one 4 KB block) + the header - two commits.
  const std::string d = "/gw.bin", h = "/gw.hdr";
  wipe(d, h);
  SjFileQueue<Gw> q;
  CHECK(sizeof(Gw) == 104);
  CHECK(q.begin(d.c_str(), h.c_str(), 4000));
  CHECK(countSegs(d, 0) == 109);  // 37 slots of 108 B per segment (gateway config.h)
  unsigned long worstBytes = 0, worstCommits = 0;
  for (uint32_t i = 0; i < 300; i++) {
    Gw g;
    std::memset(&g, 0, sizeof(g));
    g.reading = makeReading("NODE-04", 1, i);
    unsigned long b0 = g_fsBytesProgrammed, c0 = g_fsCommits;
    CHECK(q.push(g));
    worstBytes = std::max(worstBytes, g_fsBytesProgrammed - b0);
    worstCommits = std::max(worstCommits, g_fsCommits - c0);
  }
  CHECK(worstBytes <= 4096 + 64);
  CHECK(worstCommits == 2);
  unsigned long b0 = g_fsBytesProgrammed;
  CHECK(q.pop(5));
  CHECK(g_fsBytesProgrammed - b0 <= 64);  // pop only rewrites the header
  wipe(d, h);
}

// ---- corruption ------------------------------------------------------
inline void testCorruption() {
  const std::string d = "/c.bin", h = "/c.hdr";
  const size_t slot = sizeof(Big) + 4;

  // damaged header (garbage / bad CRC / cut short) -> clean empty queue + message
  for (int kind = 0; kind < 3; kind++) {
    wipe(d, h);
    {
      BigQ q;
      CHECK(q.begin(d.c_str(), h.c_str(), 10));
      fill(q, 1, 3);
    }
    std::vector<uint8_t> hd = hostRead(h);
    if (kind == 0) hd.assign(hd.size(), 0xA7);
    if (kind == 1) hd[24] ^= 1;  // head/count field: only the CRC notices
    if (kind == 2) hd.resize(10);
    hostWrite(h, hd);
    g_serialLog.clear();
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(q.count() == 0 && logged("header damaged"));
    CHECK(q.push(makeBig(50)) && ids(q) == std::vector<uint32_t>{50});
  }

  // a flipped bit inside one record: only that record is dropped, at boot
  wipe(d, h);
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 6);
  }
  flipByte(seg(d, 0, 0), 2 * slot + 100);  // record 3 (slot 2, segment 0)
  g_serialLog.clear();
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(logged("unreadable") && logged("could not be kept"));
    CHECK((ids(q) == std::vector<uint32_t>{1, 2, 4, 5, 6}) && q.dropped() == 1);
    CHECK(countSegs(d, 1) == 3 && countSegs(d, 0) == 0);  // rebuilt into the other generation
    fill(q, 7, 12);
    CHECK(ids(q) == std::vector<uint32_t>({2, 4, 5, 6, 7, 8, 9, 10, 11, 12}));
  }

  // a lost segment file (records 5..8) and a cut-short one (records 9, 10)
  for (int kind = 0; kind < 2; kind++) {
    wipe(d, h);
    {
      BigQ q;
      CHECK(q.begin(d.c_str(), h.c_str(), 10));
      fill(q, 1, 10);
    }
    if (kind == 0) hostRemove(seg(d, 0, 1));
    if (kind == 1) {
      std::vector<uint8_t> s = hostRead(seg(d, 0, 2));
      s.resize(slot + 10);
      hostWrite(seg(d, 0, 2), s);
    }
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    // the short file still holds record 9 in full; only 10 is lost
    CHECK(kind == 0 ? ids(q) == std::vector<uint32_t>({1, 2, 3, 4, 9, 10}) : ids(q) == range(1, 9));
    fill(q, 11, 14);
    CHECK(q.count() == 10 && ids(q).back() == 14);
  }

  // damage that appears while running: peek fails once, the queue drops
  // just that record, and the caller starts over from count()
  wipe(d, h);
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 5);
    flipByte(seg(d, 0, 1), 0 * slot + 8);  // record 5 (slot 4)
    flipByte(seg(d, 0, 0), 1 * slot + 8);  // record 2 (slot 1)
    Big b;
    g_serialLog.clear();
    CHECK(q.peek(0, b) && b.id == 1);
    CHECK(!q.peek(1, b) && logged("rebuilding"));
    CHECK((ids(q) == std::vector<uint32_t>{1, 3, 4}) && q.dropped() == 2);
    CHECK(q.push(makeBig(6)) && ids(q) == std::vector<uint32_t>({1, 3, 4, 6}));
  }
  {  // ...and survives a reboot
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(ids(q) == std::vector<uint32_t>({1, 3, 4, 6}));
  }
}

// ---- capacity / layout changes (B61) ---------------------------------
inline void testCapacityChange() {
  const std::string d = "/cap.bin", h = "/cap.hdr";

  // the review's case: capacity 4, records 1..5 pushed (wrapped), pop 2
  // -> 4, 5; reflashed with capacity 8 used to read "4 0"
  wipe(d, h);
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 4));
    for (uint32_t i = 1; i <= 5; i++) CHECK(q.push({makeReading("NODE-04", 1, i), i}));
    CHECK(q.pop(2));
  }
  g_serialLog.clear();
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 8));
    CHECK(logged("QUEUE_CAPACITY"));
    Rec r0, r1;
    CHECK(q.count() == 2 && q.peek(0, r0) && q.peek(1, r1) && r0.r.seq == 4 && r1.r.seq == 5 && r1.t == 5);
    for (uint32_t i = 6; i <= 13; i++) CHECK(q.push({makeReading("NODE-04", 1, i), i}));
    CHECK(q.count() == 8 && q.peek(0, r0) && r0.r.seq == 6 && q.dropped() == 3);
  }

  // shrink keeps the NEWEST records; the rest count as dropped
  wipe(d, h);
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 13);  // wrapped: 4..13, 3 dropped
  }
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 5));
    CHECK(ids(q) == range(9, 13) && q.dropped() == 8);
    CHECK(countSegs(d, 1) == 2 && countSegs(d, 0) == 0);  // 4 + 1 slots, old files gone
  }
  {  // growing again keeps all 5
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(ids(q) == range(9, 13));
    fill(q, 14, 20);
    CHECK(ids(q) == range(11, 20));
  }
  {  // a different segment size (2 records per file) is a layout change too
    SjFileQueue<Big, 2048> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(ids(q) == range(11, 20) && countSegs(d, 1) == 5);
  }
  // record struct changed -> can't convert: empty + message, no misread
  g_serialLog.clear();
  {
    SjFileQueue<SjAck> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(q.count() == 0 && logged("record format changed"));
    CHECK(countSegs(d, 1) == 0 && countSegs(d, 0) == 1);  // 10 x 25 B fit in one file
  }
}

// ---- the old single-file format ("SJQ1") is converted, not lost ------
struct LegacyHeader {
  uint32_t magic, recordSize, head, count, dropped;
};
inline void writeLegacy(const std::string& d, const std::string& h, uint32_t cap, uint32_t head,
                        const std::vector<uint32_t>& ring /* id per slot, 0 = never written */, uint32_t count,
                        uint32_t dropped, uint32_t recordSize = sizeof(Rec)) {
  std::vector<uint8_t> data(cap * sizeof(Rec), 0);
  for (uint32_t s = 0; s < cap; s++) {
    if (!ring[s]) continue;
    Rec r = {makeReading("NODE-04", 1, ring[s]), ring[s] * 10};
    std::memcpy(data.data() + s * sizeof(Rec), &r, sizeof(Rec));
  }
  hostWrite(d, data);
  LegacyHeader lh = {0x534A5131, recordSize, head, count, dropped};
  hostWrite(h, std::vector<uint8_t>((uint8_t*)&lh, (uint8_t*)&lh + sizeof(lh)));
}
inline std::vector<uint32_t> recSeqs(SjFileQueue<Rec>& q) {
  std::vector<uint32_t> v;
  for (uint32_t i = 0; i < q.count(); i++) {
    Rec r;
    if (!q.peek(i, r) || r.t != r.r.seq * 10) return {0xFFFFFFFFu};
    v.push_back(r.r.seq);
  }
  return v;
}
inline void testLegacy() {
  const std::string d = "/lg.bin", h = "/lg.hdr";
  // wrapped old ring: capacity 6, head 4 -> slots 4,5,0,1 = 11,12,13,14
  wipe(d, h);
  writeLegacy(d, h, 6, 4, {13, 14, 0, 0, 11, 12}, 4, 2);
  g_serialLog.clear();
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 2000));
    CHECK(logged("converting"));
    CHECK((recSeqs(q) == std::vector<uint32_t>{11, 12, 13, 14}) && q.dropped() == 2);
    CHECK(!hostExists(d) && countSegs(d, 0) == 36);  // 2000 / 56 per segment (node config.h)
  }
  {  // converted once; a reboot finds the new format
    g_serialLog.clear();
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 2000));
    CHECK(!logged("converting") && q.count() == 4);
  }
  // zero padding inside the old ring (left by bug B61) is not sent
  wipe(d, h);
  writeLegacy(d, h, 6, 0, {1, 2, 0, 4, 0, 0}, 4, 0);
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 2000));
    CHECK((recSeqs(q) == std::vector<uint32_t>{1, 2, 4}) && q.dropped() == 1);
  }
  // old queue of a different record struct -> empty + message
  wipe(d, h);
  writeLegacy(d, h, 6, 0, {1, 2, 0, 0, 0, 0}, 2, 0, 58);
  g_serialLog.clear();
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 2000));
    CHECK(q.count() == 0 && logged("record format changed") && !hostExists(d));
  }
  wipe(d, h);
}

// ---- power cut at every flash commit ---------------------------------
// setup() builds a known state, op() runs with the power failing after k
// commits (k = 0, 1, 2, ... until op() finishes uncut), then a fresh queue
// object is begun ("reboot") with `cap` and check() judges what survived.
inline void sweep(const char* name, const std::string& d, const std::string& h, uint32_t cap,
                  const std::function<void()>& setup, const std::function<void()>& op,
                  const std::function<bool(BigQ&)>& check, bool cutReboot = false) {
  for (long k = 0; k < 2000; k++) {
    for (long j = 0; j < (cutReboot ? 2000 : 1); j++) {
      wipe(d, h);
      setup();
      g_fsCommitBudget = k;
      op();
      bool cut = g_fsDead;
      fsPowerRestored();
      bool rebootCut = false;
      if (cutReboot && cut) {  // the power fails again while begin() repairs
        g_fsCommitBudget = j;
        BigQ q;
        q.begin(d.c_str(), h.c_str(), cap);
        rebootCut = g_fsDead;
        fsPowerRestored();
      }
      BigQ q;
      bool ok = q.begin(d.c_str(), h.c_str(), cap) && check(q) && countSegs(d, 0) + countSegs(d, 1) == (int)((cap + 3) / 4);
      if (!ok) {
        std::printf("FAIL power cut during %s after %ld (+%ld) commit(s)\n", name, k, j);
        failures++;
        return;
      }
      if (!cut) return;        // op() completed: every cut point was covered
      if (!rebootCut) break;   // this k is done for every j
    }
  }
}

inline void testPowerCuts() {
  const std::string d = "/pc.bin", h = "/pc.hdr";
  auto open = [&](uint32_t cap) {
    BigQ q;
    q.begin(d.c_str(), h.c_str(), cap);
    return q;
  };
  sweep("push (not full)", d, h, 10, [&] { BigQ q = open(10); fill(q, 1, 5); },
        [&] { BigQ q = open(10); q.push(makeBig(6)); },
        [](BigQ& q) { return ids(q) == range(1, 5) || ids(q) == range(1, 6); });
  std::vector<uint32_t> oldestReplaced = range(1, 10);
  oldestReplaced[0] = 11;  // documented: the resend becomes a duplicate
  sweep("push (full ring)", d, h, 10, [&] { BigQ q = open(10); fill(q, 1, 10); },
        [&] { BigQ q = open(10); q.push(makeBig(11)); },
        [&](BigQ& q) { return ids(q) == range(1, 10) || ids(q) == range(2, 11) || ids(q) == oldestReplaced; });
  sweep("pop", d, h, 10, [&] { BigQ q = open(10); fill(q, 1, 5); },
        [&] { BigQ q = open(10); q.pop(2); },
        [](BigQ& q) { return ids(q) == range(1, 5) || ids(q) == range(3, 5); });
  sweep("clear", d, h, 10, [&] { BigQ q = open(10); fill(q, 1, 5); },
        [&] { BigQ q = open(10); q.clear(); },
        [](BigQ& q) { return ids(q) == range(1, 5) || q.count() == 0; });
  sweep("first begin", d, h, 10, [] {}, [&] { open(10); },
        [](BigQ& q) { return q.count() == 0 && q.push(makeBig(1)) && ids(q) == range(1, 1); });
  // migrations must always end with every record (redone after a cut),
  // even when the power fails again during the redo
  sweep("capacity change", d, h, 7, [&] { BigQ q = open(10); fill(q, 1, 13); },
        [&] { open(7); }, [](BigQ& q) { return ids(q) == range(7, 13) && q.dropped() == 6; }, true);
  sweep("corrupt-record repair", d, h, 10,
        [&] {
          BigQ q = open(10);
          fill(q, 1, 6);
          flipByte(seg(d, 0, 0), 2 * (sizeof(Big) + 4) + 50);
        },
        [&] { open(10); }, [](BigQ& q) { return ids(q) == std::vector<uint32_t>({1, 2, 4, 5, 6}); }, true);
  sweep("record-format reset", d, h, 10,
        [&] {
          SjFileQueue<SjAck> q;
          q.begin(d.c_str(), h.c_str(), 400);
        },
        [&] { open(10); }, [](BigQ& q) { return q.count() == 0; }, true);
}

// ---- a full or failing flash: a failed copy keeps the old queue ------
// (the power-cut sweeps above never reach this: a cut stops every later
// flash operation, so nothing is deleted after it)
inline void testFlashFull() {
  const std::string d = "/ff.bin", h = "/ff.hdr";
  const size_t slot = sizeof(Big) + 4;

  // QUEUE_CAPACITY raised so far that the new copy doesn't fit next to the
  // old one: the queued readings stay, at the old size
  wipe(d, h);
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 8);
  }
  g_fsByteQuota = (long)fsStoredBytes() + 20000;  // capacity 40 needs 40160 B
  for (int boot = 0; boot < 2; boot++) {  // and again at the next boot, still full
    g_serialLog.clear();
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 40));
    CHECK(logged("no room to move") && !logged("starting empty"));
    CHECK(ids(q) == range(1, 8 + boot) && q.dropped() == 0);
    CHECK(countSegs(d, 1) == 0 && countSegs(d, 0) == 3);  // partial copy removed
    if (boot == 0) CHECK(q.push(makeBig(9)) && ids(q) == range(1, 9));
  }
  fsPowerRestored();  // room again: the next boot moves them
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 40));
    CHECK(ids(q) == range(1, 9) && countSegs(d, 1) == 10 && countSegs(d, 0) == 0);
    fill(q, 10, 45);
    CHECK(ids(q) == range(6, 45));
  }

  // a damaged record found while running, and no room to rebuild: the rest
  // stay, and one-at-a-time callers (peek(0)) get past the bad record
  wipe(d, h);
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 5);
    flipByte(seg(d, 0, 0), 2 * slot + 8);  // record 3
    g_fsByteQuota = (long)fsStoredBytes() + 5000;  // a rebuild needs 10040 B
    Big b;
    g_serialLog.clear();
    CHECK(q.peek(0, b) && b.id == 1);
    CHECK(!q.peek(2, b) && logged("keeping the queue as it is") && !logged("starting empty"));
    CHECK(q.count() == 5 && q.dropped() == 0 && countSegs(d, 1) == 0);
    std::vector<uint32_t> sent;
    for (int guard = 0; guard < 20 && q.count() > 0; guard++)
      if (q.peek(0, b) && intact(b)) {
        sent.push_back(b.id);
        q.pop(1);
      }
    CHECK((sent == std::vector<uint32_t>{1, 2, 4, 5}) && q.count() == 0 && q.dropped() == 1);
    CHECK(q.push(makeBig(6)) && ids(q) == range(6, 6));
  }
  fsPowerRestored();
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK(ids(q) == range(6, 6) && q.dropped() == 1);
  }

  // the old single-file format can't be kept (nothing could read it), so
  // a failed conversion still starts empty - the documented last resort
  wipe(d, h);
  {
    std::vector<uint32_t> ring(200, 0);
    for (uint32_t s = 0; s < 50; s++) ring[s] = s + 1;
    writeLegacy(d, h, 200, 0, ring, 50, 0);  // 13600 B
  }
  // capacity 2000 = 144000 B: no room next to the old 13600 B file, room without it
  g_fsByteQuota = (long)fsStoredBytes() + 140000;
  g_serialLog.clear();
  {
    SjFileQueue<Rec> q;
    CHECK(q.begin(d.c_str(), h.c_str(), 2000));
    CHECK(logged("converting") && logged("starting empty") && q.count() == 0 && !hostExists(d));
    CHECK(q.push({makeReading("NODE-04", 1, 77), 770}) && (recSeqs(q) == std::vector<uint32_t>{77}));
  }
  fsPowerRestored();
  wipe(d, h);
}

// ---- a queue that can't write anything reads as empty ----------------
// Otherwise count() kept its old value while every peek/push failed, and
// the gateway's forward task retried it every 20 ms.
inline void testDeadQueue() {
  const std::string d = "/dq.bin", h = "/dq.hdr";
  const size_t slot = sizeof(Big) + 4;
  for (int kind = 0; kind < 2; kind++) {
    wipe(d, h);
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 12);  // wrapped: 3..12, dropped 2 (a stale dropped() shows too)
    flipByte(seg(d, 0, 0), 3 * slot + 8);  // record 4 (index 1, slot 3)
    if (kind == 0) g_fsDead = true;         // power gone: nothing works
    if (kind == 1) g_fsFailCommits = true;  // failing flash: reads work, writes don't
    Big b;
    g_serialLog.clear();
    CHECK(!q.peek(1, b) && logged("could not rewrite"));
    CHECK(q.count() == 0 && q.dropped() == 0 && !q.push(makeBig(13)) && !q.peek(0, b));
    fsPowerRestored();
    BigQ again;  // nothing was deleted: the next boot repairs it
    CHECK(again.begin(d.c_str(), h.c_str(), 10));
    CHECK((ids(again) == std::vector<uint32_t>{3, 5, 6, 7, 8, 9, 10, 11, 12}) && again.dropped() == 3);
  }
  // the same repair failing inside begin()
  wipe(d, h);
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    fill(q, 1, 5);
  }
  flipByte(seg(d, 0, 0), 1 * slot + 8);
  g_fsFailCommits = true;
  {
    BigQ q;
    CHECK(!q.begin(d.c_str(), h.c_str(), 10) && q.count() == 0 && !q.push(makeBig(9)));
  }
  fsPowerRestored();
  {
    BigQ q;
    CHECK(q.begin(d.c_str(), h.c_str(), 10));
    CHECK((ids(q) == std::vector<uint32_t>{1, 3, 4, 5}));
  }
  wipe(d, h);
}

inline void runQueueTests() {
  g_serialQuiet = true;
  testModel();
  testWear();
  testCorruption();
  testCapacityChange();
  testLegacy();
  testFlashFull();
  testDeadQueue();
  testPowerCuts();
  g_serialQuiet = false;
  g_serialLog.clear();
}

}  // namespace qt
