"""
SANJEEVNI - ingest speed bench and output-equivalence check
(backend lane, step B2, 2026-10-09).

Not a test file (no "test" prefix, so `unittest discover` skips it).

    venv\\Scripts\\python.exe tests\\ingest_bench.py record OUT.json   replay, save every output
    venv\\Scripts\\python.exe tests\\ingest_bench.py compare A.json B.json
    venv\\Scripts\\python.exe tests\\ingest_bench.py profile [N]       cProfile N normal readings
    venv\\Scripts\\python.exe tests\\ingest_bench.py time              time per reading (single + batch)

`record` replays a FIXED, deterministic set of SIMULATED readings through
the real ingest path (POST /api/ingest's and POST /api/ingest/batch's
handlers, called in-process: derive_features -> process_reading ->
HazardConfirmer -> confidence -> SQLite) and saves every API answer plus
every stored row. Run it before and after a speed change and `compare`
the two files: identical output = the change did not alter results.

The set: load-test-style normal readings (30 nodes x 12, 60 s), a hot dry
site, the five injected sensor faults, a flash-flood ramp, gas-leak /
fire / flood-with-rain alert readings, an upstream pair, readings without
a water sensor, and gateway batches (with backlog and an untimed
reading). Everything runs in a TEMPORARY var/ folder (copies of
var/models and var/chroma_db, so the RAG store is rebuilt there, never in
your var/), with the network blocked, the load test's calm SIMULATED
weather-mock file, and a fake clock so datetime.now() is reproducible.
"""

import os
import shutil
import sys
import tempfile

os.environ.setdefault("OMP_NUM_THREADS", "1")  # as the load test / judge demo run the backend

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_VAR = tempfile.mkdtemp(prefix="sj_bench_")
for _sub in ("models", "chroma_db"):
    _src = os.path.join(ROOT, "var", _sub)
    if os.path.isdir(_src):
        shutil.copytree(_src, os.path.join(_VAR, _sub))
os.environ["SANJEEVNI_VAR_DIR"] = _VAR
os.environ.pop("OFFICER_API_KEY", None)
# SJ_BENCH_BACKEND: another copy of backend/ to measure (e.g. the code
# before a change, copied with data/ next to it so paths.py finds the SOPs)
sys.path.insert(0, os.environ.get("SJ_BENCH_BACKEND") or os.path.join(ROOT, "backend"))
sys.path.insert(1, os.path.join(ROOT, "tests"))

import atexit  # noqa: E402
import collections  # noqa: E402
import contextlib  # noqa: E402
import json  # noqa: E402
import sqlite3  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from unittest import mock  # noqa: E402

import backend_server as bs  # noqa: E402
from false_alarm_streams import FAULT_KINDS, inject_fault, mulberry32, normal_reading, hot_dry_reading  # noqa: E402



def _cleanup():
    """Close this process's handles on the temp folder first (Windows
    cannot delete open files), then remove it."""
    bs.close_ingest_connection()
    if _server_js_conn is not None:
        _server_js_conn.close()
    shutil.rmtree(_VAR, ignore_errors=True)


atexit.register(_cleanup)

T0 = datetime(2026, 10, 9, 6, 0, tzinfo=timezone.utc)
_server_js_conn = None
_clock = [T0]


class FakeDatetime(datetime):
    """backend_server's datetime with a settable now() (the bench clock)."""

    @classmethod
    def now(cls, tz=None):
        now = _clock[0]
        return now if tz is not None else now.replace(tzinfo=None)


def _offline(*_a, **_k):
    raise bs.requests.ConnectionError("offline (bench)")


