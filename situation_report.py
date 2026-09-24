"""
SANJEEVNI - Auto-generated PDF situation reports.

Generates a one-page (or more, for longer timelines) PDF summarizing a
hazard event: what happened, when, the AI's reasoning (SHAP), and the
lead-up readings - for an audit trail and post-incident review, or to
hand to an official who wants a document rather than a dashboard.
"""

from datetime import datetime
from fpdf import FPDF

SEVERITY_COLORS = {
    "LOW": (46, 125, 50),
    "MEDIUM": (214, 162, 60),
    "HIGH": (209, 104, 60),
    "CRITICAL": (225, 75, 69),
}


class SituationReportPDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 16)
        self.set_text_color(27, 94, 32)
        self.cell(0, 10, "SANJEEVNI - Situation Report", ln=True)
        self.set_font("Helvetica", "", 9)
        self.set_text_color(100, 100, 100)
        self.cell(0, 6, f"Generated {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", ln=True)
        self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 10, f"Page {self.page_no()} - SANJEEVNI Disaster Rescue System", align="C")


def generate_situation_report_pdf(
    event: dict, timeline: list, output_path: str
) -> str:
    """event: the alert reading (dict, from the readings table).
    timeline: list of preceding readings for the same node, oldest first,
    for the "lead-up" section (event replay in document form).
    Writes the PDF to output_path and returns it."""
    pdf = SituationReportPDF()
    pdf.add_page()

    severity = event.get("severity", "LOW")
    color = SEVERITY_COLORS.get(severity, (100, 100, 100))

    # --- Event summary box ---
    pdf.set_fill_color(*color)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 10, f"  {severity} - {(event.get('hazard_type') or 'unknown').upper()}", fill=True, ln=True)
    pdf.ln(2)

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 11)
    summary_rows = [
        ("Node", event.get("node_id", "-")),
        ("Location", event.get("location", "-")),
        ("Timestamp", event.get("timestamp", "-")),
        ("Risk score", f"{event.get('risk_score', 0):.3f}" if event.get("risk_score") is not None else "-"),
        ("Severity source", event.get("severity_source", "-")),
        ("River level", f"{event.get('river_level_m', '-')} m"),
        ("Temperature", f"{event.get('temp_c', '-')} C"),
        ("Humidity", f"{event.get('humidity_pct', '-')}%"),
        ("Gas reading", f"{event.get('gas_ppm', '-')} ppm"),
    ]
    for label, value in summary_rows:
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(45, 7, str(label))
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(0, 7, str(value), ln=True)

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
