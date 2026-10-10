"""
SANJEEVNI - Multi-node cross-check before an alert goes public.

A single reading is never enough to send a PUBLIC alert. An elevated
(MEDIUM+) assessment is only confirmed when there is independent
corroboration within CONFIRM_WINDOW_MINUTES:

  1. persistence - the SAME node assessed the same hazard_type as MEDIUM+
     again (a one-off sensor spike or glitch does not repeat), or
  2. neighbour   - ANOTHER node within CROSS_CHECK_RADIUS_KM, or linked to
     this one as upstream/downstream, assessed the same hazard (or one of
     the same physical event - HAZARD_FAMILY) as MEDIUM+.

A sensor the node itself reports as STUCK repeats its frozen value by
definition, so such an assessment gets no persistence basis and is no
evidence for a neighbour either: only an independent node can confirm it.

Unconfirmed alerts are NOT discarded: they are stored as
"pending_confirmation", shown to officers immediately, and kept off the
public map, citizen pages and CAP feed until confirmed. Dropping them
would hide a real hazard that only one node can see; publishing them
would turn every sensor glitch into a public alarm.

Cost: one extra reading interval (5s on an always-on node) before a
hazard goes public. Deep-sleep nodes should wake early when a local
reading is elevated, or this delay becomes their full sleep interval.

FORECAST-ONLY alerts (heavy_rain / high_wind raised by the weather
forecast alone - result["forecast_based"]) follow a different rule,
because neither check above means anything for them: every reading of the
node re-reads the SAME cached forecast, so a "repeat" is the forecast
agreeing with itself, and every neighbour sees the same area forecast, so
a "neighbour" is not independent either - and no node can measure wind.
So a forecast-only assessment is confirmed by its external source, basis
"forecast", and is never recorded as evidence for anything else. What
keeps that safe:
  - it is capped at HIGH (hazard_classification / integration_pipeline),
    so it can never be a confirmed CRITICAL and auto-sound a siren;
  - its confidence says it is forecast-based and is at most Medium
    (alert_confidence.CONFIRMATION_SCORES["forecast"]), and its CAP export
    is urgency "Future", certainty at most "Possible"
    (cap_alert.CAP_CERTAINTY_CAP_BY_SOURCE);
  - a MOCK forecast (SANJEEVNI_WEATHER_MOCK - a test file) is applied to
    SIMULATED readings only (backend_server.fetch_weather_forecast), and
    confirms only a simulated reading: should a mock result ever reach a
    real node's reading it stays pending (defence in depth), so a test
    file left configured can never put a public alert out.
When the node's own rain gauge ALSO measures heavy rain and the gauge sets
the severity (basis "measured", or "both" with the forecast no higher
band), the alert is not forecast-only and the normal rule applies. A
forecast in a HIGHER band than the gauge sets the severity itself, so that
result is forecast_based and follows the forecast rule above.
"""

import math
from collections import deque
from datetime import datetime, timedelta

CONFIRM_WINDOW_MINUTES = 10
CROSS_CHECK_RADIUS_KM = 5.0
ELEVATED_SEVERITIES = ("MEDIUM", "HIGH", "CRITICAL")
# Confirmation basis of a forecast-only alert (see the module docstring).
FORECAST_BASIS = "forecast"
# hazard_types that are the same physical event seen by different checks,
# so a NEIGHBOUR's one corroborates the other: a flash flood (fast rise) at
# one node and a level-based flood at its upstream neighbour are the same
# water, and smoke next to a flame-confirmed fire is the same fire.
# Anything not listed is its own family.
# Families are NOT used for persistence at the same node: there both types
# come from the same sensor (or the same suspect one - a sunlit flame
# sensor), so an earlier slow-flood MEDIUM "confirming" a first flash-flood
# CRITICAL would be the node agreeing with itself, and would auto-sound the
# siren on one reading.
HAZARD_FAMILY = {"flash_flood": "flood", "smoke": "fire"}


def hazard_family(hazard_type: str) -> str:
    return HAZARD_FAMILY.get(hazard_type, hazard_type)


