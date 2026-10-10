// =====================================================================
// SANJEEVNI gateway - forwarding bookkeeping (hardware-independent, so it
// is unit-tested on a PC: tools/firmware_host_test).
//
// The backend upload runs in its own FreeRTOS task and does NOT hold the
// queue lock while the HTTP / AT request is in flight - that is the point:
// the LoRa loop keeps receiving, queueing and ACKing node packets during a
// 15 s WiFi timeout or a minute-long NB-IoT exchange (review B: the
// gateway used to be deaf for the whole request, so nodes missed ACKs and
// their queues stalled behind one reading).
//
// The price: the queue can change under an upload. New readings are only
// appended at the tail, which is harmless. But a push into a FULL ring
// overwrites the oldest reading - one of the readings being uploaded - and
// a Serial 'c' empties the queue. Popping `sent` blindly afterwards would
// then delete readings that were never sent.
// =====================================================================
#pragma once
#include <stdint.h>

// How many of the oldest readings to pop after the backend accepted the
// `sent` oldest ones. `dropped*` are SjFileQueue::dropped() and `clears*`
// a counter bumped on every clear(), both read when the batch was built
// and again now (under the queue lock). Each overflow since the build
// overwrote one of the sent readings at the head, so that many fewer are
// left to pop; after a clear() none of them is left.
inline uint32_t sjPopAfterUpload(uint32_t sent, uint32_t droppedAtBuild, uint32_t droppedNow, uint32_t clearsAtBuild,
                                 uint32_t clearsNow) {
  if (clearsNow != clearsAtBuild) return 0;
  uint32_t overwritten = droppedNow - droppedAtBuild;  // dropped only grows between clears
  return overwritten >= sent ? 0 : sent - overwritten;
}

// ---- the order of one forwarding pass, and what a refusal stops ----------
// forwardQueue() sends, oldest first within each: SOS readings (a node's
// button), SOS requests from the offline Wi-Fi, urgent readings, then the
// backlog. An SOS that the server answers with "not now" (401 / 403 / 429
// / 5xx ...) is PARKED for the rest of the pass - it stays first in its
// outbox and goes first again on the next pass - but the readings behind
// it still go. It used to end the pass: one tap on the open SANJEEVNI-SOS
// Wi-Fi of a gateway whose GATEWAY_ID is not in its device key (403)
// stopped every reading upload - flood alerts and the siren commands that
// ride on their answers included - until an admin fixed the key (review).
// Only "no answer at all" (negative code: no network, DNS, timeout) ends
// the pass: then the readings would fail the same way.
enum SjFwdStep : uint8_t {
  SJ_FWD_SOS = 0,   // forwardSos()
  SJ_FWD_SOS_MSG,   // forwardSosMsg()
  SJ_FWD_URGENT,    // forwardUrgent()
  SJ_FWD_BACKLOG,   // one batch of the queue
  SJ_FWD_IDLE,      // nothing (else) to send in this pass
};

// What to send next. A parked outbox counts as empty for the rest of the pass.
inline SjFwdStep sjForwardStep(bool sosWaiting, bool sosParked, bool sosMsgWaiting, bool sosMsgParked,
                               bool urgentWaiting, bool queued) {
  if (sosWaiting && !sosParked) return SJ_FWD_SOS;
  if (sosMsgWaiting && !sosMsgParked) return SJ_FWD_SOS_MSG;
  if (urgentWaiting) return SJ_FWD_URGENT;
  if (queued) return SJ_FWD_BACKLOG;
  return SJ_FWD_IDLE;
}

// An SOS request the server did not take yet (sjUploadAction() RETRY):
// true = park it and carry on with the readings; false = end the pass.
inline bool sjSosRetryParks(int httpCode) { return httpCode > 0; }
