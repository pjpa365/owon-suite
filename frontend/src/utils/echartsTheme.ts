// ECharts chrome tokens (axis/grid/tooltip/legend) from
// Design_result/theme-tokens.md SS8 -- the one real dark-mode theming gap the
// original color-schema brief called out: only the series line/point color
// was theme-aware before this, so axis labels/lines, split lines, and the
// tooltip fell back to ECharts' hardcoded light-mode defaults on a dark
// canvas. Series color still comes from the per-unit chart-color setting;
// these tokens are chrome only.
const echartsTokensLight = {
  axisLine: { lineStyle: { color: "#dfe4e8" } },
  axisLabel: { color: "#636a6f" },
  splitLine: { lineStyle: { color: "#dfe4e8" } },
  tooltip: { backgroundColor: "#ffffff", textStyle: { color: "#1c2226" }, borderColor: "#dfe4e8" },
  legend: { textStyle: { color: "#41494f" } },
};

const echartsTokensDark = {
  axisLine: { lineStyle: { color: "#2c333a" } },
  axisLabel: { color: "#838a90" },
  splitLine: { lineStyle: { color: "#20262d" } },
  tooltip: { backgroundColor: "#181e24", textStyle: { color: "#e9ebec" }, borderColor: "#2c333a" },
  legend: { textStyle: { color: "#b1b9be" } },
};

export function echartsTokens(colorScheme: "light" | "dark") {
  return colorScheme === "dark" ? echartsTokensDark : echartsTokensLight;
}
