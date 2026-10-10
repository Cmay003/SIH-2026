// Tests for the node's SOS push-button (sj_sos.h) and for SOS readings
// going out before a queued backlog (SjPriorityOutbox in sj_packet.h,
// sjFlushOnce / sjFindQueuedSos in sj_sos.h). Included by
// test_firmware_logic.cpp (uses its CHECK and makeReading).
#pragma once
#include <algorithm>
#include <vector>

namespace sos {

// Same shape as the node's QueuedReading (and the gateway's record): the
// outbox only needs a `reading` member.
struct QRec {
  SjReading reading;
  uint32_t takenAtS;
};

inline QRec rec(uint32_t session, uint32_t seq, bool sosFlag = false) {
  QRec r = {makeReading("NODE-07", session, seq), seq};
  r.reading.flags = SJ_HAS_WATER | (sosFlag ? SJ_SOS_PRESSED : 0);
  r.reading.water_level_mm = 500;
  return r;
}

// ---- the press rules: hold, bounce, cooldown, stuck, deep-sleep wake ----
inline void buttonTests() {
  const SjSosTiming t = {2000, 60000, 30000, 50};
  SjSosButton b;

  // a 2-s hold = one SOS; holding on does not send a second one
  sjSosBegin(b, false, false, 1000, SJ_SOS_NEVER, t);
  CHECK(sjSosUpdate(b, false, 1000, t) == SJ_SOS_IDLE);
  CHECK(sjSosUpdate(b, true, 1010, t) == SJ_SOS_HOLDING);
  CHECK(sjSosUpdate(b, true, 3009, t) == SJ_SOS_HOLDING && !sjSosTakeTrigger(b));
  CHECK(sjSosUpdate(b, true, 3010, t) == SJ_SOS_HELD && sjSosTakeTrigger(b));
  CHECK(!sjSosTakeTrigger(b));  // collected once
  for (uint32_t ms = 3020; ms < 9000; ms += 500) sjSosUpdate(b, true, ms, t);
  CHECK(!sjSosTakeTrigger(b) && sjSosHeldMs(b, 9000) == 7990);
  sjSosUpdate(b, false, 9000, t);
  CHECK(sjSosUpdate(b, false, 9100, t) == SJ_SOS_IDLE && !sjSosTakeTrigger(b) && sjSosHeldMs(b, 9100) == 0);

  // a bump / a 1.9-s press: nothing
  sjSosBegin(b, false, false, 0, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 100, t);
  sjSosUpdate(b, false, 1999, t);
  sjSosUpdate(b, false, 2500, t);
  CHECK(!sjSosTakeTrigger(b) && sjSosPhase(b) == SJ_SOS_IDLE);

  // contact bounce mid-hold does not restart the 2 s...
  sjSosBegin(b, false, false, 0, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 0, t);
  sjSosUpdate(b, false, 1500, t);
  sjSosUpdate(b, true, 1510, t);
  CHECK(sjSosUpdate(b, true, 2000, t) == SJ_SOS_HELD && sjSosTakeTrigger(b));
  // ...and release bounce does not start a second press that triggers
  sjSosUpdate(b, false, 5000, t);
  sjSosUpdate(b, true, 5005, t);
  sjSosUpdate(b, false, 5010, t);
  sjSosUpdate(b, false, 5100, t);
  CHECK(!sjSosTakeTrigger(b) && sjSosPhase(b) == SJ_SOS_IDLE);

  // a 1-s gap is a real release: two 1.5-s presses do not add up to an SOS
  sjSosBegin(b, false, false, 0, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 0, t);
  sjSosUpdate(b, false, 1500, t);
  sjSosUpdate(b, true, 2500, t);
  sjSosUpdate(b, false, 4000, t);
  sjSosUpdate(b, false, 4100, t);
  CHECK(!sjSosTakeTrigger(b));

  // loop() blocked for the whole hold (backlog flush, HTTPS timeout): the
  // interrupt's two edges are enough, once the release is confirmed
  sjSosBegin(b, false, false, 0, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 100, t);    // edge
  sjSosUpdate(b, false, 2600, t);  // edge: released after 2.5 s
  CHECK(!sjSosTakeTrigger(b));     // could still be a bounce
  sjSosUpdate(b, false, 20000, t); // loop() samples again 17 s later
  CHECK(sjSosTakeTrigger(b) && b.lastTriggerMs == 2100);  // cooldown from when the 2 s were reached
  // ...or the next press edge confirms it - and that new press is in the cooldown
  sjSosBegin(b, false, false, 0, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 0, t);
  sjSosUpdate(b, false, 2500, t);
  CHECK(sjSosUpdate(b, true, 2700, t) == SJ_SOS_HOLDING && sjSosTakeTrigger(b));
  CHECK(sjSosUpdate(b, true, 4700, t) == SJ_SOS_HELD && !sjSosTakeTrigger(b) && b.refused);

  // cooldown: a second hold within 60 s is refused, after it works again
  sjSosBegin(b, false, false, 0, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 0, t);
  sjSosUpdate(b, true, 2000, t);
  CHECK(sjSosTakeTrigger(b));
  sjSosUpdate(b, false, 3000, t);
  sjSosUpdate(b, false, 3100, t);
  sjSosUpdate(b, true, 10000, t);
  CHECK(sjSosUpdate(b, true, 12000, t) == SJ_SOS_HELD && !sjSosTakeTrigger(b) && b.refused);
  sjSosUpdate(b, false, 13000, t);
  sjSosUpdate(b, false, 13100, t);
  sjSosUpdate(b, true, 62000, t);  // 60 s after the first SOS
  CHECK(sjSosUpdate(b, true, 64000, t) == SJ_SOS_HELD && sjSosTakeTrigger(b));

  // stuck: pressed at power-on = water in the button / a shorted cable
  sjSosBegin(b, true, false, 500, SJ_SOS_NEVER, t);
  CHECK(sjSosPhase(b) == SJ_SOS_STUCK);
  for (uint32_t ms = 500; ms < 120000; ms += 1000) sjSosUpdate(b, true, ms, t);
  CHECK(!sjSosTakeTrigger(b) && sjSosPhase(b) == SJ_SOS_STUCK);
  CHECK(sjCheckSosButton(true, b.stuck, sjSosHeldMs(b, 119500), 2000).status == SJ_CHECK_FAIL);
  sjSosUpdate(b, false, 120000, t);  // dried out / fixed: released...
  sjSosUpdate(b, false, 120100, t);
  CHECK(sjSosPhase(b) == SJ_SOS_IDLE && !b.stuck && !sjSosTakeTrigger(b));  // ...without an SOS
  sjSosUpdate(b, true, 130000, t);  // and a real hold works again
  CHECK(sjSosUpdate(b, true, 132000, t) == SJ_SOS_HELD && sjSosTakeTrigger(b));
  // held past stuckMs: stuck from then on (the SOS of its first 2 s was sent)
  CHECK(sjSosUpdate(b, true, 160000, t) == SJ_SOS_STUCK && !sjSosTakeTrigger(b));

  // deep-sleep wake by the button: the press began at the wake (millis() 0)
  sjSosBegin(b, true, true, 350, SJ_SOS_NEVER, t);  // setup() ~350 ms after the wake
  CHECK(sjSosPhase(b) == SJ_SOS_HOLDING);
  CHECK(sjSosUpdate(b, true, 1999, t) == SJ_SOS_HOLDING);
  CHECK(sjSosUpdate(b, true, 2000, t) == SJ_SOS_HELD && sjSosTakeTrigger(b));
  sjSosBegin(b, false, true, 350, SJ_SOS_NEVER, t);  // a bump woke it: released by then
  CHECK(sjSosPhase(b) == SJ_SOS_IDLE && !sjSosTakeTrigger(b));
  sjSosBegin(b, true, true, 300, SJ_SOS_NEVER, t);   // released at 1.2 s: back to sleep, no SOS
  sjSosUpdate(b, false, 1200, t);
  CHECK(sjSosUpdate(b, false, 1300, t) == SJ_SOS_IDLE && !sjSosTakeTrigger(b));
  // the cooldown spans deep sleep (RTC-clock seconds, millis() restarts)
  sjSosBegin(b, true, true, 300, sjSosSinceLastMs(true, 1000, 1030), t);  // last SOS 30 s ago
  sjSosUpdate(b, true, 2500, t);
  CHECK(!sjSosTakeTrigger(b) && b.refused);
  sjSosBegin(b, true, true, 300, sjSosSinceLastMs(true, 1000, 1061), t);  // 61 s ago
  sjSosUpdate(b, true, 2500, t);
  CHECK(sjSosTakeTrigger(b));
  CHECK(sjSosSinceLastMs(false, 0, 5) == SJ_SOS_NEVER);
  CHECK(sjSosSinceLastMs(true, 0, 0xFFFFFFF0u) == SJ_SOS_NEVER - 1);  // no overflow into "never"

  // millis() wraps in the middle of a hold
  sjSosBegin(b, false, false, 0xFFFFF000u, SJ_SOS_NEVER, t);
  sjSosUpdate(b, true, 0xFFFFFC00u, t);
  CHECK(sjSosUpdate(b, true, 0xFFFFFC00u + 1999u, t) == SJ_SOS_HOLDING);
  CHECK(sjSosUpdate(b, true, 0x000003D0u, t) == SJ_SOS_HELD && sjSosTakeTrigger(b));

  // the "delivered" LED window ends, and stays ended (review: a signed
  // "until" check lit it again ~24.8 days later for another 24.8 days)
  bool confirmed = true;
  CHECK(sjSosConfirmShowing(confirmed, 1000, 1000, 10000) && sjSosConfirmShowing(confirmed, 1000, 10999, 10000));
  CHECK(!sjSosConfirmShowing(confirmed, 1000, 11000, 10000) && !confirmed);
  CHECK(!sjSosConfirmShowing(confirmed, 1000, 1000 + 0x80000005u, 10000));
  confirmed = true;  // delivered just before millis() wraps
  CHECK(sjSosConfirmShowing(confirmed, 0xFFFFF000u, 0x00000100u, 10000));
  CHECK(!sjSosConfirmShowing(confirmed, 0xFFFFF000u, 0x00002000u, 10000) && !confirmed);

  // loop()'s flush schedule after 24.8+ days of uptime (review: "due = 0,
  // send now" was never due once millis() passed 0x80000000)
  const uint32_t retry = 10000;
  CHECK(sjFlushDue(0x80000005u, 0, retry));                // the old "0 = now"
  CHECK(sjFlushDue(0x80000005u, 0x80000005u, retry));      // "now" = millis()
  CHECK(sjFlushDue(0x80000005u, 5, retry));                // a due time 24.8 days old, never refreshed
  CHECK(sjFlushDue(0xFFFFFFF0u, 0x10u + 0x80000000u, retry));
  CHECK(!sjFlushDue(1000, 1000 + retry, retry) && !sjFlushDue(1000, 1001, retry));  // a real back-off waits
  CHECK(sjFlushDue(1000 + retry, 1000 + retry, retry) && sjFlushDue(1001 + retry, 1000 + retry, retry));
  CHECK(!sjFlushDue(0xFFFFF000u, 0xFFFFF000u + retry, retry));  // back-off across the wrap
  CHECK(sjFlushDue(0xFFFFF000u + retry, 0xFFFFF000u + retry, retry));

  // LED feedback
  CHECK(sjSosLed(SJ_SOS_IDLE, false, false, 0) == -1);  // nothing: the normal LED
  CHECK(sjSosLed(SJ_SOS_HOLDING, true, true, 0) == 0 && sjSosLed(SJ_SOS_HOLDING, false, false, 80) == 1);
  CHECK(sjSosLed(SJ_SOS_IDLE, true, false, 0) == 0 && sjSosLed(SJ_SOS_IDLE, true, false, 500) == 1);
  CHECK(sjSosLed(SJ_SOS_IDLE, true, true, 0) == 1);  // delivered beats "sending"
  CHECK(sjSosLed(SJ_SOS_HELD, false, false, 0) == 1 && sjSosLed(SJ_SOS_STUCK, false, false, 0) == 1);

  // self-test verdict
  CHECK(sjCheckSosButton(false, false, 0, 2000).status == SJ_CHECK_OK);
  CHECK(sjCheckSosButton(true, false, 500, 2000).status == SJ_CHECK_WARN);
  CHECK(std::strstr(sjCheckSosButton(true, true, 45000, 2000).detail, "SOS OFF until released"));

  // the shipped config.h
  CHECK(SOS_HOLD_MS >= 1000 && SOS_HOLD_MS <= 5000);
  CHECK(SOS_STUCK_MS > SOS_HOLD_MS && SOS_COOLDOWN_MS >= 10000 && SOS_DEBOUNCE_MS < SOS_HOLD_MS);
  CHECK(SOS_BUTTON_PIN < 0 || (sjIsRtcGpio(SOS_BUTTON_PIN) && SOS_BUTTON_PIN < 34 && SOS_BUTTON_PIN != 0 &&
                               SOS_BUTTON_PIN != 12 && SOS_BUTTON_PIN != LED_PIN));
}

// ---- packet flag + JSON -----------------------------------------------------
inline void packetTests() {
  CHECK(sizeof(SjReading) == 64);  // the flag itself needed no layout change (v3 grew it for sj_anomaly.h)
  CHECK(SJ_SOS_PRESSED == (1 << 12) && (SJ_SOS_PRESSED & SJ_MEASUREMENT_FLAGS) == 0);
  const uint16_t older = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME | SJ_FLAME_DETECTED | SJ_HAS_RAIN |
                         SJ_HAS_SOIL | SJ_HAS_TILT | SJ_HAS_PM | SJ_HAS_PH | SJ_HAS_TURBIDITY | SJ_HAS_BATTERY;
  CHECK((older & SJ_SOS_PRESSED) == 0);
  QRec r = rec(5, 6);
  String plain;
  sjAppendJson(plain, r.reading, 5, -90, "lora");
  CHECK(!std::strstr(plain.c_str(), "sos_button"));  // omitted when not pressed
  r.reading.flags |= SJ_SOS_PRESSED;
  String withSos;
  sjAppendJson(withSos, r.reading, 5, -90, "lora");
  CHECK(std::strstr(withSos.c_str(), ",\"sos_button\":true,"));
  CHECK(std::strstr(withSos.c_str(), "\"river_level_m\":0.500"));  // the measurements still go with it
  SjAck a = sjMakeAck(r.reading);  // ACKed like any reading
  CHECK(sjAckMatches((uint8_t*)&a, sizeof(a), r.reading));

  // sleep state: the new fields are sealed too, and there is no padding
  SjSleepState st;
  sjSleepStateReset(st, 7);
  CHECK(st.sosEver == 0 && st.sosAtS == 0 && st.sosPending == 0);
  st.sosEver = 1;
  st.sosAtS = 1234;
  sjSleepStateSeal(st);
  CHECK(sjSleepStateValid(st));
  st.sosAtS = 1235;
  CHECK(!sjSleepStateValid(st));
  CHECK(sizeof(SjSleepState) == offsetof(SjSleepState, check) + sizeof(uint32_t));
  CHECK(offsetof(SjSleepState, sosReading) + sizeof(SjReading) == offsetof(SjSleepState, check));
}

// ---- the outbox ---------------------------------------------------------------
inline void outboxTests() {
  SjPriorityOutbox<QRec, 2> ob = {};
  QRec s1 = rec(9, 1, true), s2 = rec(9, 2, true), s3 = rec(9, 3, true);
  QRec otherNode = s1;
  std::strncpy(otherNode.reading.node_id, "NODE-08", SJ_NODE_ID_LEN);
  CHECK(ob.empty() && ob.add(s1) && ob.count == 1);
  CHECK(ob.add(s1) && ob.count == 1);  // a resend of the same reading is kept once
  CHECK(ob.add(s2) && ob.count == 2 && ob.front().reading.seq == 1);
  CHECK(!ob.add(s3) && ob.count == 2 && ob.front().reading.seq == 2);  // full: the oldest made room
  CHECK(ob.remove(s3.reading) && ob.count == 1 && ob.front().reading.seq == 2);  // by identity, not position
  CHECK(!ob.remove(s1.reading));
  CHECK(ob.add(otherNode) && ob.count == 2);  // same session-seq from another node: another SOS
  ob.count = 200;  // a corrupted count never indexes past the array
  CHECK(ob.add(s1) && ob.count == 1);
  ob.clear();
  CHECK(ob.empty());
}

// ---- the SOS reading survives the queue / priority path ------------------------
inline void flushTests() {
  std::vector<uint32_t> sent;
  bool linkUp = false, held = false;
  int delivered = 0, holdAfter = -1;
  auto send = [&](QRec& r) {
    if (!linkUp) return false;
    sent.push_back(r.reading.seq);
    if (holdAfter > 0 && --holdAfter == 0) held = true;  // someone holds the button mid-flush
    return true;
  };
  auto sosHeld = [&] { return held; };
  auto onDelivered = [&](const QRec&) { delivered++; };

  {
    SjFileQueue<QRec> q;
    CHECK(q.begin("/sos.bin", "/sos.hdr", 500));
    q.clear();
    for (uint32_t i = 1; i <= 300; i++) CHECK(q.push(rec(9, i)));  // a 300-reading backlog (gateway out of reach)
    QRec s = rec(9, 301, true);
    SjPriorityOutbox<QRec, 2> out = {};
    SjPriorityOutbox<QRec, 4> urg = {};  // no urgent readings here (report_tests.h has them)
    SjSentAhead<16> ahead = {};
    CHECK(q.push(s));  // the node pushes it to flash AND to the outbox
    out.add(s);

    // link still down: nothing lost, nothing popped
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_NO_ACK);
    CHECK(q.count() == 301 && out.count == 1 && delivered == 0 && sent.empty());

    // link back: the SOS goes FIRST, then the oldest of the backlog
    linkUp = true;
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_DONE);
    CHECK(sent.size() == 11 && sent[0] == 301 && sent[1] == 1 && sent[10] == 10);
    CHECK(out.empty() && delivered == 1 && q.count() == 291);

