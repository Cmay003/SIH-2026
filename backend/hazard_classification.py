"""
SANJEEVNI - Multi-hazard classification.

Previously, flame_reading and gas_ppm were the only sensors with a real
decision path (flood risk via ML, gas leak via a fixed threshold) -
everything else (flame/IR beyond the anomaly-suppression override) had
no independent severity output of its own. This module adds five real,
independently-scored classification paths, closing the gap named in the
problem statement: "full multi-hazard classification".

Design choice: each classifier returns its OWN (hazard_type, risk_score,
severity) independently. process_reading() in integration_pipeline.py
then picks the single MOST SEVERE hazard as the reading's primary
hazard_type (for backward compatibility with the existing DB schema,
dashboard, and CAP alert format, which all expect one hazard per
reading) while still exposing every classifier's score in a
"hazard_scores" field for full transparency - so you can show a judge
"here's what ALL five detectors independently saw", not just the winner.

Every threshold below is a genuine external reference where one exists,
not an arbitrary guess - see each function's docstring for the source.
Sensor fields are all Optional in RawReading (backend_server.py), so a
node without a given sensor simply skips that hazard's classification
rather than crashing or reporting a false LOW.
"""

import os
import statistics

from rag_alert_pipeline import severity_band


def _env_float(name: str, default: float) -> float:
    """A threshold an operator can tune without a code change."""
    return float(os.environ.get(name, default))


FLAME_DETECT_THRESHOLD = 0.3  # matches integration_pipeline.FLAME_THRESHOLD


def classify_fire_smoke(reading: dict):
    """Fire/smoke - flame_reading is the primary signal (IR flame
    sensor, 0-1 scale, same field already used for anomaly-suppression
    in integration_pipeline.py's is_hazard_signature()). Confirming
    heat (temp_c) raises confidence when both fire signature AND
    unusually high temperature co-occur, versus flame_reading alone
    which could be sensor noise/reflection."""
    flame = reading.get("flame_reading")
    if flame is None:
        return None

    if flame < FLAME_DETECT_THRESHOLD:
        return {"hazard_type": "fire", "risk_score": 0.0, "severity": "LOW"}

    risk_score = min(1.0, flame)
    temp_c = reading.get("temp_c")
    if temp_c is not None and temp_c > 45:
        # Real fire nearby plausibly raises ambient temp - corroborating
        # evidence bumps confidence, capped at 1.0
        risk_score = min(1.0, risk_score + 0.2)
    if smoke_evidence(reading)["detected"]:
        # Smoke (PM2.5 and gas rising together - classify_smoke) is a
        # second, independent sign of burning next to the flame sensor,
        # which on its own can be fooled by sunlight or a reflection.
        risk_score = min(1.0, risk_score + SMOKE_FIRE_SUPPORT)

    return {
        "hazard_type": "fire",
        "risk_score": round(risk_score, 4),
        "severity": severity_band(risk_score),
    }


# --- Extreme heat: IMD heat-wave criteria --------------------------------
#
# SOURCE (read 2026-10-09): IMD, "Heat wave - definition / FAQ",
#   https://mausam.imd.gov.in/pdfs/heatcolduser/Definition.pdf
# and IMD's morning heat bulletin legend,
#   https://mausam.imd.gov.in/pdfs/heatcolduser/morning_heat_bulletin.pdf
# Both say (paraphrased, numbers exact):
#   - Heat wave is considered only once a station's MAXIMUM temperature
#     reaches at least 40 C (plains), 37 C (coastal), 30 C (hilly regions).
#   - a) departure from normal: heat wave 4.5-6.4 C above normal, severe
#        heat wave more than 6.4 C above normal;
#   - b) actual maximum temperature (FOR PLAINS ONLY, per the bulletin):
#        heat wave >= 45 C, severe heat wave >= 47 C;
#   - coastal: heat wave may be described when the departure is >= 4.5 C
#     provided the actual maximum is >= 37 C;
#   - IMD DECLARES a heat wave only when the criteria are met at >= 2
#     stations of a meteorological sub-division for >= 2 consecutive days.
# Before 2026-10-09 this function said "heat wave at 40 C, severe at 45 C",
# which is NOT IMD's definition: 45 C is a heat wave, 47 C a severe one.
#
# What SANJEEVNI can and cannot do with that:
#   - a node reports an INSTANTANEOUS temperature, not the day's maximum
#     from a screened IMD station, and one node is one station - so an
#     alert here means "heat-wave-level temperature measured at this
#     sensor", never "IMD has declared a heat wave".
#   - per-station normals are not tracked. When a node's registry entry
#     carries normal_max_temp_c (that place's normal daily maximum for the
#     date) the departure criterion a) is used; otherwise only b) can be,
#     and b) applies to plains only.
#   - a node's region comes from its registry entry (heat_region) or the
#     SANJEEVNI_HEAT_REGION env var; default "plains" (the old behaviour).
#
# Severity mapping (this project's choice):
#   below the region's minimum            LOW (risk ramps up 5 C below it)
#   region minimum reached, criterion
#     not assessable / not met            MEDIUM - "heat-wave level possible"
#   IMD heat wave (a or b)                HIGH
#   IMD severe heat wave (a or b)         CRITICAL
# Hilly / coastal nodes without a normal therefore stop at MEDIUM: IMD has
# no absolute-temperature criterion for them. Coastal nodes WITH a normal
# stop at HIGH (heat_wave): IMD's coastal clause names no severe heat wave.
IMD_HEAT_MIN_TEMP_C = {"plains": 40.0, "coastal": 37.0, "hilly": 30.0}
IMD_HEAT_WAVE_ACTUAL_C = 45.0          # plains only
IMD_SEVERE_HEAT_WAVE_ACTUAL_C = 47.0   # plains only
IMD_HEAT_WAVE_DEPARTURE_C = 4.5
IMD_SEVERE_HEAT_WAVE_DEPARTURE_C = 6.4  # "more than 6.4 C"
DEFAULT_HEAT_REGION = os.environ.get("SANJEEVNI_HEAT_REGION", "plains").strip().lower()


def heat_region_for(reading: dict) -> str:
    region = str(reading.get("heat_region") or DEFAULT_HEAT_REGION).strip().lower()
    return region if region in IMD_HEAT_MIN_TEMP_C else "plains"


