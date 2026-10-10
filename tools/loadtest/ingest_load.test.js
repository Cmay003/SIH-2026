// Tests for the ingestion load test tool (tools/loadtest/ingest_load.js).
// Run: node --test tools/loadtest/ingest_load.test.js
// The smoke run starts its own server.js + fake backend on spare ports with
// a temporary database (a few seconds); nothing on 3000/8000 is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lt = require("./ingest_load");

test("parseArgs: defaults, validation and --server needs a key", () => {
  const o = lt.parseArgs([]);
  assert.equal(o.nodes, 200);
  assert.equal(o.interval, 60);
  assert.equal(o.backend, "fake");
  assert.equal(lt.parseArgs(["--nodes", "1000", "--backend", "real"]).nodes, 1000);
  assert.throws(() => lt.parseArgs(["--nodes", "0"]), lt.UsageError);
  assert.throws(() => lt.parseArgs(["--backend", "mock"]), lt.UsageError);
  assert.throws(() => lt.parseArgs(["--server", "http://x:3000"]), /--key/);
  assert.throws(() => lt.parseArgs(["--bogus"]), /unknown option/);
});

test("planFleet: Wi-Fi share, gateway batches of <= gateway-size, every node exactly once", () => {
  const senders = lt.planFleet({ nodes: 1000, gatewaySize: 20, directShare: 0.25, interval: 60 });
  const direct = senders.filter((s) => s.kind === "direct");
  const gws = senders.filter((s) => s.kind === "gateway");
  assert.equal(direct.length, 250);
  assert.equal(gws.length, 38); // 750 / 20, rounded up
  assert.ok(gws.every((g) => g.nodes.length >= 1 && g.nodes.length <= 20));
  const all = senders.flatMap((s) => s.nodes);
  assert.equal(all.length, 1000);
  assert.equal(new Set(all).size, 1000);
  assert.ok(senders.every((s) => s.offsetMs >= 0 && s.offsetMs < 60000));
});

test("makeReading: a normal, simulated reading with a unique uid; node ids fit the 12-char limit", () => {
  const rand = lt.rng(1);
  const r = lt.makeReading("LT-0042", 7, rand);
  assert.equal(r.simulated, true);
  assert.equal(r.reading_uid, "LT-0042-lt-7");
  assert.ok(r.river_level_m > 1 && r.river_level_m < 2.5);
  assert.ok(r.gas_ppm >= 380 && r.gas_ppm <= 420);
  assert.ok(r.flame_reading < 0.06);
  assert.ok(r.node_id.length <= 12);
});

test("percentile / latencyStats (nearest rank)", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(lt.percentile(v, 50), 50);
  assert.equal(lt.percentile(v, 95), 95);
  assert.equal(lt.percentile(v, 99), 99);
  assert.equal(lt.percentile([], 50), null);
  const s = lt.latencyStats([10, 20, 30]);
  assert.equal(s.count, 3);
  assert.equal(s.max_ms, 30);
  assert.deepEqual(lt.latencyStats([]), { count: 0 });
});

test("latencyStats counts timed-out requests as censored at the timeout (no survivorship bias)", () => {
  // 250 answered at ~8.8 s, 614 timed out at 15 s (the shape of the real 1000-node run)
  const answered = Array.from({ length: 250 }, (_, i) => 8000 + i * 6);
  const s = lt.latencyStats(answered, { timedOut: 614, timeoutMs: 15000 });
  assert.equal(s.count, 864);
  assert.equal(s.answered, 250);
  assert.equal(s.timed_out, 614);
  assert.equal(s.p50_ms, 15000);
  assert.equal(s.p50_censored, true, "the median is AT LEAST the timeout");
  assert.equal(s.max_censored, true);
  assert.ok(s.mean_answered_ms < 15000);
  // all timed out: still reported, never "count 0"
  const none = lt.latencyStats([], { timedOut: 10, timeoutMs: 15000 });
  assert.equal(none.count, 10);
  assert.equal(none.p50_censored, true);
  assert.equal(none.mean_answered_ms, null);
  // nothing timed out: plain percentiles, no censored flags
  const plain = lt.latencyStats([10, 20, 30], { timedOut: 0, timeoutMs: 15000 });
  assert.equal(plain.p50_ms, 20);
  assert.equal(plain.p50_censored, undefined);
  assert.deepEqual(lt.requestOutcomes({ ok: 0, http_error: 0, timeout: 50, network: 0 }),
    { ok: 0, http_error: 0, timeout: 50, network: 0, total: 50, success_rate_pct: 0 });
});

test("calmWeather: 48 hourly entries from the current UTC hour, no rain", () => {
  const w = lt.calmWeather();
  assert.equal(w.hourly.time.length, 48);
  assert.equal(w.hourly.time[0], new Date().toISOString().slice(0, 13) + ":00");
  assert.ok(w.hourly.precipitation.every((p) => p === 0));
  assert.match(w._note, /SIMULATED/);
});

test("smoke run: 12 nodes against its own server.js + fake backend, JSON report written", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sanjeevni-lt-out-"));
  const lines = [];
  try {
    const code = await lt.main(["--nodes", "12", "--interval", "1", "--duration", "3", "--gateway-size", "4",
      "--out", out, "--label", "smoke"], (l) => lines.push(l));
    const files = fs.readdirSync(out);
    assert.equal(files.length, 1, lines.join("\n"));
    const report = JSON.parse(fs.readFileSync(path.join(out, files[0]), "utf8"));
    assert.equal(code, report.throughput.kept_up ? 0 : 1);
    assert.equal(report.errors.total_failed_requests, 0, lines.join("\n"));
    assert.equal(report.throughput.readings_accepted, report.throughput.readings_sent);
    assert.ok(report.throughput.readings_sent >= 24, `sent ${report.throughput.readings_sent}`);
    assert.equal(report.stored.dashboard_rows_sensor_data, report.throughput.readings_sent);
    assert.ok(report.latency.direct_single.count > 0 && report.latency.gateway_batch.count > 0);
    assert.ok(report.resources.server && report.resources.server.rss_mb_end > 0);
    assert.match(report.data_note, /SIMULATED/);
    assert.match(lines.join("\n"), /accepted .* readings\/s/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
