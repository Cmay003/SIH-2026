// =====================================================================
// SANJEEVNI - persistent FIFO queue of fixed-size records in LittleFS.
// KEEP IDENTICAL in firmware/sanjeevni_lora_node/ and
// firmware/sanjeevni_lora_gateway/ (checked by
// tools/firmware_host_test/run_tests.py).
//
// Store-and-forward: every reading is queued first and only removed once
// the next hop has acknowledged it, so a reading survives link outages
// AND reboots/power loss. Ring buffer: when full, the OLDEST record is
// overwritten - during a very long outage the newest data is the most
// useful for a live hazard picture.
//
// Storage layout (review B41 + B61):
//  - The ring is split into small segment files "<dataPath>.<gen>.<n>" of
//    at most kSegmentBytes (one 4 KB LittleFS block). LittleFS is
//    copy-on-write: changing bytes inside a file rewrites the file from
//    that block to its end. The old layout kept the whole ring in ONE
//    file, so a push on the gateway rewrote up to 256 KB / 63 erase
//    blocks - slower than the node's ACK timeout, and enough wear to kill
//    the flash in months. Now a push rewrites one segment (<= 4 KB, one
//    erase) plus the 36-byte header.
//  - Every slot is the record followed by its CRC-32. A slot that was
//    never written (zeros), a lost/short segment file or flash damage is
//    therefore DETECTED instead of being sent as a bogus all-zero reading.
//  - The header stores the layout (record size, capacity, records per
//    segment, which generation <gen> of segment files is live) plus
//    head/count/dropped and its own CRC. When QUEUE_CAPACITY (or the
//    segment size) changed since the queue was written, or the queue is
//    still in the old single-file "SJQ1" format, begin() copies the
//    queued records oldest-first into the OTHER generation's files (the
//    newest win if the new capacity is smaller), switches the header to
//    that generation in one write, then deletes the old files. A power
//    cut at any point leaves the old or the new queue intact - the next
//    begin() just redoes the copy. The copy needs free flash for a second
//    set of files: if it fails (no room, failing flash) the old queue is
//    KEPT - at its old size until the next boot tries again - instead of
//    being wiped.
//  - A changed record struct (sizeof(T), e.g. a firmware update that made
//    the packet longer) is converted the same way IF the caller passes an
//    upgrade function to begin() that understands the old record: each
//    queued record is read with the old size (its CRC checked) and
//    converted, oldest first - readings the node / gateway already
//    accepted survive the update. Without one, or if the copy fails (the
//    old records can't be kept as T), the queue starts empty, with a message.
//
// Crash safety of push(): LittleFS makes a file's new content visible only
// when it is closed, so each segment/header write is all-or-nothing. Data
// is written before the header. A power cut between the two loses only the
// reading being pushed (not ACKed yet, so the node resends it); if the
// ring was full, the oldest reading - about to be dropped anyway - is
// already replaced by the new one and the resend becomes a duplicate,
// which the backend ignores via reading_uid.
// Flash wear (estimate, not measured on hardware): ~1 block erase per push
// + header metadata commits, spread by LittleFS wear levelling.
// =====================================================================
#pragma once
#include <Arduino.h>
#include <LittleFS.h>

