"""
SANJEEVNI - confidence score per alert (round 2026-10-09, item D).

An explainable score, NOT a model probability. It says how much the
evidence behind ONE alert agrees with itself, from things an officer can
check: was it seen twice, does the node's own on-device check agree, how
well did the model do on test data at this score, and is the data clean.
Every point it loses is listed in confidence_reasons.

The formula
-----------
    confidence = weighted_mean(components) x quality        (0..1, 2 places)

Components (0..1 each). A component with no evidence is LEFT OUT and its
weight is shared by the others - "the node has no edge model" is not
evidence against the alert.

  confirmation  weight 0.50   (hazard_confirmation.HazardConfirmer)
      not confirmed yet (pending)        0.40
      seen again by the same node        0.70
      seen by a nearby / linked node     0.90
    A repeat at the same node does not count when the node reports the
    hazard's own sensor STUCK: a frozen value repeats by definition.

  edge          weight 0.25   (the node's own NORMAL/WATCH/URGENT verdict)
      Compared with our severity (MEDIUM ~ WATCH, HIGH/CRITICAL ~ URGENT)
      only for hazards the edge model is trained to see (EDGE_COMPARABLE:
      river level, gas, flame, heat - ml/make_edge_dataset.py):
      same level 1.0, one level apart 0.6, opposite ends 0.2.
      For flash flood and smoke the edge model sees a related signal but
      not the hazard itself (it has no rate of rise and no PM2.5), so a
      WATCH/URGENT there counts as 1.0 and a NORMAL is left out.
      Only a summary's window maximum known (no latest verdict): a
      WATCH/URGENT maximum is partial support, 0.6 (EDGE_WINDOW_SUPPORT_SCORE).

  model         weight 0.25
      Flood ML model only: the observed flood rate in the model card's
      reliability bin for this raw model score (ml/evaluate_models.py),
      used only when the card describes the model file actually loaded
      and the bin holds at least MIN_CALIBRATION_BIN_COUNT test cases.
      The card is SYNTHETIC data and the reason says so.
      Bench-test threshold override: 0.30 (a tabletop rig, not a river).
      Threshold classifiers (gas, heat, PM2.5 ...) compare a measurement
      with a published limit; there is no calibration data for them, so
      the component is left out rather than invented.

quality (multiplied together):
      node anomaly flag on a sensor this hazard uses:
          stuck / spike / rate 0.70, any other check 0.85 (strongest once)
      node anomaly flag only on other sensors              0.95
      another sensor out of its physical range             0.90
      reading delay  <= 5 min 1.0 | <= 30 min 0.85 | <= 6 h 0.65 | older 0.40

label: High >= 0.75, Medium >= 0.50, Low below.

Consequences worth knowing (each has a test in tests/test_confidence.py):
  - a pending alert is never High: its best case is
    0.5*0.40 + 0.25*1.0 + 0.25*1.0 = 0.70.
  - a confirmed alert with nothing else known is Medium (0.70, repeat) or
    High (0.90, neighbour).
  - the Isolation Forest "unusual reading" verdict is deliberately NOT a
    penalty: a real flood is unusual too, so it would lower confidence
    most on the most severe events. Readings it calls faults never become
    alerts in the first place.

All weights and cut-offs are configurable demo defaults chosen for
explainability, not fitted to data - there is no field data to fit them
to yet. Change them here; tests/test_confidence.py pins the behaviour.
"""

import hashlib
import json
import os
from typing import Optional

COMPONENT_WEIGHTS = {"confirmation": 0.50, "edge": 0.25, "model": 0.25}

CONFIRMATION_SCORES = {"unconfirmed": 0.40, "persistent": 0.70, "neighbour": 0.90}
# A forecast-only alert (heavy_rain / high_wind from the weather forecast
# alone, result["forecast_based"]) is confirmed by its external source
# (hazard_confirmation, basis "forecast"). It is scored on its own - see
# _forecast_confidence: 0.60, so it is never better than Medium; nothing
# a SANJEEVNI sensor measured stands behind it. Node anomaly flags, faults
# and the reading's delay say nothing about a forecast fetched at ingest
# time, so they are not applied to it. Demo default, like every weight here.
FORECAST_CONFIRMED_SCORE = 0.60

