// Shapes of the server.js JSON responses used by the frontend.
// Keep in sync with server.js (and backend_server.py for proxied routes).

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Role = "viewer" | "officer" | "admin";

export interface User {
  username: string;
  role: Role;
}

export interface MeResponse {
  user: User;
  idle_timeout_minutes: number;
}

export interface LoginResponse {
  ok: true;
  user: User;
}

/** The AI backend's own High / Medium / Low reading of its confidence score. */
export type ConfidenceLabel = "High" | "Medium" | "Low";

/**
 * How sure the AI backend is about one alert (server.js stores what the
 * backend returns, see server/confidence.js). The score is an explainable
 * formula over confirmation status, agreement with the node's own edge
 * verdict, data quality and model calibration - not an ML probability.
 * All null for readings stored before the score existed (or from an older
 * backend): show nothing then, never a made-up value.
 */
export interface ConfidenceFields {
  /** 0..1 */
  confidence?: number | null;
  confidence_label?: ConfidenceLabel | null;
  /** short reasons behind the score, e.g. "confirmed by neighbour node" */
  confidence_reasons?: string[] | null;
}

/** One row of GET /api/sensors (dashboard-shaped sensor_data row) */
export interface SensorRow extends ConfidenceFields {
  id: number;
  device_id: string;
  hazard: string;
  water_level: number | null;
  temperature: number | null;
  humidity: number | null;
  risk: Severity | string;
  risk_score: number | null;
  timestamp: string;
}

export interface SensorsResponse {
  success: boolean;
  count: number;
  data: SensorRow[];
}

/** One entry of GET /api/hazards (confirmed alerts, highest risk first) */
export interface Hazard extends ConfidenceFields {
  label: string;
  node_id: string;
  location: string;
  hazard_type: string;
  severity: Severity;
  risk_score: number;
  latitude: number | null;
  longitude: number | null;
  eta_minutes: number | null;
  predicted_time: string | null;
  prediction_text: string;
  /** timestamp of the reading behind this hazard */
  last_reading_at?: string | null;
  /** true when the node has not reported for a while - shown, but never alarms */
  stale?: boolean;
  /** readings.id of this confirmed alert (CAP XML / PDF report / timeline); null = not found */
  alert_id?: number | null;
  /** severity came from the weather forecast (raised at every node in the area), not this node's sensors */
  forecast_based?: boolean;
}

export interface HazardsResponse {
  success: boolean;
  count: number;
  hazards: Hazard[];
}

/** GET /api/route/:node_id */
export interface HospitalRoute {
  node_id: string;
  hospital: string;
  distance_km: number;
  maps_url: string;
}

/** GET /api/hazard-zones (public: confirmed only; officers: ?include_pending=1) */
export interface HazardZone extends ConfidenceFields {
  node_id: string;
  hazard_type: string;
  severity: Severity;
  risk_score: number;
  latitude: number;
  longitude: number;
  radius_m: number;
  confirmed: boolean;
  /** timestamp of the reading behind this zone */
  last_reading_at?: string | null;
  /** true when the node has not reported for a while - shown, but never alarms */
  stale?: boolean;
  /** readings.id of the confirmed alert behind this zone; null while pending */
  alert_id?: number | null;
  /** severity came from the weather forecast (raised at every node in the area), not this node's sensors */
  forecast_based?: boolean;
}

export interface HazardZonesResponse {
  success: boolean;
  zones: HazardZone[];
}

/**
 * Where an SOS location came from. "manual" = the person tapped a point on
 * the SOS page map because their location was denied, unavailable or slow -
 * approximate, and the officer views say so. "node" = the SOS button on a
 * LoRa sensor node (someone without a phone): the point is the node's
 * registered position. "hotspot" = the offline "SANJEEVNI-SOS" Wi-Fi page on
 * a gateway/node: the node's position (location_accuracy_m 150, the rough
 * Wi-Fi range) or, with location_accuracy_m null, coordinates the person typed.
 */
