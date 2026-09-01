import { createTheme, type CSSVariablesResolver } from "@mantine/core";

// Shared by both entry points (main.tsx for the PC dashboard, mobile/main.tsx
// for the phone client) so the two always render identical colors -- device
// identity colors and chart colors especially depend on this matching
// exactly, not just looking similar.
//
// Colors from Design_result/theme-tokens.md SS1 (Claude design's color-schema
// handoff): brand (blue) and accent (orange) are kept as the logo-derived
// identity anchors, values re-tuned for contrast; red/green/yellow/grape
// overridden here too so every existing color="red" etc. usage across the
// app (status badges, delete/error actions) picks up the re-tuned shades
// automatically, without touching each call site.
export const theme = createTheme({
  primaryColor: "brand",
  // Mantine derives filled/light/outline variants from this shade index, and
  // uses a different one per color scheme. Shade 8 (Mantine's dark-mode
  // default) was tested and rejected: it's too close in lightness to a dark
  // surface, so filled buttons nearly disappeared. Shade 4 gives real
  // contrast on dark backgrounds; shade 6 still reads clearly on white.
  // Applies uniformly to every named color below (not just primaryColor), so
  // e.g. a raw `var(--mantine-color-red-filled)` also resolves to red[6] in
  // light mode / red[4] in dark, without per-component conditionals.
  primaryShade: { light: 6, dark: 4 },
  colors: {
    brand: [
      "#eff6fd",
      "#dde9f7",
      "#c2d7ed",
      "#9fbee0",
      "#79a2cf",
      "#5387bd",
      "#326fac",
      "#1b5a95",
      "#0d4475",
      "#072c4f",
    ],
    accent: [
      "#fff1eb",
      "#fee1d6",
      "#f8c8b6",
      "#eda78e",
      "#e1815c",
      "#d35721",
      "#bf3100",
      "#a51700",
      "#810700",
      "#540c00",
    ],
    red: [
      "#fff0ee",
      "#ffe0dc",
      "#f7c7c2",
      "#eca69f",
      "#df7f78",
      "#d25450",
      "#c02b2f",
      "#a7031a",
      "#83000d",
      "#56060b",
    ],
    green: [
      "#eef8f0",
      "#daeede",
      "#bfddc6",
      "#9cc7a6",
      "#73af83",
      "#469760",
      "#198044",
      "#006b32",
      "#005124",
      "#013517",
    ],
    yellow: [
      "#faf5ea",
      "#f1e7d2",
      "#e3d2b0",
      "#d1b783",
      "#bb9a51",
      "#a77b00",
      "#926200",
      "#7b4e00",
      "#5e3b00",
      "#3d2700",
    ],
    grape: [
      "#faf2fc",
      "#f1e2f5",
      "#e3cae9",
      "#d0abd9",
      "#ba8ac5",
      "#a567b3",
      "#8e4d9d",
      "#783a86",
      "#5b2b66",
      "#3c1c44",
    ],
  },
});

// Root cause of "red recording buttons render white-on-white in dark mode"
// (Changes ausgust-25.txt item 3): Mantine computes the dark-mode `outline`
// variant's shade as `primaryShade.dark - 4` (floored at 0) --
// @mantine/core's get-css-color-variables.ts. Our primaryShade.dark of 4
// above (chosen so *filled* buttons have real contrast on a dark surface)
// drives that formula to shade 0 for every color -- and this theme's red[0]
// (#fff0ee) is a near-white pale pink, since the whole red ramp was
// re-tuned for a muted, less alarming range (theme-tokens.md). Mantine's own
// stock theme doesn't hit this because its default dark primaryShade is 8
// (8-4=4, a real color); nothing about our filled-shade choice was wrong,
// it just collided with this offset. Point dark-mode outline at shade 4
// directly instead -- the same shade already tuned for dark-background
// contrast, just as a border+text color instead of a fill.
export const cssVariablesResolver: CSSVariablesResolver = (theme) => ({
  variables: {},
  light: {},
  dark: {
    "--mantine-color-red-outline": theme.colors.red[4],
    "--mantine-color-red-outline-hover": `${theme.colors.red[4]}0d`, // ~5% alpha, matches Mantine's own outline-hover convention
  },
});
