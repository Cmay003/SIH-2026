// =====================================================================
// SANJEEVNI node - SOS push-button (hardware-independent, so it is
// unit-tested on a PC: tools/firmware_host_test).
//
// For people with no phone: a push-button on the node. Holding it for
// SOS_HOLD_MS sends one reading flagged SJ_SOS_PRESSED; the server raises
// an SOS at the node's registered position.
//  - A HOLD, not a press: a bump, an animal or a falling branch must not
//    raise an SOS. The LED blinks fast while it is held (sjSosLed).
//  - One press = one SOS: holding on does nothing more, the button has to
//    be released first. After an SOS, presses are ignored for the cooldown
//    (a child pressing it again and again must not flood the radio; the
//    server keeps one open SOS per node anyway).
//  - STUCK: a button already pressed at power-on (water in it, a shorted
//    cable) or held longer than stuckMs is not a person: no SOS until it is
//    released, the self-test says so, and deep sleep does not arm the
//    button wake-up while it is pressed (it would wake again at once).
//
// The sketch feeds every pin edge (from the interrupt, so a press is seen
// even while loop() is stuck in a 20-s backlog flush or a sensor read) and
// regular samples (from loop(): a hold that is still going on has no edge)
// into sjSosUpdate(), and collects the SOS with sjSosTakeTrigger().
// Times are millis(); all differences are unsigned, so a wrap is harmless.
// =====================================================================
#pragma once
#include <stdint.h>
#include <string.h>
#include "sj_packet.h"

#define SJ_SOS_NEVER 0xFFFFFFFFu  // sjSosBegin(): no SOS sent before

struct SjSosTiming {
  uint32_t holdMs;      // pressed at least this long = SOS
  uint32_t cooldownMs;  // after an SOS, presses are ignored this long
  uint32_t stuckMs;     // pressed longer than this = stuck, not a person
  uint32_t debounceMs;  // a release shorter than this is contact bounce
};

enum SjSosPhase : uint8_t {
  SJ_SOS_IDLE = 0,  // not pressed
  SJ_SOS_HOLDING,   // pressed, not long enough yet ("keep holding")
  SJ_SOS_HELD,      // this press already sent its SOS (or came in the cooldown) - release to re-arm
  SJ_SOS_STUCK,     // pressed since power-on or for > stuckMs: disabled until released
};

struct SjSosButton {
  uint8_t down;            // pressed (a release still inside the debounce time counts as pressed)
  uint8_t releasing;       // released at upAtMs, not confirmed yet (bounce?)
  uint8_t used;            // this press triggered or was refused - no second SOS from it
  uint8_t stuck;
  uint8_t triggerPending;  // an SOS to send - collected by sjSosTakeTrigger()
  uint8_t inCooldown;      // lastTriggerMs is recent
  uint8_t refused;         // a press came during the cooldown - the sketch logs it and clears this
  uint8_t reserved;
  uint32_t downAtMs;
  uint32_t upAtMs;
  uint32_t lastTriggerMs;
};

// `pressedNow`: the pin at start-up. `wokeByButton`: a deep-sleep wake
// caused by the button - its press began at the wake, i.e. at millis() 0.
// Pressed at any other start = stuck (nobody holds a button through a
// power-on; water in the button does). `sinceLastSosMs`: how long ago the
// previous SOS was (kept over deep sleep), SJ_SOS_NEVER = none.
inline void sjSosBegin(SjSosButton& b, bool pressedNow, bool wokeByButton, uint32_t nowMs, uint32_t sinceLastSosMs,
                       const SjSosTiming& t) {
  memset(&b, 0, sizeof(b));
  if (sinceLastSosMs != SJ_SOS_NEVER && sinceLastSosMs < t.cooldownMs) {
    b.inCooldown = 1;
    b.lastTriggerMs = nowMs - sinceLastSosMs;
  }
  if (!pressedNow) return;
  b.down = 1;
  if (wokeByButton) {
    b.downAtMs = 0;
  } else {
    b.downAtMs = nowMs;
    b.stuck = 1;
    b.used = 1;
  }
}

inline void sjSosTriggerAt(SjSosButton& b, uint32_t atMs, const SjSosTiming& t) {
  b.used = 1;
  if (b.stuck) return;
  if (b.inCooldown && atMs - b.lastTriggerMs < t.cooldownMs) {
    b.refused = 1;
    return;
  }
  b.refused = 0;
  b.triggerPending = 1;
  b.inCooldown = 1;
  b.lastTriggerMs = atMs;
}