export type LocationSource = "gps" | "manual" | "whatsapp" | "node" | "hotspot";

/** What a person on the offline SOS Wi-Fi page ticked (server keeps only these). */
export type HotspotNeed = "trapped" | "injured" | "medical" | "fire";

/** One open SOS as the officer sees it (GET /api/sos) */
export interface SosRequest {
  id: number;
  latitude: number;
  longitude: number;
  /** null for an SOS filed before the source was recorded */
  location_source?: LocationSource | null;
  /**
   * How far off the device fix may be, in metres (the browser's
   * coords.accuracy). null = unknown: manual point, WhatsApp, node, older page.
   */
  location_accuracy_m?: number | null;
  /** the node whose SOS button was pressed ("node") or whose SOS Wi-Fi was used ("hotspot"), else null */
  node_id?: string | null;
  /** offline SOS Wi-Fi only: how many people (null = not given / other channel) */
  people?: number | null;
  /** offline SOS Wi-Fi only: what they need ([] = nothing ticked / other channel) */
  needs?: HotspotNeed[];
  note: string | null;
  status: string;
  timestamp: string;
  escalated: boolean;
  minutes_open: number;
  nearest_hospital: string;
  hospital_distance_km: number;
  hospital_route_url: string;
  responder_route_url: string;
  /** why a farther hospital was chosen (the nearer one is inside a hazard zone) */
  hospital_skipped?: SkippedHospital | null;
  hospital_in_hazard_zone?: HospitalZone | null;
}

export interface SosListResponse {
  success: boolean;
  count: number;
  escalated_count: number;
  /** open rows left out because their stored coordinates are not numbers (old bad data, B47) */
  invalid_location_count?: number;
  /**
   * SOS-button presses on a node that has no registered position: no pin is
   * possible, so the officer panel lists them as a banner (server.js
   * createNodeButtonSos).
   */
  unlocated_node_sos?: UnlocatedNodeSos[];
  data: SosRequest[];
}

export interface UnlocatedNodeSos {
  id: number;
  node_id: string;
  /** "node" (SOS button) or "hotspot" (offline SOS Wi-Fi); missing from older servers = "node" */
  location_source?: "node" | "hotspot";
  people?: number | null;
  needs?: HotspotNeed[];
  note: string | null;
  status: string;
  timestamp: string;
  minutes_open: number;
}

export interface NodeIssue {
  level: "warning" | "critical";
  type: string;
  message: string;
}

export interface NodeHealth {
  node_id: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  status: "online" | "offline" | "never_seen";
  level: "ok" | "warning" | "critical";
  last_seen: string | null;
  seconds_since_seen: number | null;
  expected_interval_seconds: number;
  battery_pct: number | null;
  signal_strength_dbm: number | null;
  link: string | null;
  issues: NodeIssue[];
  /** village siren (server.js adds it; null = the node reports no siren) */
  siren?: SirenStatus | null;
}

/**
 * Village siren on one node (server/siren.js). "sounding" is only what the
 * node itself last reported; "desired" is what the server is asking for and
 * keeps sending until the node reports the same.
 */
export interface SirenStatus {
  node_id: string;
  fitted: boolean;
  sounding: boolean;
  /** null = the server is not asking for anything */
  desired: "on" | "off" | null;
  /** why it is wanted ("auto" | "officer"), else why the node says it sounds */
  reason: "auto" | "officer" | "auto_offline" | "command" | null;
  desired_reason: "auto" | "officer" | null;
  /** officer username, "api-key" or "auto" */
  desired_by: string | null;
  /** end of an "on" request (ISO) */
  until: string | null;
  /** the node's own words while sounding: "auto_offline" = it decided itself (no gateway) */
  reported_reason: "auto_offline" | "command" | null;
  reported_at: string | null;
  /** the reported state came from simulated (test/demo) readings */
  simulated: boolean;
  /** the request came from a simulated reading - never sent to the real node */
  desired_simulated: boolean;
}

