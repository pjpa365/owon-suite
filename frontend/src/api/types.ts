// Mirrors backend/app/models.py. Keep in sync by hand until codegen is worth adding.

export interface KnownDevice {
  id: string;
  name: string;
  address: string;
  driver: string;
  color: string;
}

export interface AddDeviceRequest {
  name: string;
  address: string;
  driver?: string;
  color?: string; // one of deviceColors.ts's DEVICE_COLORS keys; auto-assigned if omitted
}

export interface RenameDeviceRequest {
  name: string;
  color?: string; // optional: also update the device's identity color in the same call
}

export interface DiscoveredDevice {
  address: string;
  name: string;
}

export interface BluetoothStatus {
  // null means "unknown" (check couldn't run, or no known device yet) --
  // treat as "don't warn", not as "disabled".
  enabled: boolean | null;
}

export type ConnectionStatus = "connected" | "disconnected";

export interface StatusResponse {
  device_id: string;
  status: ConnectionStatus;
}

export interface ControlRequest {
  control: string;
}

export interface MeasurementOut {
  timestamp: string;
  function: string;
  unit: string;
  value: number | null; // null means overload / no valid reading ("OL")
  display_value: string;
  status_flags: string[];
}

export interface MeasurementSummary {
  id: string;
  device_id: string;
  device_name: string;
  kind: "buffer_save" | "adhoc" | "online" | "offline" | "calculated";
  name: string;
  unit: string;
  function: string;
  status: "recording" | "paused" | "finalized";
  start_time: string;
  end_time: string | null;
  min_value: number | null;
  max_value: number | null;
  avg_value: number | null;
  median_value: number | null;
  count: number;
  source_measurement_ids: string[];
}

export interface MeasurementPoint {
  id: number;
  seq: number;
  timestamp: string;
  value: number | null;
  display_value: string;
  status_flags: string[];
}

export interface RenameMeasurementRequest {
  name: string;
}

export interface DeletePointsRequest {
  point_ids: number[];
}

export interface AdhocStatus {
  active: boolean;
  paused: boolean;
  measurement_id: string | null;
}

export type Comparator = ">" | ">=" | "<" | "<=";

export interface ThresholdIn {
  comparator: Comparator;
  value: number;
}

export type OnlineStopMode = "threshold" | "count" | "duration" | "end_time";

export interface OnlineRecordingStartRequest {
  start_threshold?: ThresholdIn | null;
  stop_mode: OnlineStopMode;
  stop_threshold?: ThresholdIn | null;
  sample_count?: number | null;
  duration_seconds?: number | null;
  end_time?: string | null;
  interval_seconds: number;
  average_values: boolean;
  stop_on_low_battery: boolean;
}

export interface OnlineRecordingStatus {
  active: boolean;
  paused: boolean;
  waiting_for_start: boolean;
  start_time: string | null;
  samples_so_far: number;
  estimated_end_time: string | null;
  stop_reason: string | null;
  measurement_id: string | null;
  measurement_name: string | null;
}

export type OfflineStopMode = "count" | "duration" | "end_time";
export type OfflineState = "idle" | "recording" | "awaiting_reconnect" | "downloading" | "completed" | "error";

export interface OfflineRecordingStartRequest {
  interval_seconds: number;
  stop_mode: OfflineStopMode;
  sample_count?: number | null;
  duration_seconds?: number | null;
  end_time?: string | null;
  set_clock: boolean;
}

export interface OfflineRecordingStatus {
  state: OfflineState;
  start_time: string | null;
  estimated_end_time: string | null;
  interval_seconds: number | null;
  count: number | null;
  bytes_received: number;
  expected_bytes: number | null;
  error: string | null;
  warning: string | null;
  measurement_id: string | null;
  measurement_name: string | null;
}

export interface MeasurementFilters {
  device_id?: string;
  name_contains?: string;
  date_from?: string;
  date_to?: string;
}

