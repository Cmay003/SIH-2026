# Sample SOPs

These files are **samples** for the RAG alert pipeline (`rag_alert_pipeline.py`).
The text is retrieved and quoted inside alert messages, so keep it short,
factual and action-oriented.

They contain only general, widely published guidance (NDMA / IMD heat and
landslide advice, CPCB air-quality advice, WHO boil-water advice).
`flash_flood_response.txt` and `smoke_response.txt` (added 2026-10-09) are
generic safety steps written for this project, not quoted from any source;
they say so at the top and need an expert's review first. The same holds
for `heavy_rain_response.txt` and `high_wind_response.txt` (added
2026-10-09 with the extreme-weather hazards).
**Before any real deployment, replace them with the official SOPs of the
district / state disaster management authority you work with**, including
local shelter locations and contact numbers.

Each hazard type maps to one file in `HAZARD_SOURCE_MAP` in
`rag_alert_pipeline.py`; add a mapping when you add a file.