def classify_extreme_heat(reading: dict):
    """Extreme heat, graded against IMD's heat-wave criteria (see the block
    comment above for the source and what an instantaneous node reading
    can and cannot say). Adds "imd_category" (None / "heat_wave_threshold"
    / "heat_wave" / "severe_heat_wave"), "criterion" ("actual" /
    "departure" / None) and "heat_region"."""
    temp_c = reading.get("temp_c")
    if temp_c is None:
        return None

    region = heat_region_for(reading)
    minimum = IMD_HEAT_MIN_TEMP_C[region]
    normal = reading.get("normal_max_temp_c")
    departure = (temp_c - normal) if isinstance(normal, (int, float)) else None

    category, criterion = None, None
    if temp_c >= minimum:
        category = "heat_wave_threshold"
        if departure is not None:
            # Coastal: IMD's coastal clause describes only a "heat wave"
            # (departure >= 4.5 C with an actual maximum >= 37 C) and no
            # severe heat wave, so a coastal node stops at heat_wave (HIGH)
            # and can never be CRITICAL (= siren-eligible) on heat. Project
            # choice (2026-10-09 review), conservative reading of the IMD
            # sources above - verify with IMD before field use.
            if departure > IMD_SEVERE_HEAT_WAVE_DEPARTURE_C and region != "coastal":
                category, criterion = "severe_heat_wave", "departure"
            elif departure >= IMD_HEAT_WAVE_DEPARTURE_C:
                category, criterion = "heat_wave", "departure"
        if region == "plains":
            if temp_c >= IMD_SEVERE_HEAT_WAVE_ACTUAL_C:
                category, criterion = "severe_heat_wave", "actual"
            elif temp_c >= IMD_HEAT_WAVE_ACTUAL_C and category != "severe_heat_wave":
                category, criterion = "heat_wave", "actual"

    if category == "severe_heat_wave":
        risk_score = 0.95
    elif category == "heat_wave":
        # 0.75-0.85 across 45-47 C (HIGH); departure-based uses its own span
        if criterion == "actual":
            span = (temp_c - IMD_HEAT_WAVE_ACTUAL_C) / (IMD_SEVERE_HEAT_WAVE_ACTUAL_C - IMD_HEAT_WAVE_ACTUAL_C)
        else:
            span = (departure - IMD_HEAT_WAVE_DEPARTURE_C) / (IMD_SEVERE_HEAT_WAVE_DEPARTURE_C - IMD_HEAT_WAVE_DEPARTURE_C)
        risk_score = 0.75 + 0.1 * min(1.0, max(0.0, span))
    elif category == "heat_wave_threshold":
        # 0.45-0.69 (MEDIUM) across the 5 C above the region's minimum
        risk_score = 0.45 + 0.24 * min(1.0, (temp_c - minimum) / 5)
    elif temp_c >= minimum - 5:
        risk_score = (temp_c - (minimum - 5)) / 5 * 0.4  # 0-0.4, LOW
    else:
        risk_score = 0.0

    return {
        "hazard_type": "extreme heat",
        "risk_score": round(risk_score, 4),
        "severity": severity_band(risk_score),
        "imd_category": category,
        "criterion": criterion,
        "heat_region": region,
        "departure_c": round(departure, 1) if departure is not None else None,
    }


# --- Landslide rainfall trigger (early WATCH before the slope moves) ----
#
# A tilt sensor only reports a landslide once the ground is already
# moving. Rainfall is what triggers most Himalayan shallow landslides, and
# the backend already keeps a per-node rain log, so the rain side can raise
# a WATCH (MEDIUM) hours before tilt does.
#
# Threshold: the rainfall intensity-duration (I-D) threshold of
#   Caine, N. (1980). The rainfall intensity-duration control of shallow
#   landslides and debris flows. Geografiska Annaler: Series A, Physical
#   Geography 62(1-2), 23-27. doi:10.1080/04353676.1980.11879996
#     I = 14.82 * D^-0.39     I = mean intensity (mm/h), D = duration (h)
# The secondary sources quote its valid duration range differently (10 min
# to 10 days, or 0.167-500 h); the narrower one is used below, and every
# window checked here (1-24 h) is inside both.
# VERIFICATION STATUS: the paper itself is paywalled and was NOT read when
# this was written (2026-10-08). The constants were checked against three
# independent sources that reproduce it, which agree: Natural Resources
# Canada climate-change project report 72 (table "Caine (1980)": 14.8 mm/h
# at 1 h, 7.4 at 6 h, 4.3 at 24 h - all reproduced by the formula below),
# arXiv:1312.4179 ("I = 14.82 D^-0.39, 0.167 < D < 500"), and an SNET El
# Salvador report. Re-check them against the paper before field use.
#
# It is a GLOBAL lower envelope (Caine fitted it to ~73 events worldwide),
# NOT calibrated for Kumaon or any Indian slope. Regional Himalayan
# thresholds are generally different, which is why every node can carry its
# own alpha/beta (landslide_rain_alpha / landslide_rain_beta in the node
# registry, from a published regional study or local records).
CAINE_1980_ALPHA_MM_HR = 14.82
CAINE_1980_BETA = 0.39
CAINE_1980_MIN_DURATION_H = 1 / 6  # 10 minutes
CAINE_1980_MAX_DURATION_H = 240.0  # 10 days
# Durations the threshold is checked at. Caine's D is the duration of the
# rain EVENT; the backend only has trailing windows, so each window's mean
# intensity is tested against the threshold for that window's length and
# the worst one counts. A window that includes dry hours UNDER-states the
# event's intensity, so this errs late, never early. Several windows are
# needed: 60 mm over 6 h (10 mm/h) is above Caine's 6 h threshold (7.4
# mm/h) but below both the 1 h (14.8) and the 24 h (4.3 mm/h = 103 mm)
# ones, so a 1 h + 24 h check alone would miss it.
LANDSLIDE_RAIN_WINDOWS_HOURS = (1, 3, 6, 12, 24)
# Antecedent wetness: the same storm is far more dangerous on a slope that
# is already wet. These two numbers are THIS PROJECT'S CHOICE, not from
# Caine: at soil_saturation >= 0.8 the WATCH fires at half the I-D
# threshold. soil_saturation is the capacitive sensor when fitted, else
# the backend's rainfall-decay proxy (backend_server.derive_features).
# The proxy is filled by the very rain being tested, so the last 24 h of
# rain is taken back out of it first (see assess_landslide_rain): without
# that, any ~50 mm storm made itself "antecedent saturated" and Caine's
# 24 h threshold dropped from ~103 mm to ~52 mm for every storm.
ANTECEDENT_SATURATED = 0.8
ANTECEDENT_THRESHOLD_FRACTION = 0.5
# How much the rainfall proxy rises per mm of rain. backend_server uses
# this same constant (SOIL_SATURATION_PER_MM), so removing a storm's rain
# here undoes exactly what derive_features added for it.
PROXY_SATURATION_PER_MM = 0.01
# A window only TRIGGERS once at least this many separate rain reports
# fell in it (see assess_landslide_rain).
RAIN_TRIGGER_MIN_REPORTS = 2
# Ground movement that CONFIRMS a rain trigger. The same 5 degrees the
# node's own local alarm uses (LOCAL_TILT_LIMIT_DEG in the node firmware
# config.h), so the node and the backend agree on what "moved" means.
# Vibration alone never confirms: heavy rain, wind and traffic shake a
# pole too.
LANDSLIDE_TILT_CONFIRM_DEG = 5.0
# A rain-only trigger stays MEDIUM (WATCH), with risk_score held inside
# severity_band()'s MEDIUM range so the alert text agrees: no ground has
# moved yet, so it must never reach HIGH ("evacuate") on rain alone.
RAIN_ONLY_MAX_RISK = 0.69
# Rain + confirming tilt is at least HIGH (just above severity_band's 0.7).
RAIN_AND_TILT_MIN_RISK = 0.71


def caine_threshold_mm_hr(duration_h: float, alpha: float = CAINE_1980_ALPHA_MM_HR,
                          beta: float = CAINE_1980_BETA) -> float:
    """Mean intensity (mm/h) above which a rain event of `duration_h`
    hours can trigger shallow landslides: I = alpha * D^-beta."""
    return alpha * duration_h ** -beta


