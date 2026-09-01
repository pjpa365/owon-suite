// The 8 curated per-device identity colors (Design_result/theme-tokens.md
// SS4). Mirrors backend/app/device_manager.py's DEVICE_COLOR_KEYS -- keep the
// set of keys (and their order, used there for auto-assignment at device
// registration) in sync by hand between the two files.
//
// Two distinct uses per color, deliberately different values:
// - header{Light,Dark}: applied to a device-scoped widget's header background
//   only (never body/border/text). The color picker must preview *these*
//   exact values, not a separately-tuned vivid one -- an earlier design draft
//   used a more saturated preview than the actual header result, which was
//   confusing ("the dots don't represent the color in the header").
// - dot{Light,Dark}: a more saturated accent for small identity marks (e.g.
//   the dot next to a device name in the device list), where a firmer color
//   reads better against a small area. Computed from the doc's formula
//   (46% L / 0.14 C light, 68% L / 0.15 C dark) via CSS oklch() rather than
//   hand-converted to hex, so it stays exact for every hue.
export interface DeviceColorSwatch {
  key: string;
  headerLight: string;
  headerDark: string;
  dotLight: string;
  dotDark: string;
}

function dotColors(hue: number): { dotLight: string; dotDark: string } {
  return { dotLight: `oklch(46% 0.14 ${hue})`, dotDark: `oklch(68% 0.15 ${hue})` };
}

export const DEVICE_COLORS: DeviceColorSwatch[] = [
  { key: "coral", headerLight: "#ffd5d4", headerDark: "#55292a", ...dotColors(20) },
  { key: "amber", headerLight: "#f9dbbf", headerDark: "#4f300e", ...dotColors(65) },
  { key: "moss", headerLight: "#e3e5bf", headerDark: "#3a3b0c", ...dotColors(110) },
  { key: "jade", headerLight: "#c8ecd3", headerDark: "#174229", ...dotColors(155) },
  { key: "sky", headerLight: "#bbecee", headerDark: "#004245", ...dotColors(200) },
  { key: "indigo", headerLight: "#c6e6ff", headerDark: "#163b57", ...dotColors(245) },
  { key: "violet", headerLight: "#e0dcff", headerDark: "#383257", ...dotColors(290) },
  { key: "rose", headerLight: "#f7d5ef", headerDark: "#4c2a45", ...dotColors(335) },
];

export function getDeviceColor(key: string | undefined): DeviceColorSwatch {
  return DEVICE_COLORS.find((c) => c.key === key) ?? DEVICE_COLORS[0];
}