/** GET /api/sirens (officers) */
export interface SirensResponse {
  /** "CRITICAL" = sounds by itself for a confirmed CRITICAL hazard at that node */
  auto_severity: "CRITICAL" | "off";
  /** hazard types the automatic siren sounds for (SIREN_AUTO_HAZARDS, normalised: "gas_leak"); older servers omit it */
  auto_hazards?: string[];
  default_on_seconds: number;
  sirens: SirenStatus[];
}

/** POST /api/nodes/:id/siren */
export interface SirenActionResponse {
  status: "ok";
  siren: SirenStatus;
}

export interface NodeHealthResponse {
  generated_at: string;
  summary: { online: number; offline: number; never_seen: number };
  nodes_with_issues: number;
  nodes: NodeHealth[];
}

/** One sensor's latest value (GET /api/officer/nodes/:id/latest). */
export type NodeValueField =
  | "river_level_m" | "river_level_rate_m_per_hr" | "temp_c" | "humidity_pct" | "gas_ppm" | "flame_reading"
  | "pm25_ugm3" | "pm10_ugm3" | "tilt_angle_deg" | "vibration_magnitude" | "soil_moisture_pct"
  | "water_ph" | "turbidity_ntu" | "rainfall_24h_mm" | "battery_pct" | "signal_strength_dbm";

export interface NodeValue {
  /** null unless state is "ok" */
  value: number | null;
  /**
   * ok: in the newest reading; fault: dropped as physically impossible;
   * not_in_latest: reported recently but not now; no_sensor: not fitted.
   */
  state: "ok" | "fault" | "not_in_latest" | "no_sensor";
  last_value?: number;
  last_at?: string | null;
}

export interface NodeLatest {
  reading_id: number;
  reading_at: string | null;
  /** from the simulator (demo), not a real sensor */
  simulated: boolean;
  link: string | null;
  hazard_type: string | null;
  severity: string | null;
  status: string | null;
  sensor_faults: string[];
  edge_anomaly: string[];
  values: Partial<Record<NodeValueField, NodeValue>>;
}

export interface NodeLatestResponse {
  node_id: string;
  location: string | null;
  /** null = no reading stored for this node yet */
  latest: NodeLatest | null;
  siren: SirenStatus | null;
}

/** GET /api/officer/heatmap - per-node hotspot summary for a time window. */
export type HotspotLevel = "high" | "moderate" | "low";

export interface Hotspot {
  node_id: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  reading_count: number;
  high_count: number;
  medium_count: number;
  max_risk_score: number | null;
  days_reported: number;
  days_with_high: number;
  /** (elevated readings + half the MEDIUM ones) / readings, 0..1 - "elevated" per HeatmapResponse.basis */
  intensity: number;
  level: HotspotLevel;
}

export interface HeatmapResponse {
  range: "7d" | "30d";
  days: number;
  from_day: string;
  generated_at: string;
  data_note: string;
  /** "readings": confirmed alerts from the node's own sensors only; "backend": fallback, every row counted */
  source?: "readings" | "backend";
  /** what counts as "elevated", in words */
  basis?: string;
  /** what a hotspot is and how its intensity is computed, in words (server.js HOTSPOT_DEFINITION) */
  definition?: string;
  level_edges: { moderate: number; high: number };
  hotspots: Hotspot[];
}

export interface ForecastPoint {
  minutes_ahead: number;
  level_m: number;
  change_m: number;
  linear_baseline_level_m: number;
}

/** GET /api/forecast/:node_id */
export type ForecastResponse =
  | { node_id: string; available: false; reason: string }
  | { node_id: string; available: true; as_of: string; current_level_m: number; forecast: ForecastPoint[]; model: string };

/** GET /api/satellite-check/:node_id (officer only) */
export interface SatelliteCheck {
  node_id: string;
  status: "flood_signal" | "no_flood_signal" | "no_recent_pass" | "no_reference" | "unavailable";
  message: string;
  agreement?: string;
}