def _rain_windows_mm(reading: dict) -> dict:
    """{window hours: mm fallen in it}. derive_features() supplies
    rainfall_windows_mm; a caller that only has the older 1 h / 24 h
    fields (the what-if tool, tests) still gets those two checked."""
    windows = reading.get("rainfall_windows_mm")
    if windows:
        return {float(h): mm for h, mm in windows.items() if mm is not None}
    fallback = {}
    if reading.get("rainfall_intensity_mm_hr") is not None:
        fallback[1.0] = reading["rainfall_intensity_mm_hr"]  # mm in the last hour
    if reading.get("rainfall_24h_mm") is not None:
        fallback[24.0] = reading["rainfall_24h_mm"]
    return fallback


def assess_landslide_rain(reading: dict):
    """The rain side of classify_landslide(). Returns None only when the
    reading carries no rain keys at all (the what-if tool and tests can
    send such readings). Live readings always carry rainfall_windows_mm,
    because the firmware sends 0.0 rain when a node has no gauge, so a
    live slope node always gets a dict, and on a dry or gauge-less node
    it is exceedance 0.0 with window_hours None. The dict holds:
      triggered       - an eligible window reached the (antecedent-adjusted) threshold
      exceedance      - worst window's mean intensity / I-D threshold
      window_hours    - which window that was (None when no rain at all)
      trigger_exceedance - worst ELIGIBLE window's ratio (what "triggered" used)
      saturated       - antecedent soil saturation lowered the threshold
      threshold_source- "caine_1980_global" or "node_override"
    Note: the rain log behind rainfall_windows_mm is in memory, so a
    backend restart forgets the rain so far and the WATCH comes late
    until the log refills."""
    windows = _rain_windows_mm(reading)
    if not windows:
        return None
    counts = reading.get("rainfall_windows_count")
    if counts is not None:
        counts = {float(h): n for h, n in counts.items()}

    alpha = reading.get("landslide_rain_alpha")
    beta = reading.get("landslide_rain_beta")
    # A non-positive override can only be a data-entry error (NodeConfig
    # rejects it; this guards older rows) - fall back to the default
    # rather than divide by zero or never warn.
    if alpha is not None and alpha <= 0:
        alpha = None
    if beta is not None and beta < 0:
        beta = None
    source = "node_override" if alpha is not None or beta is not None else "caine_1980_global"
    alpha = CAINE_1980_ALPHA_MM_HR if alpha is None else alpha
    beta = CAINE_1980_BETA if beta is None else beta

    worst_ratio, worst_window = 0.0, None
    trigger_ratio = 0.0
    for hours, mm in sorted(windows.items()):
        if not CAINE_1980_MIN_DURATION_H <= hours <= CAINE_1980_MAX_DURATION_H:
            continue  # outside the range the curve was fitted on
        ratio = (max(0.0, mm) / hours) / caine_threshold_mm_hr(hours, alpha, beta)
        if ratio > worst_ratio:
            worst_ratio, worst_window = ratio, hours
        # A window holding a single rain report can be REPORTED (the
        # officer popup still shows how close the rain is) but cannot
        # TRIGGER: one tipping-bucket report cannot be told apart from a
        # chattering reed switch or a corrupted packet, and because the
        # window is cumulative, that one value would re-score MEDIUM on
        # every later dry reading for up to 24 h - which HazardConfirmer
        # would then count as "persistent" and publish. Real rain heavy
        # enough to pass Caine's threshold tips across consecutive
        # reports, so a real WATCH comes at most one report later.
        # Callers without counts (what-if tool, older tests) are not gated.
        if counts is not None and counts.get(hours, 0) < RAIN_TRIGGER_MIN_REPORTS:
            continue
        trigger_ratio = max(trigger_ratio, ratio)

    saturation = reading.get("soil_saturation")
    if saturation is not None and reading.get("soil_saturation_source") == "rainfall_proxy":
        # The proxy is filled by the same rain being tested, so remove the
        # longest window's rain to get the wetness from BEFORE this storm.
        # The windows are trailing and nested, so the largest value is the
        # 24 h total. Ignoring the proxy's decay removes slightly too much,
        # so this errs toward "not saturated" and never lets a storm count
        # as its own antecedent. A real soil sensor, or a reading that does
        # not say where its saturation came from, is used as it is.
        storm_mm = max((max(0.0, mm) for mm in windows.values()), default=0.0)
        saturation = max(0.0, saturation - storm_mm * PROXY_SATURATION_PER_MM)
    saturated = saturation is not None and saturation >= ANTECEDENT_SATURATED
    required = ANTECEDENT_THRESHOLD_FRACTION if saturated else 1.0
    return {
        "triggered": trigger_ratio >= required,
        "exceedance": round(worst_ratio, 3),
        "window_hours": worst_window,
        "trigger_exceedance": round(trigger_ratio, 3),
        "saturated": saturated,
        "required": required,
        "threshold_source": source,
    }


def classify_landslide(reading: dict):
    """Landslide, from two independent signals:

    1. Ground movement - an MPU6050 tilt/vibration sensor (tilt_angle_deg,
       vibration_magnitude). A sustained tilt deviation from the node's
       installed baseline, especially with vibration, is a standard
       landslide-monitoring signal. The tilt-only score below is unchanged
       from before; its thresholds are conservative starting points to
       calibrate once real MPU6050 data is available.
    2. Rainfall - the Caine (1980) intensity-duration threshold (see the
       constants above), checked on the node's own rain log. Rain alone
       gives at most MEDIUM (a WATCH: the slope has not moved yet). Rain
       on already-saturated soil fires at a lower threshold. Rain WITH
       tilt past LANDSLIDE_TILT_CONFIRM_DEG is at least HIGH.

    "trigger" says which signal raised it: "rain", "tilt", "both", or None
    when the result is LOW. The rain side only runs on a node that is on a
    slope: one reporting tilt, or one with a per-node threshold set in the
    registry (landslide_rain_alpha/beta) - so a rain gauge on a river-plain
    flood node never raises a landslide WATCH. A node with neither gets no
    landslide result at all, exactly as before."""
    tilt = reading.get("tilt_angle_deg")
    vibration = reading.get("vibration_magnitude")
    slope_node = (
        tilt is not None
        or reading.get("landslide_rain_alpha") is not None
        or reading.get("landslide_rain_beta") is not None
    )
    if not slope_node:
        return None

    tilt_risk = None
    if tilt is not None:
        tilt_component = min(1.0, abs(tilt) / 15.0)  # 15 degrees treated as a severe tilt
        vibration_component = min(1.0, (vibration or 0) / 2.0)  # 2.0 g treated as severe
        # Weighted toward tilt (the more specific landslide signal) - vibration
        # alone could just be wind/traffic, not ground movement.
        tilt_risk = 0.7 * tilt_component + 0.3 * vibration_component

    rain = assess_landslide_rain(reading)
    rain_triggered = bool(rain and rain["triggered"])
    tilt_confirms = tilt is not None and abs(tilt) >= LANDSLIDE_TILT_CONFIRM_DEG

    if rain_triggered and tilt_confirms:
        # Rain above the threshold AND the ground has moved: the rain
        # trigger is confirmed, so at least HIGH; a tilt score that is
        # already CRITICAL on its own stays CRITICAL.
        risk_score = max(tilt_risk, RAIN_AND_TILT_MIN_RISK)
        trigger = "both"
    elif rain_triggered:
        # How far past the threshold, scaled across the MEDIUM band; a
        # saturated slope sits higher in it. Capped below HIGH - see
        # RAIN_ONLY_MAX_RISK.
        over = min(1.0, rain["trigger_exceedance"] / rain["required"] - 1.0)
        rain_risk = min(RAIN_ONLY_MAX_RISK, 0.41 + 0.2 * over + (0.05 if rain["saturated"] else 0.0))
        risk_score = max(tilt_risk or 0.0, rain_risk)
        # Tilt short of the confirm angle can still score MEDIUM on its
        # own (strong vibration); then both signals are elevated.
        trigger = "both" if tilt_risk is not None and severity_band(tilt_risk) != "LOW" else "rain"
    else:
        risk_score = tilt_risk or 0.0
        trigger = "tilt" if tilt_risk is not None and severity_band(tilt_risk) != "LOW" else None

    risk_score = round(risk_score, 4)
    result = {
        "hazard_type": "landslide",
        "risk_score": risk_score,
        "severity": severity_band(risk_score),
        "trigger": trigger,
    }
    if rain is not None:
        # For the officer popup: how close the rain is to the threshold
        # even while it is still LOW. Always present on a LIVE slope node,
        # even one with no rain gauge (derive_features always fills the
        # windows); rain_window_hours None (exceedance 0.0) means "no rain
        # in the last 24 h, or no gauge", so a UI should hide the rain line
        # then rather than show "0% of the threshold".
        result["rain_exceedance"] = rain["exceedance"]
        result["rain_window_hours"] = rain["window_hours"]
        result["rain_threshold_source"] = rain["threshold_source"]
        result["antecedent_saturated"] = rain["saturated"]
    return result