    // a hold during a long backlog flush stops it after the send in progress
    holdAfter = 3;
    size_t before = sent.size();
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_SOS_WAITING);
    CHECK(sent.size() == before + 3 && q.count() == 288);
    held = false;
    QRec s2 = rec(9, 302, true);  // loop() measures and queues the new SOS
    CHECK(q.push(s2));
    out.add(s2);
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_DONE);
    CHECK(sent[before + 3] == 302 && delivered == 2);  // straight after the interrupted send

    // the ACK for an SOS is lost: it stays first, the backlog is not touched
    QRec s3 = rec(9, 303, true);
    CHECK(q.push(s3));
    out.add(s3);
    uint32_t queued = q.count();
    linkUp = false;
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_NO_ACK);
    CHECK(out.count == 1 && q.count() == queued);
    linkUp = true;
    before = sent.size();
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_DONE && sent[before] == 303);

    // their queued copies are popped unsent when their turn comes (they
    // went ahead - SjSentAhead): each SOS on air once, the backlog complete
    CHECK(ahead.count() == 3);
    while (q.count() > 0) sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered);
    CHECK(std::count(sent.begin(), sent.end(), 301u) == 1 && std::count(sent.begin(), sent.end(), 302u) == 1);
    CHECK(std::count(sent.begin(), sent.end(), 303u) == 1 && std::count(sent.begin(), sent.end(), 150u) == 1);
    CHECK(sent.back() == 300 && delivered == 3 && ahead.count() == 0);
    for (uint32_t i = 1; i <= 300; i++) CHECK(std::count(sent.begin(), sent.end(), i) == 1);
    // ...and if that memory is lost (reboot, deep sleep), the copy just goes
    // again: the same reading_uid, a duplicate every hop ignores
    QRec again = rec(9, 310, true);
    CHECK(q.push(again));
    out.add(again);
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_DONE);
    CHECK(std::count(sent.begin(), sent.end(), 310u) == 1 && q.count() == 0);  // copy popped in the same flush
    CHECK(q.push(again));  // a copy whose "went ahead" note is gone
    ahead.clear();
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_DONE);
    CHECK(std::count(sent.begin(), sent.end(), 310u) == 2 && q.count() == 0);

    // flash failing (no queue) and the outbox alone still delivers the SOS
    QRec ramOnly = rec(9, 304, true);
    out.add(ramOnly);
    CHECK(sjFlushOnce(q, out, urg, ahead, 10, send, sosHeld, onDelivered) == SJ_FLUSH_DONE && sent.back() == 304);

    // ...and also after a deep sleep: its RTC copy is all there is (review:
    // the wake used to look for it in the flash queue, which never had it)
    SjSleepState rtc;
    sjSleepStateReset(rtc, 9);
    QRec ramOnly2 = rec(9, 305, true);
    sjSleepKeepSos(rtc, &ramOnly2.reading, ramOnly2.takenAtS);
    SjSleepState woke = rtc;  // RTC memory over the sleep
    QRec back;
    CHECK(sjSleepPendingSos(woke, back.reading, back.takenAtS));
    CHECK(back.reading.seq == 305 && back.takenAtS == 305 && std::memcmp(&back.reading, &ramOnly2.reading, 56) == 0);

    // before a deep sleep / reset: an unacknowledged SOS among newer readings
    for (uint32_t i = 400; i < 450; i++) CHECK(q.push(rec(9, i, i == 440)));
  }
  // the outbox is RAM: after the wake / reset its entry is found again in
  // the flash queue (a fresh queue object on the same files)
  SjFileQueue<QRec> q;
  CHECK(q.begin("/sos.bin", "/sos.hdr", 500) && q.count() == 50);
  QRec found;
  CHECK(sjFindQueuedSos(q, 32, 9, 440, found) && found.reading.seq == 440 && (found.reading.flags & SJ_SOS_PRESSED));
  CHECK(sjFindQueuedSos(q, 32, 0, 0, found) && found.reading.seq == 440);  // after a reset: any SOS
  CHECK(!sjFindQueuedSos(q, 32, 9, 441, found));  // not an SOS reading
  CHECK(!sjFindQueuedSos(q, 32, 8, 440, found));  // another session
  CHECK(!sjFindQueuedSos(q, 9, 9, 440, found));   // older than the scan window...
  CHECK(sjFindQueuedSos(q, 10, 9, 440, found));

  // ...which is why a deep-sleep node keeps the unacknowledged SOS itself
  // in RTC memory: one wake = one more queued reading, and with the
  // gateway away for 40 wakes the scan would have lost it (review)
  SjSleepState rtc;
  sjSleepStateReset(rtc, 9);
  sjSleepKeepSos(rtc, &found.reading, found.takenAtS);
  for (uint32_t i = 450; i < 490; i++) {  // 40 wakes without the gateway
    CHECK(q.push(rec(9, i)));
    rtc.seq = i;              // what each wake changes before sleeping
    sjSleepStateSeal(rtc);
  }
  CHECK(!sjFindQueuedSos(q, 32, 9, 440, found));
  QRec pending;
  CHECK(sjSleepPendingSos(rtc, pending.reading, pending.takenAtS) && pending.reading.seq == 440);
  SjPriorityOutbox<QRec, 2> wakeOut = {};  // the next wake puts it first again
  SjPriorityOutbox<QRec, 4> wakeUrgent = {};
  SjSentAhead<16> wakeAhead = {};
  wakeOut.add(pending);
  std::vector<uint32_t> order;
  auto record = [&](QRec& r) {
    order.push_back(r.reading.seq);
    return true;
  };
  CHECK(sjFlushOnce(q, wakeOut, wakeUrgent, wakeAhead, 5, record, [] { return false; }, [](const QRec&) {}) ==
        SJ_FLUSH_DONE);
  CHECK(order.size() == 6 && order[0] == 440 && order[1] == 400);
  // delivered: nothing pending any more, and garbage / a corrupted copy is never an SOS
  sjSleepKeepSos(rtc, nullptr, 0);
  CHECK(sjSleepStateValid(rtc) && !sjSleepPendingSos(rtc, pending.reading, pending.takenAtS));
  sjSleepKeepSos(rtc, &pending.reading, 1);
  rtc.sosReading.seq ^= 1;  // a bit flip in RTC memory: the checksum catches it
  CHECK(!sjSleepPendingSos(rtc, pending.reading, pending.takenAtS));
  std::memset(&rtc, 0xA5, sizeof(rtc));  // after a power-on
  CHECK(!sjSleepPendingSos(rtc, pending.reading, pending.takenAtS));
  QRec plain = rec(9, 1);  // not an SOS reading
  sjSleepStateReset(rtc, 9);
  sjSleepKeepSos(rtc, &plain.reading, 1);
  CHECK(!sjSleepPendingSos(rtc, pending.reading, pending.takenAtS));
  SjFileQueue<QRec> empty;
  CHECK(empty.begin("/sos_empty.bin", "/sos_empty.hdr", 10));
  empty.clear();
  CHECK(!sjFindQueuedSos(empty, 32, 0, 0, found));
}

