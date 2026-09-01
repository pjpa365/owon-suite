import type { CSSProperties } from "react";

// Chip/badge formula from Design_result/theme-tokens.md SS6: bg/text oklch
// pairs per hue, tuned for contrast in each mode. Reused by any small
// status/kind chip (measurement "FINALIZED" status, "CALCULATED" kind badge,
// and any future one) -- add a hue to CHIP_HUES rather than a new formula.
export function chipStyle(hue: number, colorScheme: "light" | "dark"): CSSProperties {
  return colorScheme === "dark"
    ? { backgroundColor: `oklch(30% 0.035 ${hue})`, color: `oklch(82% 0.05 ${hue})` }
    : { backgroundColor: `oklch(92% 0.03 ${hue})`, color: `oklch(38% 0.09 ${hue})` };
}

export const CHIP_HUES = {
  neutral: 235, // "FINALIZED" and other plain statuses
  calculated: 320, // reuses grape's hue -- "CALCULATED" badge
} as const;