# CPCB National Air Quality Index health breakpoints, 24-hour average,
# ug/m3 - from CPCB's "About National Air Quality Index" table
# (cpcb.gov.in > National Air Quality Index > About NAQI, checked
# 2026-10-08) and the same table in CPCB's NAQI report (Oct 2014):
#
#   category             PM2.5     PM10
#   Good                 0-30      0-50
#   Satisfactory         31-60     51-100
#   Moderately polluted  61-90     101-250
#   Poor                 91-120    251-350
#   Very Poor            121-250   351-430
#   Severe               250+      430+
#
# Folded onto this system's bands on the 60/120 PM2.5 edges this module
# always used: Good/Satisfactory = LOW, Moderately polluted/Poor =
# MEDIUM, Very Poor = HIGH, Severe = CRITICAL. (The old interpolation
# drifted into HIGH at ~111 and CRITICAL at ~240, mid-category; the
# band edges now sit exactly on CPCB's.) Each tuple is the TOP of the LOW, MEDIUM and
# HIGH bands; anything above the last is Severe. CPCB writes the ranges
# as integers, so a value counts as the next category once it is ABOVE a
# band's top (60.5 PM2.5 is Moderately polluted, 430 PM10 is still Very
# Poor). CPCB defines these on 24-h averages; a node sends one
# instantaneous reading, so a single spike reads worse than CPCB would
# rate the day - accepted here, since an early warning should err that way.
PM25_BAND_TOPS = (60, 120, 250)
PM10_BAND_TOPS = (100, 350, 430)


def _pm_band(value: float, band_tops: tuple):
    """(severity, risk_score) for one pollutant. Severity comes straight
    from the CPCB breakpoint comparisons, not from severity_band(risk) -
    the interpolated float (0.4 + 0.3 = 0.7000000000000001) would
    otherwise tip a reading sitting exactly on a band top into the next
    band. risk_score still lands in the matching severity_band() range
    so it reads consistently on the dashboard and breaks ties fairly."""
    low_top, medium_top, high_top = band_tops
    value = max(0.0, value)
    # The max(0.x001, ...) floors: classify_air_pollution() rounds the
    # score to 4 dp, which would put a fractional value just above a band
    # top (60.004 ug/m3) exactly on 0.4/0.7/0.9 - and severity_band() uses
    # strict '>', so it would read that as the band BELOW and the alert
    # text would disagree with the severity. 0.0001 survives the rounding.
    # Scores still never fall as concentration rises, and a value exactly
    # on a band top still scores 0.4/0.7/0.9 and stays in its own band.
    if value <= low_top:
        return "LOW", value / low_top * 0.4
    if value <= medium_top:
        return "MEDIUM", max(0.4001, 0.4 + (value - low_top) / (medium_top - low_top) * 0.3)
    if value <= high_top:
        return "HIGH", max(0.7001, 0.7 + (value - medium_top) / (high_top - medium_top) * 0.2)
    # CPCB's table is open-ended above Severe; reaching 1.0 at twice the
    # Severe threshold is this project's choice, not a CPCB figure.
    return "CRITICAL", max(0.9001, 0.9 + min(0.1, (value - high_top) / high_top * 0.1))


def classify_air_pollution(reading: dict):
    """Air pollution - requires a PM2.5/PM10 sensor (pm25_ugm3,
    pm10_ugm3 in reading). Each pollutant is banded on its own CPCB NAQI
    breakpoints (PM25_BAND_TOPS / PM10_BAND_TOPS above) and the WORSE of
    the two is the hazard - the same rule CPCB uses, where the worst
    sub-index sets the AQI. PM10 matters on its own: dust storms and
    construction push coarse dust up with little PM2.5, so a PM2.5-only
    check would rate a 500 ug/m3 PM10 day as clean air. Either value may
    be missing (a node sends what it has); with neither there is nothing
    to classify."""
    results = []
    for field, label, band_tops in (
        ("pm25_ugm3", "PM2.5", PM25_BAND_TOPS),
        ("pm10_ugm3", "PM10", PM10_BAND_TOPS),
    ):
        value = reading.get(field)
        if value is not None:
            severity, risk_score = _pm_band(value, band_tops)
            results.append((severity, round(risk_score, 4), label))
    if not results:
        return None

    severity_rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}
    # Same ordering process_reading() uses to pick the primary hazard:
    # severity first, risk_score as the tie-break.
    severity, risk_score, pollutant = max(results, key=lambda r: (severity_rank[r[0]], r[1]))

    return {
        "hazard_type": "air pollution",
        "risk_score": risk_score,
        "severity": severity,
        # Which of the two set the severity (the NAQI report's
        # "responsible pollutant"), so an officer knows dust vs smoke.
        "responsible_pollutant": pollutant,
    }


def classify_water_quality(reading: dict):
    """Water quality degradation - requires a pH/turbidity sensor
    (water_ph, turbidity_ntu in reading). Safe drinking-water pH range
    is 6.5-8.5 (WHO guideline); turbidity above 5 NTU is WHO's guideline
    threshold for water that should be treated as unsafe without further
    treatment. Both are real external standards, not arbitrary."""
    ph = reading.get("water_ph")
    turbidity = reading.get("turbidity_ntu")
    if ph is None and turbidity is None:
        return None

    ph_risk = 0.0
    if ph is not None:
        if ph < 6.5:
            ph_risk = min(1.0, (6.5 - ph) / 2.0)
        elif ph > 8.5:
            ph_risk = min(1.0, (ph - 8.5) / 2.0)

    turbidity_risk = 0.0
    if turbidity is not None:
        turbidity_risk = min(1.0, turbidity / 20.0)  # 20 NTU treated as severe

    risk_score = max(ph_risk, turbidity_risk)  # either factor alone can indicate unsafe water

    return {
        "hazard_type": "water quality degradation",
        "risk_score": round(risk_score, 4),
        "severity": severity_band(risk_score),
    }


