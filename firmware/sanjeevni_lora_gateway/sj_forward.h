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