def calm_weather(start: datetime) -> dict:
    """ingest_load.js calmWeather(): 48 h of 0 mm rain, 8 km/h wind, 15 km/h gusts (SIMULATED)."""
    start = start.replace(minute=0, second=0, microsecond=0)
    times = [(start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:00") for h in range(48)]
    return {
        "_note": "SANJEEVNI bench - a SIMULATED calm forecast, NOT real weather.",
        "hourly_units": {"precipitation": "mm", "wind_speed_10m": "km/h", "wind_gusts_10m": "km/h"},
        "hourly": {"time": times, "precipitation": [0] * 48, "wind_speed_10m": [8] * 48,
                   "wind_gusts_10m": [15] * 48},
    }


def setup_backend(n_nodes: int = 40, rag: bool = True):
    """Like the load test's real backend: temp DB, registry of LT nodes
    (urban_low, CN 78), calm weather mock, elevation blocked."""
    mock_path = os.path.join(_VAR, "weather_mock.json")
    with open(mock_path, "w", encoding="utf-8") as f:
        json.dump(calm_weather(T0), f)
    os.environ[bs.WEATHER_MOCK_ENV] = mock_path
    bs.requests.get = _offline
    mock.patch.object(bs, "datetime", FakeDatetime).start()
    if os.path.exists(bs.DB_PATH):
        os.remove(bs.DB_PATH)
    with (mock.patch.object(bs, "build_knowledge_base", side_effect=RuntimeError("bench: no RAG"))
          if not rag else contextlib.nullcontext()):
        bs.startup()
    # server.js opens the shared database in WAL mode (server.js:67) and
    # keeps it open for its whole life - so a backend connection closing is
    # never the LAST one (which would checkpoint the WAL on every close)
    global _server_js_conn
    _server_js_conn = sqlite3.connect(bs.DB_PATH, check_same_thread=False)
    _server_js_conn.execute("PRAGMA journal_mode=WAL")
    bs.NODE_REGISTRY.clear()
    for i in range(n_nodes):
        nid = f"LT-{i + 1:04d}"
        bs.NODE_REGISTRY[nid] = {
            "location": f"Load-test site {i + 1}", "land_use": "urban_low", "curve_number": 78,
            "latitude": 29.30 + (i // 50) * 0.002, "longitude": 79.40 + (i % 50) * 0.002,
            "upstream_node": None, "report_interval_seconds": None,
        }
    # an upstream pair for the spatial-correlation path
    bs.NODE_REGISTRY["LT-0040"]["upstream_node"] = "LT-0039"
    bs.node_history.clear()
    bs.node_health.clear()
    bs.node_rainfall.clear()
    for nid in bs.NODE_REGISTRY:
        bs.node_history[nid] = collections.deque(maxlen=bs.HISTORY_WINDOW)
    bs._confirmer = bs.HazardConfirmer()
    bs._api_failed_at.clear()
    bs._elevation_cache.clear()


# --- the fixed reading set ---------------------------------------------------

def scripted_steps():
    """[(seconds after T0, kind, payload)] - kind 'single' (one reading,
    payload = dict) or 'batch' (payload = list of dicts), in send order."""
    steps = []
    # 1. load-test normal stream: 30 nodes x 12 at 60 s
    rands = {i: mulberry32(7 * 100_003 + i) for i in range(30)}
    for k in range(12):
        for i in range(30):
            r = normal_reading(i + 1, rands[i], 0.004)
            if i in (3, 17, 25) and k == 8:  # three injected faults
                r = inject_fault(r, FAULT_KINDS[(i + k) % len(FAULT_KINDS)], rands[i])
            steps.append((k * 60 + i, "single", {**r, "_uid": f"{r['node_id']}-n{k}"}))
    # 2. a hot, dry site (nodes 31-33)
    for k in range(6):
        for i in (30, 31, 32):
            rand = mulberry32(99 + i * 13 + k)
            r = hot_dry_reading(i + 1, rand)
            steps.append((800 + k * 60 + i, "single", {**r, "_uid": f"{r['node_id']}-h{k}"}))
    # 3. flash-flood ramp + rain on node 34 (alerts -> RAG text, confirmer)
    for k in range(14):
        level = 1.5 + max(0, k - 4) * 0.06
        steps.append((1300 + k * 60, "single", {
            "node_id": "LT-0034", "simulated": True, "river_level_m": round(level, 3), "temp_c": 27.0,
            "humidity_pct": 80.0, "gas_ppm": 400.0, "flame_reading": 0.0,
            "rainfall_mm_since_last": 4.0 if k >= 4 else 0.0, "fast_rise": k >= 6,
            "rise_rate_cm_per_min": 6.0 if k >= 6 else None, "_uid": f"LT-0034-f{k}"}))
    # 4. gas leak (node 35), fire (node 36), heat (node 37) - repeated so they confirm
    for k in range(4):
        steps.append((1400 + k * 30, "single", {
            "node_id": "LT-0035", "simulated": True, "river_level_m": 1.2, "temp_c": 30.0,
            "humidity_pct": 50.0, "gas_ppm": 900.0 + 50 * k, "flame_reading": 0.0, "_uid": f"LT-0035-g{k}"}))
        steps.append((1405 + k * 30, "single", {
            "node_id": "LT-0036", "simulated": True, "temp_c": 58.0 + k, "humidity_pct": 15.0,
            "gas_ppm": 600.0, "flame_reading": 1.0, "pm25_ugm3": 180, "pm10_ugm3": 260,
            "_uid": f"LT-0036-x{k}"}))
        steps.append((1410 + k * 30, "single", {
            "node_id": "LT-0037", "simulated": True, "temp_c": 46.0 + k * 0.5, "humidity_pct": 20.0,
            "gas_ppm": 410.0, "flame_reading": 0.0, "_uid": f"LT-0037-t{k}"}))
    # 5. upstream pair: LT-0039 rising, LT-0040 downstream
    for k in range(8):
        steps.append((1500 + k * 60, "single", {
            "node_id": "LT-0039", "simulated": True, "river_level_m": round(2.0 + 0.03 * k, 3),
            "temp_c": 26.0, "humidity_pct": 70.0, "gas_ppm": 400.0, "flame_reading": 0.0,
            "rainfall_mm_since_last": 2.0, "_uid": f"LT-0039-u{k}"}))
        steps.append((1510 + k * 60, "single", {
            "node_id": "LT-0040", "simulated": True, "river_level_m": round(2.4 + 0.02 * k, 3),
            "temp_c": 26.0, "humidity_pct": 70.0, "gas_ppm": 400.0, "flame_reading": 0.0,
            "rainfall_mm_since_last": 2.0, "soil_moisture_pct": 60.0, "_uid": f"LT-0040-u{k}"}))
    # 6. gateway batches: nodes 1-20 again (age 0-3 s), one with a backlog
    #    of older readings, an untimed one, a duplicate and an unknown node
    for b in range(3):
        readings = []
        rand = mulberry32(4242 + b)
        for i in range(20):
            r = normal_reading(i + 1, rand, 0.004)
            r["age_seconds"] = round(rand() * 3, 2)
            r["reading_uid"] = f"{r['node_id']}-b{b}"
            readings.append(r)
            if b == 1 and i < 4:
                for back in (1, 2):
                    old = normal_reading(i + 1, rand, 0.004)
                    old["age_seconds"] = back * 60
                    old["reading_uid"] = f"{old['node_id']}-b{b}-old{back}"
                    readings.append(old)
        if b == 2:
            readings.append({**readings[0]})  # duplicate uid in the same batch
            untimed = normal_reading(5, rand, 0.004)
            untimed["reading_uid"] = "LT-0005-untimed"
            readings.append(untimed)
            readings.append({"node_id": "NOPE-1", "simulated": True, "temp_c": 25.0, "age_seconds": 1})
        steps.append((2400 + b * 60, "batch", readings))
    return steps


def _raw(payload: dict, at: datetime):
    payload = dict(payload)
    uid = payload.pop("_uid", None)
    return bs.RawReading(**payload, timestamp=at.isoformat(), reading_uid=uid)


def run_steps(steps, collect=True):
    out = []
    for offset, kind, payload in steps:
        at = T0 + timedelta(seconds=offset)
        _clock[0] = at + timedelta(seconds=1)
        if kind == "single":
            res = bs.ingest_reading(_raw(payload, at))
        else:
            res = bs.ingest_batch(bs.ReadingBatch(readings=[bs.RawReading(**r) for r in payload]))
        if collect:
            out.append(res)
    return out


def stored_rows():
    conn = sqlite3.connect(bs.DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM readings ORDER BY id")]
    conn.close()
    return rows


def health_snapshot():
    return {k: dict(v) for k, v in sorted(bs.node_health.items())}


def record(path: str):
    setup_backend()
    steps = scripted_steps()
    results = run_steps(steps)
    data = {
        "results": results,
        "rows": stored_rows(),
        "node_health": health_snapshot(),
        "node_health_api": bs.compute_node_health(now=T0 + timedelta(hours=1)),
    }
    text = json.dumps(data, sort_keys=True, default=str, indent=1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    statuses = collections.Counter()
    for r in results:
        for x in (r.get("results") if "results" in r else [r]):
            statuses[x.get("status")] += 1
    print(f"recorded {len(steps)} requests, {sum(statuses.values())} readings, "
          f"{len(data['rows'])} rows -> {path}; statuses {dict(statuses)}")


def compare(a: str, b: str) -> int:
    with open(a, encoding="utf-8") as f:
        da = json.load(f)
    with open(b, encoding="utf-8") as f:
        db = json.load(f)
    if da == db:
        print(f"IDENTICAL: {len(da['results'])} answers, {len(da['rows'])} stored rows, node health")
        return 0
    for key in da:
        if da[key] != db.get(key):
            va, vb = da[key], db.get(key)
            if isinstance(va, list) and isinstance(vb, list):
                for i, (x, y) in enumerate(zip(va, vb)):
                    if x != y:
                        print(f"DIFF {key}[{i}]:\n  A {json.dumps(x, sort_keys=True)[:1500]}\n"
                              f"  B {json.dumps(y, sort_keys=True)[:1500]}")
                        break
                if len(va) != len(vb):
                    print(f"DIFF {key}: length {len(va)} vs {len(vb)}")
            else:
                print(f"DIFF {key}")
    return 1


# --- timing / profiling ------------------------------------------------------

def normal_singles(n_nodes=30, per_node=10, seed=21, tag="p"):
    rands = {i: mulberry32(seed * 100_003 + i) for i in range(n_nodes)}
    steps = []
    for k in range(per_node):
        for i in range(n_nodes):
            r = normal_reading(i + 1, rands[i], 0.004)
            steps.append((k * 60 + i, "single", {**r, "_uid": f"{r['node_id']}-{tag}{k}"}))
    return steps


def normal_batches(n_nodes=20, rounds=10, seed=33):
    rand = mulberry32(seed)
    steps = []
    for k in range(rounds):
        readings = []
        for i in range(n_nodes):
            r = normal_reading(i + 1, rand, 0.004)
            r["age_seconds"] = round(rand() * 3, 2)
            r["reading_uid"] = f"{r['node_id']}-q{k}"
            readings.append(r)
        steps.append((k * 60, "batch", readings))
    return steps


def time_it():
    setup_backend()
    warm = normal_singles(n_nodes=30, per_node=4, seed=5, tag="w")  # history + first-call caches
    run_steps(warm, collect=False)
    singles = [(off + 300, kind, p) for off, kind, p in normal_singles()]
    t = time.perf_counter()
    run_steps(singles, collect=False)
    single_s = (time.perf_counter() - t) / len(singles)
    batches = [(off + 1000, kind, p) for off, kind, p in normal_batches()]
    n = sum(len(p) for _, _, p in batches)
    t = time.perf_counter()
    run_steps(batches, collect=False)
    batch_s = (time.perf_counter() - t) / n
    print(json.dumps({
        "single_ms_per_reading": round(single_s * 1000, 2), "single_readings": len(singles),
        "batch_ms_per_reading": round(batch_s * 1000, 2), "batch_readings": n,
        "omp_num_threads": os.environ.get("OMP_NUM_THREADS"),
    }))


def profile(n_per_node: int = 10, batch: bool = False):
    import cProfile
    import pstats
    setup_backend()
    run_steps(normal_singles(n_nodes=30, per_node=4, seed=5, tag="w"), collect=False)
    steps = ([(off + 1000, kind, p) for off, kind, p in normal_batches(rounds=n_per_node)] if batch
             else [(off + 300, kind, p) for off, kind, p in normal_singles(per_node=n_per_node)])
    prof = cProfile.Profile()
    prof.enable()
    run_steps(steps, collect=False)
    prof.disable()
    stats = pstats.Stats(prof).strip_dirs().sort_stats("cumulative")
    stats.print_stats(45)
    stats.sort_stats("tottime").print_stats(25)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "time"
    if cmd == "record":
        record(sys.argv[2])
    elif cmd == "compare":
        sys.exit(compare(sys.argv[2], sys.argv[3]))
    elif cmd == "profile":
        profile(int(sys.argv[2]) if len(sys.argv) > 2 else 10, batch="--batch" in sys.argv)
    elif cmd == "time":
        time_it()
    else:
        sys.exit(__doc__)
