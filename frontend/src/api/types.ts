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

/** One row of GET /api/sensors (dashboard-shaped sensor_data row) */
export interface SensorRow {
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
export interface Hazard {
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
export interface HazardZone {
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
}

export interface HazardZonesResponse {
  success: boolean;
  zones: HazardZone[];
}

/**
 * Where an SOS location came from. "manual" = the person tapped a point on
 * the SOS page map because their location was denied, unavailable or slow -
 * approximate, and the officer views say so.
 */
export type LocationSource = "gps" | "manual" | "whatsapp";

/** One open SOS as the officer sees it (GET /api/sos) */
export interface SosRequest {
  id: number;
  latitude: number;
  longitude: number;
  /** null for an SOS filed before the source was recorded */
  location_source?: LocationSource | null;
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
  data: SosRequest[];
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
}

export interface NodeHealthResponse {
  generated_at: string;
  summary: { online: number; offline: number; never_seen: number };
  nodes_with_issues: number;
  nodes: NodeHealth[];
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
export type ModelId = "flood" | "anomaly_filter" | "edge" | "lstm";

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
