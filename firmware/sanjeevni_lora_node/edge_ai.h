// =====================================================================
// SANJEEVNI node - on-device edge AI (TensorFlow Lite Micro).
// One int8 model per build, picked by config.h EDGE_MODEL_IN_USE:
//  MAIN (edge_model_data.h): 5 inputs - river level m, temp C, humidity %,
//    gas ppm, flame 0/1 - for nodes with water, DHT22, MQ135 and flame;
//  LITE (edge_lite_model_data.h): 7 inputs - river level, rise rate (x the
//    fast-rise limit), temp, gas, flame, |tilt|, vibration - any of them
//    may be missing (deep-sleep, gas-free, tilt-only, modular nodes);
//  NONE: no model, no TFLite library linked.
// Both say NORMAL / WATCH / URGENT, with no network involved. The inputs,
// their scaling and the int8 quantisation are in sj_edge_input.h (tested on
// the PC against the training pipeline's own numbers); the generated
// header carries the model, the input scaling and golden vectors that
// setupEdgeAI() runs through TFLite Micro on the device.
// Library: "Chirale_TensorFLowLite" (Library Manager; 2.0.0 lists esp32
// as supported). The old official "Arduino_TensorFlowLite" is deprecated,
// gone from the Library Manager and never supported ESP32.
// =====================================================================
#pragma once
#include "config.h"
#include "sj_edge_input.h"

enum EdgeRiskLevel { EDGE_NORMAL = 0, EDGE_WATCH = 1, EDGE_URGENT = 2, EDGE_UNAVAILABLE = 255 };

#if EDGE_MODEL_IN_USE == EDGE_MODEL_MAIN || EDGE_MODEL_IN_USE == EDGE_MODEL_LITE
#include <Chirale_TensorFlowLite.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/schema/schema_generated.h>

#if EDGE_MODEL_IN_USE == EDGE_MODEL_MAIN
#include "edge_model_data.h"
#define SJ_EDGE_INPUTS SJ_EDGE_MAIN_INPUTS
#define SJ_EDGE_MODEL_NAME "main"
#define SJ_EDGE_MODEL_BYTES edge_model_data
#define SJ_EDGE_MEAN EDGE_FEATURE_MEAN
#define SJ_EDGE_SCALE EDGE_FEATURE_SCALE
#define SJ_EDGE_GOLDEN_COUNT EDGE_GOLDEN_COUNT
#define SJ_EDGE_GOLDEN_INPUT EDGE_GOLDEN_INPUT
#define SJ_EDGE_GOLDEN_CLASS EDGE_GOLDEN_CLASS
static_assert(EDGE_MODEL_INPUTS == SJ_EDGE_MAIN_INPUTS, "edge_model_data.h: not the 5-input main model");
#else
#include "edge_lite_model_data.h"
#define SJ_EDGE_INPUTS SJ_EDGE_LITE_INPUTS
#define SJ_EDGE_MODEL_NAME "lite"
#define SJ_EDGE_MODEL_BYTES edge_lite_model_data
#define SJ_EDGE_MEAN EDGE_LITE_FEATURE_MEAN
#define SJ_EDGE_SCALE EDGE_LITE_FEATURE_SCALE
#define SJ_EDGE_GOLDEN_COUNT EDGE_LITE_GOLDEN_COUNT
#define SJ_EDGE_GOLDEN_INPUT EDGE_LITE_GOLDEN_INPUT
#define SJ_EDGE_GOLDEN_CLASS EDGE_LITE_GOLDEN_CLASS
static_assert(EDGE_LITE_MODEL_INPUTS == SJ_EDGE_LITE_INPUTS, "edge_lite_model_data.h: not the 7-input lite model");
#endif

namespace sjedge {
const tflite::Model* model = nullptr;
tflite::MicroInterpreter* interpreter = nullptr;
TfLiteTensor* input = nullptr;
TfLiteTensor* output = nullptr;
constexpr int kTensorArenaSize = 8 * 1024;
alignas(16) uint8_t tensorArena[kTensorArenaSize];
bool ready = false;
uint8_t goldenPassed = 0;  // golden vectors that got the PC's class at setup
bool goldenRan = false;    // false: setup failed before the golden check
}  // namespace sjedge

inline EdgeRiskLevel runEdgeModel(const float raw[SJ_EDGE_INPUTS]);

