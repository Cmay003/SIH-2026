// Tests for the edge models' inputs (node sj_edge_input.h) and the
// generated model headers: the reading -> input mapping of the MAIN and the
// LITE model (absent sensors, a doubtful rise rate, bench scale), the int8
// quantisation (roundf, clamp, zero point), the class pick, and - against
// vectors computed by ml/quantize_edge_model.py in numpy float32 - that the
// C++ builds exactly the int8 input tensor the Python pipeline evaluated
// (edge_vectors_main.h / edge_vectors_lite.h, regenerated with --install).
// Also: the offline siren never acts on an edge verdict (decision
// 2026-10-09). Included by test_firmware_logic.cpp (uses its CHECK and
// makeReading).
// What this can't check: TFLite Micro itself on the ESP32 - the node's
// setup runs the headers' golden vectors through it (edge_ai.h) and the
// self-test reports the result.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include "../../firmware/sanjeevni_lora_node/sj_edge_input.h"
#include "../../firmware/sanjeevni_lora_node/edge_model_data.h"
#include "../../firmware/sanjeevni_lora_node/edge_lite_model_data.h"

struct EdgeVector {
  uint8_t hasWater, hasRise, hasDht, hasGas, hasFlame, hasTilt;
  uint16_t waterMm;
  int16_t riseX100;
  int16_t tempX100;
  uint16_t humX100;
  uint16_t gas;
  uint8_t flame;
  int16_t tiltX100;
  uint16_t vibX1000;
  int8_t q[SJ_EDGE_LITE_INPUTS];  // the main model uses the first 5
  uint8_t cls;                    // the TFLite interpreter's class (reference only)
};
#include "edge_vectors_main.h"
#include "edge_vectors_lite.h"