# --- Flash flood: the river rising FAST ---------------------------------
#
# The flood model (integration_pipeline) scores how HIGH the water is and
# how wet the catchment is. A flash flood is about SPEED: a river that is
# still low but rising a few cm a minute leaves people on the bank minutes,
# not hours, and needs different advice ("move away from the river now").
# So it is its own hazard_type, "flash_flood", scored from the rate of rise
# alone - two measurements of it, whichever is faster:
#   - the backend's least-squares rate over RATE_WINDOW_MINUTES of
#     median-smoothed levels (backend_server.rate_per_hour), and
#   - the node's own rate (rise_rate_cm_per_min, sent with fast_rise),
#     taken from every raw sample - it sees a rise between two reports.
#
# THRESHOLDS ARE CONFIGURABLE DEMO DEFAULTS chosen for this project, not a
# published standard: no rate-of-rise warning threshold for Indian rivers
# was found to cite. A river's normal monsoon rise rate differs a lot from
# site to site, so calibrate them per river from the node's own history
# before field use. 1 cm/min = 0.6 m/h.
FLASH_FLOOD_MEDIUM_RATE_M_PER_HR = _env_float("SANJEEVNI_FLASH_FLOOD_MEDIUM_M_PER_HR", 0.6)  # 1 cm/min
FLASH_FLOOD_HIGH_RATE_M_PER_HR = _env_float("SANJEEVNI_FLASH_FLOOD_HIGH_M_PER_HR", 1.2)  # 2 cm/min
FLASH_FLOOD_CRITICAL_RATE_M_PER_HR = _env_float("SANJEEVNI_FLASH_FLOOD_CRITICAL_M_PER_HR", 3.0)  # 5 cm/min
# Bench mode (integration_pipeline.HARDWARE_TEST_MODE, off by default): the
# tabletop rig is a few cm tall, so a river-scale rate is never reached.
# The same three levels become fractions of the rig's mount height filled
# per MINUTE, the way the bench flood override uses fractions of it.
FLASH_FLOOD_BENCH_FRACTIONS_PER_MIN = (0.10, 0.20, 0.50)
CM_PER_MIN_TO_M_PER_HR = 0.6
# What corroborates a fast rise: the same evidence integration_pipeline's
# is_flood_signature() uses (it imports these two from here).
FLOOD_SIGNATURE_RATE_M_PER_HR = 0.2
FLOOD_SIGNATURE_RAIN_MM_HR = 5.0
# Node anomaly checks (edge_anomaly "<check>:river_level_m") that make the
# NODE's rate untrustworthy: a stuck or dropped-out sensor, a rate the
# node itself calls physically impossible, or a spike - the node's rate
# is computed from that very sample, so a misreading (an ultrasonic echo
# off heavy rain, a common real failure) becomes a "fast rise". This
# matches integration_pipeline.EDGE_RIVER_HOLD_CHECKS (plus "dropout",
# which makes the node's RATE meaningless even though the one value that
# arrived is still a measurement).
# Cost: the first samples of a real flash flood are a step the spike
# check may flag; for those samples only the backend's rate (from
# median-smoothed levels) counts. Once the level stays up the spike check
# stops firing and the node's rate counts again.
NODE_RATE_DISTRUST_CHECKS = ("stuck", "dropout", "rate", "spike")


def flash_flood_thresholds(bench_mount_m=None) -> tuple:
    """(MEDIUM, HIGH, CRITICAL) rise rates in m/h. bench_mount_m: the bench
    rig's mount height when bench mode applies to this reading, else None."""
    if bench_mount_m:
        return tuple(f * bench_mount_m * 60 for f in FLASH_FLOOD_BENCH_FRACTIONS_PER_MIN)
    return (FLASH_FLOOD_MEDIUM_RATE_M_PER_HR, FLASH_FLOOD_HIGH_RATE_M_PER_HR,
            FLASH_FLOOD_CRITICAL_RATE_M_PER_HR)


def edge_flags_field(reading: dict, field: str, checks=None) -> bool:
    """True when the node's own anomaly checks flagged `field` (optionally
    only with one of `checks`)."""
    for item in reading.get("edge_anomaly") or ():
        check, _, flagged = str(item).partition(":")
        if flagged == field and (checks is None or check in checks):
            return True
    return False


def _in_band(value: float, low: float, high: float, floor: float, span: float) -> float:
    """floor .. floor+span as value goes low .. high (clamped)."""
    frac = 1.0 if high <= low else min(1.0, max(0.0, (value - low) / (high - low)))
    return floor + span * frac


def classify_flash_flood(reading: dict, bench_mount_m=None):
    """Flash flood from the river's rate of rise (see the constants above).
      MEDIUM   rate >= MEDIUM threshold, or the node's fast_rise flag alone
               (its own check fired but sent no usable rate)
      HIGH     rate >= HIGH threshold
      CRITICAL rate >= CRITICAL threshold AND corroborated by heavy rain or
               a rising upstream node AND the backend's own rate is at
               least the HIGH threshold. Otherwise it stays HIGH: CRITICAL
               is what sounds the village siren automatically, so it needs
               a second, independent sign, and it must not rest on the
               node's rate alone - rain is exactly when an ultrasonic
               sensor misreads, so "node says fast + it is raining" is
               not two independent signs while the backend's
               median-smoothed levels show a flat river. In bench mode
               the rain / upstream corroboration is waived (a tabletop rig
               has neither; bench mode exists to demo the alert chain and
               is never for field use), the backend-rate rule is not.
    risk_score sits inside severity_band()'s range for that severity.
    None when the node has no water level (no sensor, or a faulty one -
    then the node's rate is meaningless too)."""
    if reading.get("river_level_m") is None:
        return None
    medium, high, critical = flash_flood_thresholds(bench_mount_m)

    node_trusted = not edge_flags_field(reading, "river_level_m", NODE_RATE_DISTRUST_CHECKS)
    rates = {}
    if reading.get("river_level_rate_m_per_hr") is not None:
        rates["backend"] = reading["river_level_rate_m_per_hr"]
    if node_trusted and reading.get("node_rise_rate_m_per_hr") is not None:
        rates["node"] = reading["node_rise_rate_m_per_hr"]
    node_flag = bool(reading.get("fast_rise")) and node_trusted
    rate = max([0.0, *rates.values()])
    fast = [name for name, r in rates.items() if r >= medium]
    source = "both" if len(fast) == 2 else (fast[0] if fast else ("node_flag" if node_flag else None))

    corroborated = (
        (reading.get("rainfall_intensity_mm_hr") or 0) >= FLOOD_SIGNATURE_RAIN_MM_HR
        or (reading.get("upstream_rate_m_per_hr") or 0) >= FLOOD_SIGNATURE_RATE_M_PER_HR
    )
    backend_confirms = rates.get("backend", 0.0) >= high
    if rate >= critical:
        if (corroborated or bench_mount_m) and backend_confirms:
            risk_score = 0.91 + 0.08 * min(1.0, (rate - critical) / critical)
        else:
            risk_score = 0.89  # top of HIGH - see the docstring
    elif rate >= high:
        risk_score = _in_band(rate, high, critical, 0.71, 0.18)
    elif rate >= medium:
        risk_score = _in_band(rate, medium, high, 0.41, 0.28)
    elif node_flag:
        risk_score = 0.41
    else:
        risk_score = 0.0

    risk_score = round(risk_score, 4)
    return {
        "hazard_type": "flash_flood",
        "risk_score": risk_score,
        "severity": severity_band(risk_score),
        # For the alert text, the ETA and the officer popup.
        "rise_rate_m_per_hr": round(rate, 4),
        "rise_rate_source": source,  # "backend" / "node" / "both" / "node_flag" / None
        "corroborated": corroborated,
    }