// ---- the gateway's NVS copy of its outbox (sjRestoreOutbox) --------------------
// Same shape as the gateway's GatewayQueued.
struct GwRec {
  SjReading reading;
  uint32_t rxAtS;
  uint16_t gwSession;
  int16_t rssi;
};

inline GwRec gwRec(const char* node, uint32_t seq, bool sosFlag = true) {
  GwRec g = {makeReading(node, 9, seq), seq, 3, -80};
  g.reading.flags = SJ_HAS_WATER | (sosFlag ? SJ_SOS_PRESSED : 0);
  return g;
}

inline void restoreTests() {
  // ACKed SOS readings, then a reboot: the NVS blob brings them back in order
  SjPriorityOutbox<GwRec, 4> live = {};
  live.add(gwRec("NODE-07", 11));
  live.add(gwRec("NODE-03", 12));
  uint8_t blob[sizeof(live)];
  std::memcpy(blob, &live, sizeof(live));  // prefs.putBytes / getBytes
  SjPriorityOutbox<GwRec, 4> saved, booted = {};
  std::memcpy(&saved, blob, sizeof(saved));
  CHECK(sjRestoreOutbox(booted, saved) == 2 && booted.count == 2);
  CHECK(booted.front().reading.seq == 11 && std::strncmp(booted.items[1].reading.node_id, "NODE-03", 7) == 0);
  CHECK(sjRestoreOutbox(booted, saved) == 2 && booted.count == 2);  // twice = still once each

  // the gateway's flash queue behind it is untouched: 4000 readings would
  // otherwise all go before the SOS (review)
  SjFileQueue<GwRec> gq;
  CHECK(gq.begin("/gw_sos.bin", "/gw_sos.hdr", 4000));
  gq.clear();
  for (uint32_t i = 1; i <= 3990; i++) CHECK(gq.push(gwRec("NODE-01", i, false)));
  CHECK(gq.push(gwRec("NODE-07", 11)));
  std::vector<uint32_t> order;
  auto send = [&](GwRec& g) {
    order.push_back(g.reading.seq);
    return true;
  };
  SjPriorityOutbox<GwRec, 4> noUrgent = {};
  SjSentAhead<16> gwAhead = {};
  CHECK(sjFlushOnce(gq, booted, noUrgent, gwAhead, 3, send, [] { return false; }, [](const GwRec&) {}) ==
        SJ_FLUSH_DONE);
  CHECK(order.size() == 5 && order[0] == 11 && order[1] == 12 && order[2] == 1 && gq.count() == 3988);

  // what is not a current SOS reading is left out; a bad count restores nothing
  SjPriorityOutbox<GwRec, 4> bad = {};
  bad.add(gwRec("NODE-07", 21));
  bad.add(gwRec("NODE-07", 22, false));  // not an SOS
  bad.add(gwRec("NODE-07", 23));
  bad.add(gwRec("NODE-07", 24));
  bad.items[2].reading.magic = 0;               // garbage
  bad.items[3].reading.version = SJ_VERSION_V1;  // another layout
  SjPriorityOutbox<GwRec, 4> out = {};
  CHECK(sjRestoreOutbox(out, bad) == 1 && out.count == 1 && out.front().reading.seq == 21);
  bad.count = 5;
  out.clear();
  CHECK(sjRestoreOutbox(out, bad) == 0 && out.empty());
  std::memset(&bad, 0xFF, sizeof(bad));  // erased NVS / random bytes
  CHECK(sjRestoreOutbox(out, bad) == 0 && out.empty());
}

inline void runSosTests() {
  buttonTests();
  packetTests();
  outboxTests();
  flushTests();
  restoreTests();
}

}  // namespace sos
