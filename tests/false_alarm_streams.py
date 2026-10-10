"""
SANJEEVNI - deterministic synthetic streams for measuring false alarms
(backend lane, step B1, 2026-10-09).

Not a test file (no "test" prefix, so `unittest discover` skips it): it
holds the stream generators and the replay used by
tests/test_false_alarms.py, and prints the measured rates when run:

    venv\\Scripts\\python.exe tests\\false_alarm_streams.py

Every stream is SYNTHETIC. The NORMAL readings copy the value ranges of
tools/loadtest/ingest_load.js makeReading() (the stream that showed ~8-10 %
"sensor_fault" suppressions in the round-3 load test) with the same seeded
PRNG (mulberry32), one PRNG per node so the stream does not depend on the
order nodes are replayed in. It is the same DISTRIBUTION as the load test,
not the byte-identical request sequence (the load test interleaves nodes
and backlog draws).

The replay feeds each reading through backend_server.process_raw_reading
(derive_features -> process_reading -> HazardConfirmer -> SQLite) exactly
as /api/ingest does, against a throwaway database, with the network
stubbed out and the trained models from var/models.
"""

import collections
import os

# One OpenMP thread, as the judge demo and the load test run the backend:
# the flood model's per-reading predict is several times slower with the
# default thread pool on a small batch. Only applies if set before sklearn
# is first imported.
os.environ.setdefault("OMP_NUM_THREADS", "1")

import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import backend_server as bs  # noqa: E402
from test_pipeline_integrity import HAVE_MODELS, _load_models, _offline  # noqa: E402

ELEVATED = ("MEDIUM", "HIGH", "CRITICAL")
T_START = datetime(2026, 10, 9, 6, 0, tzinfo=timezone.utc)


def mulberry32(seed: int):
    """Port of ingest_load.js rng(): same seed -> same numbers."""
    state = [seed & 0xFFFFFFFF]

    def rand() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rand


def node_id(i: int) -> str:
    return f"LT-{i + 1:04d}"


def normal_reading(n: int, rand, river_noise_m: float) -> dict:
    """ingest_load.js makeReading() for node number n (1-based). river
    noise: +-river_noise_m/2 uniform (the load test uses 0.004 = +-2 mm;
    the round-3 trial run used 0.02 = +-1 cm)."""
    r = {
        "node_id": f"LT-{n:04d}",
        "simulated": True,
        "river_level_m": round(1.2 + (n % 7) * 0.1 + (rand() - 0.5) * river_noise_m, 3),
        "temp_c": round(25 + rand() * 8, 2),
        "humidity_pct": round(45 + rand() * 30, 2),
        "gas_ppm": round(380 + rand() * 40, 1),
        "flame_reading": round(rand() * 0.05, 3),
        "rainfall_mm_since_last": 0,
        "battery_pct": round(60 + (n % 35), 1),
    }
    if n % 4 == 0:
        r["pm25_ugm3"] = round(25 + rand() * 30)
        r["pm10_ugm3"] = round(50 + rand() * 40)
    if n % 3 == 0:
        r["soil_moisture_pct"] = round(30 + rand() * 20, 1)
    return r


def hot_dry_reading(n: int, rand) -> dict:
    """A hot, dry pre-monsoon afternoon on a low river - SYNTHETIC ranges
    picked as ordinary plains conditions (34-39.5 C stays under IMD's 40 C
    heat-wave consideration level, so nothing here is a hazard), not
    measured data."""
    return {
        "node_id": f"LT-{n:04d}",
        "simulated": True,
        "river_level_m": round(0.4 + (n % 7) * 0.1 + (rand() - 0.5) * 0.02, 3),
        "temp_c": round(34 + rand() * 5.5, 2),
        "humidity_pct": round(15 + rand() * 15, 2),
        "gas_ppm": round(380 + rand() * 40, 1),
        "flame_reading": 0.0,  # what the firmware sends with no flame
        "rainfall_mm_since_last": 0,
        "battery_pct": 80.0,
    }


def stream(kind: str, nodes: int, per_node: int, seed: int = 7) -> dict:
    """{node_id: [reading, ...]} - kind: 'loadtest' (+-2 mm river),
    'noisy_river' (+-1 cm), 'hot_dry'."""
    out = {}
    for i in range(nodes):
        rand = mulberry32(seed * 100_003 + i)
        n = i + 1
        if kind == "loadtest":
            out[node_id(i)] = [normal_reading(n, rand, 0.004) for _ in range(per_node)]
        elif kind == "noisy_river":
            out[node_id(i)] = [normal_reading(n, rand, 0.02) for _ in range(per_node)]
        elif kind == "hot_dry":
            out[node_id(i)] = [hot_dry_reading(n, rand) for _ in range(per_node)]
        else:
            raise ValueError(kind)
    return out


# --- injected faults (true positives) ---------------------------------------
# The four kinds anomaly_detection.generate_sensor_stream trains on, applied
# to a load-test-style normal reading, plus a temperature spike.