/** GET /api/nearest-hospital?latitude=&longitude= (public) */
/** A nearer hospital the server passed over because it lies inside an active HIGH/CRITICAL zone */
export interface SkippedHospital {
  hospital: string;
  distance_km: number;
  hazard_type: string;
  severity: Severity;
}

/** Hazard zone the chosen hospital itself is in (only when EVERY hospital is in one) */
export interface HospitalZone {
  hazard_type: string;
  severity: Severity;
}

/** GET /api/nearest-hospital - distance_km is straight-line, maps_url the road route */
export interface NearestHospital {
  hospital: string;
  distance_km: number;
  maps_url: string;
  skipped_hospital?: SkippedHospital | null;
  hospital_in_hazard_zone?: HospitalZone | null;
}

/** GET /api/sos/device/:device_id (public) */
export type DeviceSosStatus =
  | { active: false }
  | ({ active: true; sos_id: number } & NearestHospital);

/** POST /api/sos -> 201 received, or 409 already_active (same fields) */
export interface SosCreateResponse extends NearestHospital {
  status: "received" | "already_active";
  sos_id: number;
}

export type LandUse = "agricultural" | "forest" | "urban_low" | "urban_high";

/** One node in the registry - body of POST/PUT /api/admin/nodes/:id (admin only) */
export interface NodeConfig {
  location: string;
  land_use: LandUse;
  curve_number: number;
  latitude: number;
  longitude: number;
  upstream_node: string | null;
  /** null = the default 5 s (always-on firmware) */
  report_interval_seconds: number | null;
}

/** GET /api/admin/nodes */
export interface AdminNodesResponse {
  nodes: Record<string, NodeConfig>;
}

// ---- Model card (GET /api/admin/model-card, admin only) ----
// Written offline by ml/evaluate_models.py (its validate_card() is the
// contract) and passed through unchanged by the backend and server.js.
// Rates are fractions 0..1, LSTM errors are metres, numbers are rounded to
// 4 dp and never NaN (null instead).

export type DataProvenance = "SYNTHETIC" | "REAL";
export type ModelId = "flood" | "anomaly_filter" | "edge" | "edge_lite" | "lstm";

export interface ModelHeadlineMetric {
  key: string;
  label: string;
  value: number | null;
  baseline: number | null;
  higher_is_better: boolean;
}

export interface ModelConfusionMatrix {
  title: string;
  labels: string[];
  /** rows = actual, columns = predicted */
  matrix: number[][];
}

export interface ModelReliabilityBin {
  bin_lower: number;
  bin_upper: number;
  count: number;
  mean_predicted: number | null;
  observed_rate: number | null;
}

export interface ModelEntry {
  id: ModelId;
  name: string;
  status: "evaluated" | "not_available";
  /** set when not_available (numbers are then null and lists empty) */
  status_reason: string | null;
  purpose: string;
  runs_where: string;
  artifact: { path: string; sha256: string | null; modified_at: string | null };
  training_data: { provenance: DataProvenance | null; generator: string | null; size: number | null; description: string | null };
  evaluation: {
    provenance: DataProvenance | null;
    split: string | null;
    split_kind: "independent_draw" | "group" | "row" | "catchment" | null;
    test_size: number | null;
    test_positives: number | null;
    leakage_guard: string | null;
  };
  baseline: { name: string | null; description: string | null };
  beats_baseline: boolean | null;
  headline_metrics: ModelHeadlineMetric[];
  false_alarm: { definition: string | null; rate: number | null; miss_definition: string | null; miss_rate: number | null };
  calibration: {
    applicable: boolean;
    method: string | null;
    brier: number | null;
    brier_uncalibrated: number | null;
    brier_reference: number | null;
    ece: number | null;
    reliability: ModelReliabilityBin[];
    note: string | null;
  };
  confusion_matrices: ModelConfusionMatrix[];
  /** model-specific extras; not rendered */
  details: Record<string, unknown>;
  limitations: string[];
}

