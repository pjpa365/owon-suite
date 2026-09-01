import type { ControlOption } from "./api/types";

// What the meter's BLE protocol calls a control (api/types.ts's CONTROL_OPTIONS,
// mirroring backend/app/owon_ble/protocol.py's Control enum) is not what's
// printed on the meter's physical/touch buttons -- this is the one place that
// display mapping lives, decoupled from the wire values so relabeling one
// doesn't touch anything functional. Two labels are confirmed for now
// (Changes_post_phase5_and_color_design.txt); the rest are placeholders
// (today's plain "OPTION_NAME" -> "OPTION NAME" rendering) pending updates.
export const CONTROL_LABELS: Record<ControlOption, string> = {
  SELECT: "SELECT",
  RANGE: "RANGE",
  AUTO_RANGE: "AUTO RANGE",
  HOLD: "HOLD",
  LIGHT: "LIGHT",
  REL_BLE: "Delta Δ",
  BLUETOOTH_OFF: "BT OFF",
  HZ_DUTY: "HZ DUTY",
  MIN_MAX: "MIN MAX",
  NORMAL: "NORMAL",
};