inline bool setupEdgeAI() {
  sjedge::model = tflite::GetModel(SJ_EDGE_MODEL_BYTES);
  if (sjedge::model->version() != TFLITE_SCHEMA_VERSION) {
    Serial.println("[edge] model schema version mismatch");
    return false;
  }
  static tflite::MicroMutableOpResolver<3> resolver;
  resolver.AddFullyConnected();
  resolver.AddRelu();
  resolver.AddSoftmax();
  static tflite::MicroInterpreter interpreter(sjedge::model, resolver, sjedge::tensorArena, sjedge::kTensorArenaSize);
  sjedge::interpreter = &interpreter;
  if (interpreter.AllocateTensors() != kTfLiteOk) {
    Serial.println("[edge] AllocateTensors() failed - tensor arena too small?");
    return false;
  }
  sjedge::input = interpreter.input(0);
  sjedge::output = interpreter.output(0);
  if (sjedge::input->type != kTfLiteInt8 || sjedge::input->dims->data[sjedge::input->dims->size - 1] != SJ_EDGE_INPUTS) {
    Serial.println("[edge] the model's input is not the expected int8 tensor");
    return false;
  }
  // The golden vectors through TFLite Micro on THIS board must get the
  // class the training pipeline's int8 interpreter gave them on the PC: a
  // wrong model / scaling / library shows here, and then no verdict is
  // sent rather than a wrong one. ~10 inferences of a 300-weight network:
  // well under a millisecond, also on every deep-sleep wake.
  sjedge::ready = true;
  sjedge::goldenRan = true;
  sjedge::goldenPassed = 0;
  for (uint8_t i = 0; i < SJ_EDGE_GOLDEN_COUNT; i++)
    if (runEdgeModel(SJ_EDGE_GOLDEN_INPUT[i]) == (EdgeRiskLevel)SJ_EDGE_GOLDEN_CLASS[i]) sjedge::goldenPassed++;
  if (sjedge::goldenPassed != SJ_EDGE_GOLDEN_COUNT) {
    Serial.printf("[edge] %s model: %u of %u golden vectors match the PC - verdicts OFF\n", SJ_EDGE_MODEL_NAME,
                  (unsigned)sjedge::goldenPassed, (unsigned)SJ_EDGE_GOLDEN_COUNT);
    sjedge::ready = false;
    return false;
  }
  return true;
}

// One inference on raw (unscaled) inputs in the model's order.
inline EdgeRiskLevel runEdgeModel(const float raw[SJ_EDGE_INPUTS]) {
  if (!sjedge::ready) return EDGE_UNAVAILABLE;
  sjEdgeQuantize(raw, SJ_EDGE_MEAN, SJ_EDGE_SCALE, SJ_EDGE_INPUTS, sjedge::input->params.scale,
                 sjedge::input->params.zero_point, sjedge::input->data.int8);
  if (sjedge::interpreter->Invoke() != kTfLiteOk) {
    return EDGE_WATCH;  // fail safe: an inference error is not "all clear"
  }
  return (EdgeRiskLevel)sjEdgeArgmax(sjedge::output->data.int8, 3);
}

// The verdict for one reading (NORMAL / WATCH / URGENT), or EDGE_UNAVAILABLE
// when the model is not running or the reading lacks what it needs.
inline EdgeRiskLevel runEdgeInference(const SjReading& r, const SjEdgeScale& scale) {
  float raw[SJ_EDGE_INPUTS];
#if EDGE_MODEL_IN_USE == EDGE_MODEL_MAIN
  if (!sjEdgeMainInputs(r, scale, raw)) return EDGE_UNAVAILABLE;
#else
  if (sjEdgeLiteInputs(r, scale, EDGE_LITE_ABSENT, raw) == 0) return EDGE_UNAVAILABLE;
#endif
  return runEdgeModel(raw);
}

// setupEdgeAI()'s golden-vector result, for the self-test (total 0: the
// check never ran - the model did not even load).
inline void edgeGoldenResult(uint8_t& passed, uint8_t& total) {
  passed = sjedge::goldenPassed;
  total = sjedge::goldenRan ? SJ_EDGE_GOLDEN_COUNT : 0;
}

#else  // EDGE_MODEL_NONE: no model on this node
#define SJ_EDGE_MODEL_NAME "none"
inline bool setupEdgeAI() { return false; }
inline EdgeRiskLevel runEdgeInference(const SjReading&, const SjEdgeScale&) { return EDGE_UNAVAILABLE; }
inline void edgeGoldenResult(uint8_t& passed, uint8_t& total) { passed = total = 0; }
#endif
