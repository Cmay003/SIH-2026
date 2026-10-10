// Tests for the optional gas / PM duty cycle (node sj_duty.h + the warm-up
// gate in sj_warmup.h): the state machine's timing, millis() wrap, never a
// cold value (also with lost PMS5003 serial commands and slow / dead
// sensors), the reports that carry the values, the hold while elevated,
// the PMS5003 sleep / wake command bytes, and the on-time behind the energy
// figures in config.h. Included by test_firmware_logic.cpp (uses its CHECK
// and makeReading).
#pragma once
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>
#include "../../firmware/sanjeevni_lora_node/sj_duty.h"

namespace duty {

// ---- the PMS5003 serial command (datasheet PTQ3004-2015 V1.0, Appendix B) ----
inline void commandTests() {
  uint8_t c[7];
  sjPmsCommand(c, SJ_PMS_CMD_SLEEP_SET, 0);
  const uint8_t sleep[7] = {0x42, 0x4D, 0xE4, 0x00, 0x00, 0x01, 0x73};  // 0x42+0x4D+0xE4 = 0x173
  CHECK(std::memcmp(c, sleep, 7) == 0);
  sjPmsCommand(c, SJ_PMS_CMD_SLEEP_SET, 1);
  const uint8_t wake[7] = {0x42, 0x4D, 0xE4, 0x00, 0x01, 0x01, 0x74};
  CHECK(std::memcmp(c, wake, 7) == 0);
}

// ---- the state machine, step by step ----------------------------------------
inline void unitTests() {
  const SjDutyCfg cfg = {30000, 45000, 45000 + 600000, 1};
  SjDuty d;
  sjDutyBegin(d, 1000);
  CHECK(d.powered && !d.carried && sjDutyPoweredMs(d, 4000) == 3000);
  // warm only after warmMs of power, and only for a value measured after that point
  CHECK(!sjDutyWarm(d, cfg, 1000 + 29999, 0));
  CHECK(sjDutyWarm(d, cfg, 1000 + 30000, 0));
  CHECK(sjDutyWarm(d, cfg, 1000 + 35000, 5000));   // measured exactly at the warm point
  CHECK(!sjDutyWarm(d, cfg, 1000 + 35000, 5001));  // measured 1 ms before it: cold
  CHECK(!sjDutyWarm(d, cfg, 1000 + 35000, 0xFFFFFFF0u));  // a "frame from before the wake"
  // powered, nothing carried yet: stays on (also when the report is long overdue)
  CHECK(sjDutyStep(d, cfg, 1000 + 40000, 0, 300000, false) == SJ_DUTY_STAY && d.powered);
  sjDutyOnReport(d, false);  // a report without a warm value changes nothing
  CHECK(sjDutyStep(d, cfg, 1000 + 41000, 1000 + 40000, 300000, false) == SJ_DUTY_STAY && d.powered);
  sjDutyOnReport(d, true);  // carried: sleeps at the next step
  CHECK(d.carried);
  CHECK(sjDutyStep(d, cfg, 1000 + 42000, 1000 + 41000, 300000, false) == SJ_DUTY_SLEEP && !d.powered);
  CHECK(sjDutyPoweredMs(d, 50000) == 0 && !sjDutyWarm(d, cfg, 99999, 0));
  // asleep: wakes exactly leadMs before the next report is due
  uint32_t last = 1000 + 41000;
  CHECK(sjDutyMsToTarget(d, cfg, last, last, 300000) == 300000);
  CHECK(sjDutyStep(d, cfg, last + 300000 - 45001, last, 300000, false) == SJ_DUTY_STAY && !d.powered);
  CHECK(sjDutyStep(d, cfg, last + 300000 - 45000, last, 300000, false) == SJ_DUTY_WAKE && d.powered);
  CHECK(d.onSinceMs == last + 300000 - 45000 && d.wokeMs == d.onSinceMs);
  // hold: an asleep sensor wakes at once and a carried one does not sleep
  SjDuty h;
  sjDutyBegin(h, 0);
  sjDutyOnReport(h, true);
  CHECK(sjDutyStep(h, cfg, 10, 0, 300000, true) == SJ_DUTY_STAY && h.powered);
  CHECK(sjDutyStep(h, cfg, 20, 0, 300000, false) == SJ_DUTY_SLEEP);
  CHECK(sjDutyStep(h, cfg, 30, 0, 300000, true) == SJ_DUTY_WAKE && h.onSinceMs == 30);
  // give up: a sensor that never gives a warm value sleeps after giveUpMs
  // (counted from the wake, NOT from a restarted warm-up)
  SjDuty g;
  sjDutyBegin(g, 0);
  sjDutyRestartWarmUp(g, 600000);
  CHECK(g.onSinceMs == 600000 && g.wokeMs == 0);
  CHECK(sjDutyStep(g, cfg, cfg.giveUpMs - 1, 0, 300000, false) == SJ_DUTY_STAY);
  CHECK(sjDutyStep(g, cfg, cfg.giveUpMs, 0, 300000, false) == SJ_DUTY_SLEEP && g.reportsSince == 0);
  sjDutyRestartWarmUp(g, 5);  // asleep: no effect
  CHECK(!g.powered && g.onSinceMs == 600000);
  // everyN: with N = 3 it wakes before the 3rd report after a sleep
  const SjDutyCfg n3 = {30000, 45000, 600000, 3};
  SjDuty e;
  sjDutyBegin(e, 0);
  sjDutyOnReport(e, true);
  CHECK(sjDutyStep(e, n3, 1, 0, 60000, false) == SJ_DUTY_SLEEP);
  CHECK(sjDutyMsToTarget(e, n3, 1, 0, 60000) == 2 * 60000 + 59999);
  sjDutyOnReport(e, false);  // report 1 while asleep
  CHECK(e.reportsSince == 1 && sjDutyMsToTarget(e, n3, 60000, 60000, 60000) == 120000);
  sjDutyOnReport(e, false);  // report 2
  CHECK(sjDutyMsToTarget(e, n3, 120000, 120000, 60000) == 60000);
  CHECK(sjDutyStep(e, n3, 120000 + 14999, 120000, 60000, false) == SJ_DUTY_STAY);
  CHECK(sjDutyStep(e, n3, 120000 + 15000, 120000, 60000, false) == SJ_DUTY_WAKE);
  for (int i = 0; i < 400; i++) sjDutyOnReport(e, false);  // powered: the count is not touched
  CHECK(e.reportsSince == 2);
  SjDuty sat;
  sjDutyBegin(sat, 0);
  sat.powered = false;
  for (int i = 0; i < 400; i++) sjDutyOnReport(sat, false);
  CHECK(sat.reportsSince == 255);  // saturates, never wraps to 0
  // millis() wrap: powered across it
  SjDuty w;
  sjDutyBegin(w, 0xFFFFF000u);
  CHECK(sjDutyPoweredMs(w, 0x00001000u) == 0x2000u);
  const SjDutyCfg wc = {0x1FFF, 0x3000, 0x100000, 1};
  CHECK(sjDutyWarm(w, wc, 0x00001000u, 0) && !sjDutyWarm(w, wc, 0x00000FFEu, 0));
  // report due across the wrap
  SjDuty wa;
  sjDutyBegin(wa, 0);
  sjDutyOnReport(wa, true);
  sjDutyStep(wa, cfg, 0xFFFF0000u, 0xFFFF0000u, 300000, false);
  CHECK(!wa.powered);
  uint32_t due = 0xFFFF0000u + 300000u;  // wraps past 0
  CHECK(sjDutyStep(wa, cfg, due - 45001u, 0xFFFF0000u, 300000, false) == SJ_DUTY_STAY);
  CHECK(sjDutyStep(wa, cfg, due - 45000u, 0xFFFF0000u, 300000, false) == SJ_DUTY_WAKE);

  // the warm gate used by takeReading(): not warm = left out, no alert, whatever the value
  SjReading r = makeReading("NODE-04", 1, 1);
  CHECK(!sjAddGasValueIfWarm(r, 5000, false, LOCAL_GAS_LIMIT_PPM) && !(r.flags & SJ_HAS_GAS));
  CHECK(sjAddGasValueIfWarm(r, 5000, true, LOCAL_GAS_LIMIT_PPM) && (r.flags & SJ_HAS_GAS) && r.gas_ppm == 5000);
  SjReading p = makeReading("NODE-04", 1, 2);
  CHECK(!sjAddPmValuesIfWarm(p, 900, 999, false, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT) && !(p.flags & SJ_HAS_PM));
  CHECK(sjAddPmValuesIfWarm(p, 900, 999, true, LOCAL_PM25_LIMIT, LOCAL_PM10_LIMIT) && p.pm25 == 900);
}

// ---- the PMS5003 command repeat + dropout rules (sj_duty.h), step by step ----
inline void pmsRuleTests() {
  const SjDutyCfg cfg = sjDutyConfig(PMS5003_WARMUP_S, DUTY_MARGIN_S, 300000, 1);
  SjDuty d;
  sjDutyBegin(d, 100000);  // switched on (wake command sent) at 100 s
  // never more often than SJ_PMS_RESEND_MS after the last command
  CHECK(!sjPmsResendDue(d, 104999, 100000, false, 0));
  CHECK(sjPmsResendDue(d, 105000, 100000, false, 0));       // no frame ever: repeat the wake
  CHECK(sjPmsResendDue(d, 105000, 100000, true, 90000));    // only a frame from before the wake
  CHECK(!sjPmsResendDue(d, 105000, 100000, true, 103000));  // streams: obeyed
  CHECK(!sjPmsResendDue(d, 107300, 100000, true, 105000));  // the 2.3-s stable stream is never "lost"
  CHECK(sjPmsResendDue(d, 110001, 100000, true, 105000));   // stopped for > 5 s
  // dropout: from the WAKE, not from the warm-up a repeated command restarts
  CHECK(!sjDutyMissIsDropout(d, cfg, 100000 + PMS5003_WARMUP_S * 1000UL - 1));
  sjDutyRestartWarmUp(d, 125000);  // e.g. the 5th repeated wake of a dead module
  CHECK(sjDutyMissIsDropout(d, cfg, 100000 + PMS5003_WARMUP_S * 1000UL));
  CHECK(!sjDutyWarm(d, cfg, 100000 + PMS5003_WARMUP_S * 1000UL, 0));  // the OLD rule (pmWarm(0)): no dropout
  // asleep: repeat the sleep only while frames still arrive; never a dropout
  sjDutyOnReport(d, true);
  CHECK(sjDutyStep(d, cfg, 200000, 199000, 300000, false) == SJ_DUTY_SLEEP);
  CHECK(!sjDutyMissIsDropout(d, cfg, 260000));
  CHECK(!sjPmsResendDue(d, 204999, 200000, true, 204000));
  CHECK(sjPmsResendDue(d, 205000, 200000, true, 204000));   // still streaming 5 s after "sleep"
  CHECK(!sjPmsResendDue(d, 205000, 200000, true, 201999));  // quiet for 3 s: asleep
  CHECK(!sjPmsResendDue(d, 205000, 200000, false, 0));
  // millis() wrap between the wake and now
  SjDuty w;
  sjDutyBegin(w, 0xFFFFF000u);
  CHECK(sjPmsResendDue(w, 0x00001400u, 0xFFFFF000u, true, 0xFFFFE000u));  // only a frame from before the wake
  CHECK(!sjPmsResendDue(w, 0x00001400u, 0xFFFFF000u, true, 0x00000400u));
  CHECK(sjDutyMissIsDropout(w, cfg, 0xFFFFF000u + PMS5003_WARMUP_S * 1000UL));
  // the boot warm-up judged at the moment a frame was MEASURED (sj_warmup.h)
  CHECK(sjWarmWhenMeasured(30, 0, 30) && !sjWarmWhenMeasured(30, 1, 30));  // 1 ms old at "30 s": maybe 29.99 s
  CHECK(sjWarmWhenMeasured(31, 1000, 30) && !sjWarmWhenMeasured(31, 1001, 30));
  CHECK(!sjWarmWhenMeasured(5, 0xFFFFFFFFu, 30) && !sjWarmWhenMeasured(29, 0, 30));
}

// ---- a simulated node loop -------------------------------------------------------
// Mirrors loop() + serviceDutyCycle() + takeReading() of the sketch: 10 ms
// loop steps, a sample every SAMPLE_INTERVAL_MS, a report when the interval
// is due or the node is elevated (sjPlanReport), now and then a slow
// flush. The firmware's decisions are the sketch's own functions
// (sjDutyStep, sjDutyWarm, sjPmsResendDue, sjDutyMissIsDropout,
// sjAddPmValuesIfWarm); `elevated` is the sketch's rule restricted to what
// this node sees (the PM local alert, or an injected event). The PHYSICAL
// sensors are modelled separately from what the firmware believes: a lost
// serial command leaves the PMS5003 as it was, it streams a frame every
// 2.3 s (the datasheet's interval for a stable value - its slowest; the
// first frame 1 s after it starts is an assumption) only while it really
// runs, and every value that reaches a reading is checked against the
// physical truth.
struct Sim {
  uint32_t intervalMs = 300000;
  bool dutyGas = true, dutyPm = true;
  uint8_t gasEveryN = 2, pmEveryN = 1;
  int cmdLossPct = 0;             // % of PMS5003 serial commands lost
  bool deadPms = false;           // never sends a frame
  uint16_t pm25 = 12, pm10 = 20;  // the air (ug/m3), all day
  float pmLimit25 = LOCAL_PM25_LIMIT, pmLimit10 = LOCAL_PM10_LIMIT;  // the "send now" limits
  uint32_t frameEveryMs = 2300;
  uint32_t startMs = 0;  // millis() at boot
  uint64_t durMs = 86400000ULL;
  std::vector<std::pair<uint64_t, uint64_t>> events;  // elevated windows, ms since boot
  uint64_t eventWhenAsleepAfterMs = 0;  // > 0: one more event, starting the first moment after this when both sleep
  uint64_t eventWhenAsleepLenMs = 600000;
  // results
  uint64_t gasOnMs = 0, pmOnMs = 0;
  int reports = 0, quietReports = 0, quietGas = 0, quietPm = 0;
  double airMs = 0;  // every report + its ACK (report_tests.h airtimeMs; a summary = all six watched fields)
  int gasValues = 0, pmValues = 0, coldGas = 0, coldPm = 0;
  int coldPmOldRule = 0;  // cold frames the boot rule before 2026-10-09 (uptime only, no frame age) let through
  int maxQuietGapGas = 0, maxQuietGapPm = 0;  // most quiet reports in a row without the value (after the first 10 min)
  int eventSamples = 0, eventGas = 0, eventPm = 0;
  int pmDropouts = 0, pmDropoutsOldRule = 0;  // samples flagged failed: pmMissIsDropout() / the old pmWarm(0)
  uint64_t lastPmWakeMs = 0;  // ms since boot of the last firmware wake
  bool pmAwakeAtEnd = false, gasOnAtEnd = false;
  bool sawEvent = false, gasAsleepAtEvent = false, pmAsleepAtEvent = false;  // state when the first event began
  int pmCommands = 0;