_ASSESSMENT_HISTORY = 50  # per node, plenty for a 10-minute window


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class HazardConfirmer:
    """Remembers recent elevated assessments per node and decides whether a
    new one is corroborated. In-memory: after a restart the first elevated
    reading of each hazard waits for one corroborating reading again."""

    def __init__(self):
        # node_id -> deque[(datetime, hazard_type, simulated)]. Assessments
        # made on a stuck sensor are not recorded (see assess).
        self._recent: dict[str, deque] = {}

    def neighbours(self, node_id: str, registry: dict) -> list[str]:
        """Nodes close enough, or hydrologically linked, to corroborate."""
        cfg = registry.get(node_id)
        if not cfg:
            return []
        result = []
        # Snapshot: an admin edit can reload the registry while we loop.
        for other_id, other in list(registry.items()):
            if other_id == node_id:
                continue
            linked = cfg.get("upstream_node") == other_id or other.get("upstream_node") == node_id
            close = (
                None not in (cfg.get("latitude"), cfg.get("longitude"), other.get("latitude"), other.get("longitude"))
                and haversine_km(cfg["latitude"], cfg["longitude"], other["latitude"], other["longitude"])
                <= CROSS_CHECK_RADIUS_KM
            )
            if linked or close:
                result.append(other_id)
        return result

    def _seen_recently(self, node_id: str, hazard_type: str, now: datetime, simulated: bool,
                       same_type_only: bool = False) -> bool:
        """A simulated assessment never counts as evidence for a REAL one.
        The documented demo mixes real hardware with simulation.js on
        nearby nodes; without this check a scripted simulator event
        confirmed a single glitchy real reading, which then reached the
        public map and real WhatsApp subscribers. A real assessment may
        still corroborate a simulated one: real evidence is real, and
        simulated alerts never reach real people anyway.
        same_type_only: match the exact hazard_type, not its family (the
        persistence check - see HAZARD_FAMILY)."""
        window_start = now - timedelta(minutes=CONFIRM_WINDOW_MINUTES)
        key = (lambda h: h) if same_type_only else hazard_family
        wanted = key(hazard_type)
        return any(
            window_start <= ts <= now and key(h) == wanted and (simulated or not was_simulated)
            for ts, h, was_simulated in self._recent.get(node_id, ())
        )

    def assess(self, node_id: str, hazard_type: str, severity: str, now: datetime, registry: dict,
               simulated: bool = False, sensor_stuck: bool = False,
               forecast_only: bool = False, forecast_source: str | None = None):
        """Returns (confirmed, basis) for this assessment and records it.
        basis is "persistent", "neighbour:<node_id>", or None when
        unconfirmed. Non-elevated severities return (False, None) and are
        not recorded. `simulated` marks simulator traffic, which can never
        confirm a real assessment (see _seen_recently).
        sensor_stuck: the node reports a sensor THIS hazard reads as stuck
        (alert_confidence.stuck_hazard_fields). A frozen value always
        "repeats", so persistence is skipped and the assessment is not
        recorded (it must not confirm a later reading of this node, or a
        neighbour's). Only a neighbour can confirm it.
        forecast_only / forecast_source: the alert comes from the weather
        forecast alone - see the module docstring (basis "forecast"; a
        "mock" forecast confirms only simulated readings). Not recorded."""
        if severity not in ELEVATED_SEVERITIES:
            return False, None
        if forecast_only:
            if forecast_source == "mock" and not simulated:
                return False, None
            return True, FORECAST_BASIS

        basis = None
        if not sensor_stuck and self._seen_recently(node_id, hazard_type, now, simulated,
                                                    same_type_only=True):
            basis = "persistent"
        else:
            for other_id in self.neighbours(node_id, registry):
                if self._seen_recently(other_id, hazard_type, now, simulated):
                    basis = f"neighbour:{other_id}"
                    break

        if not sensor_stuck:
            self._recent.setdefault(node_id, deque(maxlen=_ASSESSMENT_HISTORY)).append(
                (now, hazard_type, bool(simulated))
            )
        return basis is not None, basis
