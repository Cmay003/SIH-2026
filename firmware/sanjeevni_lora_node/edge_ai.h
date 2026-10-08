// =====================================================================
// SANJEEVNI node - on-device edge AI (TensorFlow Lite Micro).
// Same int8 model and input handling as sanjeevni_node_edge_ai.ino:
// 5 inputs (river level m, temp C, humidity %, gas ppm, flame 0/1) ->
// NORMAL / WATCH / URGENT, with no network involved.
// Library: "Chirale_TensorFLowLite" (Library Manager; 2.0.0 lists esp32
// as supported). The old official "Arduino_TensorFlowLite" is deprecated,
// gone from the Library Manager and never supported ESP32.
// =====================================================================
#pragma once
#include <Chirale_TensorFlowLite.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/schema/schema_generated.h>
#include "edge_model_data.h"
#include "config.h"

enum EdgeRiskLevel { EDGE_NORMAL = 0, EDGE_WATCH = 1, EDGE_URGENT = 2, EDGE_UNAVAILABLE = 255 };

// From scaler_params.json at training time - must match the model.
static const float EDGE_FEATURE_MEAN[5] = {1.9372822f, 30.2528999f, 60.0702352f, 527.8328722f, 0.0594403f};
static const float EDGE_FEATURE_SCALE[5] = {0.9618157f, 7.8129314f, 23.1442541f, 215.4961791f, 0.1034814f};

namespace sjedge {
const tflite::Model* model = nullptr;
tflite::MicroInterpreter* interpreter = nullptr;
TfLiteTensor* input = nullptr;
TfLiteTensor* output = nullptr;
constexpr int kTensorArenaSize = 8 * 1024;
alignas(16) uint8_t tensorArena[kTensorArenaSize];
bool ready = false;
}  // namespace sjedge

inline bool setupEdgeAI() {
  sjedge::model = tflite::GetModel(edge_model_data);
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
  sjedge::ready = true;
  return true;
}

// The model was trained on RIVER-scale levels (mean ~1.9 m); a bench tank
// spans only 0..ULTRASONIC_MOUNT_HEIGHT_CM. In bench mode the tank's fill
// fraction is mapped onto EDGE_RIVER_EMPTY_M..EDGE_RIVER_FULL_M.
inline float edgeModelRiverLevelM(float waterLevelM) {
  if (waterLevelM < 0) waterLevelM = 0;
  if (!EDGE_BENCH_SCALE_MODEL) return waterLevelM;
  float fraction = min(1.0f, waterLevelM / (ULTRASONIC_MOUNT_HEIGHT_CM / 100.0f));
  return EDGE_RIVER_EMPTY_M + fraction * (EDGE_RIVER_FULL_M - EDGE_RIVER_EMPTY_M);
}

inline EdgeRiskLevel runEdgeInference(float waterLevelM, float tempC, float humidityPct, float gasPpm, bool flame) {
  if (!sjedge::ready) return EDGE_UNAVAILABLE;
  float raw[5] = {edgeModelRiverLevelM(waterLevelM), tempC, humidityPct, gasPpm, flame ? 1.0f : 0.0f};
  float inScale = sjedge::input->params.scale;
  int inZero = sjedge::input->params.zero_point;
  for (int i = 0; i < 5; i++) {
    float normalized = (raw[i] - EDGE_FEATURE_MEAN[i]) / EDGE_FEATURE_SCALE[i];
    int32_t q = (int32_t)roundf(normalized / inScale) + inZero;
    if (q < -128) q = -128;
    if (q > 127) q = 127;
    sjedge::input->data.int8[i] = (int8_t)q;
  }
  if (sjedge::interpreter->Invoke() != kTfLiteOk) {
    return EDGE_WATCH;  // fail safe: an inference error is not "all clear"
  }
  int best = 0;
  for (int i = 1; i < 3; i++)
    if (sjedge::output->data.int8[i] > sjedge::output->data.int8[best]) best = i;  // same scale for all outputs
  return (EdgeRiskLevel)best;
}