// A press ended at endMs: long enough and not used yet = SOS (the loop
// may have been busy for the whole hold - the interrupt still saw both edges).
inline void sjSosFinishPress(SjSosButton& b, uint32_t endMs, const SjSosTiming& t) {
  if (!b.used && endMs - b.downAtMs >= t.holdMs) sjSosTriggerAt(b, b.downAtMs + t.holdMs, t);
  b.down = 0;
  b.releasing = 0;
  b.used = 0;
  b.stuck = 0;
}

inline void sjSosStartPress(SjSosButton& b, uint32_t nowMs) {
  b.down = 1;
  b.releasing = 0;
  b.used = 0;
  b.downAtMs = nowMs;
}

// The phase for the LED / self-test. A release still inside
// the debounce time counts as pressed.
inline SjSosPhase sjSosPhase(const SjSosButton& b) {
  if (!b.down) return SJ_SOS_IDLE;
  if (b.stuck) return SJ_SOS_STUCK;
  return b.used ? SJ_SOS_HELD : SJ_SOS_HOLDING;
}

// Feed one observation of the pin: an edge from the interrupt or a sample
// from loop() (pressed = pin LOW). Returns the phase afterwards.
inline SjSosPhase sjSosUpdate(SjSosButton& b, bool pressed, uint32_t nowMs, const SjSosTiming& t) {
  if (b.inCooldown && nowMs - b.lastTriggerMs >= t.cooldownMs) b.inCooldown = 0;  // also ends the wrap risk
  if (!b.down) {
    if (pressed) sjSosStartPress(b, nowMs);
  } else if (b.releasing) {
    if (nowMs - b.upAtMs < t.debounceMs) {
      if (pressed) b.releasing = 0;  // bounce: still the same press
    } else {
      sjSosFinishPress(b, b.upAtMs, t);  // the release was real
      if (pressed) sjSosStartPress(b, nowMs);
    }
  } else if (!pressed) {
    b.releasing = 1;
    b.upAtMs = nowMs;
  }
  if (b.down && !b.releasing) {
    uint32_t heldMs = nowMs - b.downAtMs;
    if (!b.used && heldMs >= t.holdMs) sjSosTriggerAt(b, nowMs, t);
    if (heldMs >= t.stuckMs) b.stuck = 1;
  }
  return sjSosPhase(b);
}

// true once per SOS: the sketch measures and sends the SOS reading.
inline bool sjSosTakeTrigger(SjSosButton& b) {
  bool t = b.triggerPending;
  b.triggerPending = 0;
  return t;
}

// sjSosBegin()'s sinceLastSosMs from the RTC-clock seconds kept over deep
// sleep (millis() restarts at every wake, so the cooldown can't use it).
inline uint32_t sjSosSinceLastMs(bool ever, uint32_t lastSosS, uint32_t nowS) {
  if (!ever) return SJ_SOS_NEVER;
  uint32_t s = nowS - lastSosS;
  return s >= (SJ_SOS_NEVER - 1) / 1000 ? SJ_SOS_NEVER - 1 : s * 1000;
}

// How long the button has been held (0 = released) - self-test detail.
inline uint32_t sjSosHeldMs(const SjSosButton& b, uint32_t nowMs) { return b.down ? nowMs - b.downAtMs : 0; }

// LED feedback for the person at the node. -1 = no SOS business: the LED
// shows what it normally shows (elevated readings).
//   holding        fast blink ("keep holding")
//   delivered      on until confirmUntilMs ("the gateway has it")
//   sending        slow blink (in the outbox, not acknowledged yet)
//   held / stuck   on while pressed (an SOS was just sent / is refused)
inline int sjSosLed(SjSosPhase phase, bool sending, bool confirmed, uint32_t nowMs) {
  if (phase == SJ_SOS_HOLDING) return (nowMs / 80) % 2;
  if (confirmed) return 1;
  if (sending) return (nowMs / 500) % 2;
  if (phase != SJ_SOS_IDLE) return 1;
  return -1;
}

// The "delivered" LED window. Elapsed time is unsigned and the flag is
// cleared once the window is over: the old signed "until" check turned
// true again ~24.8 days later and lit the LED for another 24.8 days on an
// always-on node, hiding the elevated-reading blink.
inline bool sjSosConfirmShowing(bool& confirmed, uint32_t confirmedAtMs, uint32_t nowMs, uint32_t windowMs) {
  if (confirmed && nowMs - confirmedAtMs >= windowMs) confirmed = false;
  return confirmed;
}

// ---- getting the SOS reading out first ----------------------------------
// loop()'s "is a flush due?" for a retry time `dueMs` that is at most
// `maxWaitMs` ahead (FLUSH_RETRY_INTERVAL_MS). The signed check
// (int32_t)(now - due) >= 0 alone fails once `due` is more than 2^31 ms
// (24.8 days) old: "due = 0, send now" for an SOS stopped working after
// 24.8 days of uptime, and so did every flush when nothing refreshed
// `due`. Here anything not within maxWaitMs ahead counts as overdue, so a
// stale value can only ever make a flush come early, never late.
inline bool sjFlushDue(uint32_t nowMs, uint32_t dueMs, uint32_t maxWaitMs) {
  uint32_t wait = dueMs - nowMs;
  return wait == 0 || wait > maxWaitMs;
}

