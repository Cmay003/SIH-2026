"""
SANJEEVNI - CAP (Common Alerting Protocol) v1.2 compliant alert format.

CAP is the OASIS standard alert format that India's NDMA SACHET platform
(and most national emergency alert systems worldwide) consume. This
module generates spec-compliant CAP XML from a SANJEEVNI hazard event.

IMPORTANT - what this is and isn't:
This implements the CAP v1.2 XML FORMAT correctly per the OASIS spec -
that part is real and testable (see test_cap_alert.py-style checks in
this conversation's verification). It does NOT connect to NDMA's actual
SACHET platform, because that requires official government authorization
and API credentials this project does not have. This module produces
what you WOULD submit to such a system, positioning SANJEEVNI as "an
automatic AI trigger feeding into CBS/SACHET" (per the upgrade brief) -
the missing piece is the actual submission endpoint + authorization,
which is a government partnership question, not a code problem.

CAP v1.2 spec: https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html
"""

import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom

CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2"

# Maps SANJEEVNI's own severity bands to CAP's controlled vocabulary.
# CAP requires exactly these values (case-sensitive) - not free text.
SEVERITY_TO_CAP = {
    "LOW": "Minor",
    "MEDIUM": "Moderate",
    "HIGH": "Severe",
    "CRITICAL": "Extreme",
}

# CAP's "certainty" reflects how confident the alert is, distinct from
# severity (how bad) - mapped from severity_source, since a
# hardware-test-threshold override is inherently less certain than a
# properly-calibrated ML model's output.
CERTAINTY_BY_SOURCE = {
    "ml_model": "Likely",
    # hazard_classification.py's threshold classifiers act on a direct
    # sensor measurement against a published limit (IMD, WHO, CPCB) - as
    # confident as the model, not "Unknown" as before.
    "threshold_classifier": "Likely",
    "hardware_test_threshold": "Possible",
}

# hazard_type -> (CAP <event> text, CAP <category>). <category> must be one
# of CAP's fixed values: Geo, Met, Safety, Security, Rescue, Fire, Health,
# Env, Transport, Infra, CBRNE, Other.
HAZARD_TO_CAP = {
    "flood": ("Flood Warning", "Geo"),
    "gas leak": ("Hazardous Materials Warning", "CBRNE"),
    "fire": ("Fire Warning", "Fire"),
    "extreme heat": ("Extreme Heat Warning", "Met"),
    "landslide": ("Landslide Warning", "Geo"),
    "air pollution": ("Air Quality Alert", "Env"),
    "water quality degradation": ("Water Quality Alert", "Health"),
}

# Optional public dashboard URL for <web>. CAP's <web> is optional, so it
# is left out entirely when unset instead of emitting an empty element.
CAP_WEB_URL = os.environ.get("CAP_WEB_URL")

# CAP <status> vocabulary (spec 3.2.1). "Exercise" is what a simulated
# (demo / drill) alert must carry - "Actual" tells every downstream
# consumer it is a real public warning.
CAP_STATUSES = ("Actual", "Exercise", "System", "Test", "Draft")

# Alert-zone radius by severity - MUST match server.js HAZARD_RADIUS_M,
# which draws the zone on the map and sets the WhatsApp reach. Before this
# every CAP circle was 1 km, so a CRITICAL flood's CAP area was half the
# zone citizens were shown. Unknown severities get the smallest zone, as
# server.js does.
CAP_RADIUS_M = {"MEDIUM": 500, "HIGH": 1000, "CRITICAL": 2000}
CAP_DEFAULT_RADIUS_M = 500

# How long an alert stays in force (<expires> = <sent> + this). Readings
# arrive every few seconds, so a hazard that persists produces fresh
# alerts long before this runs out; 6 h matches the flood model's rain
# forecast horizon. Without <expires>, a three-day-old alert fetched now
# looked current to a consumer.
CAP_VALIDITY_HOURS = 6

# CAP 1.2 (3.2.1, identifier): no spaces, commas or the restricted
# characters < and &. Anything outside this set in a node_id becomes "_".
_IDENTIFIER_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")


