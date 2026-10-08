// SANJEEVNI - where everything lives on disk (Node side).
// The ONLY place that knows the folder layout, so the server, simulator and
// CLIs work whatever folder they are started from. backend/paths.py is the
// Python twin: keep the two in sync. Layout: see backend/paths.py.
//
// Also loads .env from the project root (dotenv on its own only looks in
// the current folder, which is no longer the folder these files are in).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
require("dotenv").config({ path: ENV_FILE, quiet: true });

// SANJEEVNI_VAR_DIR moves var/ elsewhere (e.g. a test copy of the database)
const VAR_DIR = process.env.SANJEEVNI_VAR_DIR || path.join(ROOT, "var");
fs.mkdirSync(VAR_DIR, { recursive: true });

module.exports = {
  ROOT,
  ENV_FILE,
  VAR_DIR,
  DB_PATH: path.join(VAR_DIR, "sanjeevni.db"),
  BACKUPS_DIR: path.join(VAR_DIR, "backups"),
  CITIZEN_UPLOADS_DIR: path.join(VAR_DIR, "citizen_uploads"),
  HOSPITALS_FILE: path.join(ROOT, "data", "hospitals.json"),
  PUBLIC_DIR: path.join(ROOT, "public"),
  REACT_DIR: path.join(ROOT, "frontend", "dist"),
};
