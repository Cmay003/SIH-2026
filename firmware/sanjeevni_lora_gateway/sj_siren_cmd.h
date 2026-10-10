// =====================================================================
// SANJEEVNI gateway - siren commands waiting for their node
// (hardware-independent, so it is unit-tested on a PC:
// tools/firmware_host_test).
//
// The server answers each upload with the siren state it WANTS for every
// siren-fitted node in that upload whose reported state differs ("commands",
// parsed by sjParseSirenCommands in sj_packet.h). A node only listens
// right after it transmits, so the gateway keeps the wanted state here and
// puts it in the ACK of that node's next reading (SjAckCmd, with a MAC in
// the node's own key - sj_auth.h) - as long as the node is NOT in that
// state yet. "The node's state" is the one it stamps into each copy it
// TRANSMITS (SjReading.tx_state), not the measured flags: after an outage
// a node drains its backlog oldest first, and those readings are from
// before the command - taken at face value, every one of them "confirmed"
// an officer's "off" (or an "on") and dropped it, so the siren could not
// be silenced until the drain reached the sounding-era readings (review).
// It is kept until:
//  - a reading from the node shows the wanted state (it arrived), or
//  - the server's COMPLETE answer to an upload with a siren-fitted reading
//    from the node has no command for it (the server says the state is
//    right, e.g. an officer cancelled before delivery), or
//  - it expires: an "on" when its time is up (the node is told the
//    REMAINING seconds, so a late delivery does not sound longer than the
//    officer asked), an "off" after offTtlS.
// A lost ACK costs nothing: the next reading gets the command again, and
// the node ignores a repeated "on" while it is already sounding by command.
//
// Kept in NVS by the sketch (sjSirenSave / sjSirenRestore) so a gateway
// reboot does not lose a pending command while the backhaul is down. Times
// are the gateway's seconds since boot (esp_timer: no wrap in practice); a
// restore re-bases them on the new boot, so a reboot can stretch an "on"
// by as long as the reboot took.
// =====================================================================
#pragma once
#include <stdint.h>
#include <string.h>
#include "sj_packet.h"

// A reading without the transmit stamp (tx_state 0: v3 firmware from before
// it) shows the node's state only if it is this fresh - else it is backlog.
#define SJ_SIREN_FLAGS_FRESH_S 30

struct SjSirenPending {
  char node_id[SJ_NODE_ID_LEN];  // NUL-padded like SjReading.node_id
  uint8_t used;
  uint8_t on;
  uint16_t reserved;
  uint32_t expiresAtS;
};

template <uint8_t N>
struct SjSirenCmdTable {
  SjSirenPending slots[N];  // no initialisers: a plain aggregate, zero as a static
};

struct SjSirenCmdLimits {
  uint16_t defaultOnS;  // "on" without for_s
  uint16_t maxOnS;      // an "on" is never kept longer than this
  uint32_t offTtlS;     // an "off" is given up after this
};

// Siren-fitted nodes that had a reading in one upload (for the "no command
// = state is right" rule). More than SJ_SIREN_FITTED_MAX distinct nodes in
// one upload: the extra ones are just not cleared by this answer.
#define SJ_SIREN_FITTED_MAX 8
struct SjFittedNodes {
  char ids[SJ_SIREN_FITTED_MAX][SJ_NODE_ID_LEN];
  uint8_t n;

  void clear() { n = 0; }
  bool has(const char* id) const {
    for (uint8_t i = 0; i < n; i++)
      if (strncmp(ids[i], id, SJ_NODE_ID_LEN) == 0) return true;
    return false;
  }
  void add(const SjReading& r) {
    if (!(r.flags & SJ_SIREN_FITTED) || has(r.node_id) || n >= SJ_SIREN_FITTED_MAX) return;
    memcpy(ids[n++], r.node_id, SJ_NODE_ID_LEN);
  }
};

template <uint8_t N>
inline int sjSirenFind(const SjSirenCmdTable<N>& t, const char* nodeId) {
  for (uint8_t i = 0; i < N; i++)
    if (t.slots[i].used && strncmp(t.slots[i].node_id, nodeId, SJ_NODE_ID_LEN) == 0) return i;
  return -1;
}

template <uint8_t N>
inline uint8_t sjSirenPendingCount(const SjSirenCmdTable<N>& t) {
  uint8_t n = 0;
  for (uint8_t i = 0; i < N; i++) n += t.slots[i].used ? 1 : 0;
  return n;
}

template <uint8_t N>
inline bool sjSirenExpire(SjSirenCmdTable<N>& t, uint32_t nowS) {
  bool changed = false;
  for (uint8_t i = 0; i < N; i++) {
    if (t.slots[i].used && nowS >= t.slots[i].expiresAtS) {
      t.slots[i].used = 0;
      changed = true;
    }
  }
  return changed;
}