// CRC-32 (IEEE 802.3, reflected). Bitwise on purpose: no 1 KB table in
// RAM, and ~60 bytes per record cost nothing next to a flash write.
inline uint32_t sjQueueCrc32(const uint8_t* p, size_t n) {
  uint32_t crc = 0xFFFFFFFFu;
  while (n--) {
    crc ^= *p++;
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}

template <typename T, uint32_t kSegmentBytes = 4096>
class SjFileQueue {
 public:
  // Converts one record of an older layout (`size` bytes, CRC already
  // checked) to T. false = not convertible: that record is left out.
  typedef bool (*Upgrade)(const uint8_t* old, uint32_t size, T& out);
  static constexpr uint32_t kMaxOldRecord = 256;  // larger old records are not offered to `upgrade`

  bool begin(const char* dataPath, const char* headerPath, uint32_t capacity, Upgrade upgrade = nullptr) {
    dataPath_ = dataPath;
    headerPath_ = headerPath;
    capacity_ = capacity;
    upgrade_ = upgrade;
    perSeg_ = kSegmentBytes / kSlot ? kSegmentBytes / kSlot : 1;
    ready_ = false;
    header_ = Header();  // count()/dropped() read 0 if begin() fails
    if (capacity_ == 0) return false;
    char probe[kPathLen];
    if (!segPath(probe, 1, segCount(capacity_, perSeg_))) {
      Serial.println("[queue] data path too long for the segment file names");
      return false;
    }
    if (!LittleFS.begin(true)) {  // true = format on first use
      Serial.println("[queue] LittleFS mount failed");
      return false;
    }

    Header h;
    LegacyHeader lh;
    switch (readHeader(h, lh)) {
      case kHdrCurrent:
        if (h.capacity == capacity_ && h.perSeg == perSeg_) {
          header_ = h;
          // Leftovers of a rebuild/migration cut off after its header write.
          // One failed open each when there is nothing to delete.
          removeSegments(1 - h.gen, 0);
          if (LittleFS.exists(dataPath_)) LittleFS.remove(dataPath_);
          uint32_t bad = countUnreadable(h);
          if (bad == 0) {
            ready_ = true;
            return true;
          }
          Serial.printf("[queue] %u queued record(s) unreadable (flash damage or a lost file) - rebuilding without them\n",
                        (unsigned)bad);
          return rebuild(h, false);
        }
        Serial.printf("[queue] QUEUE_CAPACITY/layout changed (%u -> %u records) - moving %u queued reading(s) to the new layout\n",
                      (unsigned)h.capacity, (unsigned)capacity_, (unsigned)h.count);
        return rebuild(h, false);
      case kHdrLegacy:
        if (legacySource(lh, h)) {
          Serial.printf("[queue] converting the old single-file queue (%u reading(s)) to segment files\n",
                        (unsigned)h.count);
          return rebuild(h, true);
        }
        Serial.println("[queue] old-format queue unreadable - starting empty");
        return startFresh();
      case kHdrOldRecord:
        Serial.printf("[queue] record format changed (firmware update, %u -> %u bytes) - converting %u queued reading(s)\n",
                      (unsigned)h.recordSize, (unsigned)sizeof(T), (unsigned)h.count);
        return rebuild(h, false);
      case kHdrOtherRecord:
        Serial.println("[queue] record format changed (firmware update) - old queued readings can't be converted, starting empty");
        return startFresh();
      case kHdrDamaged:
        Serial.println("[queue] queue header damaged - starting empty");
        return startFresh();
      default:  // first boot
        return startFresh();
    }
  }

  // 0 while the queue is unusable: callers (gateway forwardTask, node
  // loop()) retry while count() > 0, and a dead queue must not keep them
  // spinning on a stale count.
  uint32_t count() const { return ready_ ? header_.count : 0; }
  uint32_t dropped() const { return header_.dropped; }

  bool push(const T& record) {
    if (!ready_) return false;
    uint32_t slot = (header_.head + header_.count) % capacity_;
    if (!writeSlot(slot, record)) return false;
    if (header_.count == capacity_) {
      header_.head = (header_.head + 1) % capacity_;  // overwrote the oldest
      header_.dropped++;
    } else {
      header_.count++;
    }
    return saveHeader(header_);
  }

  // i = 0 is the oldest record. false = no such record, or it can't be
  // read back intact - then the queue rebuilds itself without the
  // unreadable record(s) and the indices shift, so a caller must abandon
  // what it was assembling and start again from count() without pop()ing.
  // (Both sketches already do: a failed peek ends the batch/flush.) Without
  // this the gateway would retry the same broken record forever.
  // If the rebuild itself fails (flash full or failing) the old files are
  // kept as they are; an unreadable OLDEST record (i = 0) is then skipped
  // without a copy, so a caller that falls back to one record at a time
  // still gets past it.
  bool peek(uint32_t i, T& out) {
    if (!ready_ || i >= header_.count) return false;
    uint32_t slot = (header_.head + i) % capacity_;
    for (int attempt = 0; attempt < 2; attempt++) {  // a second read rules out a one-off read glitch
      Cursor c;
      if (readSlot(c, header_.gen, perSeg_, slot, out)) return true;
    }
    Serial.printf("[queue] queued record %u unreadable - rebuilding the queue without it\n", (unsigned)i);
    Header cur = header_;
    rebuild(cur, false);
    // Kept = the copy failed and the same generation is live with the same
    // records (a successful rebuild always switches generation, and
    // startFresh() leaves count 0, which i < cur.count rules out).
    bool kept = ready_ && header_.gen == cur.gen && header_.count == cur.count;
    if (kept && i == 0) {
      header_.dropped++;  // counted like the records a rebuild leaves out
      pop(1);
    }
    return false;
  }

  // Overwrites record i in place (e.g. to update a retry counter)
  bool update(uint32_t i, const T& record) {
    if (!ready_ || i >= header_.count) return false;
    return writeSlot((header_.head + i) % capacity_, record);
  }

  // The in-RAM state moves on even if the header write fails: those
  // readings were delivered, and at worst they are resent after a reboot.
  bool pop(uint32_t n = 1) {
    if (!ready_) return false;
    if (n > header_.count) n = header_.count;
    header_.head = (header_.head + n) % capacity_;
    header_.count -= n;
    return saveHeader(header_);
  }

  void clear() {
    if (!ready_) return;
    header_.head = 0;
    header_.count = 0;
    header_.dropped = 0;
    saveHeader(header_);
  }

 private:
  struct Header {
    uint32_t magic = kMagic;
    uint32_t recordSize = sizeof(T);
    uint32_t capacity = 0;
    uint32_t perSeg = 0;  // records per segment file
    uint32_t gen = 0;     // which set of segment files is live (0/1)
    uint32_t head = 0;
    uint32_t count = 0;
    uint32_t dropped = 0;
    uint32_t crc = 0;  // over all fields above
  };
  struct LegacyHeader {  // format "SJQ1": one ring file, capacity not stored
    uint32_t magic, recordSize, head, count, dropped;
  };
  // Holds one segment file open while records are read in order.
  struct Cursor {
    File f;
    uint32_t seg = 0xFFFFFFFFu;
    ~Cursor() {
      if (f) f.close();
    }
  };
  enum { kHdrNone, kHdrCurrent, kHdrLegacy, kHdrOldRecord, kHdrOtherRecord, kHdrDamaged };

  static constexpr uint32_t kMagic = 0x534A5132;        // "SJQ2"
  static constexpr uint32_t kLegacyMagic = 0x534A5131;  // "SJQ1"
  static constexpr size_t kSlot = sizeof(T) + sizeof(uint32_t);  // record + CRC-32
  static constexpr size_t kPathLen = 64;  // LittleFS's default name limit on the ESP32

  const char* dataPath_ = nullptr;
  const char* headerPath_ = nullptr;
  uint32_t capacity_ = 0;
  uint32_t perSeg_ = 1;
  bool ready_ = false;
  Header header_;
  Upgrade upgrade_ = nullptr;

  static uint32_t segCount(uint32_t cap, uint32_t perSeg) { return (cap + perSeg - 1) / perSeg; }
  static uint32_t segSlots(uint32_t cap, uint32_t perSeg, uint32_t seg) {
    uint32_t left = cap - seg * perSeg;
    return left < perSeg ? left : perSeg;
  }
  bool segPath(char* out, uint32_t gen, uint32_t seg) const {
    int n = snprintf(out, kPathLen, "%s.%u.%u", dataPath_, (unsigned)gen, (unsigned)seg);
    return n > 0 && (size_t)n < kPathLen;
  }
  static uint32_t headerCrc(const Header& h) {
    return sjQueueCrc32((const uint8_t*)&h, sizeof(Header) - sizeof(uint32_t));
  }
  static void pack(uint8_t* buf, const T& record) {
    memcpy(buf, &record, sizeof(T));
    uint32_t crc = sjQueueCrc32(buf, sizeof(T));
    memcpy(buf + sizeof(T), &crc, sizeof(crc));
  }

  // ---- reading -------------------------------------------------------
  bool readSlot(Cursor& c, uint32_t gen, uint32_t perSeg, uint32_t slot, T& out) {
    uint32_t seg = slot / perSeg;
    if (seg != c.seg) {
      if (c.f) c.f.close();
      char p[kPathLen];
      segPath(p, gen, seg);
      c.f = LittleFS.open(p, "r");  // a missing file just fails, quietly
      c.seg = seg;
    }
    uint8_t buf[kSlot];
    if (!c.f || !c.f.seek((uint32_t)((slot % perSeg) * kSlot)) || c.f.read(buf, kSlot) != kSlot) return false;
    uint32_t crc;
    memcpy(&crc, buf + sizeof(T), sizeof(crc));
    if (crc != sjQueueCrc32(buf, sizeof(T))) return false;
    memcpy(&out, buf, sizeof(T));
    return true;
  }

  // A record of an older firmware's layout (src.recordSize bytes + CRC),
  // through upgrade_ (only offered for kHdrOldRecord, see readHeader()).
  bool readOldSlot(Cursor& c, const Header& src, uint32_t slot, T& out) {
    uint32_t seg = slot / src.perSeg;
    if (seg != c.seg) {
      if (c.f) c.f.close();
      char p[kPathLen];
      segPath(p, src.gen, seg);
      c.f = LittleFS.open(p, "r");
      c.seg = seg;
    }
    uint8_t buf[kMaxOldRecord + sizeof(uint32_t)];
    size_t oldSlot = src.recordSize + sizeof(uint32_t);
    if (!upgrade_ || src.recordSize > kMaxOldRecord || !c.f ||
        !c.f.seek((uint32_t)((slot % src.perSeg) * oldSlot)) || c.f.read(buf, oldSlot) != oldSlot)
      return false;
    uint32_t crc;
    memcpy(&crc, buf + src.recordSize, sizeof(crc));
    if (crc != sjQueueCrc32(buf, src.recordSize)) return false;
    return upgrade_(buf, src.recordSize, out);
  }

  // Record i (0 = oldest) of a queue described by `src`; `legacy` = the
  // old single-file format, which has no per-record CRC.
  bool readSource(Cursor& c, const Header& src, bool legacy, uint32_t i, T& out) {
    uint32_t slot = (src.head + i) % src.capacity;
    if (!legacy && src.recordSize != sizeof(T)) return readOldSlot(c, src, slot, out);
    if (!legacy) return readSlot(c, src.gen, src.perSeg, slot, out);
    if (c.seg != 0) {
      c.f = LittleFS.open(dataPath_, "r");
      c.seg = 0;
    }
    if (!c.f || !c.f.seek((uint32_t)(slot * sizeof(T))) || c.f.read((uint8_t*)&out, sizeof(T)) != sizeof(T)) return false;
    // All zeros = padding the old format pre-sized but never wrote (bug
    // B61 could leave such slots inside the ring). A real reading always
    // has a non-zero packet magic.
    const uint8_t* b = (const uint8_t*)&out;
    for (size_t k = 0; k < sizeof(T); k++)
      if (b[k]) return true;
    return false;
  }

  uint32_t countUnreadable(const Header& h) {
    Cursor c;
    T rec;
    uint32_t bad = 0;
    for (uint32_t i = 0; i < h.count; i++)
      if (!readSource(c, h, false, i, rec)) bad++;
    return bad;
  }

  // ---- header --------------------------------------------------------
  int readHeader(Header& h, LegacyHeader& lh) {
    File f = LittleFS.open(headerPath_, "r");
    if (!f) return kHdrNone;
    uint8_t buf[sizeof(Header)];
    size_t n = f.read(buf, sizeof(buf));
    f.close();
    if (n == sizeof(Header)) {
      memcpy(&h, buf, sizeof(h));
      if (h.magic != kMagic || h.crc != headerCrc(h)) return kHdrDamaged;
      bool sane = h.capacity > 0 && h.perSeg > 0 && h.gen <= 1 && h.head < h.capacity && h.count <= h.capacity;
      if (h.recordSize != sizeof(T)) {
        bool convertible = upgrade_ && sane && h.recordSize > 0 && h.recordSize <= kMaxOldRecord;
        return convertible ? kHdrOldRecord : kHdrOtherRecord;
      }
      return sane ? kHdrCurrent : kHdrDamaged;
    }
    if (n == sizeof(LegacyHeader)) {
      memcpy(&lh, buf, sizeof(lh));
      if (lh.magic == kLegacyMagic) return lh.recordSize == sizeof(T) ? kHdrLegacy : kHdrOtherRecord;
    }
    return kHdrDamaged;
  }

  // The old format pre-sized its file to capacity * sizeof(T) and never
  // stored the capacity, so the file size is the best record of it.
  bool legacySource(const LegacyHeader& lh, Header& src) {
    File f = LittleFS.open(dataPath_, "r");
    size_t size = f ? f.size() : 0;
    if (f) f.close();
    uint32_t oldCap = (uint32_t)(size / sizeof(T));
    if (oldCap == 0 || lh.head >= oldCap || lh.count > oldCap) return false;
    src = Header();
    src.capacity = oldCap;
    src.perSeg = 1;  // unused for the single-file format
    src.head = lh.head;
    src.count = lh.count;
    src.dropped = lh.dropped;
    return true;
  }

  bool saveHeader(Header& h) {
    h.magic = kMagic;
    h.recordSize = sizeof(T);
    h.capacity = capacity_;
    h.perSeg = perSeg_;
    h.crc = headerCrc(h);
    File f = LittleFS.open(headerPath_, "w");
    if (!f) return false;
    bool ok = f.write((const uint8_t*)&h, sizeof(h)) == sizeof(h);
    f.close();
    return ok;
  }

  // For the one write that switches generations: Arduino's File::close()
  // can't report a failed commit, so read the header back.
  bool saveHeaderVerified(Header& h) {
    if (!saveHeader(h)) return false;
    Header back;
    LegacyHeader unused;
    return readHeader(back, unused) == kHdrCurrent && memcmp(&back, &h, sizeof(h)) == 0;
  }

  // ---- writing -------------------------------------------------------
  bool writeSlot(uint32_t slot, const T& record) {
    uint32_t seg = slot / perSeg_;
    char p[kPathLen];
    segPath(p, header_.gen, seg);
    size_t want = segSlots(capacity_, perSeg_, seg) * kSlot;
    File f = LittleFS.open(p, "r+");
    if (!f || f.size() != want) {
      // Segment lost or cut short: recreate it. Records it held are
      // already unreadable; peek() rebuilds the queue around them.
      if (f) f.close();
      if (!writeEmptySegment(p, want)) return false;
      f = LittleFS.open(p, "r+");
      if (!f) return false;
    }
    uint8_t buf[kSlot];
    pack(buf, record);
    bool ok = f.seek((uint32_t)((slot % perSeg_) * kSlot)) && f.write(buf, kSlot) == kSlot;
    f.close();
    return ok;
  }

  static size_t fileSize(const char* p) {
    File f = LittleFS.open(p, "r");
    if (!f) return (size_t)-1;
    size_t s = f.size();
    f.close();
    return s;
  }

  static bool writeEmptySegment(const char* p, size_t bytes) {
    File f = LittleFS.open(p, "w");
    if (!f) return false;
    uint8_t zeros[64] = {0};
    bool ok = true;
    for (size_t left = bytes; left > 0 && ok;) {
      size_t n = left < sizeof(zeros) ? left : sizeof(zeros);
      ok = f.write(zeros, n) == n;
      left -= n;
    }
    f.close();
    return ok && fileSize(p) == bytes;  // close() can't report a failed commit
  }

  // Deletes generation `gen`'s segment files, highest first: an
  // interrupted delete (or create, which goes lowest first) leaves
  // 0..k-1, so probing from 0 finds them all next time. atLeast covers
  // files beyond a gap.
  void removeSegments(uint32_t gen, uint32_t atLeast) {
    char p[kPathLen];
    uint32_t n = 0;
    while (segPath(p, gen, n) && LittleFS.exists(p)) n++;
    if (atLeast > n) n = atLeast;
    while (n > 0) {
      n--;
      segPath(p, gen, n);
      if (LittleFS.exists(p)) LittleFS.remove(p);
    }
  }

  // Writes generation `gen` for the current layout: the first `keep`
  // readable records of `src` after skipping `skip` readable ones,
  // oldest first from slot 0, zeros after. Returns how many it wrote,
  // or -1 on a write failure.
  long writeGeneration(uint32_t gen, const Header* src, bool legacy, uint32_t skip, uint32_t keep) {
    Cursor c;
    uint32_t i = 0, written = 0;
    uint8_t buf[kSlot];
    for (uint32_t seg = 0; seg < segCount(capacity_, perSeg_); seg++) {
      char p[kPathLen];
      segPath(p, gen, seg);
      uint32_t slots = segSlots(capacity_, perSeg_, seg);
      File f = LittleFS.open(p, "w");
      if (!f) return -1;
      bool ok = true;
      for (uint32_t j = 0; j < slots && ok; j++) {
        memset(buf, 0, kSlot);
        T rec;
        while (src && written < keep && i < src->count) {
          if (!readSource(c, *src, legacy, i++, rec)) continue;
          if (skip) {
            skip--;
            continue;
          }
          pack(buf, rec);
          written++;
          break;
        }
        ok = f.write(buf, kSlot) == kSlot;
      }
      f.close();
      if (!ok || fileSize(p) != slots * kSlot) return -1;
    }
    return (long)written;
  }

  // Copies the readable records of `src` into the other generation, newest
  // `capacity_` of them, then switches the header over (see the top).
  bool rebuild(const Header& src, bool legacy) {
    ready_ = false;
    uint32_t dst = legacy ? 0 : 1 - src.gen;
    removeSegments(dst, segCount(capacity_, perSeg_));  // frees space; a stale copy can't pass the size checks
    uint32_t readable = 0;
    {
      Cursor c;
      T rec;
      for (uint32_t i = 0; i < src.count; i++)
        if (readSource(c, src, legacy, i, rec)) readable++;
    }
    uint32_t keep = readable < capacity_ ? readable : capacity_;
    long written = writeGeneration(dst, &src, legacy, readable - keep, keep);
    if (written >= 0) {
      Header h;
      h.gen = dst;
      h.count = (uint32_t)written;
      h.dropped = src.dropped + (src.count - (uint32_t)written);
      if (saveHeaderVerified(h)) {
        header_ = h;
        ready_ = true;
        removeSegments(1 - dst, legacy ? 0 : segCount(src.capacity, src.perSeg));
        if (legacy && LittleFS.exists(dataPath_)) LittleFS.remove(dataPath_);
        if (src.count != h.count)
          Serial.printf("[queue] %u reading(s) could not be kept (unreadable or over the new capacity)\n",
                        (unsigned)(src.count - h.count));
        return true;
      }
    }
    // The copy failed (usually no room for two generations). The source
    // was never touched, so keep it instead of wiping both: losing queued
    // readings the nodes were already ACKed for is worse than staying on
    // the old layout / keeping a damaged record.
    removeSegments(dst, segCount(capacity_, perSeg_));  // free the partial copy
    if (!legacy && src.recordSize == sizeof(T)) {  // old-layout records can't be kept as T
      char probe[kPathLen];
      if (src.capacity != capacity_ || src.perSeg != perSeg_) {
        if (segPath(probe, 1, segCount(src.capacity, src.perSeg))) {
          Serial.printf("[queue] no room to move the queue to %u records - keeping the old size %u, retried at the next boot\n",
                        (unsigned)capacity_, (unsigned)src.capacity);
          // push/peek/pop all use these members; begin() resets them, so
          // the next boot tries the move again.
          capacity_ = src.capacity;
          perSeg_ = src.perSeg;
        }
      }
      if (src.capacity == capacity_ && src.perSeg == perSeg_) {
        Header keepH = src;  // the failed switch may have truncated the header file
        if (saveHeaderVerified(keepH)) {
          header_ = keepH;
          ready_ = true;
          Serial.println("[queue] could not write a rebuilt copy (flash full or failing?) - keeping the queue as it is");
          return true;
        }
      }
    }
    Serial.println("[queue] could not rewrite the queue (flash full or failing?) - starting empty");
    return startFresh();  // legacy source, or the header itself cannot be written
  }

  bool startFresh() {
    ready_ = false;
    // Reset before anything can fail: a failed runtime rebuild must not
    // leave a stale count()/dropped() behind (begin() resets on its own).
    header_ = Header();
    removeSegments(0, segCount(capacity_, perSeg_));
    removeSegments(1, segCount(capacity_, perSeg_));
    if (LittleFS.exists(dataPath_)) LittleFS.remove(dataPath_);  // old single-file format
    if (writeGeneration(0, nullptr, false, 0, 0) < 0) return false;
    Header h;
    if (!saveHeaderVerified(h)) return false;
    header_ = h;
    ready_ = true;
    Serial.printf("[queue] new empty queue for %u readings\n", (unsigned)capacity_);
    return true;
  }
};
