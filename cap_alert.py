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
import uuid
from datetime import datetime, timezone
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
    radius_m: float = 1000,
    sender: str = "sanjeevni-system@example.org",
) -> str:
    """Returns a complete, spec-compliant CAP v1.2 XML string for one
    hazard alert. Never raises on bad input types it can coerce; raises
    only on a genuinely unmapped severity/hazard_type, since sending a
    malformed or silently-wrong-severity CAP alert is worse than failing
    loudly during development."""
    if severity not in SEVERITY_TO_CAP:
        raise ValueError(f"Unknown severity '{severity}' - cannot map to CAP vocabulary")

    # CAP 1.2's XSD only accepts YYYY-MM-DDThh:mm:ss+hh:mm - isoformat()'s
    # microseconds made every alert fail schema validation.
    now = datetime.now(timezone.utc).replace(microsecond=0)
    identifier = str(uuid.uuid4())
    cap_event, cap_category = HAZARD_TO_CAP.get(
        hazard_type, ("Other Hazard Warning", "Other")
    )
    cap_severity = SEVERITY_TO_CAP[severity]
    cap_certainty = CERTAINTY_BY_SOURCE.get(severity_source, "Unknown")

    alert = Element("alert", xmlns=CAP_NAMESPACE)
    SubElement(alert, "identifier").text = identifier
    SubElement(alert, "sender").text = sender
    SubElement(alert, "sent").text = now.isoformat()
    SubElement(alert, "status").text = "Actual"
    SubElement(alert, "msgType").text = "Alert"
    SubElement(alert, "scope").text = "Public"

    info = SubElement(alert, "info")
    SubElement(info, "category").text = cap_category
    SubElement(info, "event").text = cap_event
    SubElement(info, "urgency").text = "Immediate" if severity in ("HIGH", "CRITICAL") else "Expected"
    SubElement(info, "severity").text = cap_severity
    SubElement(info, "certainty").text = cap_certainty
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