// Mirrors backend/app/owon_ble/protocol.py's Control enum.
export const CONTROL_OPTIONS = [
  "SELECT",
  "RANGE",
  "AUTO_RANGE",
  "HOLD",
  "LIGHT",
  "REL_BLE",
  "BLUETOOTH_OFF",
  "HZ_DUTY",
  "MIN_MAX",
  "NORMAL",
] as const;

export type ControlOption = (typeof CONTROL_OPTIONS)[number];

// --- Calculation engine (architecture.md SS3.5) ----------------------------

export interface CalculationStats {
  duration_seconds: number;
  count: number;
  min_value: number | null;
  max_value: number | null;
  avg_value: number | null;
  median_value: number | null;
}

export interface CalculatedPoint {
  timestamp: string;
  value: number | null;
  interpolated: boolean;
}

export interface AhRequest {
  measurement_id: string;
}

export interface AhResponse {
  stats: CalculationStats;
  ah_value: number;
}

export interface WattHourRequest {
  current_measurement_id?: string | null;
  voltage_measurement_id?: string | null;
  default_current?: number | null;
  default_voltage?: number | null;
  tolerance?: number | null;
  sync_offset_seconds?: number;
  create_dataset?: boolean;
}

export interface WattHourResponse {
  stats: CalculationStats;
  watt_hour_value: number;
  created_measurement_id: string | null;
}

export interface ShuntCurrentRequest {
  voltage_measurement_id: string;
  resistance_ohms: number;
  store?: boolean;
}

export interface ShuntCurrentResponse {
  stats: CalculationStats;
  points: CalculatedPoint[];
  created_measurement_id: string | null;
}

export type OhmsLawQuantity = "V" | "I" | "R";

export interface OhmsLawRequest {
  measurement_id: string;
  constant_quantity: OhmsLawQuantity;
  constant_value: number;
  create_dataset?: boolean;
}

export interface OhmsLawResponse {
  stats: CalculationStats;
  points: CalculatedPoint[];
  output_unit: string;
  created_measurement_id: string | null;
}

export interface AlignRequest {
  measurement_id_a: string;
  measurement_id_b: string;
  tolerance?: number | null;
  sync_offset_seconds?: number;
}

export interface AlignResponse {
  timestamps: string[];
  values_a: number[];
  values_b: number[];
  interpolated_a: boolean[];
  interpolated_b: boolean[];
}

// --- Live/UI settings (architecture.md SS3.6) -------------------------------
// Backend storage is deliberately generic (a schemaless key-value store) --
// this interface is just the frontend's known-fields contract and will grow
// as more settings are added, without any backend change required.

export type ColorScheme = "light" | "dark" | "auto";

export interface ChartColorSet {
  light: Record<string, string>;
  dark: Record<string, string>;
}

export type ChartTimeMode = "absolute" | "relative";

export interface AppSettings {
  dark_mode: ColorScheme;
  chart_colors: ChartColorSet;
  naming_template: string;
  /** date-fns token string (e.g. "dd-MM-yyyy HH:mm:ss") -- see utils/dateFormat.ts. */
  date_format: string;
  auto_connect: boolean;
  set_meter_clock_on_offline_init: boolean;
  /** Horizontal axis for every time-based chart: "absolute" (real recorded
   * time) or "relative" (elapsed seconds since the chart's own first point). */
  chart_time_mode: ChartTimeMode;
  /** 4-digit PIN gating the mobile client; null/empty disables it entirely. */
  mobile_pincode: string | null;
  /** Master switch for the MCP server (architecture.md SS5); off by default. */
  mcp_enabled: boolean;
  /** Whether the MCP server's read-only SQL query tool is allowed to run;
   * independent of mcp_enabled so the rest of MCP can be on with this off. */
  mcp_queries_enabled: boolean;
  /** User-chosen key sent as the X-MCP-Key header by any MCP client reaching
   * this server from off this PC; null/empty means no non-loopback client
   * can authenticate, regardless of mcp_enabled. */
  mcp_api_key: string | null;
}