EDGE_LEVELS = ("NORMAL", "WATCH", "URGENT")
# Our severity -> the edge level it corresponds to (make_edge_dataset.py's
# labels use the same thresholds as the backend: WATCH ~ MEDIUM, URGENT ~
# HIGH and above).
SEVERITY_TO_EDGE_INDEX = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 2}
# Heat is one level lower on the node (ml/make_edge_dataset.py, retrained
# 2026-10-09 on the IMD plains rule): 40-45 C is backend MEDIUM but node
# NORMAL (a WATCH would send every 5-s sample on an ordinary summer
# afternoon), 45 C heat wave = backend HIGH = node WATCH, 47 C severe heat
# wave = CRITICAL = URGENT. With the generic map a correct node scored 0.6.
HEAT_SEVERITY_TO_EDGE_INDEX = {"LOW": 0, "MEDIUM": 0, "HIGH": 1, "CRITICAL": 2}
EDGE_AGREEMENT_SCORES = (1.0, 0.6, 0.2)  # by distance 0 / 1 / 2 levels
# Hazards the edge model is trained to judge (river level, gas, flame, temp)
EDGE_COMPARABLE = ("flood", "gas leak", "fire", "extreme heat")
# Hazards where the edge model sees a related signal (river level / gas)
# but not the hazard itself: its WATCH/URGENT supports, its NORMAL says nothing.
EDGE_SUPPORT_ONLY = ("flash_flood", "smoke")
# Firmware that sends only a summary block gives the WORST verdict in its
# report window (max_edge_risk_level), not the latest sample's. A WATCH /
# URGENT there says "the node saw something" but not that it agrees NOW,
# so it counts as partial support (the "one level apart" score), never as
# full agreement. A NORMAL maximum means every sample was NORMAL and is
# used as the verdict.
EDGE_WINDOW_SUPPORT_SCORE = 0.6

BENCH_MODEL_SCORE = 0.30
MIN_CALIBRATION_BIN_COUNT = 30

# Sensors each hazard's classifier reads - a node anomaly flag on one of
# these is about THIS alert's evidence.
HAZARD_FIELDS = {
    "flood": ("river_level_m",),
    "flash_flood": ("river_level_m",),
    "gas leak": ("gas_ppm",),
    "fire": ("flame_reading", "temp_c"),
    "smoke": ("pm25_ugm3", "gas_ppm"),
    "extreme heat": ("temp_c",),
    "landslide": ("tilt_angle_deg", "vibration_magnitude"),
    "air pollution": ("pm25_ugm3", "pm10_ugm3"),
    "water quality degradation": ("water_ph", "turbidity_ntu"),
    # The gauge only; a forecast-only result is scored without node flags.
    "heavy_rain": ("rainfall_mm_since_last",),
    "high_wind": (),
}
# Checks that say the VALUE itself is wrong (frozen, jumped, impossible
# change), as opposed to e.g. "dropout" (samples missing, the value sent
# is still a measurement).
SERIOUS_EDGE_CHECKS = ("stuck", "spike", "rate")
EDGE_FLAG_FACTOR_SERIOUS = 0.70
EDGE_FLAG_FACTOR_OTHER = 0.85
EDGE_FLAG_FACTOR_OTHER_SENSOR = 0.95
SENSOR_FAULT_FACTOR = 0.90
# (max delay in seconds, factor), checked in order; anything older gets
# STALE_FACTOR_OLDEST. A late reading describes the past, not now:
# 5 min is a few report intervals (normal LoRa / retry delay); 6 h is the
# CAP validity window (cap_alert.CAP_VALIDITY_HOURS), past which the
# reading says little about the present.
STALENESS_STEPS = ((5 * 60, 1.0), (30 * 60, 0.85), (6 * 3600, 0.65))
STALE_FACTOR_OLDEST = 0.40

HIGH_CONFIDENCE = 0.75
MEDIUM_CONFIDENCE = 0.50

# server.js (confidence.js) keeps at most 8 reasons of at most 120 chars;
# stay inside that so nothing is cut off.
MAX_REASONS = 8
MAX_REASON_LENGTH = 120

ELEVATED = ("MEDIUM", "HIGH", "CRITICAL")


def confidence_label(score: float) -> str:
    if score >= HIGH_CONFIDENCE:
        return "High"
    if score >= MEDIUM_CONFIDENCE:
        return "Medium"
    return "Low"


def edge_flags(edge_anomaly) -> list[tuple[str, str]]:
    """[(check, field), ...] from the node's "<check>:<field>" list."""
    out = []
    for item in edge_anomaly or ():
        check, sep, field = str(item).partition(":")
        if sep and check and field:
            out.append((check, field))
    return out


def stuck_hazard_fields(hazard_type: str, edge_anomaly) -> list[str]:
    """The sensors this hazard reads that the node reports as stuck. A
    frozen value repeats by definition, so backend_server passes this to
    HazardConfirmer (no persistence basis) and the score below does not
    count a repeat either."""
    fields = HAZARD_FIELDS.get(hazard_type or "", ())
    out = []
    for check, field in edge_flags(edge_anomaly):
        if check == "stuck" and field in fields and field not in out:
            out.append(field)
    return out