# --- Smoke: PM2.5 and gas rising TOGETHER, fast -------------------------
#
# Burning (a building, a vehicle, a forest edge, a waste dump) puts fine
# particles AND combustion gases into the air at the same moment, and both
# climb within minutes. Ordinary urban pollution builds up over hours and
# moves PM2.5 without a matching MQ135 jump. So smoke is told apart by
# SPEED and AGREEMENT, not by level: both must rise by at least a set
# amount inside SHORT_TREND_WINDOW_MINUTES. The PM2.5 LEVEL is still graded
# by classify_air_pollution (CPCB bands) as before; "smoke" is a separate
# hazard_type that says "something is burning nearby".
# A temperature rise or a humidity drop over the same window supports it
# (hot, dry smoke plume); a flame reading supports it too, but is not
# needed - most smoke reaches a sensor long before any flame is in view.
#
# THRESHOLDS ARE CONFIGURABLE DEMO DEFAULTS chosen for this project, not
# from a published standard. The MQ135 reading is an uncalibrated "ppm"
# (see the firmware), so the gas rise in particular must be tuned on the
# real sensor. The PM2.5 floor is CPCB's top of "Satisfactory" (60 ug/m3,
# PM25_BAND_TOPS), so a tiny rise in clean air does not count.
SHORT_TREND_WINDOW_MINUTES = 10
SHORT_TREND_FIELDS = ("pm25_ugm3", "gas_ppm", "temp_c", "humidity_pct")
# The "now" level is the median of this many latest samples, so one spiked
# sample is outvoted by the two around it and can never raise smoke alone.
SHORT_TREND_RECENT_SAMPLES = 3
SMOKE_PM25_RISE_UGM3 = _env_float("SANJEEVNI_SMOKE_PM25_RISE_UGM3", 30.0)
SMOKE_GAS_RISE_PPM = _env_float("SANJEEVNI_SMOKE_GAS_RISE_PPM", 100.0)
SMOKE_TEMP_RISE_C = 1.0
SMOKE_RH_FALL_PCT = 5.0
SMOKE_MIN_PM25_UGM3 = PM25_BAND_TOPS[0]
# How much a smoke detection adds to a flame-sensor fire score.
SMOKE_FIRE_SUPPORT = 0.1
# Top of severity_band()'s HIGH range: smoke alone never reaches CRITICAL.
SMOKE_MAX_RISK = 0.89


def short_window_trend(prior_values: list, current, summary_stats=None):
    """How one sensor moved over the short window, robust to one bad sample.

    prior_values: this node's earlier values of the field inside the last
        SHORT_TREND_WINDOW_MINUTES, oldest first (gaps already removed).
    current: this reading's value.
    summary_stats: this reading's summary block for the field
        ({"min", "max", "mean"}) when the node sent one whose window_s fits
        inside SHORT_TREND_WINDOW_MINUTES (the caller checks that).
        The min is the lowest sample, not the window's first one, so on a
        noisy sensor the rise reads high by up to about the noise
        amplitude; the SMOKE_* rise thresholds are well above the noise
        the tests model, and smoke needs PM2.5 AND gas to clear them.

    recent   = median of the last SHORT_TREND_RECENT_SAMPLES values (+ the
               summary mean, which is itself an average of many samples)
    baseline = median of the older values in the window. With no older
               value in the window (a node reporting every few minutes) the
               summary min / max is used instead: that is where the window
               of samples behind this report started from.
    Returns {"recent", "rise", "fall", "baseline_source"} - rise = recent -
    baseline (low side), fall = baseline (high side) - recent - or None
    when there is too little evidence (one sample, or no baseline)."""
    if current is None:
        return None
    prior = [v for v in prior_values if v is not None]
    keep = SHORT_TREND_RECENT_SAMPLES - 1
    recent = prior[-keep:] + [current]
    older = prior[:-keep] if len(prior) > keep else []
    if summary_stats:
        recent.append(summary_stats["mean"])
    if len(recent) < 2:
        return None
    if older:
        low = high = statistics.median(older)
        source = "history"
    elif summary_stats:
        low, high = summary_stats["min"], summary_stats["max"]
        source = "summary"
    else:
        return None
    level = statistics.median(recent)
    return {
        "recent": round(level, 3),
        "rise": round(level - low, 3),
        "fall": round(high - level, 3),
        "baseline_source": source,
    }


def smoke_evidence(reading: dict) -> dict:
    """{"assessable", "detected", ...} for the smoke check. Needs this
    reading's PM2.5 and gas values and their short_trends (filled by
    backend_server.derive_features); without them it is not assessable."""
    trends = reading.get("short_trends") or {}
    pm, gas = trends.get("pm25_ugm3"), trends.get("gas_ppm")
    if reading.get("pm25_ugm3") is None or reading.get("gas_ppm") is None or not pm or not gas:
        return {"assessable": False, "detected": False}
    support = []
    temp, rh = trends.get("temp_c"), trends.get("humidity_pct")
    if reading.get("temp_c") is not None and temp and temp["rise"] >= SMOKE_TEMP_RISE_C:
        support.append("temp_rising")
    if reading.get("humidity_pct") is not None and rh and rh["fall"] >= SMOKE_RH_FALL_PCT:
        support.append("humidity_falling")
    if (reading.get("flame_reading") or 0) >= FLAME_DETECT_THRESHOLD:
        support.append("flame")
    return {
        "assessable": True,
        "detected": (
            pm["rise"] >= SMOKE_PM25_RISE_UGM3
            and gas["rise"] >= SMOKE_GAS_RISE_PPM
            and pm["recent"] > SMOKE_MIN_PM25_UGM3
        ),
        "pm25_rise_ugm3": pm["rise"],
        "gas_rise_ppm": gas["rise"],
        "support": support,
    }


def classify_smoke(reading: dict):
    """Smoke (see the constants above). MEDIUM when PM2.5 and gas rise
    together; HIGH when a temperature rise, a humidity drop or a flame
    reading supports it, or when the PM2.5 level itself is CPCB "Very Poor"
    or worse. Never CRITICAL on its own: smoke says something
    is burning, not how close or how big - a flame-confirmed fire is
    scored by classify_fire_smoke. None when PM2.5 / gas or their recent
    history is missing."""
    evidence = smoke_evidence(reading)
    if not evidence["assessable"]:
        return None
    result = {
        "hazard_type": "smoke",
        "pm25_rise_ugm3": evidence["pm25_rise_ugm3"],
        "gas_rise_ppm": evidence["gas_rise_ppm"],
        "smoke_support": evidence["support"],
    }
    if not evidence["detected"]:
        return {**result, "risk_score": 0.0, "severity": "LOW"}
    # 0 at the threshold, 1 at four times it
    magnitude = min(1.0, max(0.0, (evidence["pm25_rise_ugm3"] / SMOKE_PM25_RISE_UGM3 - 1) / 3))
    if evidence["support"]:
        risk_score = 0.72 + 0.1 * magnitude + 0.03 * (len(evidence["support"]) - 1)  # <= 0.88, HIGH
    else:
        risk_score = 0.45 + 0.2 * magnitude  # <= 0.65, MEDIUM
    # Smoke is never rated LESS severe than the PM2.5 it is putting in the
    # air (CPCB band, as classify_air_pollution grades it) - otherwise a
    # "Very Poor" smoke plume would be reported as plain air pollution and
    # people would get the haze advice instead of "something is burning".
    # Still capped below CRITICAL (see the docstring).
    _, pm_risk = _pm_band(reading["pm25_ugm3"], PM25_BAND_TOPS)
    risk_score = round(max(risk_score, min(pm_risk, SMOKE_MAX_RISK)), 4)
    return {**result, "risk_score": risk_score, "severity": severity_band(risk_score)}