namespace edge {

inline uint32_t fnv1a(const unsigned char* p, unsigned n) {
  uint32_t h = 2166136261u;
  for (unsigned i = 0; i < n; i++) {
    h ^= p[i];
    h *= 16777619u;
  }
  return h;
}

inline SjReading fromVector(const EdgeVector& v) {
  SjReading r = makeReading("NODE-07", 1, 1);
  if (v.hasWater) {
    r.flags |= SJ_HAS_WATER;
    r.water_level_mm = v.waterMm;
    if (v.hasRise) {
      r.xflags |= SJ_X_RISE_RATE;
      r.rise_cm_min_x100 = v.riseX100;
    }
  }
  if (v.hasDht) {
    r.flags |= SJ_HAS_DHT;
    r.temp_c_x100 = v.tempX100;
    r.humidity_x100 = v.humX100;
  }
  if (v.hasGas) {
    r.flags |= SJ_HAS_GAS;
    r.gas_ppm = v.gas;
  }
  if (v.hasFlame) {
    r.flags |= SJ_HAS_FLAME;
    if (v.flame) r.flags |= SJ_FLAME_DETECTED;
  }
  if (v.hasTilt) {
    r.flags |= SJ_HAS_TILT;
    r.tilt_deg_x100 = v.tiltX100;
    r.vibration_g_x1000 = v.vibX1000;
  }
  return r;
}

const SjEdgeScale RIVER = {false, 4.0f, 1.5f, 4.0f, 1.0f};  // as the vectors: river scale, 1 cm/min

// ---- C++ input tensor == the Python pipeline's, vector by vector ------------
inline void vectorTests() {
  // the vectors belong to the installed model bytes
  CHECK(edge_model_data_len == VEC_MAIN_MODEL_LEN && fnv1a(edge_model_data, edge_model_data_len) == VEC_MAIN_MODEL_FNV);
  CHECK(edge_lite_model_data_len == VEC_LITE_MODEL_LEN &&
        fnv1a(edge_lite_model_data, edge_lite_model_data_len) == VEC_LITE_MODEL_FNV);
  CHECK(VEC_MAIN_COUNT >= 200 && VEC_LITE_COUNT >= 200);
  int mainBad = 0, liteBad = 0, liteNone = 0;
  int classes[2][3] = {{0, 0, 0}, {0, 0, 0}};
  for (int i = 0; i < VEC_MAIN_COUNT; i++) {
    const EdgeVector& v = VEC_MAIN[i];
    SjReading r = fromVector(v);
    float raw[SJ_EDGE_MAIN_INPUTS];
    int8_t q[SJ_EDGE_MAIN_INPUTS];
    if (!sjEdgeMainInputs(r, RIVER, raw)) {
      mainBad++;
      continue;
    }
    sjEdgeQuantize(raw, EDGE_FEATURE_MEAN, EDGE_FEATURE_SCALE, SJ_EDGE_MAIN_INPUTS, VEC_MAIN_IN_SCALE, VEC_MAIN_IN_ZERO,
                   q);
    if (std::memcmp(q, v.q, SJ_EDGE_MAIN_INPUTS) != 0) mainBad++;
    if (v.cls < 3) classes[0][v.cls]++;
  }
  for (int i = 0; i < VEC_LITE_COUNT; i++) {
    const EdgeVector& v = VEC_LITE[i];
    SjReading r = fromVector(v);
    float raw[SJ_EDGE_LITE_INPUTS];
    int8_t q[SJ_EDGE_LITE_INPUTS];
    uint8_t groups = sjEdgeLiteInputs(r, RIVER, EDGE_LITE_ABSENT, raw);
    if (groups == 0) liteNone++;  // never: the generator always fits one group
    sjEdgeQuantize(raw, EDGE_LITE_FEATURE_MEAN, EDGE_LITE_FEATURE_SCALE, SJ_EDGE_LITE_INPUTS, VEC_LITE_IN_SCALE,
                   VEC_LITE_IN_ZERO, q);
    if (std::memcmp(q, v.q, SJ_EDGE_LITE_INPUTS) != 0) liteBad++;
    if (v.cls < 3) classes[1][v.cls]++;
  }
  CHECK(mainBad == 0);
  CHECK(liteBad == 0);
  CHECK(liteNone == 0);
  // the vectors exercise every class of both models
  for (int m = 0; m < 2; m++) CHECK(classes[m][0] > 0 && classes[m][1] > 0 && classes[m][2] > 0);
  if (mainBad || liteBad) std::printf("edge vectors: %d main / %d lite int8 inputs differ from Python\n", mainBad, liteBad);
}

// ---- the generated headers' own constants -----------------------------------
inline void headerTests() {
  CHECK(EDGE_MODEL_INPUTS == SJ_EDGE_MAIN_INPUTS && EDGE_LITE_MODEL_INPUTS == SJ_EDGE_LITE_INPUTS);
  for (int i = 0; i < SJ_EDGE_MAIN_INPUTS; i++) CHECK(EDGE_FEATURE_SCALE[i] > 0);
  for (int i = 0; i < SJ_EDGE_LITE_INPUTS; i++) CHECK(EDGE_LITE_FEATURE_SCALE[i] > 0);
  // the absent stand-ins are CALM readings (below every WATCH limit of
  // ml/make_edge_dataset.py): river < 2.75 m, no rise, < 45 C, < 600 ppm,
  // no flame, no tilt, little vibration
  CHECK(EDGE_LITE_ABSENT[0] < 2.75f && EDGE_LITE_ABSENT[1] == 0.0f && EDGE_LITE_ABSENT[2] < 45.0f &&
        EDGE_LITE_ABSENT[3] < 600.0f && EDGE_LITE_ABSENT[4] == 0.0f && EDGE_LITE_ABSENT[5] == 0.0f &&
        EDGE_LITE_ABSENT[6] < 0.5f);
  // golden vectors cover every class (the device self-check is meaningful)
  bool seen[2][3] = {{false, false, false}, {false, false, false}};
  for (int i = 0; i < EDGE_GOLDEN_COUNT; i++) seen[0][EDGE_GOLDEN_CLASS[i] % 3] = true;
  for (int i = 0; i < EDGE_LITE_GOLDEN_COUNT; i++) seen[1][EDGE_LITE_GOLDEN_CLASS[i] % 3] = true;
  CHECK(EDGE_GOLDEN_COUNT >= 6 && EDGE_LITE_GOLDEN_COUNT >= 6);
  for (int m = 0; m < 2; m++) CHECK(seen[m][0] && seen[m][1] && seen[m][2]);
  // IMD heat (plains): 46 C is a heat wave (WATCH), 49.5 C a severe one (URGENT)
  bool heatWatch = false, heatUrgent = false;
  for (int i = 0; i < EDGE_GOLDEN_COUNT; i++) {
    if (EDGE_GOLDEN_INPUT[i][1] == 46.0f) heatWatch = EDGE_GOLDEN_CLASS[i] == 1;
    if (EDGE_GOLDEN_INPUT[i][1] == 49.5f) heatUrgent = EDGE_GOLDEN_CLASS[i] == 2;
  }
  CHECK(heatWatch && heatUrgent);
}

// ---- reading -> inputs --------------------------------------------------------
inline void inputTests() {
  // bench scale: the tank's fill fraction onto 1.5..4.0 m; river scale: as is
  const SjEdgeScale bench = {true, 0.0234f, 1.5f, 4.0f, 0.10f * 2.34f};
  CHECK(std::fabs(sjEdgeModelLevelM(0.0f, bench) - 1.5f) < 1e-6f);
  CHECK(std::fabs(sjEdgeModelLevelM(0.0234f, bench) - 4.0f) < 1e-5f);
  CHECK(std::fabs(sjEdgeModelLevelM(0.0234f * 0.8f, bench) - 3.5f) < 1e-5f);  // 0.8 of the tank = 3.5 m
  CHECK(std::fabs(sjEdgeModelLevelM(1.0f, bench) - 4.0f) < 1e-6f);           // above the tank: clamped
  CHECK(std::fabs(sjEdgeModelLevelM(-1.0f, bench) - 1.5f) < 1e-6f);
  CHECK(sjEdgeModelLevelM(2.9f, RIVER) == 2.9f && sjEdgeModelLevelM(-0.1f, RIVER) == 0.0f);

  // MAIN: all four sensors or nothing
  SjReading r = makeReading("NODE-07", 1, 1);
  r.flags = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_FLAME;
  r.water_level_mm = 3210;
  r.temp_c_x100 = 4650;
  r.humidity_x100 = 2500;
  r.gas_ppm = 812;
  float m[SJ_EDGE_MAIN_INPUTS];
  CHECK(!sjEdgeMainInputs(r, RIVER, m));  // gas missing (warming up / asleep)
  r.flags |= SJ_HAS_GAS | SJ_FLAME_DETECTED;
  CHECK(sjEdgeMainInputs(r, RIVER, m));
  CHECK(m[0] == 3.21f && m[1] == 46.5f && m[2] == 25.0f && m[3] == 812.0f && m[4] == 1.0f);

  // LITE: nothing it can judge -> 0 groups
  SjReading none = makeReading("NODE-07", 1, 1);
  none.flags = SJ_HAS_SOIL | SJ_HAS_PH;
  float l[SJ_EDGE_LITE_INPUTS];
  CHECK(sjEdgeLiteInputs(none, RIVER, EDGE_LITE_ABSENT, l) == 0);
  for (int i = 0; i < SJ_EDGE_LITE_INPUTS; i++) CHECK(l[i] == EDGE_LITE_ABSENT[i]);
  // tilt-only node: the rest stand in as calm; a tilt either way counts
  SjReading tilt = makeReading("NODE-07", 1, 1);
  tilt.flags = SJ_HAS_TILT;
  tilt.tilt_deg_x100 = -1250;
  tilt.vibration_g_x1000 = 400;
  CHECK(sjEdgeLiteInputs(tilt, RIVER, EDGE_LITE_ABSENT, l) == 1);
  CHECK(l[5] == 12.5f && l[6] == 0.4f && l[0] == EDGE_LITE_ABSENT[0] && l[2] == EDGE_LITE_ABSENT[2] &&
        l[3] == EDGE_LITE_ABSENT[3] && l[4] == EDGE_LITE_ABSENT[4]);
  // deep-sleep kit: water + rise + DHT + flame, no gas
  SjReading ds = makeReading("NODE-07", 1, 1);
  ds.flags = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_FLAME;
  ds.water_level_mm = 2200;
  ds.temp_c_x100 = 3000;
  ds.xflags = SJ_X_RISE_RATE;
  ds.rise_cm_min_x100 = 250;  // 2.5 cm/min
  CHECK(sjEdgeLiteInputs(ds, RIVER, EDGE_LITE_ABSENT, l) == 3);
  CHECK(l[0] == 2.2f && l[1] == 2.5f && l[2] == 30.0f && l[3] == EDGE_LITE_ABSENT[3] && l[4] == 0.0f &&
        l[5] == EDGE_LITE_ABSENT[5]);
  // no rate yet (too few samples) -> rise absent, level still used
  ds.xflags = 0;
  sjEdgeLiteInputs(ds, RIVER, EDGE_LITE_ABSENT, l);
  CHECK(l[0] == 2.2f && l[1] == EDGE_LITE_ABSENT[1]);
  // a doubted water level: its rate is ignored (stuck / spike / rate / dropout), the level is not
  ds.xflags = SJ_X_RISE_RATE;
  for (uint8_t c : {SJ_AC_STUCK, SJ_AC_SPIKE, SJ_AC_RATE, SJ_AC_DROPOUT}) {
    SjReading d = ds;
    d.anomaly[c] = 1u << SJ_AF_WATER;
    sjEdgeLiteInputs(d, RIVER, EDGE_LITE_ABSENT, l);
    CHECK(l[1] == EDGE_LITE_ABSENT[1] && l[0] == 2.2f);
  }
  SjReading other = ds;  // another field's doubt does not matter
  other.anomaly[SJ_AC_SPIKE] = 1u << SJ_AF_TEMP;
  sjEdgeLiteInputs(other, RIVER, EDGE_LITE_ABSENT, l);
  CHECK(l[1] == 2.5f);
  // rise: in multiples of the node's fast-rise limit, clamped to the training range
  SjReading b = ds;
  b.rise_cm_min_x100 = 117;  // a bench tank rising 1.17 cm/min = 5 x (0.10 x 2.34 cm)
  sjEdgeLiteInputs(b, bench, EDGE_LITE_ABSENT, l);
  CHECK(std::fabs(l[1] - 5.0f) < 1e-4f);
  b.rise_cm_min_x100 = 32767;
  sjEdgeLiteInputs(b, RIVER, EDGE_LITE_ABSENT, l);
  CHECK(l[1] == SJ_EDGE_RISE_X_MAX);
  b.rise_cm_min_x100 = -32768;
  sjEdgeLiteInputs(b, RIVER, EDGE_LITE_ABSENT, l);
  CHECK(l[1] == SJ_EDGE_RISE_X_MIN);
}

// ---- int8 quantisation + class ------------------------------------------------
inline void quantizeTests() {
  const float zero[3] = {0, 0, 0}, one[3] = {1, 1, 1};
  int8_t q[3];
  const float halves[3] = {0.5f, -0.5f, 2.5f};  // roundf: half away from zero (numpy's round would give 0, -0, 2)
  sjEdgeQuantize(halves, zero, one, 3, 1.0f, 0, q);
  CHECK(q[0] == 1 && q[1] == -1 && q[2] == 3);
  const float big[3] = {500.0f, -500.0f, 1e30f};
  sjEdgeQuantize(big, zero, one, 3, 1.0f, 0, q);
  CHECK(q[0] == 127 && q[1] == -128 && q[2] == 127);
  const float nan3[3] = {NAN, -1e30f, 0.0f};
  sjEdgeQuantize(nan3, zero, one, 3, 1.0f, -57, q);
  CHECK(q[0] == -128 && q[1] == -128 && q[2] == -57);  // NaN never becomes "calm" or wraps
  const float mean[3] = {10, 20, 30}, scale[3] = {2, 4, 0.5f}, x[3] = {12, 12, 31};
  sjEdgeQuantize(x, mean, scale, 3, 0.25f, 5, q);
  CHECK(q[0] == 9 && q[1] == -3 && q[2] == 13);  // (1, -2, 2) / 0.25 + 5
  const int8_t out1[3] = {-128, 90, 90}, out2[3] = {10, -5, 11}, out3[3] = {-128, -128, -128};
  CHECK(sjEdgeArgmax(out1, 3) == 1 && sjEdgeArgmax(out2, 3) == 2 && sjEdgeArgmax(out3, 3) == 0);
}

// ---- the offline siren ignores the edge verdict (decision 2026-10-09) ---------
inline void sirenTests() {
  // URGENT from the model with nothing at a siren danger level: heat, flame,
  // tilt - never a siren trigger, whatever the model says
  SjReading r = makeReading("NODE-07", 1, 1);
  r.flags = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME | SJ_FLAME_DETECTED | SJ_HAS_TILT;
  r.water_level_mm = 1500;
  r.temp_c_x100 = 4900;  // IMD severe heat wave
  r.gas_ppm = 400;
  r.tilt_deg_x100 = 2000;
  r.edge_risk = 2;
  CHECK(!sjSirenLocalUrgent(r, 3200, 800));
  // the danger levels themselves still do, verdict or not
  r.edge_risk = SJ_EDGE_NONE;
  r.water_level_mm = 3200;
  CHECK(sjSirenLocalUrgent(r, 3200, 800));
  r.water_level_mm = 1500;
  r.gas_ppm = 800;
  CHECK(sjSirenLocalUrgent(r, 3200, 800));
}

inline void runEdgeTests() {
  vectorTests();
  headerTests();
  inputTests();
  quantizeTests();
  sirenTests();
  // the shipped config.h (every sensor fitted, continuous MQ135) runs the main model
  CHECK(EDGE_MODEL_IN_USE == EDGE_MODEL_MAIN);
}

}  // namespace edge
