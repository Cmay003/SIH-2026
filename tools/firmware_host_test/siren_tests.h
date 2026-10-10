// Tests for the village siren: the node's rules (sj_siren.h - offline
// fallback, on-time / cooldown / re-arm, commands, millis() wrap), the
// downlink in the ACK window (SjAckCmd in sj_packet.h), the server's
// "commands" JSON (sjParseSirenCommands) and the gateway's table of
// commands waiting for their node (sj_siren_cmd.h). Included by
// test_firmware_logic.cpp (uses its CHECK and makeReading).
#pragma once
#include <algorithm>
#include <cstring>
#include <string>

namespace siren {

const uint32_t S = 1000;  // ms per second
// The shipped config.h values, so a change there is tested too.
const SjSirenTiming T = {SIREN_OFFLINE_AFTER_S * S, SIREN_OFFLINE_URGENT_SAMPLES, SIREN_ON_S * S, SIREN_MAX_ON_S * S,
                         SIREN_COOLDOWN_S * S};
const uint32_t SAMPLE = SAMPLE_INTERVAL_MS;

// ---- offline fallback: when the node may sound it itself -----------------
inline void offlineTests(uint32_t base) {
  CHECK(SIREN_OFFLINE_AFTER_S == 900 && SIREN_OFFLINE_URGENT_SAMPLES == 2);  // the user's decision (A)
  SjSiren s;

  // online (an ACK with every 60-s report): URGENT never sounds it - the server decides
  sjSirenBegin(s, base);
  bool everOn = false;
  for (uint32_t t = 0; t <= 3600 * S; t += SAMPLE) {
    if (t % (60 * S) == 0) sjSirenAck(s, base + t);
    sjSirenSample(s, true, base + t, T);
    everOn |= s.on;
  }
  CHECK(!everOn && !sjSirenTakeChanged(s) && !s.offline);

  // no ACK since boot, URGENT all along: silent until exactly 900 s
  sjSirenBegin(s, base);
  for (uint32_t t = 0; t < 900 * S; t += SAMPLE) sjSirenSample(s, true, base + t, T);
  CHECK(!s.on && !s.offline && s.urgentStreak >= 2);
  sjSirenSample(s, true, base + 900 * S, T);
  CHECK(s.on && s.offline && s.reason == SJ_SIREN_AUTO_OFFLINE && s.onForMs == SIREN_ON_S * S);
  CHECK(sjSirenTakeChanged(s) && !sjSirenTakeChanged(s));  // reported once
  CHECK(sjSirenFlags(s) == (SJ_SIREN_FITTED | SJ_SIREN_ON));  // no BY_COMMAND = "auto_offline"

  // offline, but URGENT needs 2 CONSECUTIVE samples
  sjSirenBegin(s, base);
  sjSirenTick(s, base + 900 * S, T);
  CHECK(s.offline && !s.on);
  sjSirenSample(s, true, base + 905 * S, T);
  CHECK(!s.on);  // one sample: a glitch
  sjSirenSample(s, false, base + 910 * S, T);
  sjSirenSample(s, true, base + 915 * S, T);
  CHECK(!s.on);  // urgent, normal, urgent: not consecutive
  sjSirenSample(s, true, base + 920 * S, T);
  CHECK(s.on && s.reason == SJ_SIREN_AUTO_OFFLINE);

  // an ACK restarts the 900 s
  sjSirenBegin(s, base);
  for (uint32_t t = 0; t < 1500 * S; t += SAMPLE) {
    if (t == 600 * S) sjSirenAck(s, base + t);
    sjSirenSample(s, true, base + t, T);
  }
  CHECK(!s.on && !s.offline);
  sjSirenSample(s, true, base + 1500 * S, T);
  CHECK(s.on && s.offline);

  // the node's verdict for one reading (sjSirenLocalUrgent)
  SjReading r = makeReading("NODE-07", 1, 1);
  CHECK(!sjSirenLocalUrgent(r, 1000, 800));  // nothing measured
  r.edge_risk = 2;
  CHECK(!sjSirenLocalUrgent(r, 1000, 800));  // an edge-AI URGENT alone is no siren trigger (decision 2026-10-09)
  r.edge_risk = 1;
  CHECK(!sjSirenLocalUrgent(r, 0, 0));
  r.flags = SJ_HAS_WATER | SJ_HAS_GAS;
  r.water_level_mm = 999;
  r.gas_ppm = 799;
  CHECK(!sjSirenLocalUrgent(r, 1000, 800));
  r.water_level_mm = 1000;
  CHECK(sjSirenLocalUrgent(r, 1000, 800) && !sjSirenLocalUrgent(r, 0, 800));  // 0 = check off
  r.water_level_mm = 0;
  r.gas_ppm = 800;
  CHECK(sjSirenLocalUrgent(r, 1000, 800) && !sjSirenLocalUrgent(r, 1000, 0));
  r.flags = SJ_HAS_WATER;  // a value without its flag (sensor absent) never counts
  CHECK(!sjSirenLocalUrgent(r, 1000, 800));
  CHECK(SIREN_LOCAL_GAS_PPM >= LOCAL_GAS_LIMIT_PPM && SIREN_LOCAL_WATER_FRACTION >= LOCAL_WATER_FRACTION_LIMIT);
}

// ---- one trigger's on-time, the cooldown, re-arming ----------------------
inline void onTimeCooldownTests(uint32_t base) {
  SjSiren s;
  sjSirenBegin(s, base);
  uint32_t on = base + 900 * S;  // sounds here (as above)
  for (uint32_t t = 0; t <= 900 * S; t += SAMPLE) sjSirenSample(s, true, base + t, T);
  CHECK(s.on);
  sjSirenTakeChanged(s);
  sjSirenTick(s, on + SIREN_ON_S * S - 1, T);
  CHECK(s.on);
  sjSirenTick(s, on + SIREN_ON_S * S, T);  // max on-time per trigger
  CHECK(!s.on && s.inCooldown && sjSirenTakeChanged(s) && sjSirenFlags(s) == SJ_SIREN_FITTED);
  uint32_t off = on + SIREN_ON_S * S;
  // still URGENT and offline: quiet for the whole cooldown... (loops count
  // relative time: an absolute bound would itself break at the wrap)
  for (uint32_t d = 0; d < SIREN_COOLDOWN_S * S; d += SAMPLE) {
    sjSirenSample(s, true, off + d, T);
    CHECK(!s.on);
  }
  // ...then re-armed at once, because it is STILL urgent
  uint32_t t = off + SIREN_COOLDOWN_S * S;
  sjSirenSample(s, true, t, T);
  CHECK(s.on && s.reason == SJ_SIREN_AUTO_OFFLINE && sjSirenTakeChanged(s));

  // not urgent any more when the cooldown ends: stays quiet; urgent again
  // later: two samples, as always
  sjSirenTick(s, t + SIREN_ON_S * S, T);
  CHECK(!s.on);
  uint32_t u = t + (SIREN_ON_S + SIREN_COOLDOWN_S) * S;
  sjSirenSample(s, false, u, T);
  sjSirenSample(s, false, u + SAMPLE, T);
  CHECK(!s.on && !s.inCooldown);
  sjSirenSample(s, true, u + 2 * SAMPLE, T);
  CHECK(!s.on);
  sjSirenSample(s, true, u + 3 * SAMPLE, T);
  CHECK(s.on);

  // the link comes back during a self-started sounding: it runs to its end
  // (the server takes over from there), and is not re-armed while online
  sjSirenBegin(s, base);
  for (uint32_t k = 0; k <= 900 * S; k += SAMPLE) sjSirenSample(s, true, base + k, T);
  CHECK(s.on);
  sjSirenAck(s, on + 30 * S);
  sjSirenTick(s, on + 31 * S, T);
  CHECK(s.on && !s.offline);
  bool reArmed = false;
  for (uint32_t d = 35 * S; d < 3600 * S; d += SAMPLE) {
    if (d % (60 * S) == 0) sjSirenAck(s, on + d);
    sjSirenSample(s, true, on + d, T);
    if (d >= (SIREN_ON_S + 1) * S) reArmed |= s.on;
  }
  CHECK(!reArmed && !s.on);
}

// ---- commands from the server ---------------------------------------------
inline void commandTests(uint32_t base) {
  SjSiren s;
  sjSirenBegin(s, base);
  sjSirenAck(s, base);
  // "on" without for_s: the default time
  CHECK(sjSirenCommand(s, true, 0, base, T));
  CHECK(s.on && s.reason == SJ_SIREN_COMMAND && s.onForMs == SIREN_ON_S * S);
  CHECK(sjSirenFlags(s) == (SJ_SIREN_FITTED | SJ_SIREN_ON | SJ_SIREN_BY_COMMAND));
  CHECK(sjSirenTakeChanged(s));
  // the same "on" again (the gateway repeats it; older queued readings
  // still say "silent"): no restart, no extension
  CHECK(!sjSirenCommand(s, true, 500, base + 100 * S, T));
  CHECK(s.onAtMs == base && s.onForMs == SIREN_ON_S * S && !sjSirenTakeChanged(s));
  sjSirenTick(s, base + SIREN_ON_S * S, T);
  CHECK(!s.on && sjSirenTakeChanged(s));
  // for_s is capped at SIREN_MAX_ON_S; tiny values still sound >= 1 s
  CHECK(sjSirenCommand(s, true, 65535, base + 1000 * S, T) && s.onForMs == SIREN_MAX_ON_S * S);
  CHECK(sjSirenCommand(s, false, 0, base + 1001 * S, T) && !s.on && s.inCooldown);
  CHECK(!sjSirenCommand(s, false, 0, base + 1002 * S, T));  // off when off: nothing changes
  // an officer's "on" is not held back by the cooldown (a human decided)
  CHECK(sjSirenCommand(s, true, 1, base + 1003 * S, T) && s.on && s.onForMs == 1 * S);
  sjSirenTick(s, base + 1004 * S, T);
  CHECK(!s.on);

  // via the ACK downlink
  SjDownlink none = {SJ_CMD_NONE, 0, 0}, on = {SJ_CMD_SIREN_ON, 120, 0}, off = {SJ_CMD_SIREN_OFF, 0, 0};
  sjSirenBegin(s, base);
  CHECK(!sjSirenApplyDownlink(s, none, base, T) && !s.on);
  CHECK(sjSirenApplyDownlink(s, on, base, T) && s.on && s.onForMs == 120 * S);
  CHECK(sjSirenApplyDownlink(s, off, base + S, T) && !s.on);

  // an "on" while the node's own fallback sounds: the officer takes it over
  // (BY_COMMAND, the command's time from now)
  sjSirenBegin(s, base);
  for (uint32_t t = 0; t <= 900 * S; t += SAMPLE) sjSirenSample(s, true, base + t, T);
  CHECK(s.on && s.reason == SJ_SIREN_AUTO_OFFLINE);
  sjSirenTakeChanged(s);
  sjSirenAck(s, base + 1000 * S);
  CHECK(sjSirenCommand(s, true, 60, base + 1000 * S, T));
  CHECK(s.reason == SJ_SIREN_COMMAND && s.onAtMs == base + 1000 * S && s.onForMs == 60 * S && sjSirenTakeChanged(s));

  // an officer silences the node's own fallback: it does not sound again
  // by itself right away, even though it is still URGENT
  sjSirenBegin(s, base);
  for (uint32_t t = 0; t <= 900 * S; t += SAMPLE) sjSirenSample(s, true, base + t, T);
  CHECK(s.on);
  sjSirenAck(s, base + 905 * S);  // the "off" comes with a gateway ACK
  CHECK(sjSirenApplyDownlink(s, off, base + 905 * S, T) && !s.on);
  bool again = false;
  for (uint32_t t = 910 * S; t < 905 * S + SIREN_OFFLINE_AFTER_S * S; t += SAMPLE) {
    sjSirenSample(s, true, base + t, T);
    again |= s.on;
  }
  CHECK(!again);
}

// ---- millis() wrap (49.7 days) -------------------------------------------
inline void wrapTests() {
  // every rule again, with the wrap falling in the offline wait (-100 s),
  // at the trigger (-900 s), inside a sounding (-1000 s), inside the
  // cooldown (-1200 s) and at once (-1 ms)
  for (uint32_t base : {0xFFFFFFFFu - 100 * S, 0xFFFFFFFFu - 900 * S, 0xFFFFFFFFu - 1000 * S, 0xFFFFFFFFu - 1200 * S,
                        0xFFFFFFFFu - 1}) {
    offlineTests(base);
    onTimeCooldownTests(base);
    commandTests(base);
  }
  // a commanded sounding that starts 10 s before the wrap ends on time after it
  SjSiren s;
  uint32_t start = 0xFFFFFFFFu - 10 * S;
  sjSirenBegin(s, start);
  sjSirenCommand(s, true, 180, start, T);
  sjSirenTick(s, start + 179 * S, T);  // wrapped
  CHECK(s.on);
  sjSirenTick(s, start + 180 * S, T);
  CHECK(!s.on);

  // 51 days online (ACK every 60 s, URGENT all along, past the 49.7-day
  // wrap): never sounds by itself; then the gateway goes silent: sounds
  // exactly SIREN_OFFLINE_AFTER_S after the last ACK
  sjSirenBegin(s, 0);
  uint32_t t = 0, lastAck = 0;
  bool everOn = false;
  for (uint64_t k = 0; k < 51ull * 86400 * S; k += SAMPLE) {
    t = (uint32_t)k;  // wraps like millis()
    if (k % (60 * S) == 0) {
      sjSirenAck(s, t);
      lastAck = t;
    }
    sjSirenSample(s, true, t, T);
    everOn |= s.on;
  }
  CHECK(!everOn);
  for (t = lastAck + SAMPLE; t - lastAck < SIREN_OFFLINE_AFTER_S * S; t += SAMPLE) sjSirenSample(s, true, t, T);
  CHECK(!s.on);
  sjSirenSample(s, true, t, T);
  CHECK(s.on && t - lastAck == SIREN_OFFLINE_AFTER_S * S);

  // offline for 51 days, URGENT all along: it keeps cycling - never on
  // longer than one trigger, never quiet shorter than the cooldown, and
  // never stuck on or off by the wrap
  sjSirenBegin(s, 0);
  uint32_t onSince = 0, offSince = 0, longestOn = 0, shortestOff = 0xFFFFFFFFu, triggers = 0;
  bool wasOn = false;
  for (uint64_t k = 0; k < 51ull * 86400 * S; k += SAMPLE) {
    t = (uint32_t)k;
    sjSirenSample(s, true, t, T);
    if (s.on && !wasOn) {
      triggers++;
      onSince = t;
      if (triggers > 1 && t - offSince < shortestOff) shortestOff = t - offSince;
    }
    if (!s.on && wasOn) {
      offSince = t;
      if (t - onSince > longestOn) longestOn = t - onSince;
    }
    wasOn = s.on;
  }
  uint32_t cycle = (SIREN_ON_S + SIREN_COOLDOWN_S) * S;
  CHECK(longestOn <= SIREN_ON_S * S + SAMPLE && shortestOff >= SIREN_COOLDOWN_S * S);
  CHECK(triggers + 2 >= (uint32_t)((51ull * 86400 * S - SIREN_OFFLINE_AFTER_S * S) / (cycle + SAMPLE)));
}

// ---- the command in the ACK window (sj_packet.h), authenticated (sj_auth.h) ----
inline std::string hex(const uint8_t* b, size_t n) {
  std::string out;
  char x[3];
  for (size_t i = 0; i < n; i++) {
    std::snprintf(x, sizeof(x), "%02x", b[i]);
    out += x;
  }
  return out;
}

// A gateway master key and the node key derived from it (as the sketches do)
struct Keys {
  uint8_t master[SJ_CMD_MASTER_LEN];
  uint8_t node[SJ_CMD_KEY_LEN];
  Keys(const char* nodeId) {
    for (uint8_t i = 0; i < SJ_CMD_MASTER_LEN; i++) master[i] = (uint8_t)(0xA0 + i);
    char id[SJ_NODE_ID_LEN] = {0};
    std::strncpy(id, nodeId, SJ_NODE_ID_LEN);
    sjSirenNodeKey(master, id, node);
  }
};

inline void authTests(const std::string& dir) {
  // SHA-256 / HMAC-SHA256 against published test vectors (FIPS 180-2
  // "abc"; RFC 4231 test case 2); run_tests.py checks more against Python.
  uint8_t d[SJ_SHA256_LEN];
  SjSha256 h;
  sjSha256Init(h);
  sjSha256Update(h, (const uint8_t*)"abc", 3);
  sjSha256Final(h, d);
  CHECK(hex(d, 32) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  sjHmacSha256((const uint8_t*)"Jefe", 4, (const uint8_t*)"what do ya want for nothing?", 28, d);
  CHECK(hex(d, 32) == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  // a message across several blocks, fed in odd pieces = in one go
  std::string longMsg(1000, 'x');
  for (size_t i = 0; i < longMsg.size(); i++) longMsg[i] = (char)('a' + i % 26);
  uint8_t one[SJ_SHA256_LEN], pieces[SJ_SHA256_LEN];
  sjSha256Init(h);
  sjSha256Update(h, (const uint8_t*)longMsg.data(), longMsg.size());
  sjSha256Final(h, one);
  sjSha256Init(h);
  for (size_t k = 0; k < longMsg.size(); k += 37)
    sjSha256Update(h, (const uint8_t*)longMsg.data() + k, std::min<size_t>(37, longMsg.size() - k));
  sjSha256Final(h, pieces);
  CHECK(std::memcmp(one, pieces, 32) == 0);
  // keys from secrets.h: exactly the right number of hex digits, or none
  uint8_t k16[16];
  CHECK(sjParseHexKey("00112233445566778899AABBCCddeeff", k16, 16) && k16[0] == 0 && k16[10] == 0xAA && k16[15] == 0xFF);
  CHECK(!sjParseHexKey("", k16, 16) && !sjParseHexKey(nullptr, k16, 16));
  CHECK(!sjParseHexKey("paste-the-32-hex-characters-printed-above", k16, 16));
  CHECK(!sjParseHexKey("00112233445566778899aabbccddeef", k16, 16));    // 31
  CHECK(!sjParseHexKey("00112233445566778899aabbccddeeff0", k16, 16));  // 33
  CHECK(!sjParseHexKey("0011223344556677 899aabbccddeeff", k16, 16));   // not hex

  // vectors for run_tests.py: node keys + an ACK_CMD's MAC, recomputed with Python's hmac
  std::FILE* f = std::fopen((dir + "/auth_samples.jsonl").c_str(), "wb");
  CHECK(f != nullptr);
  for (const char* id : {"NODE-04", "NODE-INDB-12", "N"}) {
    Keys k(id);
    SjReading r = makeReading(id, 3000000001u, 41);
    SjDownlink on = {SJ_CMD_SIREN_ON, 180, 0};
    SjAckCmd a = sjMakeAckCmd(r, on, k.node);
    if (f)
      std::fprintf(f, "{\"master\":\"%s\",\"node_id\":\"%s\",\"node_key\":\"%s\",\"ack_cmd\":\"%s\"}\n",
                   hex(k.master, 32).c_str(), id, hex(k.node, 16).c_str(), hex((uint8_t*)&a, sizeof(a)).c_str());
  }
  if (f) std::fclose(f);
}

inline void ackEncodingTests() {
  CHECK(sizeof(SjAckCmd) == 34 && offsetof(SjAckCmd, cmd) == sizeof(SjAck) &&
        offsetof(SjAckCmd, mac) == SJ_ACK_CMD_V0_SIZE);
  Keys k("NODE-07");
  SjReading r = makeReading("NODE-07", 3000000001u, 41);
  r.flags = SJ_HAS_WATER | SJ_SIREN_FITTED;
  SjDownlink cmd, on = {SJ_CMD_SIREN_ON, 120, 0};
  SjAckCmd a = sjMakeAckCmd(r, on, k.node);
  CHECK(a.type == SJ_TYPE_ACK_CMD && a.version == SJ_VERSION);
  CHECK(sjParseAck((uint8_t*)&a, sizeof(a), r, cmd, k.node) && cmd.cmd == SJ_CMD_SIREN_ON && cmd.arg == 120 &&
        !cmd.refused);
  SjDownlink off = {SJ_CMD_SIREN_OFF, 0, 0};
  a = sjMakeAckCmd(r, off, k.node);
  CHECK(sjParseAck((uint8_t*)&a, sizeof(a), r, cmd, k.node) && cmd.cmd == SJ_CMD_SIREN_OFF && !cmd.refused);
  // the plain ACK still works, with no command
  SjAck plain = sjMakeAck(r);
  cmd.cmd = 9;
  CHECK(sjParseAck((uint8_t*)&plain, sizeof(plain), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.arg == 0 &&
        !cmd.refused);
  // not ours: other reading, other node, truncated, a plain-ACK type at the longer length
  SjReading other = r;
  other.seq = 42;
  a = sjMakeAckCmd(r, on, k.node);
  CHECK(!sjParseAck((uint8_t*)&a, sizeof(a), other, cmd, k.node) && cmd.cmd == SJ_CMD_NONE);
  SjReading otherNode = makeReading("NODE-08", 3000000001u, 41);
  CHECK(!sjParseAck((uint8_t*)&a, sizeof(a), otherNode, cmd, k.node));
  CHECK(!sjParseAck((uint8_t*)&a, sizeof(a) - 1, r, cmd, k.node));
  a.type = SJ_TYPE_ACK;
  CHECK(!sjParseAck((uint8_t*)&a, sizeof(a), r, cmd, k.node));
  // an unknown command from a newer gateway is still the ACK - just no command
  a = sjMakeAckCmd(r, on, k.node);
  a.cmd = 77;
  CHECK(sjParseAck((uint8_t*)&a, sizeof(a), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE);
  // why the gateway sends it ONLY to readings flagged SJ_SIREN_FITTED: an
  // older node's check (sjAckMatches) refuses the longer ACK = "no ACK"
  a = sjMakeAckCmd(r, on, k.node);
  CHECK(!sjAckMatches((uint8_t*)&a, sizeof(a), r));
  // an older node never sets the siren flags (its takeReading() zeroes the reading)
  CHECK((SJ_SIREN_FITTED | SJ_SIREN_ON | SJ_SIREN_BY_COMMAND) == 0xE000 && (SJ_MEASUREMENT_FLAGS & 0xE000) == 0);

  // ---- forgeries (review: anyone could answer in the ACK window) ----
  // The attacker sees node id / session / seq on air, but not the key: a
  // command with a made-up MAC, or none, is the ACK and nothing more.
  SjAckCmd forged = sjMakeAckCmd(r, on, k.node);
  std::memset(forged.mac, 0, sizeof(forged.mac));
  CHECK(sjParseAck((uint8_t*)&forged, sizeof(forged), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  // ...signed with another node's key (a node that was stolen and read out)
  Keys thief("NODE-08");
  forged = sjMakeAckCmd(r, off, thief.node);
  CHECK(sjParseAck((uint8_t*)&forged, sizeof(forged), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  // ...a genuine command with a changed argument (on for 600 s instead of 120) or kind (on -> off)
  forged = sjMakeAckCmd(r, on, k.node);
  forged.arg = 600;
  CHECK(sjParseAck((uint8_t*)&forged, sizeof(forged), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  forged = sjMakeAckCmd(r, on, k.node);
  forged.cmd = SJ_CMD_SIREN_OFF;
  CHECK(sjParseAck((uint8_t*)&forged, sizeof(forged), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  // ...a genuine command recorded for an earlier reading, replayed with this one's numbers
  SjReading earlier = r;
  earlier.seq = 40;
  forged = sjMakeAckCmd(earlier, off, k.node);
  forged.seq = r.seq;
  CHECK(sjParseAck((uint8_t*)&forged, sizeof(forged), r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  // ...the first, unauthenticated 26-byte layout: still the ACK, never a command
  forged = sjMakeAckCmd(r, on, k.node);
  CHECK(sjParseAck((uint8_t*)&forged, SJ_ACK_CMD_V0_SIZE, r, cmd, k.node) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  // a node without a key (SIREN_CMD_KEY not set) obeys nothing, even a genuine command
  a = sjMakeAckCmd(r, on, k.node);
  CHECK(sjParseAck((uint8_t*)&a, sizeof(a), r, cmd, nullptr) && cmd.cmd == SJ_CMD_NONE && cmd.refused);
  // every single bit of the MAC matters
  int accepted = 0;
  for (int bit = 0; bit < SJ_CMD_MAC_LEN * 8; bit++) {
    forged = sjMakeAckCmd(r, on, k.node);
    forged.mac[bit / 8] ^= (uint8_t)(1u << (bit % 8));
    sjParseAck((uint8_t*)&forged, sizeof(forged), r, cmd, k.node);
    accepted += cmd.cmd != SJ_CMD_NONE;
  }
  CHECK(accepted == 0);
  // the node keys differ per node and per master
  Keys k2("NODE-07");
  CHECK(std::memcmp(k.node, k2.node, 16) == 0 && std::memcmp(k.node, thief.node, 16) != 0);
  k2.master[0] ^= 1;
  char id7[SJ_NODE_ID_LEN] = "NODE-07";
  sjSirenNodeKey(k2.master, id7, k2.node);
  CHECK(std::memcmp(k.node, k2.node, 16) != 0);
  // the derivation reads the id without its NUL padding, and never past 12 characters
  char id12[SJ_NODE_ID_LEN];
  std::memcpy(id12, "NODE-INDB-12", SJ_NODE_ID_LEN);  // no NUL at all
  uint8_t key12[16], expect12[SJ_SHA256_LEN];
  sjSirenNodeKey(k.master, id12, key12);
  sjHmacSha256(k.master, 32, (const uint8_t*)"NODE-INDB-12", 12, expect12);
  CHECK(std::memcmp(key12, expect12, 16) == 0);
}

// ---- the server's "commands" (sjParseSirenCommands) ----------------------
inline void parserTests() {
  SjSirenCommand c[8];
  const char* body =
      "{\"status\":\"success\",\"results\":[{\"node_id\":\"NODE-07\",\"reading_uid\":\"1-2\",\"ai_action\":\"stored\"}],\n"
      "  \"commands\" : [ {\"node_id\":\"NODE-07\", \"siren\":\"on\", \"for_s\":180},\n"
      "   {\"siren\":\"off\",\"node_id\":\"NODE-INDB-12\",\"why\":{\"a\":[1,\"]}\"]},\"n\":null},"
      "{\"node_id\":\"NODE-09\",\"for_s\":90.0,\"siren\":\"on\"} ] }";
  int n = sjParseSirenCommands(body, c, 8);
  CHECK(n == 3);
  CHECK(std::strcmp(c[0].node_id, "NODE-07") == 0 && c[0].on == 1 && c[0].forS == 180);
  CHECK(std::strcmp(c[1].node_id, "NODE-INDB-12") == 0 && c[1].on == 0 && c[1].forS == 0);  // 12 chars kept
  CHECK(std::strcmp(c[2].node_id, "NODE-09") == 0 && c[2].on == 1 && c[2].forS == 90);
  CHECK(sjParseSirenCommands("{\"status\":\"success\",\"results\":[]}", c, 8) == -1);  // older server
  CHECK(sjParseSirenCommands("{\"commands\":[]}", c, 8) == 0);
  CHECK(sjParseSirenCommands("{\"detail\":\"no \\\"commands\\\" here\"}", c, 8) == -1);
  // entries that can't be trusted are skipped, the good ones kept
  n = sjParseSirenCommands(
      "{\"commands\":[{\"node_id\":\"NODE-07\"},{\"node_id\":\"NODE-07\",\"siren\":\"loud\"},"
      "{\"node_id\":\"NODE-TOO-LONG-1\",\"siren\":\"on\"},{\"node_id\":\"NO\\\"DE\",\"siren\":\"on\"},"
      "{\"node_id\":7,\"siren\":\"on\"},{\"node_id\":\"\",\"siren\":\"on\"},"
      "{\"node_id\":\"NODE-05\",\"siren\":\"on\",\"for_s\":99999999}]}",
      c, 8);
  CHECK(n == 1 && std::strcmp(c[0].node_id, "NODE-05") == 0 && c[0].forS == 65535);
  // a cut-off answer keeps what was complete, invents nothing
  n = sjParseSirenCommands("{\"commands\":[{\"node_id\":\"NODE-07\",\"siren\":\"off\"},{\"node_id\":\"NODE-08\",\"sir",
                           c, 8);
  CHECK(n == 1 && std::strcmp(c[0].node_id, "NODE-07") == 0 && c[0].on == 0);
  CHECK(sjParseSirenCommands("{\"commands\":[{\"node_id\":\"NODE-07\",\"siren\":\"on\"", c, 8) == 0);
  CHECK(sjParseSirenCommands("{\"commands\":", c, 8) == -1);
  // never more than `max`
  CHECK(sjParseSirenCommands("{\"commands\":[{\"node_id\":\"A\",\"siren\":\"on\"},{\"node_id\":\"B\",\"siren\":\"on\"},"
                             "{\"node_id\":\"C\",\"siren\":\"on\"}]}",
                             c, 2) == 2 &&
        std::strcmp(c[1].node_id, "B") == 0);
}

// ---- the gateway's commands waiting for their node (sj_siren_cmd.h) -------
// A reading as the current node firmware sends it: measured `sounding`,
// and stamped with the same state at transmission (sendOne()).
inline SjReading nodeReading(const char* node, bool fitted, bool sounding) {
  SjReading r = makeReading(node, 5, 1);
  r.flags = SJ_HAS_WATER | (fitted ? SJ_SIREN_FITTED : 0) | (sounding ? SJ_SIREN_ON | SJ_SIREN_BY_COMMAND : 0);
  r.tx_state = (uint8_t)(SJ_TX_VALID | (sounding ? SJ_TX_SIREN_ON : 0));
  return r;
}

// A backlog reading: measured `soundingThen`, `ageS` old, sent while the
// siren is `soundingNow` (stamp = false: an older v3 node without the stamp).
inline SjReading backlogReading(const char* node, bool soundingThen, bool soundingNow, uint32_t ageS,
                                bool stamp = true) {
  SjReading r = nodeReading(node, true, soundingThen);
  r.age_s = ageS;
  r.tx_state = stamp ? (uint8_t)(SJ_TX_VALID | (soundingNow ? SJ_TX_SIREN_ON : 0)) : 0;
  return r;
}

inline SjSirenCommand cmdFor(const char* node, bool on, uint16_t forS) {
  SjSirenCommand c;
  std::memset(&c, 0, sizeof(c));
  std::strncpy(c.node_id, node, SJ_NODE_ID_LEN);
  c.on = on;
  c.forS = forS;
  return c;
}

inline void gatewayTableTests() {
  // The gateway's config.h can't be included next to the node's (same
  // pin names); run_tests.py checks that its SIREN_DEFAULT_ON_S /
  // SIREN_CMD_MAX_ON_S equal the node's SIREN_ON_S / SIREN_MAX_ON_S.
  const SjSirenCmdLimits lim = {SIREN_ON_S, SIREN_MAX_ON_S, 900};
  SjSirenCmdTable<4> t;
  std::memset(&t, 0, sizeof(t));
  SjDownlink d;
  bool changed;
  uint32_t now = 1000;

  // the server's answer to an upload holding a silent NODE-07 reading
  SjSirenCommand cmds[4];
  int n = sjParseSirenCommands("{\"results\":[],\"commands\":[{\"node_id\":\"NODE-07\",\"siren\":\"on\",\"for_s\":180}]}",
                               cmds, 4);
  SjFittedNodes fitted;
  fitted.clear();
  fitted.add(nodeReading("NODE-07", true, false));
  fitted.add(nodeReading("NODE-07", true, false));  // listed once
  fitted.add(nodeReading("NODE-OLD", false, false));  // not siren-fitted: not listed
  CHECK(fitted.n == 1);
  CHECK(sjSirenApplyResponse(t, cmds, n, fitted, now, lim) && sjSirenPendingCount(t) == 1);
  // the same command again in the next answer: kept, no NVS write needed
  CHECK(!sjSirenApplyResponse(t, cmds, n, fitted, now + 20, lim));

  // NODE-07's next reading (still silent) gets it in its ACK, with the time LEFT
  CHECK(sjSirenForReading(t, nodeReading("NODE-07", true, false), now + 60, d, changed));
  CHECK(d.cmd == SJ_CMD_SIREN_ON && d.arg == 180 - 60 + 20 && !changed);
  // a lost ACK: the resend gets it again
  CHECK(sjSirenForReading(t, nodeReading("NODE-07", true, false), now + 62, d, changed) && d.cmd == SJ_CMD_SIREN_ON);
  // another node, and an older firmware's reading (not fitted): plain ACK
  CHECK(!sjSirenForReading(t, nodeReading("NODE-08", true, false), now + 63, d, changed) && d.cmd == SJ_CMD_NONE);
  CHECK(!sjSirenForReading(t, nodeReading("NODE-07", false, false), now + 63, d, changed));
  // the node's reading shows it sounding: done, dropped (save after the ACK)
  CHECK(!sjSirenForReading(t, nodeReading("NODE-07", true, true), now + 70, d, changed) && changed);
  CHECK(sjSirenPendingCount(t) == 0);
  CHECK(!sjSirenForReading(t, nodeReading("NODE-07", true, false), now + 75, d, changed));

  // "off": delivered while the node still sounds, dropped once it is silent
  SjSirenCommand offCmd = cmdFor("NODE-07", false, 0);
  CHECK(sjSirenSet(t, offCmd, now, lim));
  CHECK(sjSirenForReading(t, nodeReading("NODE-07", true, true), now + 5, d, changed) && d.cmd == SJ_CMD_SIREN_OFF &&
        d.arg == 0);
  CHECK(!sjSirenForReading(t, nodeReading("NODE-07", true, false), now + 10, d, changed) && changed &&
        sjSirenPendingCount(t) == 0);

  // expiry: an "on" when its time is up, an "off" after its TTL
  CHECK(sjSirenSet(t, cmdFor("NODE-07", true, 0), now, lim));  // no for_s: the default
  CHECK(sjSirenForReading(t, nodeReading("NODE-07", true, false), now, d, changed) && d.arg == lim.defaultOnS);
  CHECK(!sjSirenForReading(t, nodeReading("NODE-07", true, false), now + lim.defaultOnS, d, changed) && changed);
  CHECK(sjSirenSet(t, cmdFor("NODE-07", true, 60000), now, lim));  // capped
  CHECK(sjSirenForReading(t, nodeReading("NODE-07", true, false), now, d, changed) && d.arg == lim.maxOnS);
  CHECK(sjSirenSet(t, offCmd, now, lim));
  CHECK(sjSirenForReading(t, nodeReading("NODE-07", true, true), now + lim.offTtlS - 1, d, changed));
  CHECK(!sjSirenForReading(t, nodeReading("NODE-07", true, true), now + lim.offTtlS, d, changed) && changed);

  // the server changed its mind before delivery (officer cancelled): its
  // answer to NODE-07's reading has no command for it -> dropped. A node
  // that had no reading in that upload keeps its command.
  sjSirenSet(t, cmdFor("NODE-07", true, 180), now, lim);
  sjSirenSet(t, cmdFor("NODE-09", true, 180), now, lim);
  CHECK(sjSirenApplyResponse(t, cmds, 0, fitted, now + 1, lim));
  CHECK(sjSirenFind(t, "NODE-07\0\0\0\0") < 0 && sjSirenFind(t, "NODE-09\0\0\0\0") >= 0);
  // an older server (no "commands" key, -1 -> 0) behaves the same: nothing wanted
  sjSirenSet(t, cmdFor("NODE-07", true, 180), now, lim);
  int none = sjParseSirenCommands("{\"status\":\"success\"}", cmds, 4);
  CHECK(none == -1 && sjSirenApplyResponse(t, cmds, 0, fitted, now + 2, lim) && sjSirenFind(t, "NODE-07") < 0);

  // full table: the entry closest to expiry makes room
  std::memset(&t, 0, sizeof(t));
  sjSirenSet(t, cmdFor("N1", true, 500), now, lim);
  sjSirenSet(t, cmdFor("N2", true, 100), now, lim);
  sjSirenSet(t, cmdFor("N3", false, 0), now, lim);
  sjSirenSet(t, cmdFor("N4", true, 300), now, lim);
  CHECK(sjSirenSet(t, cmdFor("N5", true, 200), now, lim));
  CHECK(sjSirenPendingCount(t) == 4 && sjSirenFind(t, "N2") < 0 && sjSirenFind(t, "N5") >= 0);

  // NVS copy: survives a reboot with the time it had left; a damaged or
  // foreign copy restores nothing
  SjSirenCmdSaved<4> saved;
  sjSirenSave(t, now + 50, saved);
  SjSirenCmdTable<4> after;
  CHECK(sjSirenRestore(after, saved, 3, lim) == 4);  // new boot: clock near 0
  int i5 = sjSirenFind(after, "N5"), i3 = sjSirenFind(after, "N3");
  CHECK(i5 >= 0 && after.slots[i5].on == 1 && after.slots[i5].expiresAtS == 3 + 200 - 50);
  CHECK(i3 >= 0 && after.slots[i3].on == 0 && after.slots[i3].expiresAtS == 3 + lim.offTtlS - 50);
  CHECK(sjSirenForReading(after, nodeReading("N5", true, false), 3, d, changed) && d.arg == 150);
  sjSirenSave(t, now + 250, saved);  // N5 (200 s) has run out by then
  CHECK(sjSirenRestore(after, saved, 3, lim) == 3 && sjSirenFind(after, "N5") < 0);
  SjSirenCmdSaved<4> bad = saved;
  bad.magic ^= 1;
  CHECK(sjSirenRestore(after, bad, 3, lim) == 0 && sjSirenPendingCount(after) == 0);
  bad = saved;
  for (auto& e : bad.e) {
    e.node_id[0] = '\x01';  // garbage id
  }
  CHECK(sjSirenRestore(after, bad, 3, lim) == 0);
  bad = saved;
  for (auto& e : bad.e) e.remainingS = 0x7FFFFFFF;  // absurd time
  CHECK(sjSirenRestore(after, bad, 3, lim) == 0);
}

// ---- review: the node's state NOW, not its backlog's ------------------------
// The node sounded by itself during an outage; the link is back and it
// drains its backlog oldest first; the officer presses "off". Every silent
// reading from BEFORE the sounding used to "confirm" the off and drop it.
inline void staleBacklogTests() {
  const SjSirenCmdLimits lim = {SIREN_ON_S, SIREN_MAX_ON_S, 900};
  SjSirenCmdTable<4> t;
  std::memset(&t, 0, sizeof(t));
  SjDownlink d;
  bool changed;
  const uint32_t now = 5000;
  CHECK(sjSirenSet(t, cmdFor("NODE-07", false, 0), now, lim));  // the server wants it off
  // hours-old silent readings, sent while the siren sounds: the "off" goes with each ACK, and stays
  for (uint32_t k = 0; k < 50; k++) {
    CHECK(sjSirenForReading(t, backlogReading("NODE-07", false, true, 7200 - k * 60), now + k, d, changed));
    CHECK(d.cmd == SJ_CMD_SIREN_OFF && sjSirenPendingCount(t) == 1);
  }
  // the node took it: its next (still old, still silent-era) reading is stamped silent -> done
  CHECK(!sjSirenForReading(t, backlogReading("NODE-07", false, false, 3000), now + 60, d, changed) && changed &&
        sjSirenPendingCount(t) == 0);
  // the same for "on": old SOUNDING readings from an earlier sounding do not confirm a new "on"
  CHECK(sjSirenSet(t, cmdFor("NODE-07", true, 180), now, lim));
  CHECK(sjSirenForReading(t, backlogReading("NODE-07", true, false, 5000), now + 1, d, changed) &&
        d.cmd == SJ_CMD_SIREN_ON && sjSirenPendingCount(t) == 1);
  CHECK(!sjSirenForReading(t, backlogReading("NODE-07", true, true, 5000), now + 2, d, changed) &&
        sjSirenPendingCount(t) == 0);
  // an older v3 node without the stamp: a fresh reading's flags count, an old one's do not
  CHECK(sjSirenSet(t, cmdFor("NODE-07", false, 0), now, lim));
  CHECK(sjSirenForReading(t, backlogReading("NODE-07", false, true, 7200, false), now + 3, d, changed) &&
        d.cmd == SJ_CMD_SIREN_OFF && sjSirenPendingCount(t) == 1);  // can't tell: sent anyway
  SjReading lost = backlogReading("NODE-07", false, true, 0, false);
  lost.age_s = SJ_AGE_UNKNOWN;  // from before the node's reboot
  CHECK(sjSirenForReading(t, lost, now + 4, d, changed) && sjSirenPendingCount(t) == 1);
  CHECK(!sjSirenForReading(t, backlogReading("NODE-07", false, true, SJ_SIREN_FLAGS_FRESH_S, false), now + 5, d,
                           changed) &&
        sjSirenPendingCount(t) == 0);  // fresh and silent: done
  CHECK(sjSirenStateNow(backlogReading("N", true, false, 9999)) == 0);
  CHECK(sjSirenStateNow(backlogReading("N", false, true, 9999)) == 1);
  CHECK(sjSirenStateNow(backlogReading("N", true, true, SJ_SIREN_FLAGS_FRESH_S + 1, false)) == -1);
  // the node side stamps what sounds NOW
  SjSiren s;
  sjSirenBegin(s, 0);
  CHECK(sjSirenTxState(s) == SJ_TX_VALID);
  SjSirenTiming tm = T;
  sjSirenCommand(s, true, 60, 0, tm);
  CHECK(sjSirenTxState(s) == (SJ_TX_VALID | SJ_TX_SIREN_ON));
  // and the byte never reaches the JSON
  String js;
  sjAppendJson(js, backlogReading("NODE-07", false, true, 100), 100, -90, "lora");
  CHECK(!std::strstr(js.c_str(), "siren_on") && !std::strstr(js.c_str(), "tx_state"));
}

// ---- review: an empty / cut-off answer is not "the server wants nothing" ------
inline void answerTests() {
  const SjSirenCmdLimits lim = {SIREN_ON_S, SIREN_MAX_ON_S, 900};
  SjSirenCmdTable<4> t;
  SjFittedNodes fitted;
  fitted.clear();
  fitted.add(nodeReading("NODE-07", true, true));
  fitted.add(nodeReading("NODE-08", true, false));
  SjSirenCommand cmds[4];
  int n;
  auto reset = [&]() {
    std::memset(&t, 0, sizeof(t));
    sjSirenSet(t, cmdFor("NODE-07", false, 0), 100, lim);
    sjSirenSet(t, cmdFor("NODE-08", true, 180), 100, lim);
  };
  // bodies that prove nothing: both commands stay
  for (const char* body : {"", "   ", "{\"status\":\"suc", "<html>502 Bad Gateway</html>", "{\"status\":\"success\"} x",
                           "{\"status\":\"success\",\"commands\":[{\"node_id\":\"NODE-07\",\"siren\":\"off\"},"}) {
    reset();
    sjSirenApplyAnswer(t, body, fitted, 110, lim, cmds, 4, n);
    CHECK(sjSirenPendingCount(t) == 2 && sjSirenFind(t, "NODE-07") >= 0 && sjSirenFind(t, "NODE-08") >= 0);
  }
  reset();
  CHECK(!sjSirenApplyAnswer(t, nullptr, fitted, 110, lim, cmds, 4, n) && sjSirenPendingCount(t) == 2);
  // a cut-off array keeps what it read (NODE-07 off) and clears nothing
  reset();
  sjSirenApplyAnswer(t, "{\"commands\":[{\"node_id\":\"NODE-07\",\"siren\":\"off\"},{\"node_id\":\"NODE-0", fitted, 110,
                     lim, cmds, 4, n);
  CHECK(n == 1 && sjSirenPendingCount(t) == 2);
  // a complete answer without "commands": both nodes are as the server wants
  reset();
  CHECK(sjSirenApplyAnswer(t, " {\"status\":\"success\",\"results\":[{\"a\":\"}\"}]}\r\n", fitted, 110, lim, cmds, 4,
                           n) &&
        n == 0 && sjSirenPendingCount(t) == 0);
  // a complete answer with a command for one of them: the other one is cleared
  reset();
  sjSirenApplyAnswer(t, "{\"status\":\"success\",\"commands\":[{\"node_id\":\"NODE-07\",\"siren\":\"off\"}]}", fitted,
                     110, lim, cmds, 4, n);
  CHECK(n == 1 && sjSirenFind(t, "NODE-07") >= 0 && sjSirenFind(t, "NODE-08") < 0);
  // more commands than fit: none of the fitted nodes is cleared on that answer
  reset();
  SjSirenCommand two[1];
  sjSirenApplyAnswer(t,
                     "{\"commands\":[{\"node_id\":\"NODE-09\",\"siren\":\"on\"},{\"node_id\":\"NODE-08\","
                     "\"siren\":\"on\"}]}",
                     fitted, 110, lim, two, 1, n);
  CHECK(n == 1 && sjSirenFind(t, "NODE-07") >= 0 && sjSirenFind(t, "NODE-08") >= 0);
  bool complete = true;
  CHECK(sjParseSirenCommands("{\"commands\":[{\"node_id\":\"A\",\"siren\":\"on\"}]}", cmds, 4, &complete) == 1 && complete);
  CHECK(sjParseSirenCommands("{\"commands\":[]}", cmds, 4, &complete) == 0 && complete);
  CHECK(sjParseSirenCommands("{\"commands\":[{\"node_id\":\"A\"", cmds, 4, &complete) == 0 && !complete);
  CHECK(sjParseSirenCommands("{\"status\":1}", cmds, 4, &complete) == -1 && !complete);
  CHECK(sjJsonObjectComplete("{}") && sjJsonObjectComplete("\n{\"a\":[1,{\"b\":\"]}\"}]}\n") &&
        !sjJsonObjectComplete("{\"a\":[1}") && !sjJsonObjectComplete("[]") && !sjJsonObjectComplete("{}{}"));
}

// ---- the readings' JSON (validated against the backend in Python too) ------
inline void jsonTests() {
  SjReading r = nodeReading("NODE-07", true, true);
  String s;
  sjAppendJson(s, r, 5, -90, "lora");
  CHECK(std::strstr(s.c_str(), "\"siren_fitted\":true,\"siren_on\":true,\"siren_reason\":\"command\""));
  r.flags &= ~SJ_SIREN_BY_COMMAND;
  String s2;
  sjAppendJson(s2, r, 5, -90, "lora");
  CHECK(std::strstr(s2.c_str(), "\"siren_on\":true,\"siren_reason\":\"auto_offline\""));
  r.flags &= ~SJ_SIREN_ON;
  String s3;
  sjAppendJson(s3, r, 5, -90, "lora");
  CHECK(std::strstr(s3.c_str(), "\"siren_fitted\":true") && !std::strstr(s3.c_str(), "siren_on") &&
        !std::strstr(s3.c_str(), "siren_reason"));
  r.flags = SJ_HAS_WATER;  // no siren: no siren fields at all
  String s4;
  sjAppendJson(s4, r, 5, -90, "lora");
  CHECK(!std::strstr(s4.c_str(), "siren"));
}

inline void runSirenTests(const std::string& dir) {
  offlineTests(0);
  onTimeCooldownTests(0);
  commandTests(0);
  wrapTests();
  authTests(dir);
  ackEncodingTests();
  parserTests();
  gatewayTableTests();
  staleBacklogTests();
  answerTests();
  jsonTests();
}

}  // namespace siren
