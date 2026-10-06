#!/usr/bin/env node
// SANJEEVNI - manage device keys for sensor ingestion (see device_auth.js).
//
//   node device_keys.js add <name> [--nodes NODE-04,NODE-07] [--kind device|simulator]
//        prints the key ONCE - put it in the device's secrets.h as DEVICE_KEY
//        (or SANJEEVNI_INGEST_KEY in .env for simulation.js)
//   node device_keys.js list
//   node device_keys.js revoke <name>     the device can no longer send readings
//
// Examples
//   node device_keys.js add node-04 --nodes NODE-04
//   node device_keys.js add gateway-1 --nodes NODE-04,NODE-07,NODE-INDB
//   node device_keys.js add simulator --kind simulator
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createDeviceKey, initDeviceKeyTable, KINDS } = require("./device_auth");

const db = new DatabaseSync(path.join(__dirname, "sanjeevni.db"));
initDeviceKeyTable(db);

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const [command, name, ...rest] = process.argv.slice(2);
switch (command) {
  case "add": {
    if (!name || !/^[A-Za-z0-9._-]{2,40}$/.test(name)) {
      console.error("Name: 2-40 characters, letters/digits/._- only.");
      process.exit(1);
    }
    const kind = option(rest, "--kind", "device");
    const nodes = option(rest, "--nodes", "*").replace(/\s+/g, "");
    if (!KINDS.includes(kind)) {
      console.error(`--kind must be one of: ${KINDS.join(", ")}`);
      process.exit(1);
    }
    if (db.prepare("SELECT 1 FROM device_keys WHERE name = ?").get(name)) {
      console.error(`A key named '${name}' already exists (revoke it first to replace it).`);
      process.exit(1);
    }
    if (kind === "device" && nodes === "*") {
      console.warn("Note: this key may report for ANY node. Limit it with --nodes NODE-04,... if you can.");
    }
    const key = createDeviceKey(db, { name, kind, nodes });
    console.log(`Created ${kind} key '${name}' for nodes: ${nodes}`);
    console.log("\nKEY (shown only once - store it now):\n");
    console.log(`  ${key}\n`);
    console.log(kind === "simulator"
      ? "Use it with:  $env:SANJEEVNI_INGEST_KEY=\"<key>\"; node simulation.js   (or put it in .env)"
      : 'Put it in the sketch\'s secrets.h:  #define DEVICE_KEY "<key>"');
    break;
  }
  case "list": {
    const rows = db.prepare("SELECT name, kind, nodes, active, created_at, last_used_at FROM device_keys ORDER BY name").all();
    if (!rows.length) console.log("No device keys yet. Create one: node device_keys.js add <name> --nodes NODE-04");
    for (const r of rows) {
      console.log(`${r.name.padEnd(16)} ${r.kind.padEnd(9)} ${r.active ? "active " : "REVOKED"}  nodes: ${r.nodes.padEnd(28)} last used: ${r.last_used_at || "never"}`);
    }
    break;
  }
  case "revoke": {
    const result = db.prepare("UPDATE device_keys SET active = 0 WHERE name = ?").run(name || "");
    if (!result.changes) {
      console.error(`No key named '${name}'. See: node device_keys.js list`);
      process.exit(1);
    }
    console.log(`Revoked '${name}' - readings sent with it are now refused.`);
    break;
  }
  default:
    console.log(require("fs").readFileSync(__filename, "utf8").split("\n").slice(1, 14).join("\n").replace(/^\/\/ ?/gm, ""));
}