def normalise_edge_level(value) -> Optional[str]:
    """NORMAL / WATCH / URGENT, or None for anything else. edge_risk_level
    is not validated on the way in (older firmware), so it is checked here."""
    if not isinstance(value, str):
        return None
    value = value.strip().upper()
    return value if value in EDGE_LEVELS else None


# --- model calibration from the model card ----------------------------------

def _file_sha256(path: str) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _valid_bin(b) -> bool:
    if not isinstance(b, dict):
        return False
    try:
        lower, upper = float(b["bin_lower"]), float(b["bin_upper"])
        count = int(b["count"])
    except (KeyError, TypeError, ValueError):
        return False
    rate = b.get("observed_rate")
    return (0.0 <= lower < upper <= 1.0 and count >= 0
            and (rate is None or (isinstance(rate, (int, float)) and 0.0 <= rate <= 1.0)))


def load_flood_calibration(card_path: str, model_path: str) -> Optional[dict]:
    """{"bins": [...], "provenance": "SYNTHETIC"|...} from the model card,
    or None (with a log line saying why). Only used when the card's
    recorded sha256 of the flood model equals the model file actually
    loaded: a card left over from an older model would otherwise lend its
    numbers to a model it never tested."""
    try:
        with open(card_path, encoding="utf-8") as f:
            card = json.load(f)
    except FileNotFoundError:
        print("[confidence] no model card - flood model calibration not used")
        return None
    except (OSError, ValueError) as e:
        print(f"[confidence] model card unreadable ({e}) - flood model calibration not used")
        return None
    models = card.get("models") if isinstance(card, dict) else None
    flood = next((m for m in models or () if isinstance(m, dict) and m.get("id") == "flood"), None)
    if not flood or flood.get("status") != "evaluated":
        print("[confidence] model card has no evaluated flood model - calibration not used")
        return None
    card_sha = (flood.get("artifact") or {}).get("sha256")
    if not card_sha or card_sha != _file_sha256(model_path):
        print("[confidence] model card describes a different flood model file - "
              "calibration not used (re-run ml/evaluate_models.py)")
        return None
    calibration = flood.get("calibration") or {}
    bins = calibration.get("reliability")
    if not calibration.get("applicable") or not isinstance(bins, list) or not bins \
            or not all(_valid_bin(b) for b in bins):
        print("[confidence] model card has no usable reliability table - calibration not used")
        return None
    return {
        "bins": bins,
        "provenance": str(flood.get("evaluation", {}).get("provenance") or card.get("provenance") or "UNKNOWN"),
    }


def calibration_rate(calibration: Optional[dict], probability) -> Optional[tuple[float, int]]:
    """(observed flood rate, test cases) of the reliability bin holding
    `probability`, or None when there is no trustworthy bin for it."""
    if not calibration or not isinstance(probability, (int, float)):
        return None
    p = min(1.0, max(0.0, float(probability)))
    bins = calibration["bins"]
    for i, b in enumerate(bins):
        last = i == len(bins) - 1
        if b["bin_lower"] <= p < b["bin_upper"] or (last and p == b["bin_upper"]):
            if b.get("observed_rate") is None or int(b["count"]) < MIN_CALIBRATION_BIN_COUNT:
                return None
            return float(b["observed_rate"]), int(b["count"])
    return None


# --- the score ---------------------------------------------------------------

def _confirmation_component(confirmation: Optional[str], stuck_fields: list) -> tuple[float, str]:
    basis = confirmation or "unconfirmed"
    if basis.startswith("neighbour:"):
        other = basis.split(":", 1)[1][:40]
        return CONFIRMATION_SCORES["neighbour"], f"Confirmed by nearby node {other}"
    # A stuck sensor's repeat is no confirmation. HazardConfirmer already
    # gives it no "persistent" basis; the check here also covers a result
    # built some other way.
    if stuck_fields:
        return (CONFIRMATION_SCORES["unconfirmed"],
                f"Not confirmed: node reports {stuck_fields[0]} stuck, so repeat readings "
                "do not count - waiting for a nearby node")
    if basis == "persistent":
        return CONFIRMATION_SCORES["persistent"], "Confirmed: the same node measured it again"
    return CONFIRMATION_SCORES["unconfirmed"], "Not confirmed yet: waiting for a repeat reading or a nearby node"


