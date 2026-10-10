// =====================================================================
// SANJEEVNI node - village siren (hardware-independent, so it is
// unit-tested on a PC: tools/firmware_host_test).
//
// A 12 V siren + strobe on SIREN_PIN (through a MOSFET / relay, see
// config.h and docs/wiring.html). Who may switch it on:
//  - the SERVER, by command (an officer's button, or the server's own rule
//    for a CONFIRMED CRITICAL hazard at this node). The command arrives in
//    the gateway's ACK of one of our readings (SjAckCmd, sj_packet.h), or
//    in the backend's answer on a WiFi node.
//  - the NODE ITSELF only as an offline fallback (user decision: never on
//    HIGH, never while the server can decide): no gateway ACK for
//    offlineAfterMs AND the water level or the gas is at its siren danger
//    level (sjSirenLocalUrgent) on urgentSamples consecutive samples. If
//    the village is cut off when the river comes up, nobody else can
//    sound it. Evacuation hazards only (decision 2026-10-09: the server's
//    automatic siren is for flood / flash flood / landslide / fire / gas
//    leak, SIREN_AUTO_HAZARDS) - and of those the node judges alone only
//    what it measures directly: water and gas.
// Every trigger sounds for a limited time (autoOnMs for the node's own,
// the command's for_s capped at maxOnMs), then the siren stays quiet for
// cooldownMs before the offline rule may sound it again - "re-armed" only
// if the samples are STILL urgent. An officer's command is not held back
// by the cooldown (a human decided). An "off" command silences either
// kind and starts the cooldown, so the node does not overrule the officer
// the moment the link drops.
//
// The node reports its state in every reading (SJ_SIREN_* flags) and sends
// one at once when it changes (sjSirenTakeChanged), so the server sees the
// siren within seconds and stops re-sending a command that has arrived.
//
// Times are millis(). All differences are unsigned and every "since"
// timestamp is retired by a flag once its period is over (as in sj_sos.h),
// so the 49.7-day millis() wrap never makes an old timestamp look new -
// sjSirenTick() must run at least once per period (loop() runs it every
// pass).
// =====================================================================
#pragma once
#include <stdint.h>
#include <string.h>
#include "sj_packet.h"

enum SjSirenReason : uint8_t {
  SJ_SIREN_SILENT = 0,
  SJ_SIREN_COMMAND,       // server / officer
  SJ_SIREN_AUTO_OFFLINE,  // the node's own offline fallback
};

struct SjSirenTiming {
  uint32_t offlineAfterMs;  // no gateway ACK for this long = offline
  uint8_t urgentSamples;    // consecutive URGENT samples before the node sounds it itself
  uint32_t autoOnMs;        // one offline trigger sounds this long; also a command's default
  uint32_t maxOnMs;         // a command's for_s is capped at this
  uint32_t cooldownMs;      // quiet at least this long after a sounding ends
};

struct SjSiren {
  uint8_t on;
  uint8_t reason;        // SjSirenReason
  uint8_t offline;       // latched: no ACK for offlineAfterMs (cleared by the next ACK)
  uint8_t inCooldown;
  uint8_t urgentStreak;  // consecutive URGENT samples (saturates at 255)
  uint8_t changed;       // on/off changed - the sketch reports at once (sjSirenTakeChanged)
  uint8_t reserved[2];
  uint32_t onAtMs;
  uint32_t onForMs;
  uint32_t lastAckMs;
  uint32_t cooldownAtMs;
};

// At boot: silent, and the boot counts as the last contact - a node that
// starts with no gateway in range waits the full offlineAfterMs too.
inline void sjSirenBegin(SjSiren& s, uint32_t nowMs) {
  memset(&s, 0, sizeof(s));
  s.lastAckMs = nowMs;
}

inline void sjSirenStop(SjSiren& s, uint32_t nowMs) {
  if (s.on) s.changed = 1;
  s.on = 0;
  s.reason = SJ_SIREN_SILENT;
  s.inCooldown = 1;
  s.cooldownAtMs = nowMs;
}

inline void sjSirenStart(SjSiren& s, SjSirenReason reason, uint32_t forMs, uint32_t nowMs) {
  if (!s.on || s.reason != reason) s.changed = 1;
  s.on = 1;
  s.reason = reason;
  s.onAtMs = nowMs;
  s.onForMs = forMs;
}

// Timers: end of a sounding, end of the cooldown, the offline latch.
inline void sjSirenTick(SjSiren& s, uint32_t nowMs, const SjSirenTiming& t) {
  if (s.on && nowMs - s.onAtMs >= s.onForMs) sjSirenStop(s, nowMs);
  if (s.inCooldown && nowMs - s.cooldownAtMs >= t.cooldownMs) s.inCooldown = 0;
  if (!s.offline && nowMs - s.lastAckMs >= t.offlineAfterMs) s.offline = 1;
}

// The gateway acknowledged a reading (WiFi node: the backend answered 200).
// A sounding the node started itself keeps going to its end - the link
// flickering back is no reason to stop warning; from now on the server
// decides (it sees siren_reason auto_offline, an officer can silence it).
inline void sjSirenAck(SjSiren& s, uint32_t nowMs) {
  s.lastAckMs = nowMs;
  s.offline = 0;
}