# --- Extreme weather: heavy rain and high wind (2026-10-09) ---------------
#
# Two inputs, kept apart because they are different kinds of evidence:
#   MEASURED - the node's own rain gauge: rainfall_24h_mm, the trailing
#              24 h sum of plausibility-checked rain reports
#              (backend_server.derive_features);
#   FORECAST - Open-Meteo's hourly forecast for the node's coordinates for
#              the next 24 h (backend_server.fetch_weather_forecast):
#              forecast_rainfall_24h_mm, forecast_wind_speed_max_kmh,
#              forecast_wind_gust_max_kmh. A weather MODEL, not an IMD
#              warning and not a SANJEEVNI measurement.
#
# A forecast-only result ("forecast_based": True, severity_source
# "weather_forecast") is never above HIGH - FORECAST_MAX_RISK keeps its
# risk_score inside severity_band()'s HIGH range - so it can never become
# a CRITICAL alert and auto-sound a village siren. Measured heavy rain is
# capped at HIGH too: rain is a weather condition, not the impact; the
# flood, flash-flood and landslide checks it feeds decide on evacuation.
#
# RAINFALL CATEGORIES - IMD, verified 2026-10-09 from:
#   IMD / RSMC New Delhi terminology,
#     https://rsmcnewdelhi.imd.gov.in/images/pdf/terminology.pdf
#     ("Heavy Rainfall: 24 hours cumulative rainfall at a station is
#     64.5-115.5 mm as recorded at 0830 hrs IST"; Very Heavy 115.6-204.4 mm;
#     Extremely Heavy "greater than 204.5 mm")
#   IMD National Bulletin No. 15, 11 Sep 2024, legend "Heavy rain: 64.5 -
#     115.5, Very heavy rain: 115.6 - 204.4, Extremely heavy rain: 204.5 or
#     more", https://rsmcnewdelhi.imd.gov.in/uploads/archive/1/
#     1_0cbf6a_15.National%20Bulletin%20No%2015-11th%20Sept2024_0830%20IST.pdf
# The two differ only at exactly 204.5 mm; the bulletin's ">= 204.5" is used.
# IMD's day is 0830-0830 IST at a station; SANJEEVNI uses a TRAILING 24 h
# window (gauge) or the next 24 forecast hours, so alerts say "in IMD's
# heavy-rain range", never "IMD recorded / warned heavy rain".
IMD_HEAVY_RAIN_24H_MM = 64.5
IMD_VERY_HEAVY_RAIN_24H_MM = 115.6
IMD_EXTREMELY_HEAVY_RAIN_24H_MM = 204.5
# Severity per IMD category (this project's choice): heavy -> MEDIUM,
# very heavy -> HIGH, extremely heavy -> HIGH at the top of the band.
FORECAST_MAX_RISK = 0.9       # highest risk_score that is still HIGH (CRITICAL is > 0.9)
HEAVY_RAIN_MAX_RISK = 0.9

# WIND - no node has an anemometer, so this is forecast-only.
#   Verified (IMD terminology PDF above, read 2026-10-09): "Gale force
#   wind: Average surface wind speed of 34 knots or more"; the same document
#   writes 34 knots as 62 kmph ("Cyclonic storm ... 34 to 47 knots (62 to
#   88 kmph)"). Open-Meteo's hourly wind_speed_10m is used as the "average
#   surface wind" (it is an hourly value, not a 10-minute mean - close, not
#   identical).
#   IMD's terminology gives NO gust threshold (a gust is only "instantaneous
#   peak value of surface wind speed"), so the two gust thresholds below
#   are DEMO DEFAULTS - VERIFY with IMD / the district authority before field
#   use. Open-Meteo's wind_gusts_10m is the maximum of the preceding hour,
#   in km/h (https://open-meteo.com/en/docs, read 2026-10-09).
IMD_GALE_FORCE_KMH = 62.0
WIND_GUST_MEDIUM_KMH = _env_float("SANJEEVNI_WIND_GUST_MEDIUM_KMH", 60.0)  # demo default - verify
WIND_GUST_HIGH_KMH = _env_float("SANJEEVNI_WIND_GUST_HIGH_KMH", 90.0)      # demo default - verify


_BAND_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def imd_rain_category(mm_24h):
    """None / "heavy" / "very_heavy" / "extremely_heavy" for a 24 h total."""
    if mm_24h is None:
        return None
    if mm_24h >= IMD_EXTREMELY_HEAVY_RAIN_24H_MM:
        return "extremely_heavy"
    if mm_24h >= IMD_VERY_HEAVY_RAIN_24H_MM:
        return "very_heavy"
    if mm_24h >= IMD_HEAVY_RAIN_24H_MM:
        return "heavy"
    return None


def _rain_risk(mm_24h, category) -> float:
    """Risk inside the category's severity band, rising a little with the
    amount: heavy 0.50-0.65 (MEDIUM), very heavy 0.78-0.85 (HIGH),
    extremely heavy 0.90 (HIGH). Below heavy: 0-0.4 (LOW) from half the
    heavy-rain line up to it."""
    if not mm_24h:
        return 0.0
    if category is None:
        half = IMD_HEAVY_RAIN_24H_MM / 2
        return round(max(0.0, min(0.4, (mm_24h - half) / half * 0.4)), 4)
    if category == "heavy":
        frac = (mm_24h - IMD_HEAVY_RAIN_24H_MM) / (IMD_VERY_HEAVY_RAIN_24H_MM - IMD_HEAVY_RAIN_24H_MM)
        return round(0.5 + 0.15 * min(1.0, frac), 4)
    if category == "very_heavy":
        frac = (mm_24h - IMD_VERY_HEAVY_RAIN_24H_MM) / (IMD_EXTREMELY_HEAVY_RAIN_24H_MM - IMD_VERY_HEAVY_RAIN_24H_MM)
        return round(0.78 + 0.07 * min(1.0, frac), 4)
    return 0.9


def _measured_rain_reports_24h(reading: dict):
    """How many separate rain reports make up the measured 24 h total, or
    None when the caller did not say (what-if tool, older tests)."""
    counts = reading.get("rainfall_windows_count")
    if not counts:
        return None
    return {float(h): n for h, n in counts.items()}.get(24.0)