def _edge_component(hazard_type: str, severity: str, severity_source: str, edge_level: Optional[str],
                    window_max: Optional[str] = None):
    """(score, reason) or None when the edge verdict says nothing here.
    window_max: the summary block's max_edge_risk_level, used only when the
    node sent no edge_risk_level for its latest sample (see
    EDGE_WINDOW_SUPPORT_SCORE)."""
    if edge_level is None and window_max is not None:
        if window_max == "NORMAL":
            edge_level = "NORMAL"  # every sample in the window, so the latest too
        elif _edge_component(hazard_type, severity, severity_source, window_max) is None:
            return None
        else:
            return EDGE_WINDOW_SUPPORT_SCORE, f"Node's own check flagged {window_max} earlier in its report window"
    if edge_level is None:
        return None
    edge_idx = EDGE_LEVELS.index(edge_level)
    if hazard_type in EDGE_SUPPORT_ONLY:
        if edge_idx == 0:
            return None
        return 1.0, f"Node's own check also flags it ({edge_level})"
    # The edge model was trained on river-scale levels; a bench rig's few
    # centimetres always look NORMAL to it, which is no disagreement.
    if hazard_type not in EDGE_COMPARABLE or severity_source == "hardware_test_threshold":
        return None
    expected = HEAT_SEVERITY_TO_EDGE_INDEX if hazard_type == "extreme heat" else SEVERITY_TO_EDGE_INDEX
    distance = abs(edge_idx - expected.get(severity, 0))
    score = EDGE_AGREEMENT_SCORES[min(distance, 2)]
    word = ("agrees", "partly agrees", "disagrees")[min(distance, 2)]
    return score, f"Node's own check {word} ({edge_level})"


def _model_component(result: dict, calibration: Optional[dict]):
    """(score, reason) or None."""
    source = result.get("severity_source")
    if source == "hardware_test_threshold":
        return BENCH_MODEL_SCORE, "Bench-test threshold, not a field-calibrated model"
    if source != "ml_model" or result.get("hazard_type") != "flood":
        return None
    flood = (result.get("hazard_scores") or {}).get("flood") or {}
    probability = flood.get("model_probability", result.get("risk_score"))
    found = calibration_rate(calibration, probability)
    if found is None:
        return None
    rate, _count = found
    data = "synthetic" if calibration.get("provenance") == "SYNTHETIC" else "test"
    return rate, f"Flood model on {data} data: {round(rate * 100)}% of similar scores were floods"


def _staleness(delay_seconds) -> tuple[float, Optional[str]]:
    if not isinstance(delay_seconds, (int, float)) or delay_seconds <= STALENESS_STEPS[0][0]:
        return 1.0, None
    if delay_seconds < 3600:
        age = f"{round(delay_seconds / 60)} min"
    else:
        age = f"{delay_seconds / 3600:.1f} h"
    factor = next((f for limit, f in STALENESS_STEPS if delay_seconds <= limit), STALE_FACTOR_OLDEST)
    return factor, f"Reading arrived {age} late"


