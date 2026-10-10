"""
SANJEEVNI - Auto-generated PDF situation reports.

Generates a one-page (or more, for longer timelines) PDF summarizing a
hazard event: what happened, when, the AI's reasoning (SHAP), and the
lead-up readings - for an audit trail and post-incident review, or to
hand to an official who wants a document rather than a dashboard.
"""

import json
from datetime import datetime
from fpdf import FPDF

# fpdf 1.7's built-in fonts are Latin-1 only: one "→", "₹" or Hindi place
# name anywhere in the report raised UnicodeEncodeError and the endpoint
# returned 500. Common symbols get ASCII stand-ins; anything else outside
# Latin-1 (e.g. Devanagari) becomes "?" - a readable report with a few
# "?" beats no report. Full Unicode needs fpdf2 plus a bundled TTF font.
_PDF_REPLACEMENTS = {
    "→": "->", "←": "<-", "₹": "Rs.", "–": "-", "—": "-",
    "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...",
    "⚠": "!", "✅": "",
}


def _pdf_text(value) -> str:
    text = str(value)
    for symbol, replacement in _PDF_REPLACEMENTS.items():
        text = text.replace(symbol, replacement)
    return text.encode("latin-1", errors="replace").decode("latin-1")


SEVERITY_COLORS = {
    "LOW": (46, 125, 50),
    "MEDIUM": (214, 162, 60),
    "HIGH": (209, 104, 60),
    "CRITICAL": (225, 75, 69),
}


# Printed at the top of EVERY page of a report built on simulator data
# (readings.simulated - simulation.js / the judge demo), so a printed or
# forwarded page can never pass for a real incident report. Same meaning
# as the CAP export's status "Exercise" and the Atom feed's "[EXERCISE]".
EXERCISE_BANNER = "EXERCISE - SIMULATED DATA, NOT A REAL EVENT"

# forecast_source column -> who made the forecast (backend_server.
# fetch_weather_forecast); same names as alert_confidence.
FORECAST_SOURCE_TEXT = {
    "open-meteo": "Open-Meteo weather forecast",
    "mock": "TEST forecast file (SANJEEVNI_WEATHER_MOCK), not a live forecast",
}


def is_exercise(event: dict) -> bool:
    """True when the alert came from simulated (synthetic) readings."""
    value = event.get("simulated")
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes")
    return bool(value)


def _forecast_text(event: dict):
    """The "Forecast-based" row, or None when the severity came from the
    node's own measurement (severity_source != "weather_forecast")."""
    if event.get("severity_source") != "weather_forecast":
        return None
    source = FORECAST_SOURCE_TEXT.get(event.get("forecast_source"), "an external weather forecast")
    return f"Yes - from {source}; not measured by SANJEEVNI sensors"


def _confirmation_text(event: dict) -> str:
    """How (or whether) the alert was confirmed - hazard_confirmation's
    basis, as stored in readings.confirmation."""
    basis = event.get("confirmation")
    if event.get("status") == "pending_confirmation" or basis == "unconfirmed":
        return "NOT confirmed (single assessment; officers only, not public)"
    if not basis:
        return "-"
    if basis == "persistent":
        return "Persistent - the same node repeated the assessment"
    if basis.startswith("neighbour:"):
        return f"Neighbour - corroborated by {basis.split(':', 1)[1]}"
    if basis == "forecast":
        return "Forecast - confirmed by its external forecast source, not by nodes"
    return basis


class SituationReportPDF(FPDF):
    # Set before add_page(): header() prints the EXERCISE banner on every
    # page of a report built on simulated data.
    exercise = False

    # Every piece of text goes through cell()/multi_cell(), so sanitizing
    # here covers all current and future report fields in one place.
    def cell(self, w, h=0, txt="", *args, **kwargs):
        return super().cell(w, h, _pdf_text(txt), *args, **kwargs)

    def multi_cell(self, w, h, txt, *args, **kwargs):
        return super().multi_cell(w, h, _pdf_text(txt), *args, **kwargs)

    def header(self):
        if self.exercise:
            self.set_fill_color(180, 30, 30)
            self.set_text_color(255, 255, 255)
            self.set_font("Helvetica", "B", 12)
            self.cell(0, 9, EXERCISE_BANNER, fill=True, ln=True, align="C")
            self.ln(1)
        self.set_font("Helvetica", "B", 16)
        self.set_text_color(27, 94, 32)
        title = "SANJEEVNI - Situation Report"
        self.cell(0, 10, title + (" (EXERCISE)" if self.exercise else ""), ln=True)
        self.set_font("Helvetica", "", 9)
        self.set_text_color(100, 100, 100)
        self.cell(0, 6, f"Generated {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", ln=True)
        self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 10, f"Page {self.page_no()} - SANJEEVNI Disaster Rescue System", align="C")


