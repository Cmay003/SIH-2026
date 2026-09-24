"""
Trains a genuinely tiny neural network for ESP32 on-device inference.
5 inputs -> 16 -> 8 -> 3 outputs (softmax). ~230 parameters total -
trivially small for TFLite Micro, which typically runs models with a
few KB to a few hundred KB, well within ESP32's ~320KB RAM budget.
"""
import numpy as np
import tensorflow as tf
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.preprocessing import StandardScaler
import json

X, y = np.load("edge_X.npy"), np.load("edge_y.npy")

# Normalize features - critical for a small NN to train well, and the
# scaler's mean/scale get baked into the ESP32 firmware as constants
# (can't run sklearn on the device, so normalization becomes fixed
# arithmetic in C).
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X).astype(np.float32)

X_train, X_test, y_train, y_test = train_test_split(
    X_scaled, y, test_size=0.2, random_state=42, stratify=y
)

model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(5,)),
    tf.keras.layers.Dense(16, activation="relu"),
    tf.keras.layers.Dense(8, activation="relu"),
    tf.keras.layers.Dense(3, activation="softmax"),
])
model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])

print(f"Total trainable parameters: {model.count_params()}")

history = model.fit(
    X_train, y_train, validation_split=0.15, epochs=30, batch_size=64, verbose=0,
)

print("\n=== Full-precision Keras model performance (held-out test set) ===")
y_pred = np.argmax(model.predict(X_test, verbose=0), axis=1)
print(classification_report(y_test, y_pred, target_names=["NORMAL", "WATCH", "URGENT"]))
print("Confusion matrix:\n", confusion_matrix(y_test, y_pred))

model.save("edge_model.keras")

# Save the scaler's parameters as plain JSON - these become hardcoded
# constants in the ESP32 firmware for normalizing raw sensor readings
# before feeding them to the quantized model.
scaler_params = {
    "mean": scaler.mean_.tolist(),
    "scale": scaler.scale_.tolist(),
    "feature_order": ["river_level_m", "temp_c", "humidity_pct", "gas_ppm", "flame_reading"],
}
with open("scaler_params.json", "w") as f:
    json.dump(scaler_params, f, indent=2)
print("\nSaved edge_model.keras and scaler_params.json")
