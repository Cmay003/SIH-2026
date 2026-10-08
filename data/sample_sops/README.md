# Sample SOPs

These files are **samples** for the RAG alert pipeline (`rag_alert_pipeline.py`).
The text is retrieved and quoted inside alert messages, so keep it short,
factual and action-oriented.

They contain only general, widely published guidance (NDMA / IMD heat and
landslide advice, CPCB air-quality advice, WHO boil-water advice).
**Before any real deployment, replace them with the official SOPs of the
district / state disaster management authority you work with**, including
local shelter locations and contact numbers.

Each hazard type maps to one file in `HAZARD_SOURCE_MAP` in
`rag_alert_pipeline.py`; add a mapping when you add a file.