def classify_heavy_rain(reading: dict):
    """Heavy rain from the node's gauge (trailing 24 h) and/or the next
    24 h of forecast, graded with IMD's rainfall categories (block comment
    above). None when there is no measured rain and no forecast.

    basis: "measured" / "forecast" / "both" / None (nothing elevated).
    severity_basis: which of them sets the severity - the gauge, unless
    the forecast is in a higher severity band.
    forecast_based: True when the forecast sets the severity (forecast
    alone, or a forecast above what the gauge measured) - such a result is
    capped at HIGH, has severity_source "weather_forecast", and is
    confirmed by its external source, not by nodes (hazard_confirmation).
    A measured total built from fewer than 2 rain reports (or of unknown
    count) is reported but
    cannot trigger (same rule and reason as the landslide rain WATCH,
    RAIN_TRIGGER_MIN_REPORTS): one corrupted tipping-bucket report would
    otherwise re-score itself on every reading for 24 h and "confirm"
    itself as persistent."""
    measured = reading.get("rainfall_24h_mm")
    forecast = reading.get("forecast_rainfall_24h_mm")
    if not measured and forecast is None:
        return None

    measured_cat = imd_rain_category(measured)
    reports = _measured_rain_reports_24h(reading)
    # Unlike the landslide WATCH, a total WITHOUT a report count cannot
    # trigger either: only derive_features' rain log supplies the count,
    # and callers without one (the demo readings, the what-if tool, tests)
    # use rainfall_24h_mm as a flood-model input, not as a gauge record.
    single_report = measured_cat is not None and (reports is None or reports < RAIN_TRIGGER_MIN_REPORTS)
    measured_risk = _rain_risk(measured, None if single_report else measured_cat)
    forecast_cat = imd_rain_category(forecast)
    forecast_risk = min(FORECAST_MAX_RISK, _rain_risk(forecast, forecast_cat))

    measured_elevated = severity_band(measured_risk) != "LOW"
    forecast_elevated = severity_band(forecast_risk) != "LOW"
    if measured_elevated and forecast_elevated:
        basis = "both"
    elif measured_elevated:
        basis = "measured"
    elif forecast_elevated:
        basis = "forecast"
    else:
        basis = None
    # Which input sets the severity. With both elevated, the GAUGE does,
    # unless the forecast is in a higher severity band - then the forecast
    # sets it and the whole result is forecast-based (2026-10-09 review):
    # before, a "heavy" gauge (MEDIUM) plus a "very heavy" forecast was a
    # HIGH labelled as measured, so it was confirmed by node repeats, got
    # CAP urgency "Immediate" / certainty "Observed" and lost the
    # forecast caveat. Now such a result has severity_source
    # "weather_forecast" (CAP certainty <= "Possible", urgency "Future"),
    # the forecast HIGH cap, and text saying the severity comes from the
    # forecast while the gauge measured less (basis stays "both").
    if basis == "both":
        severity_basis = ("forecast" if _BAND_RANK[severity_band(forecast_risk)]
                          > _BAND_RANK[severity_band(measured_risk)] else "measured")
    else:
        severity_basis = basis
    if severity_basis == "measured":
        risk_score = measured_risk
    elif severity_basis == "forecast":
        risk_score = forecast_risk
    else:  # nothing elevated - both LOW
        risk_score = max(measured_risk, forecast_risk)
    # Nothing elevated: "forecast-based" only when the gauge had nothing to
    # say, so a quiet node's own LOW reading is not labelled a forecast.
    forecast_based = severity_basis == "forecast" or (basis is None and not measured)
    risk_score = min(HEAVY_RAIN_MAX_RISK, risk_score)
    return {
        "hazard_type": "heavy_rain",
        "risk_score": round(risk_score, 4),
        "severity": severity_band(risk_score),
        "basis": basis,
        "severity_basis": severity_basis,  # "measured" / "forecast" / None
        "forecast_based": forecast_based,
        "severity_source": "weather_forecast" if forecast_based else "threshold_classifier",
        "measured_24h_mm": round(measured, 1) if measured is not None else None,
        "measured_category": measured_cat,
        "measured_gated": single_report,  # total shown, but too few reports to trigger
        "forecast_24h_mm": round(forecast, 1) if forecast is not None else None,
        "forecast_category": forecast_cat,
        "forecast_source": reading.get("forecast_source") if forecast is not None else None,
    }


def classify_high_wind(reading: dict):
    """High wind from the 24 h forecast only (no node has an anemometer):
    HIGH at IMD gale force (forecast wind >= 62 km/h, verified) or a gust
    >= WIND_GUST_HIGH_KMH; MEDIUM at a gust >= WIND_GUST_MEDIUM_KMH (the
    gust thresholds are demo defaults). Always forecast_based, so never
    above HIGH. None when the forecast has no wind values."""
    gust = reading.get("forecast_wind_gust_max_kmh")
    speed = reading.get("forecast_wind_speed_max_kmh")
    if gust is None and speed is None:
        return None

    wind_trigger = None
    if speed is not None and speed >= IMD_GALE_FORCE_KMH:
        risk_score = 0.78 + 0.12 * min(1.0, (speed - IMD_GALE_FORCE_KMH) / IMD_GALE_FORCE_KMH)
        wind_trigger = "gale_force_wind"
    elif gust is not None and gust >= WIND_GUST_HIGH_KMH:
        risk_score = 0.75 + 0.1 * min(1.0, (gust - WIND_GUST_HIGH_KMH) / WIND_GUST_HIGH_KMH)
        wind_trigger = "gust"
    elif gust is not None and gust >= WIND_GUST_MEDIUM_KMH:
        frac = (gust - WIND_GUST_MEDIUM_KMH) / max(1e-6, WIND_GUST_HIGH_KMH - WIND_GUST_MEDIUM_KMH)
        risk_score = 0.5 + 0.15 * min(1.0, frac)
        wind_trigger = "gust"
    elif gust is not None:
        half = WIND_GUST_MEDIUM_KMH / 2
        risk_score = max(0.0, min(0.4, (gust - half) / half * 0.4))
    else:
        risk_score = 0.0
    risk_score = min(FORECAST_MAX_RISK, risk_score)
    return {
        "hazard_type": "high_wind",
        "risk_score": round(risk_score, 4),
        "severity": severity_band(risk_score),
        "wind_trigger": wind_trigger,
        "forecast_based": True,
        "severity_source": "weather_forecast",
        "forecast_wind_speed_max_kmh": round(speed, 1) if speed is not None else None,
        "forecast_wind_gust_max_kmh": round(gust, 1) if gust is not None else None,
        "forecast_source": reading.get("forecast_source"),
    }


ALL_CLASSIFIERS = [
    classify_fire_smoke,
    classify_smoke,
    classify_extreme_heat,
    classify_landslide,
    classify_air_pollution,
    classify_water_quality,
    classify_heavy_rain,
    classify_high_wind,
]


def classify_all_hazards(reading: dict, bench_mount_m=None) -> dict:
    """Runs every applicable classifier (skipping ones whose sensor data
    isn't present) and returns {hazard_type: {risk_score, severity}, ...}
    for all of them - the full multi-hazard picture, not just the
    winner. A classifier's extra detail (air pollution's
    responsible_pollutant) rides along unchanged.

    bench_mount_m: the bench rig's mount height when bench mode applies to
    this reading (integration_pipeline decides), else None - only the
    flash-flood rate thresholds depend on it."""
    results = {}
    for classifier in ALL_CLASSIFIERS:
        result = classifier(reading)
        if result is not None:
            results[result["hazard_type"]] = {k: v for k, v in result.items() if k != "hazard_type"}
    flash = classify_flash_flood(reading, bench_mount_m)
    if flash is not None:
        results["flash_flood"] = {k: v for k, v in flash.items() if k != "hazard_type"}
    return results