def inject_fault(reading: dict, kind: str, rand) -> dict:
    r = dict(reading)
    factor = 3 + rand() * 5  # x3..x8 like generate_sensor_stream
    if kind == "spike_river":
        r["river_level_m"] = round(r["river_level_m"] * factor, 3)
    elif kind == "spike_temp":
        r["temp_c"] = round(r["temp_c"] * factor, 2)
    elif kind == "dropout":
        r.update(river_level_m=0.0, temp_c=0.0, humidity_pct=0.0, gas_ppm=0.0)
    elif kind == "stuck":
        r.update(humidity_pct=0.0, gas_ppm=round(r["gas_ppm"] * 4, 1))
    elif kind == "drift":
        r.update(temp_c=round(r["temp_c"] + 15 + rand() * 10, 2),
                 gas_ppm=round(r["gas_ppm"] + 300 + rand() * 300, 1))
    else:
        raise ValueError(kind)
    return r


FAULT_KINDS = ("spike_river", "spike_temp", "dropout", "stuck", "drift")


def outcome(result: dict) -> str:
    """How the backend treated a FAULTY reading:
    'suppressed'   - the whole reading held back as a sensor fault
    'field_dropped'- the bad field dropped, the rest classified
    'hazard'       - passed as a MEDIUM+ hazard (gas leak / heat ...)
    'passed'       - stored as a normal measurement (the fault was missed)"""
    if result.get("hazard_type") == "sensor_fault":
        return "suppressed"
    if result.get("sensor_faults"):
        return "field_dropped"
    if result.get("severity") in ELEVATED:
        return "hazard"
    return "passed"


# --- replay --------------------------------------------------------------------

