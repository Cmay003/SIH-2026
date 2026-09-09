import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

RNG = np.random.default_rng(7)


def generate_sensor_stream(n_normal=2000, n_anomalies=100):
    t = np.arange(n_normal)
    river_level = 1.8 + 0.3 * np.sin(t / 200) + RNG.normal(0, 0.05, n_normal)
    temp = 27 + 3 * np.sin(t / 300) + RNG.normal(0, 0.5, n_normal)
    humidity = 60 + 10 * np.sin(t / 250 + 1) + RNG.normal(0, 1.5, n_normal)
    gas_ppm = 400 + RNG.normal(0, 15, n_normal)
    flame_reading = RNG.normal(0, 0.02, n_normal)

    normal = pd.DataFrame(
        {
            "river_level_m": river_level,
            "temp_c": temp,
            "humidity_pct": humidity,
            "gas_ppm": gas_ppm,
            "flame_reading": np.clip(flame_reading, 0, None),
        }
    )
    normal["is_anomaly"] = 0

    anomaly_rows = []
    for _ in range(n_anomalies):
        kind = RNG.choice(["spike", "dropout", "stuck", "drift"])
        row = normal.sample(1, random_state=RNG.integers(0, 1_000_000)).iloc[0].copy()
        if kind == "spike":
            col = RNG.choice(["river_level_m", "temp_c", "gas_ppm", "flame_reading"])
            row[col] = row[col] * RNG.uniform(3, 8)
        elif kind == "dropout":
            row[["river_level_m", "temp_c", "humidity_pct", "gas_ppm"]] = 0
        elif kind == "stuck":
            row["humidity_pct"] = 0
            row["gas_ppm"] = row["gas_ppm"] * 4
        elif kind == "drift":
            row["temp_c"] += RNG.uniform(15, 25)
            row["gas_ppm"] += RNG.uniform(300, 600)
        row["is_anomaly"] = 1
        anomaly_rows.append(row)

    anomalies = pd.DataFrame(anomaly_rows)
    df = (
        pd.concat([normal, anomalies], ignore_index=True)
        .sample(frac=1, random_state=42)
        .reset_index(drop=True)
    )
    return df


def main():
    df = generate_sensor_stream()
    feature_cols = [
        "river_level_m",
        "temp_c",
        "humidity_pct",
        "gas_ppm",
        "flame_reading",
    ]
    X = df[feature_cols]
    y_true = df["is_anomaly"]

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    contamination = y_true.mean()
    model = IsolationForest(
        n_estimators=200,
        contamination=contamination,
        random_state=42,
    )
    model.fit(X_scaled)

    raw_pred = model.predict(X_scaled)
    y_pred = (raw_pred == -1).astype(int)
    anomaly_score = -model.score_samples(X_scaled)

    tp = ((y_pred == 1) & (y_true == 1)).sum()
    fp = ((y_pred == 1) & (y_true == 0)).sum()
    fn = ((y_pred == 0) & (y_true == 1)).sum()
    tn = ((y_pred == 0) & (y_true == 0)).sum()
    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0

    print("=" * 60)
    print("EDGE ANOMALY DETECTION - PERFORMANCE")
    print("=" * 60)
    print(f"Detected {y_pred.sum()} anomalies out of {len(df)} readings")
    print(f"True positives:  {tp}")
    print(f"False positives: {fp}  (flagged as anomaly, actually normal)")
    print(f"False negatives: {fn}  (missed real anomaly)")
    print(f"Precision: {precision:.3f}")
    print(f"Recall:    {recall:.3f}")
    print(f"F1:        {f1:.3f}")

    plt.figure(figsize=(8, 5))
    plt.hist(
        anomaly_score[y_true == 0], bins=40, alpha=0.6, label="Normal", color="#2E86AB"
    )
    plt.hist(
        anomaly_score[y_true == 1], bins=40, alpha=0.6, label="Anomaly", color="#E63946"
    )
    plt.axvline(
        np.quantile(anomaly_score, 1 - contamination),
        color="black",
        linestyle="--",
        label="Decision threshold",
    )
    plt.title("Anomaly Score Distribution")
    plt.xlabel("Anomaly score (higher = more anomalous)")
    plt.ylabel("Count")
    plt.legend()
    plt.tight_layout()
    plt.savefig("anomaly_score_distribution.png", dpi=150)
    print("\nSaved anomaly_score_distribution.png")

    print("\n" + "=" * 60)
    print("EXAMPLE: scoring a live reading batch")
    print("=" * 60)
    live_batch = pd.DataFrame(
        [
            {
                "river_level_m": 1.9,
                "temp_c": 28.1,
                "humidity_pct": 61,
                "gas_ppm": 410,
                "flame_reading": 0.01,
            },
            {
                "river_level_m": 9.4,
                "temp_c": 27.0,
                "humidity_pct": 59,
                "gas_ppm": 395,
                "flame_reading": 0.02,
            },
            {
                "river_level_m": 2.0,
                "temp_c": 55.0,
                "humidity_pct": 60,
                "gas_ppm": 900,
                "flame_reading": 0.5,
            },
        ]
    )
    live_scaled = scaler.transform(live_batch[feature_cols])
    live_pred = model.predict(live_scaled)
    live_score = -model.score_samples(live_scaled)
    for i, (pred, score) in enumerate(zip(live_pred, live_score)):
        status = (
            "ANOMALY - suppress before risk model"
            if pred == -1
            else "normal - pass through"
        )
        print(f"Reading {i}: score={score:.3f}  ->  {status}")

    return model, scaler, feature_cols


if __name__ == "__main__":
    main()