export interface ModelCard {
  schema_version: number;
  generated_by: string;
  seed: number;
  provenance: "SYNTHETIC" | "REAL" | "MIXED" | "NONE";
  /** must always be shown next to the numbers */
  banner: string;
  /** newest model file's time, "YYYY-MM-DDTHH:MM:SSZ" (UTC) */
  models_updated_at: string | null;
  models: ModelEntry[];
}

// ---- Trends & reports (step W2) ----
// GET /api/officer/trends, /summary (AI backend, proxied), /alerts and
// /timeline/:node_id. All analytics include simulated (demo) readings
// unless data_note says otherwise - the page always shows data_note.

export type TrendRange = "24h" | "7d" | "30d";
export type SummaryRange = "7d" | "30d";

/** min / max / mean of one sensor inside one time bucket; null = no reading in the bucket */
export interface FieldStats {
  min: number | null;
  max: number | null;
  mean: number | null;
}

export type TrendField =
  | "river_level_m" | "temp_c" | "humidity_pct" | "gas_ppm" | "pm25_ugm3" | "pm10_ugm3"
  | "soil_moisture_pct" | "tilt_angle_deg";

export type TrendPoint = {
  /** bucket start, ISO */
  t: string;
  risk_score_max: number | null;
  severity_max: string | null;
} & { [F in TrendField]?: FieldStats | null };

export interface TrendsResponse {
  node_id: string;
  range: TrendRange;
  bucket_s: number;
  generated_at: string;
  data_note?: string | null;
  series: TrendPoint[];
}

/** Forecast-only alerts (severity from the weather forecast, raised at every node in the forecast area). */
export interface ForecastAlertsSummary {
  /** alert READINGS (confirmed + pending) */
  count: number;
  confirmed: number;
  /** nodes that received one */
  nodes: number;
  by_hazard: Record<string, { count: number; confirmed: number; max_severity: string | null }>;
  basis?: string;
}

export interface SummaryResponse {
  range: SummaryRange;
  generated_at: string;
  data_note?: string | null;
  /** alert READINGS (confirmed + pending) assessed from the nodes' own sensors - see alerts_count_basis */
  alerts_by_hazard: Record<string, { count: number; confirmed: number; max_severity: string | null }>;
  alerts_by_node: Record<string, { count: number; max_severity: string | null }>;
  alerts_count_basis?: string;
  /** reported apart from the counts above (backend analytics.py) */
  forecast_alerts?: ForecastAlertsSummary;
  /** NODE-hours (summed over nodes) above a documented threshold, e.g. pm25_poor_or_worse, heat_wave */
  exceedance_hours: Record<string, number>;
  /** key -> how it is counted, in words */
  exceedance_basis?: Record<string, string>;
  exceedance_note?: string;
  top_hotspots: { node_id: string; location: string; score: number; dominant_hazard: string | null }[];
  hotspot_basis?: string;
  /** 0..100 */
  node_uptime_pct: Record<string, number>;
  uptime_basis?: string;
}

/** One confirmed (dispatched) alert - GET /api/officer/alerts */
export interface ConfirmedAlert {
  id: number;
  node_id: string;
  location: string;
  timestamp: string;
  hazard_type: string | null;
  severity: string | null;
  risk_score: number | null;
  simulated: boolean;
}

export interface ConfirmedAlertsResponse {
  range: TrendRange;
  node_id: string | null;
  generated_at: string;
  count: number;
  alerts: ConfirmedAlert[];
}

/** One readings row of GET /api/officer/timeline/:node_id (the backend sends the whole row; only these are used) */
export interface TimelineRow {
  id: number;
  timestamp: string | null;
  status: string | null;
  severity: string | null;
  hazard_type: string | null;
  risk_score: number | null;
  simulated?: number | boolean | null;
  river_level_m?: number | null;
  temp_c?: number | null;
  gas_ppm?: number | null;
  pm25_ugm3?: number | null;
  [key: string]: unknown;
}

export interface TimelineResponse {
  node_id: string;
  count: number;
  timeline: TimelineRow[];
}
