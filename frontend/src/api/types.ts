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
}

export interface HazardZonesResponse {
  success: boolean;
  zones: HazardZone[];
}

/** One open SOS as the officer sees it (GET /api/sos) */
export interface SosRequest {
  id: number;
  latitude: number;
  longitude: number;
  note: string | null;
  status: string;
  timestamp: string;
  escalated: boolean;
  minutes_open: number;
  nearest_hospital: string;
  hospital_distance_km: number;
  hospital_route_url: string;
  responder_route_url: string;
}

export interface SosListResponse {
  success: boolean;
  count: number;
  escalated_count: number;
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
export interface NearestHospital {
  hospital: string;
  distance_km: number;
  maps_url: string;
}

/** GET /api/sos/device/:device_id (public) */
export type DeviceSosStatus =
  | { active: false }
  | { active: true; sos_id: number; hospital: string; distance_km: number; maps_url: string };

/** POST /api/sos -> 201 received, or 409 already_active (same fields) */
export interface SosCreateResponse {
  status: "received" | "already_active";
  sos_id: number;
  hospital: string;
  distance_km: number;
  maps_url: string;
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