  void run() {
    // the sketch's GAS_DUTY / PM_DUTY
    const SjDutyCfg G = sjDutyConfig(MQ135_WARMUP_S, DUTY_MARGIN_S, intervalMs, gasEveryN);
    const SjDutyCfg P = sjDutyConfig(PMS5003_WARMUP_S, DUTY_MARGIN_S, intervalMs, pmEveryN);
    SjDuty gas, pm;
    uint32_t now = startMs;
    sjDutyBegin(gas, now);
    sjDutyBegin(pm, now);
    // physical truth; both run from the power-on
    bool gasPhys = true, pmPhys = true;
    uint64_t gasPhysSince = 0, pmPhysSince = 0, nextFrameT = 1000;
    bool everFrame = false, frameWarmTruth = false;
    uint32_t lastFrameMs = 0, pmsCmdMs = now;
    uint32_t lastSampleMs = now - SAMPLE_INTERVAL_MS, lastReportMs = 0;
    bool elevated = false;
    int gapGas = 0, gapPm = 0, samples = 0, windowSamples = 0;
    uint32_t rng = 12345;
    auto rand100 = [&rng]() {
      rng = rng * 1103515245u + 12345u;
      return (int)((rng >> 16) % 100);
    };
    auto sendPms = [&](bool awake, uint64_t t) {
      pmCommands++;
      pmsCmdMs = now;
      if (rand100() < cmdLossPct) return;  // lost: the module stays as it was
      if (awake && !pmPhys) {
        pmPhysSince = t;
        nextFrameT = t + 1000;
      }
      pmPhys = awake;
    };
    uint64_t t = 0;
    while (t < durMs) {
      if (eventWhenAsleepAfterMs && t >= eventWhenAsleepAfterMs && !gas.powered && !pm.powered) {
        events.push_back({t, t + eventWhenAsleepLenMs});
        eventWhenAsleepAfterMs = 0;
      }
      if (!sawEvent)
        for (auto& ev : events)
          if (t >= ev.first && t < ev.second) {
            sawEvent = true;
            gasAsleepAtEvent = dutyGas && !gas.powered;
            pmAsleepAtEvent = dutyPm && !pm.powered;
          }
      // ---- serviceDutyCycle()
      if (dutyGas) {
        SjDutyAction a = sjDutyStep(gas, G, now, lastReportMs, intervalMs, elevated);
        if (a == SJ_DUTY_WAKE) gasPhys = true, gasPhysSince = t;  // MOSFET: never lost
        if (a == SJ_DUTY_SLEEP) gasPhys = false;
      }
      if (dutyPm) {
        SjDutyAction a = sjDutyStep(pm, P, now, lastReportMs, intervalMs, elevated);
        if (a == SJ_DUTY_WAKE) lastPmWakeMs = t;
        if (a != SJ_DUTY_STAY) {
          sendPms(a == SJ_DUTY_WAKE, t);
        } else if (sjPmsResendDue(pm, now, pmsCmdMs, everFrame, lastFrameMs)) {  // the sketch's rule
          sendPms(pm.powered, t);
          sjDutyRestartWarmUp(pm, now);
        }
      }
      // ---- the PMS5003 streams a frame every frameEveryMs while it really
      //      runs (pollPms5003() reads it on the next loop pass)
      if (pmPhys && !deadPms && t >= nextFrameT) {
        lastFrameMs = now;
        everFrame = true;
        frameWarmTruth = nextFrameT - pmPhysSince >= PMS5003_WARMUP_S * 1000ULL;  // when it was MEASURED
        while (nextFrameT <= t) nextFrameT += frameEveryMs;
      }
      // ---- a sample
      if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
        lastSampleMs = now;
        samples++;
        windowSamples++;
        uint32_t uptimeS = (uint32_t)(t / 1000);
        bool inEvent = false;
        for (auto& e : events) inEvent |= t >= e.first && t < e.second;
        // gas: read only while powered; counts only when warm
        bool gasIn = false;
        if (!dutyGas || gas.powered) {
          bool warm = !sjWarmingUp(uptimeS, MQ135_WARMUP_S) && (!dutyGas || sjDutyWarm(gas, G, now, 0));
          SjReading r = makeReading("NODE-04", 1, samples);
          gasIn = sjAddGasValueIfWarm(r, 420, warm, LOCAL_GAS_LIMIT_PPM) || (r.flags & SJ_HAS_GAS);
          if (gasIn && !(gasPhys && t - gasPhysSince >= MQ135_WARMUP_S * 1000ULL)) coldGas++;
        }
        bool pmIn = false, pmAlert = false;
        if (!dutyPm || pm.powered) {
          if (everFrame && now - lastFrameMs <= 10000) {  // readPm()
            uint32_t age = now - lastFrameMs;
            bool warm = sjWarmWhenMeasured(uptimeS, age, PMS5003_WARMUP_S) && (!dutyPm || sjDutyWarm(pm, P, now, age));
            bool warmOld = !sjWarmingUp(uptimeS, PMS5003_WARMUP_S) && (!dutyPm || sjDutyWarm(pm, P, now, age));
            coldPmOldRule += warmOld && !frameWarmTruth;
            SjReading r = makeReading("NODE-04", 1, samples);
            pmAlert = sjAddPmValuesIfWarm(r, pm25, pm10, warm, pmLimit25, pmLimit10);
            pmIn = (r.flags & SJ_HAS_PM) != 0;
            if (pmIn && !frameWarmTruth) coldPm++;
          } else {
            // no frame for 10 s: the sketch's pmMissIsDropout(), and the rule before 2026-10-09 (pmWarm(0))
            bool boot = !sjWarmingUp(uptimeS, PMS5003_WARMUP_S);
            pmDropouts += boot && (!dutyPm || sjDutyMissIsDropout(pm, P, now));
            pmDropoutsOldRule += boot && (!dutyPm || sjDutyWarm(pm, P, now, 0));
          }
        }
        gasValues += gasIn;
        pmValues += pmIn;
        elevated = inEvent || pmAlert;  // localAlert (here: PM only) || an injected WATCH / fast rise
        if (inEvent) {
          eventSamples++;
          eventGas += gasIn;
          eventPm += pmIn;
        }
        bool due = now - lastReportMs >= intervalMs || lastReportMs == 0;
        if (due || elevated) {
          lastReportMs = now;
          reports++;
          airMs += report::airtimeMs(sizeof(SjReading) + (windowSamples >= 2 ? SJ_SUMMARY_MAX_WIRE : 0)) +
                   report::airtimeMs(sizeof(SjAck));
          windowSamples = 0;
          if (dutyGas) sjDutyOnReport(gas, gasIn);
          if (dutyPm) sjDutyOnReport(pm, pmIn);
          // gaps: quiet reports in a row without the value (a report of
          // an event that carries it ends a gap too)
          if (t >= 600000) {
            if (gasIn) gapGas = 0;
            if (pmIn) gapPm = 0;
          }
          if (!elevated && t >= 600000) {
            quietReports++;
            quietGas += gasIn;
            quietPm += pmIn;
            if (!gasIn) gapGas++;
            if (!pmIn) gapPm++;
            if (gapGas > maxQuietGapGas) maxQuietGapGas = gapGas;
            if (gapPm > maxQuietGapPm) maxQuietGapPm = gapPm;
          }
        }
      }
      // ---- time passes: a 10 ms loop, now and then a slow LoRa flush
      uint32_t step = (samples % 7 == 3 && now - lastSampleMs < 10) ? 1200 : 10;
      if (gasPhys) gasOnMs += step;
      if (pmPhys) pmOnMs += step;
      now += step;
      t += step;
    }
    pmAwakeAtEnd = pmPhys;
    gasOnAtEnd = gasPhys;
  }
  double pmFrac() const { return (double)pmOnMs / durMs; }
  double gasFrac() const { return (double)gasOnMs / durMs; }
  // the config.h energy ESTIMATE (5 V rail, datasheet currents - heater 5 V / 33 ohm,
  // PMS5003 <= 100 mA active / 0.2 mA standby), mAh per day
  double mAhDay() const {
    const double heaterMa = 5.0 / 33.0 * 1000.0;
    return heaterMa * 24 * gasFrac() + 100.0 * 24 * pmFrac() + 0.2 * 24 * (1 - pmFrac());
  }
};