template <uint8_t N>
inline bool sjSirenClearNode(SjSirenCmdTable<N>& t, const char* nodeId) {
  int i = sjSirenFind(t, nodeId);
  if (i < 0) return false;
  t.slots[i].used = 0;
  return true;
}

// Stores one server command. Returns true if the table changed enough to
// be worth an NVS write (the server repeats a command in every answer
// until the node shows it; re-writing NVS for each repeat is not needed).
template <uint8_t N>
inline bool sjSirenSet(SjSirenCmdTable<N>& t, const SjSirenCommand& c, uint32_t nowS, const SjSirenCmdLimits& lim) {
  char id[SJ_NODE_ID_LEN] = {0};  // NUL-padded, as in a reading
  memcpy(id, c.node_id, strnlen(c.node_id, SJ_NODE_ID_LEN));
  uint32_t ttl = c.on ? (c.forS ? c.forS : lim.defaultOnS) : lim.offTtlS;
  if (c.on && ttl > lim.maxOnS) ttl = lim.maxOnS;
  if (ttl < 1) ttl = 1;
  uint32_t expires = nowS + ttl;
  int i = sjSirenFind(t, id);
  if (i < 0) {
    for (uint8_t k = 0; k < N && i < 0; k++)
      if (!t.slots[k].used) i = k;
  }
  if (i < 0) {  // full: the one closest to giving up anyway makes room
    i = 0;
    for (uint8_t k = 1; k < N; k++)
      if (t.slots[k].expiresAtS < t.slots[i].expiresAtS) i = k;
    t.slots[i].used = 0;
  }
  SjSirenPending& s = t.slots[i];
  uint32_t moved = s.expiresAtS > expires ? s.expiresAtS - expires : expires - s.expiresAtS;
  bool changed = !s.used || s.on != c.on || moved > 60;
  memcpy(s.node_id, id, SJ_NODE_ID_LEN);
  s.used = 1;
  s.on = c.on;
  s.expiresAtS = expires;
  return changed;
}

// After a 200 answer: every siren-fitted node of the upload without a
// command is as the server wants it (drop its pending command); every
// command is stored. Returns true if the table changed. The sketch calls
// sjSirenApplyAnswer() below, which decides whether the answer is
// complete enough for the first part.
template <uint8_t N>
inline bool sjSirenApplyResponse(SjSirenCmdTable<N>& t, const SjSirenCommand* cmds, int n, const SjFittedNodes& fitted,
                                 uint32_t nowS, const SjSirenCmdLimits& lim) {
  bool changed = false;
  for (uint8_t f = 0; f < fitted.n; f++) {
    bool commanded = false;
    for (int k = 0; k < n && !commanded; k++) commanded = strncmp(cmds[k].node_id, fitted.ids[f], SJ_NODE_ID_LEN) == 0;
    if (!commanded) changed |= sjSirenClearNode(t, fitted.ids[f]);
  }
  for (int k = 0; k < n; k++) changed |= sjSirenSet(t, cmds[k], nowS, lim);
  return changed;
}

// The node's siren at the moment it sent `r`: 1 sounding, 0 silent, -1
// unknown (an unstamped reading from the backlog).
inline int sjSirenStateNow(const SjReading& r) {
  if (r.tx_state & SJ_TX_VALID) return (r.tx_state & SJ_TX_SIREN_ON) ? 1 : 0;
  if (r.age_s != SJ_AGE_UNKNOWN && r.age_s <= SJ_SIREN_FLAGS_FRESH_S) return (r.flags & SJ_SIREN_ON) ? 1 : 0;
  return -1;
}

// A reading from a node arrived (loop(), before its ACK). true = send `out`
// in an SjAckCmd instead of the plain ACK. `changed`: the table changed
// (an entry delivered-and-confirmed or expired) - save it after the ACK.
// Only a reading flagged SJ_SIREN_FITTED gets a command: older firmware
// would not take the longer ACK as an ACK (sj_packet.h). A reading that
// can't tell the node's state now gets the command anyway: a repeated "on"
// changes nothing on the node, a repeated "off" leaves it silent.
template <uint8_t N>
inline bool sjSirenForReading(SjSirenCmdTable<N>& t, const SjReading& r, uint32_t nowS, SjDownlink& out,
                              bool& changed) {
  out.cmd = SJ_CMD_NONE;
  out.arg = 0;
  out.refused = 0;
  changed = sjSirenExpire(t, nowS);
  if (!(r.flags & SJ_SIREN_FITTED)) return false;
  int i = sjSirenFind(t, r.node_id);
  if (i < 0) return false;
  int state = sjSirenStateNow(r);
  if (state >= 0 && (state == 1) == (t.slots[i].on != 0)) {  // the node is there: done
    t.slots[i].used = 0;
    changed = true;
    return false;
  }
  out.cmd = t.slots[i].on ? SJ_CMD_SIREN_ON : SJ_CMD_SIREN_OFF;
  if (t.slots[i].on) {
    uint32_t left = t.slots[i].expiresAtS - nowS;  // > 0: expired ones are gone
    out.arg = left > 65535 ? 65535 : (uint16_t)left;
  }
  return true;
}

