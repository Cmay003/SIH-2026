"""
SANJEEVNI - where everything lives on disk (Python side).

The ONLY place that knows the folder layout - every module imports its
paths from here, so the backend works whatever folder it is started from
(uvicorn --app-dir backend, the ml/ scripts, the tests). server/paths.js
is the Node twin: keep the two in sync.

  SIH-2026/
    backend/  ml/  server/  frontend/  public/  firmware/  tests/  tools/  docs/
    data/     hospitals.json, sample_sops/, CSV templates + exports
    var/      runtime data, git-ignored: sanjeevni.db, models/, chroma_db/,
              backups/, citizen_uploads/, edge_ai_build/,
              fw_build/ (tools/firmware_build)
    .env

SANJEEVNI_VAR_DIR moves var/ elsewhere (e.g. a test copy of the database).
"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, ".env")

DATA_DIR = os.path.join(ROOT, "data")
SOPS_DIR = os.path.join(DATA_DIR, "sample_sops")

VAR_DIR = os.environ.get("SANJEEVNI_VAR_DIR") or os.path.join(ROOT, "var")
DB_PATH = os.path.join(VAR_DIR, "sanjeevni.db")
MODELS_DIR = os.path.join(VAR_DIR, "models")
# Written by ml/evaluate_models.py, served by GET /api/model-card (Python
# only - server.js just proxies the endpoint, so paths.js needs no twin).
MODEL_CARD_PATH = os.path.join(MODELS_DIR, "model_card.json")
CHROMA_DIR = os.path.join(VAR_DIR, "chroma_db")
EDGE_BUILD_DIR = os.path.join(VAR_DIR, "edge_ai_build")
CHARTS_DIR = VAR_DIR  # feature_importance.png etc. from the demo scripts

FIRMWARE_DIR = os.path.join(ROOT, "firmware")

os.makedirs(VAR_DIR, exist_ok=True)
