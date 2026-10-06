"""
SANJEEVNI - Multi-node cross-check before an alert goes public.

A single reading is never enough to send a PUBLIC alert. An elevated
(MEDIUM+) assessment is only confirmed when there is independent
corroboration within CONFIRM_WINDOW_MINUTES:

  1. persistence - the SAME node assessed the same hazard as MEDIUM+ again
     (a one-off sensor spike or glitch does not repeat), or
  2. neighbour   - ANOTHER node within CROSS_CHECK_RADIUS_KM, or linked to
     this one as upstream/downstream, assessed the same hazard as MEDIUM+.

Unconfirmed alerts are NOT discarded: they are stored as
"pending_confirmation", shown to officers immediately, and kept off the
public map, citizen pages and CAP feed until confirmed. Dropping them
would hide a real hazard that only one node can see; publishing them
would turn every sensor glitch into a public alarm.

Cost: one extra reading interval (5s on an always-on node) before a
hazard goes public. Deep-sleep nodes should wake early when a local
reading is elevated, or this delay becomes their full sleep interval.
"""

import math
from collections import deque
from datetime import datetime, timedelta

CONFIRM_WINDOW_MINUTES = 10
CROSS_CHECK_RADIUS_KM = 5.0
ELEVATED_SEVERITIES = ("MEDIUM", "HIGH", "CRITICAL")
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
        self._recent: dict[str, deque] = {}  # node_id -> deque[(datetime, hazard_type)]

    def neighbours(self, node_id: str, registry: dict) -> list[str]:
        """Nodes close enough, or hydrologically linked, to corroborate."""
        cfg = registry.get(node_id)
        if not cfg:
            return []
        result = []
        for other_id, other in registry.items():
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

    def _seen_recently(self, node_id: str, hazard_type: str, now: datetime) -> bool:
        window_start = now - timedelta(minutes=CONFIRM_WINDOW_MINUTES)
        return any(
            window_start <= ts <= now and h == hazard_type
            for ts, h in self._recent.get(node_id, ())
        )

    def assess(self, node_id: str, hazard_type: str, severity: str, now: datetime, registry: dict):
        """Returns (confirmed, basis) for this assessment and records it.
        basis is "persistent", "neighbour:<node_id>", or None when
        unconfirmed. Non-elevated severities return (False, None) and are
        not recorded."""
        if severity not in ELEVATED_SEVERITIES:
            return False, None

        basis = None
        if self._seen_recently(node_id, hazard_type, now):
            basis = "persistent"
        else:
            for other_id in self.neighbours(node_id, registry):
                if self._seen_recently(other_id, hazard_type, now):
                    basis = f"neighbour:{other_id}"
                    break

        self._recent.setdefault(node_id, deque(maxlen=_ASSESSMENT_HISTORY)).append(
            (now, hazard_type)
        )
        return basis is not None, basis
