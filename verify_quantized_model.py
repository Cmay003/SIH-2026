"""
Runs the ACTUAL quantized int8 TFLite model (via the TFLite interpreter,
not the original Keras model) against the held-out test set, to prove
quantization didn't destroy real-world accuracy - this is the test that
actually matters, not just "the conversion succeeded without erroring".
"""
import numpy as np
import tensorflow as tf
import json
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

X, y = np.load("edge_X.npy"), np.load("edge_y.npy")
with open("scaler_params.json") as f:
    scaler = json.load(f)
mean, scale = np.array(scaler["mean"]), np.array(scaler["scale"])
X_scaled = ((X - mean) / scale).astype(np.float32)

_, X_test, _, y_test = train_test_split(X_scaled, y, test_size=0.2, random_state=42, stratify=y)

interpreter = tf.lite.Interpreter(model_path="edge_model_int8.tflite")
interpreter.allocate_tensors()
input_details = interpreter.get_input_details()[0]
output_details = interpreter.get_output_details()[0]

input_scale, input_zero_point = input_details["quantization"]
output_scale, output_zero_point = output_details["quantization"]

predictions = []
for i in range(len(X_test)):
    x = X_test[i:i+1]
    x_int8 = (x / input_scale + input_zero_point).astype(np.int8)
    interpreter.set_tensor(input_details["index"], x_int8)
    interpreter.invoke()
    output = interpreter.get_tensor(output_details["index"])
    predictions.append(np.argmax(output[0]))

predictions = np.array(predictions)
print("=== QUANTIZED (int8) model performance on the SAME held-out test set ===")
print(classification_report(y_test, predictions, target_names=["NORMAL", "WATCH", "URGENT"]))

accuracy = (predictions == y_test).mean()
print(f"Quantized model accuracy: {accuracy:.4f}")

# Critical safety check: does quantization introduce any NORMAL<->URGENT
# confusion that wasn't there before? That would be a genuinely dangerous
# regression for a safety system, worth catching explicitly.
normal_as_urgent = ((y_test == 0) & (predictions == 2)).sum()
urgent_as_normal = ((y_test == 2) & (predictions == 0)).sum()
print(f"\nNORMAL misclassified as URGENT: {normal_as_urgent}")
print(f"URGENT misclassified as NORMAL (the dangerous direction): {urgent_as_normal}")
assert urgent_as_normal == 0, "CRITICAL: quantization caused a real hazard to be missed entirely"
print("\nPASS: quantized model never mistakes a real URGENT event for NORMAL")
