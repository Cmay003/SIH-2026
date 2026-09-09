const http = require("http");

const nodes = ["NODE-04", "NODE-07", "NODE-INDB"];
let tick = 0;

function generateData() {
  const node_id = nodes[tick % nodes.length];
  const scenario = tick % 12;
  tick++;

  const base = {
    node_id,
    river_level_m: +(1.5 + Math.random() * 0.6).toFixed(2),
    temp_c: +(25 + Math.random() * 8).toFixed(2),
    humidity_pct: +(45 + Math.random() * 30).toFixed(2),
    gas_ppm: +(380 + Math.random() * 40).toFixed(1),
    flame_reading: +(Math.random() * 0.05).toFixed(3),
    rainfall_mm_since_last: +(Math.random() * 5).toFixed(1),
  };

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
