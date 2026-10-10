// Latest sensor values for the officer map (node popup + side panel) and the
// hotspot layer's classes. Values come from GET /api/officer/nodes/:id/latest
// (server.js latestNodeValues), hotspots from GET /api/officer/heatmap.
import type { HotspotLevel, NodeLatest, NodeValueField, NodeValue } from "../api/types";

// ---------------------------------------------------------------- NAQI bands
// CPCB National Air Quality Index, "About National Air Quality Index"
// (https://cpcb.gov.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvQWJvdXRfQVFJLnBkZg==,
// read 2026-10-09). Concentration ranges in ug/m3, 24-hourly average:
//   category             PM10      PM2.5
//   Good                 0-50      0-30
//   Satisfactory         51-100    31-60
//   Moderately polluted  101-250   61-90
//   Poor                 251-350   91-120
//   Very Poor            351-430   121-250
//   Severe               430+      250+
// The same table backs backend/hazard_classification.py (PM25_BAND_TOPS /
// PM10_BAND_TOPS), with the same edge rule: a value counts as the next
// category only once it is ABOVE a band's top. CPCB defines the bands on
// 24-h averages; a node sends one instantaneous reading, so the popup says
// "indicative".
export const NAQI_CATEGORIES = ["Good", "Satisfactory", "Moderately polluted", "Poor", "Very Poor", "Severe"] as const;
export type NaqiCategory = (typeof NAQI_CATEGORIES)[number];
const NAQI_TOPS = {
  pm25: [30, 60, 90, 120, 250],
  pm10: [50, 100, 250, 350, 430],
} as const;

export function naqiCategory(pollutant: "pm25" | "pm10", value: number | null | undefined): NaqiCategory | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const tops = NAQI_TOPS[pollutant];
  const i = tops.findIndex((top) => value <= top);
  return NAQI_CATEGORIES[i === -1 ? tops.length : i];
}

// ------------------------------------------------------------- sensor rows
/** FLAME_DETECT_THRESHOLD in backend/hazard_classification.py (flame_reading is 0..1). */
export const FLAME_DETECT_THRESHOLD = 0.3;

export interface SensorRowDef {
  field: NodeValueField;
  label: string;
  /** shown after the number; "" = unitless */
  unit: string;
  digits: number;
  /** full text for a value, when a plain number + unit is not enough */
  format?: (value: number) => string;
  /** shown under the value: what the number can and cannot tell */
  note?: string;
}

const signed = (v: number, digits: number) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

/** Every sensor a node can carry, in popup order (server.js NODE_VALUE_FIELDS). */
export const SENSOR_ROWS: readonly SensorRowDef[] = [
  { field: "river_level_m", label: "River level", unit: "m", digits: 2 },
  { field: "river_level_rate_m_per_hr", label: "River rise rate", unit: "m/h", digits: 2,
    format: (v) => `${signed(v, 2)} m/h` },
  { field: "pm25_ugm3", label: "PM2.5", unit: "µg/m³", digits: 0 },
  { field: "pm10_ugm3", label: "PM10", unit: "µg/m³", digits: 0 },
  { field: "gas_ppm", label: "Gas", unit: "ppm", digits: 0 },
  { field: "flame_reading", label: "Flame sensor", unit: "", digits: 2,
    format: (v) => `${v >= FLAME_DETECT_THRESHOLD ? "flame detected" : "no flame"} (${v.toFixed(2)})` },
  { field: "temp_c", label: "Temperature", unit: "°C", digits: 1 },
  { field: "humidity_pct", label: "Humidity", unit: "%", digits: 0 },
  { field: "tilt_angle_deg", label: "Tilt", unit: "°", digits: 1 },
  { field: "vibration_magnitude", label: "Vibration", unit: "", digits: 2 },
  { field: "soil_moisture_pct", label: "Soil moisture", unit: "%", digits: 0 },
  { field: "water_ph", label: "Water pH", unit: "", digits: 1 },
  { field: "turbidity_ntu", label: "Turbidity", unit: "NTU", digits: 0 },
  { field: "rainfall_24h_mm", label: "Rain, last 24 h", unit: "mm", digits: 1,
    note: "0 mm is also shown for a node without a rain gauge" },
  { field: "battery_pct", label: "Battery", unit: "%", digits: 0 },
  { field: "signal_strength_dbm", label: "Signal", unit: "dBm", digits: 0 },
];

export function formatSensorValue(row: SensorRowDef, value: number): string {
  if (row.format) return row.format(value);
  const n = value.toFixed(row.digits);
  return row.unit ? `${n} ${row.unit}` : n;
}

/** "Very Poor" for PM rows (with the reading), else null. */
export function naqiForRow(row: SensorRowDef, value: number | null): NaqiCategory | null {
  if (row.field === "pm25_ugm3") return naqiCategory("pm25", value);
  if (row.field === "pm10_ugm3") return naqiCategory("pm10", value);
  return null;
}

const timeText = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
};

/**
 * The text for one fitted sensor's cell. null for "no sensor" (those are
 * listed together on one line instead of one row each).
 */
export function sensorCellText(row: SensorRowDef, v: NodeValue | undefined): string | null {
  if (!v || v.state === "no_sensor") return null;
  if (v.state === "ok" && typeof v.value === "number") {
    const band = naqiForRow(row, v.value);
    return band ? `${formatSensorValue(row, v.value)} · NAQI ${band}` : formatSensorValue(row, v.value);
  }
  const last = typeof v.last_value === "number"
    ? `last ${formatSensorValue(row, v.last_value)}${timeText(v.last_at) ? ` at ${timeText(v.last_at)}` : ""}`
    : null;
  if (v.state === "fault") return `sensor fault - value dropped${last ? ` (${last})` : ""}`;
  return `not in the latest reading${last ? ` (${last})` : ""}`;
}

export interface NodeSensorView {
  rows: { row: SensorRowDef; text: string }[];
  /** labels of the sensors this node does not have */
  noSensor: string[];
}

export function nodeSensorView(latest: NodeLatest): NodeSensorView {
  const rows: NodeSensorView["rows"] = [];
  const noSensor: string[] = [];
  for (const row of SENSOR_ROWS) {
    const text = sensorCellText(row, latest.values[row.field]);
    if (text === null) noSensor.push(row.label);
    else rows.push({ row, text });
  }
  return { rows, noSensor };
}

/** "12 s ago" / "4 min ago" / "3 h ago" for the reading time. */
export function readingAge(iso: string | null, now = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 120) return `${s} s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  if (s < 3 * 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ------------------------------------------------------------- hotspots
export type HotspotRange = "off" | "7d" | "30d";
export const HOTSPOT_RANGES: readonly { value: HotspotRange; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
export const isHotspotRange = (v: unknown): v is HotspotRange => v === "off" || v === "7d" || v === "30d";

/** Purple, so a hotspot never reads as a live red/orange hazard zone. */
export const HOTSPOT_COLOR: Record<HotspotLevel, string> = { high: "#6a1b9a", moderate: "#9c4dcc", low: "#c9a3e0" };
export const HOTSPOT_LEVEL_TEXT: Record<HotspotLevel, string> = {
  high: "Frequent hazards", moderate: "Occasional hazards", low: "Rare or none",
};

/**
 * Circle radius in metres: 400 m (a node's own neighbourhood) up to 2 km
 * (the CRITICAL zone radius, server.js HAZARD_RADIUS_M) at intensity 1.
 * A display choice, not a measured area.
 */
export const hotspotRadiusM = (intensity: number) =>
  Math.round(400 + 1600 * Math.min(Math.max(Number.isFinite(intensity) ? intensity : 0, 0), 1));