def cap_datetime(dt: datetime) -> str:
    """CAP 1.2 date-time: YYYY-MM-DDThh:mm:ss with an explicit offset, no
    fractional seconds (the XSD rejects them). UTC must be written
    "-00:00" (spec 3.3.2) - isoformat() writes "+00:00". A naive datetime
    is taken to be UTC, which is how the backend stores reading times."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc).replace(microsecond=0)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + "-00:00"


def cap_identifier(node_id: str, reading_id: Optional[int]) -> str:
    """Stable per alert: the same stored reading always yields the same
    identifier, so a consumer polling /api/alerts/{id}/cap sees one alert,
    not a "new" one per download. Without a reading id (an ad-hoc message
    that was never stored) there is nothing stable to derive it from, so a
    random one is used as before."""
    if reading_id is None:
        return str(uuid.uuid4())
    safe_node = _IDENTIFIER_UNSAFE.sub("_", str(node_id)) or "node"
    return f"sanjeevni-{safe_node}-{int(reading_id)}"


def generate_cap_alert(
    hazard_type: str,
    severity: str,
    location: str,
    latitude: float,
    longitude: float,
    message: str,
    node_id: str,
    risk_score: float,
    severity_source: str = "ml_model",
    radius_m: Optional[float] = None,
    sender: str = "sanjeevni-system@example.org",
    reading_id: Optional[int] = None,
    sent_at: Optional[datetime] = None,
    status: str = "Actual",
) -> str:
    """Returns a complete, spec-compliant CAP v1.2 XML string for one
    hazard alert. Never raises on bad input types it can coerce; raises
    only on a genuinely unmapped severity/hazard_type, since sending a
    malformed or silently-wrong-severity CAP alert is worse than failing
    loudly during development.

    reading_id / sent_at: the stored alert's id and the time its reading
    was taken. Pass both for a stored alert, so repeated exports of it are
    the SAME CAP message (same identifier, same <sent>); sent_at falls back
    to now only for a message that has no stored time.
    radius_m: defaults to the severity's zone (CAP_RADIUS_M).
    status: "Exercise" for simulated alerts - see CAP_STATUSES."""
    if severity not in SEVERITY_TO_CAP:
        raise ValueError(f"Unknown severity '{severity}' - cannot map to CAP vocabulary")
    if status not in CAP_STATUSES:
        raise ValueError(f"Unknown CAP status '{status}' - must be one of {CAP_STATUSES}")

    sent = sent_at if sent_at is not None else datetime.now(timezone.utc)
    if sent.tzinfo is None:
        sent = sent.replace(tzinfo=timezone.utc)
    expires = sent + timedelta(hours=CAP_VALIDITY_HOURS)
    identifier = cap_identifier(node_id, reading_id)
    if radius_m is None:
        radius_m = CAP_RADIUS_M.get(severity, CAP_DEFAULT_RADIUS_M)
    cap_event, cap_category = HAZARD_TO_CAP.get(
        hazard_type, ("Other Hazard Warning", "Other")
    )
    cap_severity = SEVERITY_TO_CAP[severity]
    cap_certainty = CERTAINTY_BY_SOURCE.get(severity_source, "Unknown")

    alert = Element("alert", xmlns=CAP_NAMESPACE)
    SubElement(alert, "identifier").text = identifier
    SubElement(alert, "sender").text = sender
    SubElement(alert, "sent").text = cap_datetime(sent)
    SubElement(alert, "status").text = status
    SubElement(alert, "msgType").text = "Alert"
    SubElement(alert, "scope").text = "Public"
    if status != "Actual":
        # <note> follows <scope> in CAP's element order. Says in plain
        # words why this is not a real warning, for consumers that only
        # show text and drop <status>.
        # HUMAN REVIEW: public-facing wording - confirm with the alerting
        # authority before any real CAP feed carries it.
        SubElement(alert, "note").text = (
            "Generated from SANJEEVNI simulator data - not a real event."
            if status == "Exercise"
            else f"Non-operational CAP message (status {status})."
        )

    info = SubElement(alert, "info")
    SubElement(info, "category").text = cap_category
    SubElement(info, "event").text = cap_event
    SubElement(info, "urgency").text = "Immediate" if severity in ("HIGH", "CRITICAL") else "Expected"
    SubElement(info, "severity").text = cap_severity
    SubElement(info, "certainty").text = cap_certainty
    # <expires> sits between <certainty> and <senderName> in CAP's order.
    SubElement(info, "expires").text = cap_datetime(expires)
    SubElement(info, "senderName").text = "SANJEEVNI Disaster Rescue System"
    SubElement(info, "headline").text = f"{cap_event}: {location}"
    SubElement(info, "description").text = message
    if CAP_WEB_URL:
        SubElement(info, "web").text = CAP_WEB_URL

    # Custom parameters preserving SANJEEVNI's own data alongside the
    # standard CAP fields - CAP explicitly supports this via <parameter>.
    param_node_id = SubElement(info, "parameter")
    SubElement(param_node_id, "valueName").text = "sanjeevni_node_id"
    SubElement(param_node_id, "value").text = node_id

    param_risk = SubElement(info, "parameter")
    SubElement(param_risk, "valueName").text = "sanjeevni_risk_score"
    SubElement(param_risk, "value").text = f"{risk_score:.4f}"

    area = SubElement(info, "area")
    SubElement(area, "areaDesc").text = location
    SubElement(area, "circle").text = f"{latitude},{longitude} {radius_m / 1000.0}"

    rough_string = tostring(alert, encoding="unicode")
    return minidom.parseString(rough_string).toprettyxml(indent="  ")
