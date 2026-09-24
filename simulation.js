const http = require("http");

const nodes = ["NODE-04", "NODE-07", "NODE-INDB"];
let tick = 0;

// Simulated battery/signal strength per node - drifts slowly downward
// over the run to demo the node-health telemetry feature, rather than
// being static or fully random every tick (a real battery doesn't jump
// around, it slowly drains).
const nodeBattery = { "NODE-04": 92, "NODE-07": 78, "NODE-INDB": 65 };

// BUG FIX: previously, which node got a special scenario (sensor fault /
// flood / gas leak) was derived from the SAME counter driving the
// scenario type (`tick`). Since nodes.length (3) divides evenly into the
// scenario cycle (12), the math always landed on the same node for each
// scenario type - sensor fault and flood were PERMANENTLY pinned to
// NODE-04, gas leak was PERMANENTLY pinned to NODE-INDB, and NODE-07
// never got any special scenario at all, ever.
//
// A first attempt at this fix used a separate ROTATING counter instead
// of tick itself - that still failed, because there are exactly 3
// special events per 12-tick cycle and 3 nodes, so a rotating counter
// realigns every single cycle and just permanently pins each scenario
// TYPE to a different (but still fixed) node forever. Any counter-based
// scheme where events-per-cycle and node-count share a common factor
// aliases the same way. Genuine randomness is what actually avoids this,
// and is more realistic anyway - real disasters don't visit nodes on a
// predictable schedule.
function randomNode() {
  return nodes[Math.floor(Math.random() * nodes.length)];
}

function generateData() {
  const node_id = nodes[tick % nodes.length];
  const scenario = tick % 12;
  tick++;

  // Battery drains slowly (~0.05% per tick) plus tiny jitter - realistic
  // enough to demo the node-health dashboard without needing real hardware.
  nodeBattery[node_id] = Math.max(
    0,
    nodeBattery[node_id] - (0.02 + Math.random() * 0.06),
  );

  const base = {
    node_id,
    river_level_m: +(1.5 + Math.random() * 0.6).toFixed(2),
    temp_c: +(25 + Math.random() * 8).toFixed(2),
    humidity_pct: +(45 + Math.random() * 30).toFixed(2),
    gas_ppm: +(380 + Math.random() * 40).toFixed(1),
    flame_reading: +(Math.random() * 0.05).toFixed(3),
    rainfall_mm_since_last: +(Math.random() * 5).toFixed(1),
    // UPGRADE: node health telemetry - simulated here since we're not
    // reading real hardware. Signal strength in typical WiFi dBm range.
    signal_strength_dbm: Math.round(-40 - Math.random() * 40),
    battery_pct: +nodeBattery[node_id].toFixed(1),
    // UPGRADE: tells backend_server.py to skip the HC-SR04 raw-distance
    // conversion and hardware-test threshold override, both calibrated
    // to one specific physical sensor's tiny real-world range - without
    // this flag, every realistic river_level_m value below would either
    // get wrongly clamped to 0 (conversion) or blow straight through to
    // HIGH regardless of scenario (threshold override). Confirmed via
    // testing before this flag existed.
    simulated: true,
  };

  if (scenario === 6 || scenario === 9 || scenario === 11) {
    // Randomly pick which node this occurrence of the scenario hits, so
    // the SAME scenario type visits DIFFERENT nodes over time instead of
    // always appearing at the same fixed spot on the officer's map.
    base.node_id = randomNode();
  }

  if (scenario === 6) {
    // sensor fault - implausible spike, should be suppressed by anomaly filter
    base.river_level_m = 14.2;
    base.rainfall_mm_since_last = 0.1;
  } else if (scenario === 9) {
    // rising flood scenario
    base.rainfall_mm_since_last = 30 + Math.random() * 20;
    base.river_level_m = +(2.5 + Math.random() * 1.5).toFixed(2);
  } else if (scenario === 11) {
    // gas leak
    base.gas_ppm = 900 + Math.random() * 100;
  }

  return base;
}

function sendSensorData() {
  const data = generateData();
  const postData = JSON.stringify(data);

  const options = {
    hostname: "localhost",
    port: 3000,
    path: "/api/ingest",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = http.request(options, (res) => {
    let response = "";
    res.on("data", (chunk) => (response += chunk));
    res.on("end", () => {
      console.log(
        `[${new Date().toLocaleTimeString()}] ${data.node_id} ->`,
        response,
      );
    });
  });

  req.on("error", (error) => console.error("Error:", error.message));
  req.write(postData);
  req.end();
}

sendSensorData();
setInterval(sendSensorData, 3000);
