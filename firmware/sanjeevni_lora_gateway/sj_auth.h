// =====================================================================
// SANJEEVNI - HMAC-SHA256 for the siren command in the gateway's ACK
// (SjAckCmd in sj_packet.h). KEEP IDENTICAL in firmware/sanjeevni_lora_node/
// and firmware/sanjeevni_lora_gateway/ (run_tests.py checks the copies
// match, and checks this code against Python's hashlib / hmac).
//
// Why: the node accepted any ACK_CMD whose node id / session / seq matched
// the reading it had just sent - and all three go out in plain text in
// that reading. Anyone with a LoRa module who answered inside the ACK
// window, ahead of the gateway, could sound a village siren or silence it
// during a real emergency (review). The command now carries a truncated
// HMAC with a key only that node and its gateway know.
//
// Keys (secrets.h on both boards, never in git):
//   gateway  SIREN_MASTER_KEY  32 bytes as 64 hex characters
//   node     SIREN_CMD_KEY     16 bytes as 32 hex characters =
//            the first 16 bytes of HMAC-SHA256(master, "<NODE_ID>")
// so one gateway secret serves every node, and a node that is stolen and
// read out gives away only its own key, not the other nodes'. The node's
// key is worked out on a PC (secrets.example.h has the one-line command).
//
// Plain portable C++ (FIPS 180-4 SHA-256, RFC 2104 HMAC) rather than the
// ESP32's mbedTLS, so the host tests run exactly this code; a few hundred
// bytes of flash, a few microseconds per command.
// =====================================================================
#pragma once
#ifndef SJ_AUTH_H_
#define SJ_AUTH_H_
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define SJ_SHA256_LEN 32

struct SjSha256 {
  uint32_t h[8];
  uint64_t bytes;  // message length so far
  uint8_t buf[64];
  uint8_t used;    // bytes waiting in buf
};

namespace sjauth {
static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};
inline uint32_t ror(uint32_t x, uint8_t n) { return (x >> n) | (x << (32 - n)); }

inline void block(SjSha256& s, const uint8_t* p) {
  uint32_t w[64];
  for (uint8_t i = 0; i < 16; i++)
    w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
  for (uint8_t i = 16; i < 64; i++) {
    uint32_t s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = s.h[0], b = s.h[1], c = s.h[2], d = s.h[3], e = s.h[4], f = s.h[5], g = s.h[6], h = s.h[7];
  for (uint8_t i = 0; i < 64; i++) {
    uint32_t t1 = h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
    uint32_t t2 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  s.h[0] += a;
  s.h[1] += b;
  s.h[2] += c;
  s.h[3] += d;
  s.h[4] += e;
  s.h[5] += f;
  s.h[6] += g;
  s.h[7] += h;
}
}  // namespace sjauth

inline void sjSha256Init(SjSha256& s) {
  static const uint32_t H0[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(s.h, H0, sizeof(H0));
  s.bytes = 0;
  s.used = 0;
}

inline void sjSha256Update(SjSha256& s, const uint8_t* d, size_t n) {
  s.bytes += n;
  while (n > 0) {
    size_t room = (size_t)(64u - s.used);
    size_t take = room < n ? room : n;
    memcpy(s.buf + s.used, d, take);
    s.used = (uint8_t)(s.used + take);
    d += take;
    n -= take;
    if (s.used == 64) {
      sjauth::block(s, s.buf);
      s.used = 0;
    }
  }
}

inline void sjSha256Final(SjSha256& s, uint8_t out[SJ_SHA256_LEN]) {
  const uint64_t bits = s.bytes * 8;
  const uint8_t one = 0x80, zero = 0;
  sjSha256Update(s, &one, 1);
  while (s.used != 56) sjSha256Update(s, &zero, 1);
  uint8_t len[8];
  for (uint8_t i = 0; i < 8; i++) len[i] = (uint8_t)(bits >> (56 - 8 * i));
  sjSha256Update(s, len, 8);
  for (uint8_t i = 0; i < 8; i++) {
    out[4 * i] = (uint8_t)(s.h[i] >> 24);
    out[4 * i + 1] = (uint8_t)(s.h[i] >> 16);
    out[4 * i + 2] = (uint8_t)(s.h[i] >> 8);
    out[4 * i + 3] = (uint8_t)s.h[i];
  }
}

// RFC 2104. Keys up to 64 bytes (ours are 16 and 32).
inline void sjHmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen,
                         uint8_t out[SJ_SHA256_LEN]) {
  uint8_t k[64];
  memset(k, 0, sizeof(k));
  if (keyLen > 64) {
    SjSha256 s;
    sjSha256Init(s);
    sjSha256Update(s, key, keyLen);
    sjSha256Final(s, k);
  } else {
    memcpy(k, key, keyLen);
  }
  uint8_t pad[64];
  SjSha256 s;
  for (uint8_t i = 0; i < 64; i++) pad[i] = k[i] ^ 0x36;
  sjSha256Init(s);
  sjSha256Update(s, pad, 64);
  sjSha256Update(s, msg, msgLen);
  uint8_t inner[SJ_SHA256_LEN];
  sjSha256Final(s, inner);
  for (uint8_t i = 0; i < 64; i++) pad[i] = k[i] ^ 0x5c;
  sjSha256Init(s);
  sjSha256Update(s, pad, 64);
  sjSha256Update(s, inner, sizeof(inner));
  sjSha256Final(s, out);
}

// Exactly 2 * len hex digits (either case) -> len bytes. false = anything
// else (empty, the example's placeholder, a typo): no key.
inline bool sjParseHexKey(const char* hex, uint8_t* out, size_t len) {
  if (!hex || strlen(hex) != 2 * len) return false;
  for (size_t i = 0; i < 2 * len; i++) {
    char c = hex[i];
    uint8_t v;
    if (c >= '0' && c <= '9') {
      v = (uint8_t)(c - '0');
    } else if (c >= 'a' && c <= 'f') {
      v = (uint8_t)(c - 'a' + 10);
    } else if (c >= 'A' && c <= 'F') {
      v = (uint8_t)(c - 'A' + 10);
    } else {
      return false;
    }
    if (i % 2 == 0) {
      out[i / 2] = (uint8_t)(v << 4);
    } else {
      out[i / 2] |= v;
    }
  }
  return true;
}

// Constant-time compare: how many bytes matched must not show in the timing.
inline bool sjSameBytes(const uint8_t* a, const uint8_t* b, size_t n) {
  uint8_t diff = 0;
  for (size_t i = 0; i < n; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

#endif  // SJ_AUTH_H_
