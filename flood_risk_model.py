import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.inspection import permutation_importance
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

RNG = np.random.default_rng(42)


def scs_cn_runoff(rainfall_mm: np.ndarray, curve_number: np.ndarray) -> np.ndarray:
    S = (25400.0 / curve_number) - 254.0
    Ia = 0.2 * S
    excess = rainfall_mm - Ia
    runoff = np.where(excess > 0, (excess**2) / (rainfall_mm - Ia + S), 0.0)
    return np.clip(runoff, 0, None)


def generate_synthetic_data(n=6000) -> pd.DataFrame:
    land_use = RNG.choice(
        ["forest", "agricultural", "urban_low", "urban_high"],
        size=n,
        p=[0.25, 0.35, 0.25, 0.15],
    )
    cn_lookup = {
        "forest": (35, 55),
        "agricultural": (55, 75),
        "urban_low": (75, 85),
        "urban_high": (85, 96),
    }
    curve_number = np.array([RNG.uniform(*cn_lookup[lu]) for lu in land_use])

    rainfall_24h_mm = RNG.gamma(shape=2.0, scale=20.0, size=n)
    rainfall_intensity_mm_hr = rainfall_24h_mm / RNG.uniform(6, 24, n)

    runoff_mm = scs_cn_runoff(rainfall_24h_mm, curve_number)

    river_level_m = 1.5 + 0.01 * runoff_mm + RNG.normal(0, 0.3, n)
    river_level_m = np.clip(river_level_m, 0.2, None)
    river_level_rate_m_per_hr = 0.02 * runoff_mm / 6 + RNG.normal(0, 0.05, n)

    upstream_level_m = river_level_m * RNG.uniform(0.8, 1.1, n) + RNG.normal(0, 0.2, n)
    soil_saturation = np.clip(RNG.beta(2, 3, n) + 0.002 * rainfall_24h_mm, 0, 1)

    # Forecasted rain for the next 6 hours (from a weather API - Open-Meteo,
    # see backend_server.py: fetch_rainfall_forecast). A leading indicator,
    # not something any sensor has measured yet. Modeled here as loosely
    # correlated with the rain that's already fallen (storms don't stop
    # instantly) plus its own independent noise, since a forecast is never
    # a perfect readout of the actual 24h rainfall.
    forecast_rainfall_6h_mm = np.clip(
        0.25 * rainfall_24h_mm * RNG.uniform(0.4, 1.6, n) + RNG.gamma(1.0, 8.0, n),
        0,
        None,
    )

    df = pd.DataFrame(
        {
            "land_use": land_use,
            "curve_number": curve_number,
            "rainfall_24h_mm": rainfall_24h_mm,
            "rainfall_intensity_mm_hr": rainfall_intensity_mm_hr,
            "forecast_rainfall_6h_mm": forecast_rainfall_6h_mm,
            "runoff_mm": runoff_mm,
            "river_level_m": river_level_m,
            "river_level_rate_m_per_hr": river_level_rate_m_per_hr,
            "upstream_level_m": upstream_level_m,
            "soil_saturation": soil_saturation,
        }
    )

    risk_signal = (
        0.30 * (df.runoff_mm / df.runoff_mm.max())
        + 0.25 * (df.river_level_m / df.river_level_m.max())
        + 0.18
        * (df.river_level_rate_m_per_hr / max(df.river_level_rate_m_per_hr.max(), 1e-6))
        + 0.12 * df.soil_saturation
        + 0.15 * (df.forecast_rainfall_6h_mm / df.forecast_rainfall_6h_mm.max())
    )
    risk_signal += RNG.normal(0, 0.05, n)
    threshold = np.quantile(risk_signal, 0.85)
    df["flood_event"] = (risk_signal > threshold).astype(int)

    return df


def main():
    df = generate_synthetic_data()
    df = pd.get_dummies(df, columns=["land_use"], drop_first=True)

    feature_cols = [c for c in df.columns if c != "flood_event"]
    X = df[feature_cols]
    y = df["flood_event"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    model = HistGradientBoostingClassifier(
        max_iter=200, learning_rate=0.08, max_depth=4, random_state=42
    )
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_proba = model.predict_proba(X_test)[:, 1]

    print("=" * 60)
    print("MODEL PERFORMANCE")
    print("=" * 60)
    print(
        classification_report(y_test, y_pred, target_names=["No Flood", "Flood Risk"])
    )
    print(f"ROC-AUC: {roc_auc_score(y_test, y_proba):.3f}")

    result = permutation_importance(
        model, X_test, y_test, n_repeats=10, random_state=42
    )
    importances = pd.Series(result.importances_mean, index=feature_cols).sort_values()

    plt.figure(figsize=(8, 5))
    importances.plot(kind="barh", color="#2E86AB")
    plt.title("Flood Risk Model - Feature Importance")
    plt.xlabel("Permutation Importance")
    plt.tight_layout()
    plt.savefig("feature_importance.png", dpi=150)
    print("\nSaved feature importance chart -> feature_importance.png")

    print("\n" + "=" * 60)
    print("EXAMPLE: scoring a new reading (this is what your edge/backend calls)")
    print("=" * 60)
    example = pd.DataFrame(
        [
            {
                "curve_number": 82,
                "rainfall_24h_mm": 95,
                "rainfall_intensity_mm_hr": 18,
                "forecast_rainfall_6h_mm": 40,
                "runoff_mm": scs_cn_runoff(np.array([95.0]), np.array([82.0]))[0],
                "river_level_m": 3.1,
                "river_level_rate_m_per_hr": 0.25,
                "upstream_level_m": 3.4,
                "soil_saturation": 0.72,
                "land_use_forest": 0,
                "land_use_urban_high": 0,
                "land_use_urban_low": 1,
            }
        ]
    )[feature_cols]

    risk_score = model.predict_proba(example)[0, 1]
    print(
        f"Risk score: {risk_score}  |  Confidence band: "
        f"{'LOW' if risk_score < 0.007 else 'MEDIUM' if risk_score < 0.0004 else 'HIGH'}"
    )

    return model, feature_cols


if __name__ == "__main__":
    main()