inline void simulationTests() {
  // 1. a CLEAN-AIR day (PM 12 / 20, gas 420) of 5-min reports (node without
  //    a siren), millis() wrapping after one hour; the shipped warm-up times
  Sim a;
  a.startMs = 0xFFFFFFFFu - 3600000u;
  a.run();
  double pmFrac = a.pmFrac(), gasFrac = a.gasFrac();
  std::printf("   duty cycle, a simulated clean-air day of 5-min reports: PMS5003 on %.1f %%, MQ135 heater on %.1f %%; "
              "%d quiet reports, PM in %d, gas in %d\n",
              100 * pmFrac, 100 * gasFrac, a.quietReports, a.quietPm, a.quietGas);
  CHECK(a.coldGas == 0 && a.coldPm == 0);
  CHECK(a.gasValues > 0 && a.pmValues > 0);
  CHECK(a.pmDropouts == 0);  // a healthy sensor is never a dropout
  // PM in EVERY quiet report, gas in every 2nd (never 2 in a row without)
  CHECK(a.quietReports >= 270 && a.quietPm == a.quietReports && a.maxQuietGapPm == 0);
  CHECK(a.maxQuietGapGas == 1 && a.quietGas * 2 >= a.quietReports - 1 && a.quietGas * 2 <= a.quietReports + 1);
  // on-time: (warm-up + margin) per period, plus the wait for the report sample
  CHECK(pmFrac > 0.149 && pmFrac < 0.165);
  CHECK(gasFrac > 0.324 && gasFrac < 0.335);
  // the energy table in config.h, from these on-times (ESTIMATE)
  double heaterMa = 5.0 / 33.0 * 1000.0;
  double gasDay = heaterMa * 24 * gasFrac, pmDay = 100.0 * 24 * pmFrac + 0.2 * 24 * (1 - pmFrac);
  double before = heaterMa * 24 + 100.0 * 24;
  std::printf("   energy ESTIMATE (5 V rail) from these on-times: MQ135 %.0f -> %.0f mAh/day, PMS5003 %.0f -> %.0f, "
              "together %.0f -> %.0f mAh/day (%.1f %% less)\n",
              heaterMa * 24, gasDay, 100.0 * 24, pmDay, before, gasDay + pmDay, 100.0 * (1 - (gasDay + pmDay) / before));
  CHECK(gasDay > 1170 && gasDay < 1200 && pmDay > 360 && pmDay < 400);
  CHECK(std::fabs(a.mAhDay() - (gasDay + pmDay)) < 0.5);

  // 2. the same day without the duty cycle (before): always on, values in every report
  Sim b;
  b.dutyGas = b.dutyPm = false;
  b.startMs = a.startMs;
  b.run();
  std::printf("   without the duty cycle: PMS5003 on %.1f %%, MQ135 on %.1f %%; PM in %d of %d quiet reports, gas in %d; "
              "%d reports, airtime %.0f s/day\n",
              100.0 * b.pmOnMs / b.durMs, 100.0 * b.gasOnMs / b.durMs, b.quietPm, b.quietReports, b.quietGas, b.reports,
              b.airMs / 1000);
  CHECK(b.pmOnMs == b.durMs && b.gasOnMs == b.durMs && b.coldGas == 0 && b.coldPm == 0);
  // the boot warm-up now judges a PMS5003 frame by when it was MEASURED (sjWarmWhenMeasured): with
  // frames every 2.3 s the old uptime-only rule let the frames measured just before 30 s through
  std::printf("   boot warm-up, no duty cycle: cold PM frames let through - old rule (uptime only) %d, now %d\n",
              b.coldPmOldRule, b.coldPm);
  CHECK(b.quietPm == b.quietReports && b.quietGas == b.quietReports);
  CHECK(b.pmDropouts == 0);

  // 3. a siren node (1-min reports): the PMS5003 in every 5th report, same
  //    on-time; its MQ135 is NOT duty-cycled (config.h static_assert: gas is
  //    an offline-siren trigger) - gas in every report
  Sim s;
  s.intervalMs = 60000;
  s.pmEveryN = 5;
  s.dutyGas = false;
  s.run();
  std::printf("   siren node (1-min reports, PMS5003 only): PMS5003 on %.1f %%, MQ135 on %.1f %%\n",
              100.0 * s.pmOnMs / s.durMs, 100.0 * s.gasOnMs / s.durMs);
  CHECK(s.coldGas == 0 && s.coldPm == 0);
  CHECK(s.maxQuietGapPm == 4 && s.maxQuietGapGas == 0 && s.gasOnMs >= s.durMs);
  CHECK((double)s.pmOnMs / s.durMs < 0.17);

  // 4. lost serial commands (30 %): the PMS5003 sometimes keeps sleeping or
  //    running; the firmware repeats the command - still never a cold value,
  //    and still PM in (almost) every report
  Sim l;
  l.cmdLossPct = 30;
  l.run();
  std::printf("   30 %% of PMS5003 commands lost: PM in %d of %d quiet reports, %d commands, cold values %d, "
              "samples flagged failed %d\n",
              l.quietPm, l.quietReports, l.pmCommands, l.coldPm, l.pmDropouts);
  CHECK(l.coldPm == 0 && l.coldGas == 0);
  CHECK(l.quietPm * 100 >= l.quietReports * 95);
  CHECK(l.pmDropouts < SJ_AN_DROPOUT_MIN);  // lost commands are not reported as a dropout

  // 5. an event (elevated 10 min) starting while both sensors sleep: both
  //    wake at once, stay on, and every sample once warm carries gas + PM
  //    (none before: the warm-up still applies); afterwards back to sleeping
  Sim e;
  e.durMs = 4ULL * 3600000ULL;
  e.eventWhenAsleepAfterMs = 7200000ULL;
  e.run();
  const int evN = (int)(600000 / SAMPLE_INTERVAL_MS);
  const int gasWarmN = (int)(MQ135_WARMUP_S * 1000UL / SAMPLE_INTERVAL_MS);
  const int pmWarmN = (int)(PMS5003_WARMUP_S * 1000UL / SAMPLE_INTERVAL_MS);
  std::printf("   10-min event (both asleep when it began: %d/%d): %d samples, gas in %d, PM in %d\n",
              e.gasAsleepAtEvent, e.pmAsleepAtEvent, e.eventSamples, e.eventGas, e.eventPm);
  CHECK(e.sawEvent && e.gasAsleepAtEvent && e.pmAsleepAtEvent);
  CHECK(e.coldGas == 0 && e.coldPm == 0);
  CHECK(e.eventSamples >= evN - 2);
  CHECK(e.eventGas >= e.eventSamples - gasWarmN - 2 && e.eventGas <= e.eventSamples - gasWarmN + 1);
  CHECK(e.eventPm >= e.eventSamples - pmWarmN - 2 && e.eventPm <= e.eventSamples - pmWarmN + 1);
  CHECK(e.maxQuietGapPm == 0 && e.maxQuietGapGas <= 1);

  // 6. a dead PMS5003 (no frame ever): no value, never stuck on - it gives up
  //    and sleeps until its next report - and it IS reported failed (the
  //    backend's dropout anomaly). The rule before 2026-10-09 was pmWarm(0):
  //    the wake command repeated every 5 s restarted the warm-up, so a dead
  //    module was never counted failed. Both rules counted on the same run.
  Sim d;
  d.deadPms = true;
  d.dutyGas = false;
  d.run();
  SjDutyCfg dc = sjDutyConfig(PMS5003_WARMUP_S, DUTY_MARGIN_S, 300000, 1);
  std::printf("   dead PMS5003: on %.1f %% of the day (gives up %u s after each wake); samples flagged failed: "
              "old rule %d, now %d\n",
              100.0 * d.pmOnMs / d.durMs, (unsigned)(dc.giveUpMs / 1000), d.pmDropoutsOldRule, d.pmDropouts);
  CHECK(dc.giveUpMs == (PMS5003_WARMUP_S + DUTY_MARGIN_S) * 1000UL + 300000 + DUTY_MARGIN_S * 1000UL);
  CHECK(d.pmValues == 0 && d.coldPm == 0);
  CHECK(d.pmOnMs < d.durMs * 65 / 100);
  CHECK(d.pmDropoutsOldRule == 0);  // the reviewer's finding, reproduced on the old rule
  // now: every powered sample from PMS5003_WARMUP_S after a wake until it gives up - per wake far
  // more than the SJ_AN_DROPOUT_MIN failures the anomaly check needs
  const int perWake = (int)((dc.giveUpMs - PMS5003_WARMUP_S * 1000UL) / SAMPLE_INTERVAL_MS);
  CHECK(perWake > SJ_AN_DROPOUT_MIN && d.pmDropouts > 100 * perWake);
  // without the duty cycle the same dead sensor was and is flagged on every sample after the boot warm-up
  Sim dn;
  dn.deadPms = true;
  dn.dutyGas = dn.dutyPm = false;
  dn.durMs = 3600000ULL;
  dn.run();
  CHECK(dn.pmDropouts == dn.pmDropoutsOldRule && dn.pmDropouts > 650);

  // 7. a POLLUTED day (PM2.5 80 / PM10 180 all day: CPCB "Moderately
  //    polluted" = backend MEDIUM). Before 2026-10-09 the node's "send now"
  //    limits were 60 / 100 (top of "Satisfactory"): every 5-s sample went at
  //    once and the duty hold kept both sensors on. Now 120 / 350 (top of
  //    "Poor"): MEDIUM goes with the 5-min report. Same Sim, both limits.
  Sim pb, pa, nb, na;
  pb.pm25 = pa.pm25 = nb.pm25 = na.pm25 = 80;
  pb.pm10 = pa.pm10 = nb.pm10 = na.pm10 = 180;
  pb.pmLimit25 = nb.pmLimit25 = 60;
  pb.pmLimit10 = nb.pmLimit10 = 100;
  nb.dutyGas = nb.dutyPm = na.dutyGas = na.dutyPm = false;
  pb.startMs = pa.startMs = nb.startMs = na.startMs = a.startMs;  // the clean days' clock: same report times
  pb.run();
  pa.run();
  nb.run();
  na.run();
  std::printf("   polluted day (PM2.5 80 / PM10 180), send-now limits 60/100 -> 120/350:\n"
              "     no duty cycle: %d -> %d reports/day, airtime %.0f -> %.0f s/day (clean day: %d, %.0f s)\n"
              "     duty cycle:    PMS5003 on %.1f -> %.1f %%, MQ135 on %.1f -> %.1f %%, "
              "ESTIMATE %.0f -> %.0f mAh/day (clean day %.0f; continuous %.0f)\n",
              nb.reports, na.reports, nb.airMs / 1000, na.airMs / 1000, b.reports, b.airMs / 1000, 100 * pb.pmFrac(),
              100 * pa.pmFrac(), 100 * pb.gasFrac(), 100 * pa.gasFrac(), pb.mAhDay(), pa.mAhDay(), a.mAhDay(),
              b.mAhDay());
  CHECK(nb.reports > 17000 && pb.pmFrac() > 0.99 && pb.gasFrac() > 0.99);  // before: the savings were gone
  CHECK(na.reports == b.reports && std::fabs(na.airMs - b.airMs) < 1.0);    // after: as on a clean day
  CHECK(std::fabs(pa.pmFrac() - a.pmFrac()) < 0.002 && std::fabs(pa.gasFrac() - a.gasFrac()) < 0.002);
  CHECK(pa.coldPm == 0 && pa.coldGas == 0 && pa.quietPm == pa.quietReports);

  // 8. a "Very Poor" day (PM2.5 150 all day = backend HIGH, the node's WATCH
  //    level): still sent at once on every sample and both sensors held on,
  //    by design (decision 2026-10-09: WATCH/URGENT go at once). No saving on
  //    such a day - printed here so the figure is not hidden.
  Sim vp, vn;
  vp.pm25 = vn.pm25 = 150;
  vp.pm10 = vn.pm10 = 300;
  vn.dutyGas = vn.dutyPm = false;
  vp.run();
  vn.run();
  std::printf("   'Very Poor' day (PM2.5 150): %d reports/day, airtime %.0f s/day; duty cycle: PMS5003 on %.1f %%, "
              "MQ135 on %.1f %% (ESTIMATE %.0f mAh/day)\n",
              vn.reports, vn.airMs / 1000, 100 * vp.pmFrac(), 100 * vp.gasFrac(), vp.mAhDay());
  CHECK(vn.reports > 17000 && vp.pmFrac() > 0.99 && vp.coldPm == 0);
}

// The config.h defaults: off, no pins; whole report intervals per wake.
inline void configTests() {
  CHECK(PMS5003_DUTY_CYCLE == 0 && MQ135_DUTY_CYCLE == 0);  // default: unchanged behaviour
  CHECK(PMS5003_SET_PIN == -1 && MQ135_HEATER_PIN == -1);
  // the shipped node has a siren (1-min reports): every 5th / 10th report
  CHECK(SJ_DUTY_EVERY_N(PMS5003_DUTY_PERIOD_S) == PMS5003_DUTY_PERIOD_S * 1000UL / NORMAL_REPORT_INTERVAL_MS);
  CHECK(SJ_DUTY_EVERY_N(30) == 1);  // shorter than one report interval: every report
}

inline void runDutyTests() {
  commandTests();
  unitTests();
  pmsRuleTests();
  simulationTests();
  configTests();
}

}  // namespace duty