// The newest SOS reading among the newest `maxScan` queued records. Only
// for a start after a power-on, when RTC memory (sjSleepPendingSos(), which
// covers deep sleep and resets) is lost: its outbox entry is found again
// here and goes first once more. seq 0 = any SOS reading, else only
// session/seq. An unreadable record is skipped, not fatal.
template <typename Queue, typename T>
inline bool sjFindQueuedSos(Queue& queue, uint32_t maxScan, uint32_t session, uint32_t seq, T& out) {
  uint32_t n = queue.count();
  for (uint32_t k = 0; k < maxScan && k < n; k++) {
    T rec;
    if (!queue.peek(n - 1 - k, rec)) {
      if (queue.count() != n) return false;  // peek() rebuilt the queue: indexes moved, give up
      continue;
    }
    if (!(rec.reading.flags & SJ_SOS_PRESSED)) continue;
    if (seq != 0 && (rec.reading.session != session || rec.reading.seq != seq)) continue;
    out = rec;
    return true;
  }
  return false;
}

enum SjFlushResult : uint8_t {
  SJ_FLUSH_DONE = 0,     // outbox empty and up to maxSends queued readings sent
  SJ_FLUSH_NO_ACK,       // a send was not acknowledged - everything stays, retry later
  SJ_FLUSH_SOS_WAITING,  // stopped early: a new SOS was just held, measure and send it first
  SJ_FLUSH_STUCK,        // the oldest record can't be read and the queue could not repair itself
};

// One flush of the LoRa node, in this order (sj_packet.h):
//  1. the SOS outbox, each until acknowledged
//  2. the urgent outbox (SJ_X_PRIORITY readings - WATCH / URGENT, a fast
//     rise, a new anomaly), oldest first, each until acknowledged
//  3. the oldest queued readings, one acknowledged send each - the flash
//     queue's rules are unchanged (only an acknowledged head is popped).
//     A queued copy of a reading that already went ahead (in `ahead`) is
//     popped without being sent again. A queued copy goes WITHOUT
//     SJ_X_PRIORITY: it is backlog (an urgent reading whose outbox entry
//     made room for a newer one, or was lost in a reboot) and must not
//     jump the gateway's backlog as news (sjIsUrgentReading, review).
// Steps 2 and 3 share `maxSends`; `sosHeld()` is checked before each of
// their sends, so a press during a long flush waits at most one send.
template <typename Queue, typename T, uint8_t NS, uint8_t NU, uint8_t M, typename SendFn, typename SosHeldFn,
          typename DeliveredFn>
inline SjFlushResult sjFlushOnce(Queue& queue, SjPriorityOutbox<T, NS>& sosOutbox, SjPriorityOutbox<T, NU>& urgent,
                                 SjSentAhead<M>& ahead, int maxSends, SendFn send, SosHeldFn sosHeld,
                                 DeliveredFn onSosDelivered) {
  while (!sosOutbox.empty()) {
    T item = sosOutbox.front();
    if (!send(item)) return SJ_FLUSH_NO_ACK;
    sosOutbox.remove(item.reading);
    ahead.add(item.reading);
    onSosDelivered(item);
  }
  int sent = 0;
  for (; sent < maxSends && !urgent.empty(); sent++) {
    if (sosHeld()) return SJ_FLUSH_SOS_WAITING;
    T item = urgent.front();
    if (!send(item)) return SJ_FLUSH_NO_ACK;
    urgent.remove(item.reading);
    ahead.add(item.reading);
  }
  for (; sent < maxSends && queue.count() > 0; sent++) {
    if (sosHeld()) return SJ_FLUSH_SOS_WAITING;
    sjPopSentAhead<T>(queue, ahead);  // no airtime: they are at the gateway already
    if (queue.count() == 0) break;
    T item;
    uint32_t before = queue.count();
    if (!queue.peek(0, item)) {
      // peek() rebuilt the queue or skipped the unreadable oldest record:
      // carry on with the new oldest. Nothing changed = flash failing.
      if (queue.count() != before) continue;
      return SJ_FLUSH_STUCK;
    }
    item.reading.xflags &= (uint8_t)~SJ_X_PRIORITY;  // the copy on air only: the flash record is untouched
    if (!send(item)) return SJ_FLUSH_NO_ACK;
    queue.pop(1);
  }
  return SJ_FLUSH_DONE;
}
