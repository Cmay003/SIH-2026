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
// Crash safety: data is written before the header, so a power cut between
// the two at worst re-sends one reading (the backend ignores duplicates
// via reading_uid) - it never loses or corrupts other records.
// Flash wear: LittleFS wear-levels across the partition; at one write per
// 60 s report that is far below the flash's rated endurance.
// =====================================================================
#pragma once
#include <Arduino.h>
#include <LittleFS.h>

template <typename T>
class SjFileQueue {
 public:
  bool begin(const char* dataPath, const char* headerPath, uint32_t capacity) {
    dataPath_ = dataPath;
    headerPath_ = headerPath;
    capacity_ = capacity;
    if (!LittleFS.begin(true)) {  // true = format on first use
      Serial.println("[queue] LittleFS mount failed");
      return false;
    }
    loadHeader();
    // Pre-size the data file so every slot can be written in place
    size_t wanted = (size_t)capacity_ * sizeof(T);
    File f = LittleFS.open(dataPath_, LittleFS.exists(dataPath_) ? "r+" : "w+");
    if (!f) return false;
    if (f.size() < wanted) {
      f.seek(f.size());
      uint8_t zeros[64] = {0};
      for (size_t left = wanted - f.size(); left > 0;) {
        size_t n = left < sizeof(zeros) ? left : sizeof(zeros);
        f.write(zeros, n);
        left -= n;
      }
    }
    f.close();
    if (header_.count > capacity_ || header_.head >= capacity_) resetHeader();
    return true;
  }

  uint32_t count() const { return header_.count; }
  uint32_t dropped() const { return header_.dropped; }

  bool push(const T& record) {
    uint32_t slot = (header_.head + header_.count) % capacity_;
    if (!writeSlot(slot, record)) return false;
    if (header_.count == capacity_) {
      header_.head = (header_.head + 1) % capacity_;  // overwrote the oldest
      header_.dropped++;
    } else {
      header_.count++;
    }
    return saveHeader();
  }

  // i = 0 is the oldest record
  bool peek(uint32_t i, T& out) {
    if (i >= header_.count) return false;
    File f = LittleFS.open(dataPath_, "r");
    if (!f) return false;
    f.seek((size_t)((header_.head + i) % capacity_) * sizeof(T));
    bool ok = f.read((uint8_t*)&out, sizeof(T)) == sizeof(T);
    f.close();
    return ok;
  }

  // Overwrites record i in place (e.g. to update a retry counter)
  bool update(uint32_t i, const T& record) {
    if (i >= header_.count) return false;
    return writeSlot((header_.head + i) % capacity_, record);
  }

  bool pop(uint32_t n = 1) {
    if (n > header_.count) n = header_.count;
    header_.head = (header_.head + n) % capacity_;
    header_.count -= n;
    return saveHeader();
  }

  void clear() { resetHeader(); }

 private:
  struct Header {
    uint32_t magic;
    uint32_t recordSize;
    uint32_t head;
    uint32_t count;
    uint32_t dropped;
  };
  static const uint32_t kMagic = 0x534A5131;  // "SJQ1"

  const char* dataPath_ = nullptr;
  const char* headerPath_ = nullptr;
  uint32_t capacity_ = 0;
  Header header_ = {kMagic, sizeof(T), 0, 0, 0};

  bool writeSlot(uint32_t slot, const T& record) {
    File f = LittleFS.open(dataPath_, "r+");
    if (!f) return false;
    f.seek((size_t)slot * sizeof(T));
    bool ok = f.write((const uint8_t*)&record, sizeof(T)) == sizeof(T);
    f.close();
    return ok;
  }

  void loadHeader() {
    File f = LittleFS.open(headerPath_, "r");
    Header h;
    if (f && f.read((uint8_t*)&h, sizeof(h)) == sizeof(h) && h.magic == kMagic && h.recordSize == sizeof(T)) {
      header_ = h;
    } else {
      resetHeader();  // first boot, or the record layout changed
    }
    if (f) f.close();
  }

  bool saveHeader() {
    File f = LittleFS.open(headerPath_, "w");
    if (!f) return false;
    bool ok = f.write((const uint8_t*)&header_, sizeof(header_)) == sizeof(header_);
    f.close();
    return ok;
  }

  void resetHeader() {
    header_ = {kMagic, sizeof(T), 0, 0, 0};
    saveHeader();
  }
};
