// =====================================================================
// SANJEEVNI node - the edge models' INPUTS (hardware-independent, so it is
// unit-tested on a PC: tools/firmware_host_test/edge_tests.h, against
// vectors computed by ml/quantize_edge_model.py).
//
// Everything between a reading and the TFLite Micro call: which values go
// in, in which unit and order, what stands in for a sensor the node does
// not have, and the int8 quantisation of the input tensor. edge_ai.h only
// adds the interpreter.
//
// MAIN model (5 inputs): river level (model scale), temperature, humidity,
// gas, flame - needs all of water, DHT22, MQ135 and flame in the reading.
// LITE model (7 inputs): river level (model scale), rise rate as a multiple
// of the node's fast-rise limit, temperature, gas, flame, |tilt|,
// vibration. A sensor group the reading lacks gets the generated header's
// ABSENT value - a calm reading, which is exactly how the label rule
// treats a missing sensor (ml/make_edge_dataset.py label_lite). The rise
// rate also counts as absent while the anomaly checks doubt the water
// level it was computed from (stuck / spike / rate / dropout - the same
// checks the backend distrusts the node's rate on,
// hazard_classification.NODE_RATE_DISTRUST_CHECKS).
// Values come from the reading's fixed-point fields (mm, 0.01 C, ...), so
// the verdict is a function of what is sent.
// =====================================================================
#pragma once
#include <math.h>
#include <stdint.h>
#include "sj_packet.h"

#define SJ_EDGE_MAIN_INPUTS 5
#define SJ_EDGE_LITE_INPUTS 7
#define SJ_EDGE_RISE_X_MIN -5.0f  // = ml/make_edge_dataset.py RISE_X_MIN / RISE_X_MAX
#define SJ_EDGE_RISE_X_MAX 10.0f

// How a reading maps onto the models' (river) scale - config.h EDGE_* /
// FAST_RISE_* values.
struct SjEdgeScale {
  bool bench;              // EDGE_BENCH_SCALE_MODEL: a tabletop tank, mapped onto emptyM..fullM
  float mountM;            // ULTRASONIC_MOUNT_HEIGHT_CM / 100
  float emptyM, fullM;     // EDGE_RIVER_EMPTY_M / EDGE_RIVER_FULL_M
  float fastRiseCmPerMin;  // the node's fast-rise limit in the reading's own cm/min (bench: of the tank)
};

// The models were trained on RIVER-scale levels (mean ~1.9 m); a bench tank
// spans only 0..mountM. In bench mode the tank's fill fraction is mapped
// onto emptyM..fullM.
inline float sjEdgeModelLevelM(float waterLevelM, const SjEdgeScale& s) {
  if (waterLevelM < 0) waterLevelM = 0;
  if (!s.bench) return waterLevelM;
  float fraction = s.mountM > 0 ? waterLevelM / s.mountM : 0.0f;
  if (fraction > 1.0f) fraction = 1.0f;
  return s.emptyM + fraction * (s.fullM - s.emptyM);
}

// MAIN model inputs: river_level_m, temp_c, humidity_pct, gas_ppm, flame.
// false = one of the four sensors is missing from this reading (gas still
// warming up, a failed DHT read...): no verdict.
inline bool sjEdgeMainInputs(const SjReading& r, const SjEdgeScale& s, float out[SJ_EDGE_MAIN_INPUTS]) {
  const uint16_t need = SJ_HAS_WATER | SJ_HAS_DHT | SJ_HAS_GAS | SJ_HAS_FLAME;
  if ((r.flags & need) != need) return false;
  out[0] = sjEdgeModelLevelM(r.water_level_mm / 1000.0f, s);
  out[1] = r.temp_c_x100 / 100.0f;
  out[2] = r.humidity_x100 / 100.0f;
  out[3] = (float)r.gas_ppm;
  out[4] = (r.flags & SJ_FLAME_DETECTED) ? 1.0f : 0.0f;
  return true;
}

// The water level's anomaly flags that make the node's own RATE meaningless.
inline bool sjEdgeRiseDoubtful(const SjReading& r) {
  const uint8_t w = 1u << SJ_AF_WATER;
  return (r.anomaly[SJ_AC_STUCK] | r.anomaly[SJ_AC_SPIKE] | r.anomaly[SJ_AC_RATE] | r.anomaly[SJ_AC_DROPOUT]) & w;
}

// LITE model inputs: river_level_m, rise_x, temp_c, gas_ppm, flame, tilt_deg,
// vibration_g; `absent` = the generated header's EDGE_LITE_ABSENT. Returns
// how many of the five sensor groups (water, DHT, gas, flame, tilt) the
// reading has - 0 = nothing the model can judge: no verdict.
inline uint8_t sjEdgeLiteInputs(const SjReading& r, const SjEdgeScale& s, const float absent[SJ_EDGE_LITE_INPUTS],
                                float out[SJ_EDGE_LITE_INPUTS]) {
  for (int i = 0; i < SJ_EDGE_LITE_INPUTS; i++) out[i] = absent[i];
  uint8_t groups = 0;
  if (r.flags & SJ_HAS_WATER) {
    groups++;
    out[0] = sjEdgeModelLevelM(r.water_level_mm / 1000.0f, s);
    if ((r.xflags & SJ_X_RISE_RATE) && !sjEdgeRiseDoubtful(r) && s.fastRiseCmPerMin > 0) {
      float x = r.rise_cm_min_x100 / 100.0f / s.fastRiseCmPerMin;
      if (x < SJ_EDGE_RISE_X_MIN) x = SJ_EDGE_RISE_X_MIN;
      if (x > SJ_EDGE_RISE_X_MAX) x = SJ_EDGE_RISE_X_MAX;
      out[1] = x;
    }
  }
  if (r.flags & SJ_HAS_DHT) {
    groups++;
    out[2] = r.temp_c_x100 / 100.0f;
  }
  if (r.flags & SJ_HAS_GAS) {
    groups++;
    out[3] = (float)r.gas_ppm;
  }
  if (r.flags & SJ_HAS_FLAME) {
    groups++;
    out[4] = (r.flags & SJ_FLAME_DETECTED) ? 1.0f : 0.0f;
  }
  if (r.flags & SJ_HAS_TILT) {
    groups++;
    out[5] = fabsf(r.tilt_deg_x100 / 100.0f);  // a tilt either way
    out[6] = r.vibration_g_x1000 / 1000.0f;
  }
  return groups;
}

// The int8 input tensor: (x - mean) / scale, then the tensor's own
// quantisation (scale, zero point), rounded half away from zero (roundf)
// and clamped. The float is clamped first only so the int conversion stays
// defined - anything that far out clamps to -128 / 127 either way.
inline void sjEdgeQuantize(const float* raw, const float* mean, const float* scale, int n, float inScale,
                           int32_t inZero, int8_t* out) {
  for (int i = 0; i < n; i++) {
    float normalized = (raw[i] - mean[i]) / scale[i];
    float v = normalized / inScale;
    if (!(v > -1000.0f)) v = -1000.0f;  // also NaN
    if (v > 1000.0f) v = 1000.0f;
    int32_t q = (int32_t)roundf(v) + inZero;
    if (q < -128) q = -128;
    if (q > 127) q = 127;
    out[i] = (int8_t)q;
  }
}

// The class: the first maximum of the int8 output (all outputs share one scale).
inline uint8_t sjEdgeArgmax(const int8_t* v, int n) {
  int best = 0;
  for (int i = 1; i < n; i++)
    if (v[i] > v[best]) best = i;
  return (uint8_t)best;
}
