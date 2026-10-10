// Preloaded into the server.js process by ingest_load.js (node -r probe.js
// server.js): once a second it sends the process's own CPU time, memory and
// event-loop utilisation to the load generator over the IPC channel. Read
// inside the process, so it is exact on every OS (no ps / PowerShell
// sampling) and adds next to no load. Does nothing without an IPC channel.
const { performance } = require("perf_hooks");

if (typeof process.send === "function") {
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const elu = performance.eventLoopUtilization();
    try {
      process.send({
        probe: true,
        t: Date.now(),
        cpu: process.cpuUsage(), // microseconds since start: { user, system }
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        elu: { idle: elu.idle, active: elu.active }, // cumulative ms
      });
    } catch {
      clearInterval(timer); // channel closed: the load test has ended
    }
  }, 1000);
  timer.unref();
  process.on("disconnect", () => clearInterval(timer));
}