// A command from the server. `forS` 0 = default (autoOnMs). Returns true if
// the siren changed. The same "on" again while a commanded sounding runs
// changes nothing: the gateway repeats a command until our readings show
// it, and queued older readings (still "silent") would otherwise keep
// extending it. To sound longer the server sends "on" again after the
// node reported the end.
inline bool sjSirenCommand(SjSiren& s, bool on, uint32_t forS, uint32_t nowMs, const SjSirenTiming& t) {
  if (!on) {
    bool was = s.on;
    sjSirenStop(s, nowMs);
    return was;
  }
  if (s.on && s.reason == SJ_SIREN_COMMAND) return false;
  uint64_t forMs = forS ? (uint64_t)forS * 1000u : t.autoOnMs;
  if (forMs > t.maxOnMs) forMs = t.maxOnMs;
  if (forMs < 1000) forMs = 1000;
  sjSirenStart(s, SJ_SIREN_COMMAND, (uint32_t)forMs, nowMs);
  return true;
}

// One regular sample. `urgent`: the node's own verdict for it
// (sjSirenLocalUrgent). Applies the offline fallback rule.
inline void sjSirenSample(SjSiren& s, bool urgent, uint32_t nowMs, const SjSirenTiming& t) {
  sjSirenTick(s, nowMs, t);
  s.urgentStreak = urgent ? (s.urgentStreak < 255 ? s.urgentStreak + 1 : 255) : 0;
  if (!s.on && s.offline && !s.inCooldown && s.urgentStreak >= t.urgentSamples) {
    sjSirenStart(s, SJ_SIREN_AUTO_OFFLINE, t.autoOnMs, nowMs);
  }
}

// A downlink from the gateway's ACK (sj_packet.h sjParseAck). Returns true
// if the siren changed.
inline bool sjSirenApplyDownlink(SjSiren& s, const SjDownlink& d, uint32_t nowMs, const SjSirenTiming& t) {
  if (d.cmd == SJ_CMD_SIREN_ON) return sjSirenCommand(s, true, d.arg, nowMs, t);
  if (d.cmd == SJ_CMD_SIREN_OFF) return sjSirenCommand(s, false, 0, nowMs, t);
  return false;
}

// true once per on/off change: the sketch measures and reports at once.
inline bool sjSirenTakeChanged(SjSiren& s) {
  bool c = s.changed;
  s.changed = 0;
  return c;
}

// The reading flags for the current state (sj_packet.h).
inline uint16_t sjSirenFlags(const SjSiren& s) {
  uint16_t f = SJ_SIREN_FITTED;
  if (s.on) {
    f |= SJ_SIREN_ON;
    if (s.reason == SJ_SIREN_COMMAND) f |= SJ_SIREN_BY_COMMAND;
  }
  return f;
}

// SjReading.tx_state for a transmission NOW (sendOne() stamps every copy it
// sends): the gateway decides from this, not from the measured flags,
// whether a command has taken effect - a backlog reading's flags are from
// before the command (sj_siren_cmd.h).
inline uint8_t sjSirenTxState(const SjSiren& s) { return (uint8_t)(SJ_TX_VALID | (s.on ? SJ_TX_SIREN_ON : 0)); }

// Fields whose value in this reading the node's own anomaly checks doubt
// (sj_anomaly.h): stuck, spike or impossible rate - the same checks the
// backend holds a flood on (integration_pipeline.EDGE_RIVER_HOLD_CHECKS).
// A dropout is not among them: it says the sensor missed OTHER samples,
// not that this value is wrong.
inline uint8_t sjSirenDoubtfulFields(const SjReading& r) {
  return r.anomaly[SJ_AC_STUCK] | r.anomaly[SJ_AC_SPIKE] | r.anomaly[SJ_AC_RATE];
}

// The node's own siren verdict for one reading: the water level or the gas
// at its danger level. At or above the LOCAL_* "send now" limits (those
// mean "worth a look"): the water level above them (0.8 vs 0.4 of the
// mount), the gas EQUAL to LOCAL_GAS_LIMIT_PPM (800 ppm = backend
// GAS_CRITICAL_PPM) - for gas the only extra margin is the
// SIREN_OFFLINE_URGENT_SAMPLES consecutive samples. A false village siren
// costs trust.
// 0 = that check is off.
// NOT siren triggers here (decision 2026-10-09): heat (also IMD's severe
// heat wave), PM / smoke, tilt, flame, a fast rise on its own (HIGH at
// most at the backend without corroboration), and the EDGE-AI VERDICT
// (r.edge_risk) - main or lite model. The models' URGENT also covers heat
// (>= 47 C), flame and tilt, and their water / gas URGENT is the same
// fixed threshold learned from synthetic data (bench scale: 0.8 of the
// tank = SIREN_LOCAL_WATER_FRACTION, 800 ppm = SIREN_LOCAL_GAS_PPM), so the
// configured danger levels below decide - per site, not a model's 3.5 m.
// A value the anomaly checks doubt never counts.
inline bool sjSirenLocalUrgent(const SjReading& r, uint32_t waterLimitMm, uint32_t gasLimitPpm) {
  const uint8_t doubt = sjSirenDoubtfulFields(r);
  if (waterLimitMm && (r.flags & SJ_HAS_WATER) && !(doubt & (1u << SJ_AF_WATER)) && r.water_level_mm >= waterLimitMm)
    return true;
  if (gasLimitPpm && (r.flags & SJ_HAS_GAS) && !(doubt & (1u << SJ_AF_GAS)) && r.gas_ppm >= gasLimitPpm) return true;
  return false;
}
