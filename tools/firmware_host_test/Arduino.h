// Minimal stand-in for the Arduino core so the firmware's pure-logic
// headers (sj_packet.h, sj_file_queue.h) compile and run on a PC.
// Only what those headers use is implemented.
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

class String {
 public:
  String() {}
  String(const char* s) : s_(s ? s : "") {}
  String(const std::string& s) : s_(s) {}
  String(char c) : s_(1, c) {}
  String(int v) : s_(std::to_string(v)) {}
  String(unsigned int v) : s_(std::to_string(v)) {}
  String(long v) : s_(std::to_string(v)) {}
  String(unsigned long v) : s_(std::to_string(v)) {}
  String(float v, unsigned char decimals = 2) : s_(fmt(v, decimals)) {}
  String(double v, unsigned char decimals = 2) : s_(fmt(v, decimals)) {}

  String& operator+=(const String& o) { s_ += o.s_; return *this; }
  String& operator+=(const char* o) { s_ += o; return *this; }
  String& operator+=(char c) { s_ += c; return *this; }
  friend String operator+(const String& a, const String& b) { return String(a.s_ + b.s_); }
  friend String operator+(const String& a, const char* b) { return String(a.s_ + b); }
  friend String operator+(const char* a, const String& b) { return String(std::string(a) + b.s_); }

  const char* c_str() const { return s_.c_str(); }
  size_t length() const { return s_.size(); }
  void reserve(size_t n) { s_.reserve(n); }
  char operator[](size_t i) const { return s_[i]; }

 private:
  std::string s_;
  static std::string fmt(double v, unsigned char d) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.*f", d, v);
    return buf;
  }
};

// Everything printed is also kept in g_serialLog so tests can check that a
// message was given; g_serialQuiet hides it from the console (the queue
// tests "reboot" hundreds of times).
inline std::string g_serialLog;
inline bool g_serialQuiet = false;
struct SerialStub {
  void println(const char* s) { emit(std::string(s) + "\n"); }
  template <typename... A>
  void printf(const char* f, A... a) {
    char buf[512];
    std::snprintf(buf, sizeof(buf), f, a...);
    emit(buf);
  }

 private:
  void emit(const std::string& s) {
    g_serialLog += s;
    if (!g_serialQuiet) std::fputs(s.c_str(), stdout);
  }
};
inline SerialStub Serial;
