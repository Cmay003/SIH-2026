// LittleFS stand-in so sj_file_queue.h's persistence can be tested
// (including "reboots": a new queue object reading the same files).
// Files live in memory (g_fsFiles), not on disk: the power-cut sweeps make
// thousands of commits, and a host file write costs ~7 ms on Windows.
//
// It copies the LittleFS behaviour the queue's safety depends on:
//  - an open file's changes become visible only when it is closed (or
//    the last File copy goes away), all at once - "w" included, so an
//    interrupted rewrite leaves the old content;
//  - g_fsCommitBudget simulates a power cut: after that many commits
//    (closes with changes, removes) the next one is lost and every later
//    call fails, until fsPowerRestored() - the "reboot";
//  - g_fsBytesProgrammed counts what copy-on-write really rewrites: a
//    file from the block holding its first changed byte to its end;
//  - g_fsByteQuota simulates a FULL flash and g_fsFailCommits a FAILING
//    one: writes/commits fail, but - unlike a power cut - the filesystem
//    stays alive and reads/exists() keep working, so the queue's
//    recovery path itself runs.
#pragma once
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "Arduino.h"

inline std::string g_fsRoot = ".";  // kept for test_firmware_logic.cpp's argv; files are in memory
inline std::map<std::string, std::vector<uint8_t>> g_fsFiles;  // path -> committed content
inline const size_t g_fsBlockSize = 4096;  // ESP32 LittleFS block (= flash sector)
inline long g_fsCommitBudget = -1;         // -1 = no power cut planned
inline bool g_fsDead = false;              // the simulated power cut happened
inline unsigned long g_fsCommits = 0;
inline unsigned long g_fsBytesProgrammed = 0;
// -1 = unlimited. Otherwise the most bytes all files may hold. Copy-on-
// write keeps a file's old content until the new one is committed, so a
// file being written counts with both (conservative: LittleFS copies only
// from the first changed block).
inline long g_fsByteQuota = -1;
inline bool g_fsFailCommits = false;  // every write/commit/remove fails

inline void fsPowerRestored() {
  g_fsDead = false;
  g_fsCommitBudget = -1;
  g_fsByteQuota = -1;
  g_fsFailCommits = false;
}

inline size_t fsStoredBytes() {
  size_t n = 0;
  for (const auto& kv : g_fsFiles) n += kv.second.size();
  return n;
}
// false = a file of `newSize` bytes being written (its old version still
// stored) would not fit the quota
inline bool fsRoomFor(size_t newSize) { return g_fsByteQuota < 0 || fsStoredBytes() + newSize <= (size_t)g_fsByteQuota; }

// true = this commit may happen; false = the power is (now) gone
inline bool fsTryCommit() {
  if (g_fsDead) return false;
  if (g_fsCommitBudget == 0) {
    g_fsDead = true;
    return false;
  }
  if (g_fsCommitBudget > 0) g_fsCommitBudget--;
  g_fsCommits++;
  return true;
}

class File {
 public:
  struct Impl {
    std::string path;
    std::vector<uint8_t> data;
    size_t pos = 0;
    bool writable = false;
    bool dirty = false;
    size_t firstChange = (size_t)-1;
    bool open = true;
    ~Impl() { close(); }
    void close() {
      if (!open) return;
      open = false;
      if (!dirty || g_fsFailCommits || !fsRoomFor(data.size()) || !fsTryCommit()) return;
      g_fsFiles[path] = data;
      size_t from = firstChange < data.size() ? firstChange / g_fsBlockSize * g_fsBlockSize : data.size();
      g_fsBytesProgrammed += data.size() - from;
    }
  };

  File() {}
  explicit File(std::shared_ptr<Impl> p) : p_(std::move(p)) {}
  explicit operator bool() const { return p_ && p_->open && !g_fsDead; }
  size_t size() const { return p_ ? p_->data.size() : 0; }
  bool seek(size_t pos) {
    if (!*this) return false;
    p_->pos = pos;  // past the end is allowed, as in LittleFS
    return true;
  }
  size_t read(uint8_t* buf, size_t n) {
    if (!*this || p_->pos >= p_->data.size()) return 0;
    size_t k = std::min(n, p_->data.size() - p_->pos);
    std::memcpy(buf, p_->data.data() + p_->pos, k);
    p_->pos += k;
    return k;
  }
  size_t write(const uint8_t* buf, size_t n) {
    if (!*this || !p_->writable || g_fsFailCommits) return 0;
    if (!fsRoomFor(std::max(p_->data.size(), p_->pos + n))) return 0;  // flash full
    if (p_->pos + n > p_->data.size()) {
      p_->firstChange = std::min(p_->firstChange, p_->data.size());
      p_->data.resize(p_->pos + n, 0);
    }
    std::memcpy(p_->data.data() + p_->pos, buf, n);
    p_->firstChange = std::min(p_->firstChange, p_->pos);
    p_->pos += n;
    p_->dirty = true;
    return n;
  }
  void close() {
    if (p_) p_->close();
    p_.reset();
  }

 private:
  std::shared_ptr<Impl> p_;
};

struct LittleFSStub {
  bool begin(bool) { return !g_fsDead; }
  bool exists(const char* p) { return !g_fsDead && g_fsFiles.count(p) > 0; }
  File open(const char* p, const char* mode) {
    if (g_fsDead) return File();
    auto impl = std::make_shared<File::Impl>();
    impl->path = p;
    std::string m(mode);
    if (m[0] == 'r') {
      auto it = g_fsFiles.find(p);
      if (it == g_fsFiles.end()) return File();  // like LittleFS: "r"/"r+" never create
      impl->data = it->second;
      impl->writable = m.find('+') != std::string::npos;
    } else if (m[0] == 'w') {
      impl->writable = true;
      impl->dirty = true;  // create/truncate, committed on close
      impl->firstChange = 0;
    } else {
      return File();  // "a" isn't used by the firmware
    }
    return File(impl);
  }
  bool remove(const char* p) {
    if (!exists(p) || g_fsFailCommits || !fsTryCommit()) return false;
    g_fsFiles.erase(p);
    return true;
  }
};
inline LittleFSStub LittleFS;
