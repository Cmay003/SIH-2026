// LittleFS stand-in backed by real files in a host directory, so
// sj_file_queue.h's persistence can be tested (including "reboots": a
// new queue object reading the same files).
#pragma once
#include <cstdio>
#include <string>
#include "Arduino.h"

inline std::string g_fsRoot = ".";

class File {
 public:
  File() {}
  explicit File(FILE* f) : f_(f) {}
  explicit operator bool() const { return f_ != nullptr; }
  size_t size() {
    long pos = std::ftell(f_);
    std::fseek(f_, 0, SEEK_END);
    long end = std::ftell(f_);
    std::fseek(f_, pos, SEEK_SET);
    return (size_t)end;
  }
  bool seek(size_t pos) { return std::fseek(f_, (long)pos, SEEK_SET) == 0; }
  size_t read(uint8_t* buf, size_t n) { return std::fread(buf, 1, n, f_); }
  size_t write(const uint8_t* buf, size_t n) {
    size_t w = std::fwrite(buf, 1, n, f_);
    std::fflush(f_);
    return w;
  }
  void close() {
    if (f_) std::fclose(f_);
    f_ = nullptr;
  }

 private:
  FILE* f_ = nullptr;
};

struct LittleFSStub {
  bool begin(bool) { return true; }
  std::string path(const char* p) { return g_fsRoot + p; }
  bool exists(const char* p) {
    FILE* f = std::fopen(path(p).c_str(), "rb");
    if (f) std::fclose(f);
    return f != nullptr;
  }
  File open(const char* p, const char* mode) {
    std::string m = std::string(mode) + "b";  // binary on Windows
    return File(std::fopen(path(p).c_str(), m.c_str()));
  }
};
inline LittleFSStub LittleFS;