def _confidence_text(event: dict) -> str:
    """"Medium (60%)" from the stored confidence columns, "-" for an alert
    from before scores existed (alert_confidence.py)."""
    score = event.get("confidence")
    if not isinstance(score, (int, float)):
        return "-"
    label = event.get("confidence_label")
    pct = f"{round(score * 100)}%"
    return f"{label} ({pct})" if label else pct


def _confidence_reasons(event: dict) -> list:
    """The stored JSON reasons list, as latin-1-safe strings (the PDF's
    core font cannot draw other characters); [] when absent or unreadable."""
    try:
        reasons = json.loads(event.get("confidence_reasons") or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(reasons, list):
        return []
    return [str(r).encode("latin-1", "replace").decode("latin-1") for r in reasons[:8] if isinstance(r, str)]


def generate_situation_report_pdf(
    event: dict, timeline: list, output_path: str
) -> str:
    """event: the alert reading (dict, from the readings table).
    timeline: list of preceding readings for the same node, oldest first,
    for the "lead-up" section (event replay in document form).
    Writes the PDF to output_path and returns it."""
    pdf = SituationReportPDF()
    pdf.exercise = is_exercise(event)
    pdf.add_page()

    severity = event.get("severity", "LOW")
    color = SEVERITY_COLORS.get(severity, (100, 100, 100))

    # --- Event summary box ---
    pdf.set_fill_color(*color)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 10, f"  {severity} - {(event.get('hazard_type') or 'unknown').replace('_', ' ').upper()}", fill=True, ln=True)
    pdf.ln(2)

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 11)
    summary_rows = [
        ("Data", "SIMULATED / synthetic (exercise)" if pdf.exercise else "Live sensor data"),
        ("Node", event.get("node_id", "-")),
        ("Location", event.get("location", "-")),
        ("Timestamp", event.get("timestamp", "-")),
        ("Risk score", f"{event.get('risk_score', 0):.3f}" if event.get("risk_score") is not None else "-"),
        ("Severity source", event.get("severity_source", "-")),
    ]
    forecast = _forecast_text(event)
    if forecast:
        summary_rows.append(("Forecast-based", forecast))
    summary_rows += [
        ("Confirmation", _confirmation_text(event)),
        ("Confidence", _confidence_text(event)),
        ("River level", f"{event.get('river_level_m', '-')} m"),
        ("Temperature", f"{event.get('temp_c', '-')} C"),
        ("Humidity", f"{event.get('humidity_pct', '-')}%"),
        ("Gas reading", f"{event.get('gas_ppm', '-')} ppm"),
    ]
    for label, value in summary_rows:
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(45, 7, str(label))
        pdf.set_font("Helvetica", "", 10)
        # multi_cell: the forecast / confirmation texts can be longer
        # than one line, and cell() would run them off the page
        pdf.multi_cell(0, 7, str(value))

    reasons = _confidence_reasons(event)
    if reasons:
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(0, 7, "Confidence reasons:", ln=True)
        pdf.set_font("Helvetica", "", 9)
        for reason in reasons:
            pdf.multi_cell(0, 5, f"- {reason}")

    pdf.ln(3)
    if event.get("message"):
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 8, "Alert message:", ln=True)
        pdf.set_font("Helvetica", "", 10)
        pdf.multi_cell(0, 6, event["message"])
        pdf.ln(2)

    # --- Timeline / event replay section ---
    if timeline:
        pdf.ln(2)
        pdf.set_font("Helvetica", "B", 12)
        pdf.set_text_color(27, 94, 32)
        pdf.cell(0, 8, "Lead-up timeline", ln=True)
        pdf.set_text_color(0, 0, 0)

        pdf.set_font("Helvetica", "B", 9)
        pdf.set_fill_color(230, 240, 230)
        col_widths = [35, 25, 25, 25, 25, 25]
        headers = ["Time", "River (m)", "Temp (C)", "Gas (ppm)", "Risk", "Severity"]
        for w, h in zip(col_widths, headers):
            pdf.cell(w, 7, h, border=1, fill=True)
        pdf.ln()

        pdf.set_font("Helvetica", "", 8)
        for r in timeline[-20:]:  # cap at 20 rows to keep the report readable
            values = [
                str(r.get("timestamp", "-"))[:19],
                f"{r.get('river_level_m', 0):.3f}" if r.get("river_level_m") is not None else "-",
                f"{r.get('temp_c', 0):.1f}" if r.get("temp_c") is not None else "-",
                f"{r.get('gas_ppm', 0):.0f}" if r.get("gas_ppm") is not None else "-",
                f"{r.get('risk_score', 0):.3f}" if r.get("risk_score") is not None else "-",
                str(r.get("severity", "-")),
            ]
            for w, v in zip(col_widths, values):
                pdf.cell(w, 6, v, border=1)
            pdf.ln()

    pdf.output(output_path)
    return output_path