def compute_confidence(result: dict, reading: dict, calibration: Optional[dict] = None) -> dict:
    """{"confidence", "confidence_label", "confidence_reasons"} for one
    pipeline result. All three are None unless the result is an alert
    (MEDIUM+ and alert_dispatched / pending_confirmation): a logged or
    suppressed reading has no alert to be confident about.

    result:  process_reading()'s result after HazardConfirmer has set
             result["confirmation"] ("persistent" / "neighbour:<id>" /
             "unconfirmed").
    reading: the enriched reading - edge_risk_level,
             edge_risk_level_window_max (a summary's max_edge_risk_level),
             edge_anomaly, delay_seconds are read from it.
    calibration: load_flood_calibration()'s value, or None."""
    empty = {"confidence": None, "confidence_label": None, "confidence_reasons": None}
    if result.get("status") not in ("alert_dispatched", "pending_confirmation") \
            or result.get("severity") not in ELEVATED:
        return empty

    if result.get("forecast_based"):
        return _forecast_confidence(result)

    hazard_type = result.get("hazard_type") or ""
    severity = result["severity"]
    hazard_fields = HAZARD_FIELDS.get(hazard_type, ())
    flags = edge_flags(reading.get("edge_anomaly"))
    own_flags = [(c, f) for c, f in flags if f in hazard_fields]
    other_flags = [(c, f) for c, f in flags if f not in hazard_fields]
    stuck_fields = stuck_hazard_fields(hazard_type, reading.get("edge_anomaly"))

    components, reasons = [], []
    score, reason = _confirmation_component(result.get("confirmation"), stuck_fields)
    components.append((COMPONENT_WEIGHTS["confirmation"], score))
    reasons.append(reason)

    edge = _edge_component(hazard_type, severity, result.get("severity_source"),
                           normalise_edge_level(reading.get("edge_risk_level")),
                           normalise_edge_level(reading.get("edge_risk_level_window_max")))
    if edge is not None:
        components.append((COMPONENT_WEIGHTS["edge"], edge[0]))
        reasons.append(edge[1])

    model = _model_component(result, calibration)
    if model is not None:
        components.append((COMPONENT_WEIGHTS["model"], model[0]))
        reasons.append(model[1])

    base = sum(w * s for w, s in components) / sum(w for w, _ in components)

    quality = 1.0
    if own_flags:
        serious = [(c, f) for c, f in own_flags if c in SERIOUS_EDGE_CHECKS]
        check, field = (serious or own_flags)[0]
        quality *= EDGE_FLAG_FACTOR_SERIOUS if serious else EDGE_FLAG_FACTOR_OTHER
        reasons.append(f"Node's anomaly check flags {field} ({check})")
    if other_flags:
        quality *= EDGE_FLAG_FACTOR_OTHER_SENSOR
        check, field = other_flags[0]
        reasons.append(f"Node's anomaly check flags another sensor ({check}:{field})")
    faults = [f for f in result.get("sensor_faults") or () if isinstance(f, str)]
    if faults:
        quality *= SENSOR_FAULT_FACTOR
        reasons.append(f"Another sensor on this node is faulty ({', '.join(faults[:3])})")
    stale_factor, stale_reason = _staleness(reading.get("delay_seconds"))
    quality *= stale_factor
    if stale_reason:
        reasons.append(stale_reason)
    if hazard_type == "heavy_rain":
        rain = (result.get("hazard_scores") or {}).get("heavy_rain") or {}
        if rain.get("basis") == "both":
            # Information, not a score change: the gauge is the evidence.
            reasons.append("The weather forecast also expects heavy rain")

    confidence = round(min(1.0, max(0.0, base * quality)), 2)
    return {
        "confidence": confidence,
        "confidence_label": confidence_label(confidence),
        "confidence_reasons": [r[:MAX_REASON_LENGTH] for r in reasons[:MAX_REASONS]],
    }


FORECAST_SOURCE_NAMES = {"open-meteo": "Open-Meteo", "mock": "a TEST file (SANJEEVNI_WEATHER_MOCK)"}


def _forecast_confidence(result: dict) -> dict:
    """Score of a forecast-only alert (see FORECAST_CONFIRMED_SCORE)."""
    source = FORECAST_SOURCE_NAMES.get(result.get("forecast_source"), "an external weather model")
    rain = (result.get("hazard_scores") or {}).get("heavy_rain") or {}
    if result.get("hazard_type") == "heavy_rain" and rain.get("basis") == "both":
        # The gauge measured heavy rain, but a lower category than the
        # forecast; the severity is the forecast's (hazard_classification).
        reasons = [f"Forecast-based severity: from {source}; the node's rain gauge "
                   "measured a lower IMD category"]
    else:
        reasons = [f"Forecast-based: from {source}, not measured by SANJEEVNI sensors"]
    if result.get("confirmation") == "forecast":
        score = FORECAST_CONFIRMED_SCORE
    else:
        score = CONFIRMATION_SCORES["unconfirmed"]
        reasons.append("Not confirmed: a test forecast cannot confirm a real node's alert"
                       if result.get("forecast_source") == "mock"
                       else "Not confirmed yet")
    return {
        "confidence": score,
        "confidence_label": confidence_label(score),
        "confidence_reasons": [r[:MAX_REASON_LENGTH] for r in reasons[:MAX_REASONS]],
    }


def confidence_sentence(conf: dict) -> Optional[str]:
    """One line for the alert text, e.g. "Confidence: Medium (60%) - Not
    confirmed yet: ...; Node's own check agrees (URGENT)." None when the
    result has no score."""
    if not conf or conf.get("confidence") is None:
        return None
    text = f"Confidence: {conf['confidence_label']} ({round(conf['confidence'] * 100)}%)"
    reasons = conf.get("confidence_reasons") or []
    if reasons:
        text += " - " + "; ".join(reasons[:2])
    return text + "."


def add_confidence_to_message(message: Optional[str], conf: dict) -> Optional[str]:
    """The alert text with the confidence line at the end of its first
    paragraph (the headline paragraph of the template in
    rag_alert_pipeline.generate_alert_message), so it is read before the
    long SOP guidance. A one-paragraph (LLM) message gets it appended."""
    sentence = confidence_sentence(conf)
    if not message or not sentence:
        return message
    head, sep, rest = message.partition("\n\n")
    return f"{head.rstrip()} {sentence}{sep}{rest}"