class Backend:
    """Context manager: a throwaway database, offline network, the trained
    models, fresh confirmer and the given nodes registered (load-test node
    config: urban_low, CN 78, no upstream). Restores everything on exit."""

    def __init__(self, node_ids, report_interval_seconds=None):
        self.node_ids = list(node_ids)
        self.interval = report_interval_seconds

    def __enter__(self):
        self._tmp = tempfile.mkdtemp(prefix="sj_fa_")
        self._saved = dict(
            db=bs.DB_PATH, get=bs.requests.get, confirmer=bs._confirmer,
            models=(bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols),
            registry=dict(bs.NODE_REGISTRY),
        )
        bs.DB_PATH = os.path.join(self._tmp, "fa.db")
        bs.requests.get = _offline
        bs.init_db()
        bs._confirmer = bs.HazardConfirmer()
        bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols = _load_models()
        for i, nid in enumerate(self.node_ids):
            bs.NODE_REGISTRY[nid] = {
                "location": f"Load-test site {i + 1}", "land_use": "urban_low", "curve_number": 78,
                "latitude": 29.30 + (i // 50) * 0.002, "longitude": 79.40 + (i % 50) * 0.002,
                "upstream_node": None, "report_interval_seconds": self.interval,
            }
            bs.node_history[nid] = collections.deque(maxlen=bs.HISTORY_WINDOW)
            bs.node_health[nid] = {}
            bs.node_rainfall.pop(nid, None)
            bs._weather_cache.pop(nid, None)
        # derive_features looks the weather up per reading; offline it
        # returns {} quickly, but skip the attempt entirely.
        self._weather = mock.patch.object(bs, "fetch_weather_forecast", return_value={})
        self._weather.start()
        return self

    def __exit__(self, *exc):
        self._weather.stop()
        for nid in self.node_ids:
            bs.node_history.pop(nid, None)
            bs.node_health.pop(nid, None)
            bs.node_rainfall.pop(nid, None)
        bs.NODE_REGISTRY.clear()
        bs.NODE_REGISTRY.update(self._saved["registry"])
        bs.close_ingest_connection()  # its kept-open DB handle (Windows cannot delete an open file)
        bs.DB_PATH = self._saved["db"]
        bs.requests.get = self._saved["get"]
        bs._confirmer = self._saved["confirmer"]
        (bs._anomaly_model, bs._anomaly_scaler, bs._flood_model,
         bs._flood_feature_cols) = self._saved["models"]
        shutil.rmtree(self._tmp, ignore_errors=True)
        return False

    @staticmethod
    def send(reading: dict, at: datetime, uid: str) -> dict:
        raw = bs.RawReading(**reading, timestamp=at.isoformat(), reading_uid=uid)
        return bs.process_raw_reading(raw, at + timedelta(seconds=1))


def replay(streams: dict, step_s: float, start: datetime = T_START) -> dict:
    """{node_id: [result, ...]} - tick by tick, every node once per tick."""
    results = {nid: [] for nid in streams}
    with Backend(streams):
        ticks = max(len(v) for v in streams.values())
        for k in range(ticks):
            at = start + timedelta(seconds=k * step_s)
            for nid, readings in streams.items():
                if k < len(readings):
                    results[nid].append(Backend.send(readings[k], at, f"{nid}-fa-{k}"))
    return results


def normal_rates(results: dict) -> dict:
    """False-positive rates over a NORMAL stream (every reading is good)."""
    flat = [r for rs in results.values() for r in rs]
    n = len(flat)
    sensor_fault = sum(r.get("hazard_type") == "sensor_fault" for r in flat)
    elevated = [r for r in flat if r.get("severity") in ELEVATED]
    flash = sum((r.get("hazard_scores", {}).get("flash_flood") or {}).get("severity") in ELEVATED
                for r in flat)
    dispatched = sum(r.get("status") == "alert_dispatched" for r in flat)
    by_type = collections.Counter(r.get("hazard_type") for r in elevated)
    return {
        "readings": n,
        "sensor_fault": sensor_fault, "sensor_fault_rate": round(sensor_fault / n, 4),
        "elevated": len(elevated), "elevated_rate": round(len(elevated) / n, 4),
        "flash_flood_medium_plus": flash, "flash_flood_rate": round(flash / n, 4),
        "alert_dispatched": dispatched,
        "elevated_by_type": dict(by_type),
    }


def fault_outcomes(nodes: int = 30, warmup: int = 8, seed: int = 11) -> dict:
    """{kind: Counter(outcome)} - each node sends `warmup` normal load-test
    readings at 60 s, then one faulty reading, then 3 normal ones; one
    fault kind per node, cycling through FAULT_KINDS."""
    streams, fault_at = {}, {}
    for i in range(nodes):
        rand = mulberry32(seed * 100_003 + i)
        readings = [normal_reading(i + 1, rand, 0.004) for _ in range(warmup + 4)]
        kind = FAULT_KINDS[i % len(FAULT_KINDS)]
        readings[warmup] = inject_fault(readings[warmup], kind, rand)
        streams[node_id(i)] = readings
        fault_at[node_id(i)] = kind
    results = replay(streams, 60)
    out = {k: collections.Counter() for k in FAULT_KINDS}
    for nid, kind in fault_at.items():
        out[kind][outcome(results[nid][warmup])] += 1
    return {k: dict(v) for k, v in out.items()}


def ramp_stream(cm_per_min: float, minutes: int, noise_m: float = 0.02, seed: int = 5, start_m=1.5,
                calm_minutes: int = 10) -> list:
    """calm_minutes of a calm river, then a rise of cm_per_min, one
    reading a minute, +-noise_m/2 uniform noise (simulated readings)."""
    rand = mulberry32(seed)
    out = []
    for k in range(calm_minutes + minutes):
        rise = max(0, k - calm_minutes + 1) * cm_per_min / 100
        out.append({"node_id": "LT-0001", "simulated": True,
                    "river_level_m": round(start_m + rise + (rand() - 0.5) * noise_m, 3),
                    "temp_c": 27.0, "humidity_pct": 60.0, "gas_ppm": 400.0, "flame_reading": 0.0,
                    "rainfall_mm_since_last": 0})
    return out


def ramp_detection(cm_per_min: float, minutes: int = 15, calm_minutes: int = 10) -> dict:
    """Minute (after the rise starts) of the first MEDIUM+ flash flood and
    the worst flash-flood severity seen, for one simulated ramp."""
    results = replay({"LT-0001": ramp_stream(cm_per_min, minutes, calm_minutes=calm_minutes)}, 60)["LT-0001"]
    first, worst = None, "LOW"
    rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}
    for k, r in enumerate(results):
        sev = (r.get("hazard_scores", {}).get("flash_flood") or {}).get("severity", "LOW")
        if k < calm_minutes:
            continue
        if sev in ELEVATED and first is None:
            first = k - calm_minutes + 1
        if rank[sev] > rank[worst]:
            worst = sev
    calm_false = sum((r.get("hazard_scores", {}).get("flash_flood") or {}).get("severity") in ELEVATED
                     for r in results[:calm_minutes])
    return {"first_elevated_minute": first, "worst": worst, "calm_part_false_alarms": calm_false}


def measure_all(nodes: int = 30, per_node: int = 12) -> dict:
    out = {
        "loadtest_60s": normal_rates(replay(stream("loadtest", nodes, per_node), 60)),
        "noisy_river_60s": normal_rates(replay(stream("noisy_river", nodes, per_node), 60)),
        "noisy_river_300s": normal_rates(replay(stream("noisy_river", nodes, per_node), 300)),
        "hot_dry_60s": normal_rates(replay(stream("hot_dry", nodes, per_node), 60)),
        "faults": fault_outcomes(),
        "ramps": {f"{v}cm_per_min": ramp_detection(v) for v in (1.5, 2.5, 6.0)},
    }
    return out


if __name__ == "__main__":
    import json

    if not HAVE_MODELS:
        sys.exit("trained models missing in var/models - run ml\\train_models.py")
    print(json.dumps(measure_all(), indent=1), flush=True)