// The whole body is one JSON object, read to its closing brace with
// nothing but whitespace after it (sjjson::skip follows strings and
// nesting). Empty, cut off, an HTML error page: false.
inline bool sjJsonObjectComplete(const char* body) {
  const char* p = sjjson::ws(body);
  if (*p != '{') return false;
  p = sjjson::skip(p);
  return p && *sjjson::ws(p) == '\0';
}

// A 200 answer's body: its commands are stored (`cmds` / `n` get them, for
// the log). Only if the body is a complete JSON object AND its "commands"
// array (if any) was read to the end does "no command for a fitted node"
// drop that node's pending command. The SIM7020's body read is best-effort
// and HTTPClient::getString() can come back empty; such a body used to
// count as "the server wants nothing" and wiped every pending command of
// the upload - an officer's "off" included (review). Now it just delays:
// the next complete answer decides. Returns true if the table changed.
template <uint8_t N>
inline bool sjSirenApplyAnswer(SjSirenCmdTable<N>& t, const char* body, const SjFittedNodes& fitted, uint32_t nowS,
                               const SjSirenCmdLimits& lim, SjSirenCommand* cmds, int maxCmds, int& n) {
  bool arrayComplete = false;
  n = sjParseSirenCommands(body ? body : "", cmds, maxCmds, &arrayComplete);
  bool mayClear = body && sjJsonObjectComplete(body) && (n < 0 || arrayComplete);
  if (n < 0) n = 0;
  SjFittedNodes none;
  none.clear();
  return sjSirenApplyResponse(t, cmds, n, mayClear ? fitted : none, nowS, lim);
}

// ---- NVS copy ---------------------------------------------------------------
#define SJ_SIREN_SAVE_MAGIC 0x534A4331u  // "SJC1" - bump if the layout changes

struct SjSirenSavedEntry {
  char node_id[SJ_NODE_ID_LEN];
  uint8_t on;
  uint8_t reserved[3];
  uint32_t remainingS;  // 0 = empty
};

template <uint8_t N>
struct SjSirenCmdSaved {
  uint32_t magic;
  SjSirenSavedEntry e[N];
};

template <uint8_t N>
inline void sjSirenSave(const SjSirenCmdTable<N>& t, uint32_t nowS, SjSirenCmdSaved<N>& out) {
  memset(&out, 0, sizeof(out));
  out.magic = SJ_SIREN_SAVE_MAGIC;
  for (uint8_t i = 0; i < N; i++) {
    const SjSirenPending& s = t.slots[i];
    if (!s.used || nowS >= s.expiresAtS) continue;
    memcpy(out.e[i].node_id, s.node_id, SJ_NODE_ID_LEN);
    out.e[i].on = s.on;
    out.e[i].remainingS = s.expiresAtS - nowS;
  }
}

// Only entries that still look like ours (magic, a node id, a sane time)
// come back - a damaged or foreign copy restores nothing rather than a
// siren command nobody gave. Returns how many were restored.
template <uint8_t N>
inline uint8_t sjSirenRestore(SjSirenCmdTable<N>& t, const SjSirenCmdSaved<N>& saved, uint32_t nowS,
                              const SjSirenCmdLimits& lim) {
  memset(&t, 0, sizeof(t));
  if (saved.magic != SJ_SIREN_SAVE_MAGIC) return 0;
  uint8_t n = 0;
  uint32_t longest = lim.maxOnS > lim.offTtlS ? lim.maxOnS : lim.offTtlS;
  for (uint8_t i = 0; i < N; i++) {
    const SjSirenSavedEntry& e = saved.e[i];
    char c = e.node_id[0];
    if (e.remainingS == 0 || e.remainingS > longest || e.on > 1 || c <= ' ' || c > '~') continue;
    memcpy(t.slots[i].node_id, e.node_id, SJ_NODE_ID_LEN);
    t.slots[i].used = 1;
    t.slots[i].on = e.on;
    t.slots[i].expiresAtS = nowS + e.remainingS;
    n++;
  }
  return n;
}
