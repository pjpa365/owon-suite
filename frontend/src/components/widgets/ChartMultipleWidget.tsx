import { useEffect, useRef } from "react";
import ReactECharts from "echarts-for-react";
import { Checkbox, Group, Stack, Text, useComputedColorScheme } from "@mantine/core";

import { useMeasurements, useMultipleMeasurementPoints } from "../../api/measurements";
import { useSettings } from "../../api/settings";
import type { MeasurementSummary } from "../../api/types";
import type { WidgetConfig } from "../../state/dashboardStore";
import { computeAutoYMin } from "../../utils/chartAxis";
import { elapsedSeconds } from "../../utils/chartTime";
import { echartsTokens } from "../../utils/echartsTheme";
import { ChartExportMenu } from "./ChartExportMenu";
import { MeasurementPickerList } from "./MeasurementPickerList";

// Chart (multiple) (Changes ausgust-25.txt item 10): several measurements
// overlaid on one chart, one line each, locked to at most 2 different units
// (left/right axis) once a 2nd unit is picked.
export function unitsInPlay(measurements: MeasurementSummary[]): string[] {
  return Array.from(new Set(measurements.map((m) => m.unit)));
}

// Fallback categorical palette (qualitative, colorblind-considered-distinct
// hues) for a series whose unit has no color assigned on the Settings page --
// cycled by index so it's at least stable across renders. The per-unit
// settings colors still win when set.
const FALLBACK_PALETTE = [
  "#4c72b0",
  "#dd8452",
  "#55a868",
  "#c44e52",
  "#8172b3",
  "#937860",
  "#da8bc3",
  "#8c8c8c",
  "#ccb974",
  "#64b5cd",
];

export function ChartMultipleSettings({
  config,
  onConfigChange,
}: {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}) {
  const measurements = useMeasurements();
  const selectedIds = new Set(config.measurementIds ?? []);
  const selected = (measurements.data ?? []).filter((m) => selectedIds.has(m.id));
  const units = unitsInPlay(selected);

  function isDisabled(m: MeasurementSummary): boolean {
    if (selectedIds.has(m.id)) return false;
    if (units.length < 2) return false;
    return !units.includes(m.unit);
  }

  function handleToggle(m: MeasurementSummary) {
    const next = new Set(selectedIds);
    if (next.has(m.id)) next.delete(m.id);
    else next.add(m.id);
    onConfigChange({ ...config, measurementIds: Array.from(next) });
  }

  return (
    <Stack gap="xs">
      <Text size="xs" fw={600}>
        Measurements ({selectedIds.size} selected)
      </Text>
      {units.length >= 2 && (
        <Text size="xs" c="dimmed">
          Locked to units: {units.join(", ")}
        </Text>
      )}
      <MeasurementPickerList selectionMode="multi" selectedIds={selectedIds} onToggle={handleToggle} isDisabled={isDisabled} />
      <Checkbox
        label="Auto Y-axis offset"
        checked={config.autoYOffset ?? true}
        onChange={(e) => onConfigChange({ ...config, autoYOffset: e.currentTarget.checked })}
      />
    </Stack>
  );
}

interface ChartMultipleWidgetProps {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}

export function ChartMultipleWidget({ config }: ChartMultipleWidgetProps) {
  const measurements = useMeasurements();
  const measurementIds = config.measurementIds ?? [];
  const pointQueries = useMultipleMeasurementPoints(measurementIds);
  const settings = useSettings();
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorScheme = useComputedColorScheme("light");
  const tokens = echartsTokens(colorScheme);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      chartRef.current?.getEchartsInstance().resize();
    });
    observer.observe(node);
    // See LiveChartWidget.tsx's identical block: a fixed rAF-based delay
    // wasn't reliably enough, so this polls for up to 2s after mount and
    // forces a resize with the container's actual measured size whenever it
    // disagrees with what ECharts currently thinks it is.
    let elapsed = 0;
    const POLL_MS = 100;
    const POLL_BUDGET_MS = 2000;
    const interval = setInterval(() => {
      elapsed += POLL_MS;
      const inst = chartRef.current?.getEchartsInstance();
      if (inst && (inst.getWidth() !== node.clientWidth || inst.getHeight() !== node.clientHeight)) {
        inst.resize({ width: node.clientWidth, height: node.clientHeight });
      }
      if (elapsed >= POLL_BUDGET_MS) clearInterval(interval);
    }, POLL_MS);
    return () => {
      observer.disconnect();
      clearInterval(interval);
    };
  }, []);

  if (measurementIds.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Pick measurements via this widget's gear settings.
      </Text>
    );
  }

  const selected = measurementIds
    .map((id) => measurements.data?.find((m) => m.id === id))
    .filter((m): m is MeasurementSummary => !!m);

  const units = unitsInPlay(selected);
  const leftUnit = units[0];
  const rightUnit = units[1];
  const chartTimeMode = settings.data?.chart_time_mode ?? "absolute";

  // "relative" (the global chart-time-axis setting, Changes ausgust-25.txt):
  // elapsed seconds since each series' own first point, not real timestamps.
  // Measurements can have started on different real days/times; this is what
  // makes them "all start at t0" on one shared time axis, each keeping its
  // own native sample spacing (no interpolation). "absolute" plots each
  // series' real recorded time instead -- overlaid measurements from
  // different days simply won't line up on the horizontal axis in that mode.
  // Resolved once per series and reused for both the line itself and the
  // custom legend section below, so the two always agree.
  const seriesColors = selected.map(
    (m, i) => settings.data?.chart_colors?.[colorScheme]?.[m.unit] ?? FALLBACK_PALETTE[i % FALLBACK_PALETTE.length],
  );

  const series = selected.map((m, i) => {
    const points = pointQueries[measurementIds.indexOf(m.id)]?.data ?? [];
    const validPoints = points.filter((p) => p.value !== null);
    const t0 = validPoints[0]?.timestamp;
    const data: [number, number][] = validPoints.map((p) => [
      chartTimeMode === "relative" && t0 ? elapsedSeconds(p.timestamp, t0) : new Date(p.timestamp).getTime(),
      p.value as number,
    ]);
    return {
      type: "line" as const,
      name: m.name,
      showSymbol: false,
      yAxisIndex: rightUnit !== undefined && m.unit === rightUnit ? 1 : 0,
      data,
      itemStyle: { color: seriesColors[i] },
      lineStyle: { color: seriesColors[i] },
    };
  });

  // Each axis's offset is computed from only the series plotted against it --
  // a left-axis measurement's baseline shouldn't be dragged around by
  // whatever the right-axis measurement happens to be doing.
  const autoOffset = config.autoYOffset ?? true;
  function axisMin(axisIndex: 0 | 1): number | undefined {
    if (!autoOffset) return undefined;
    const values = series.filter((s) => s.yAxisIndex === axisIndex).flatMap((s) => s.data.map(([, v]) => v));
    return computeAutoYMin(values);
  }

  const option = {
    grid: { left: 55, right: rightUnit !== undefined ? 55 : 20, top: 20, bottom: 40 },
    xAxis: {
      type: chartTimeMode === "relative" ? "value" : "time",
      name: chartTimeMode === "relative" ? "s" : undefined,
      axisLine: tokens.axisLine,
      axisLabel: tokens.axisLabel,
      splitLine: tokens.splitLine,
    },
    yAxis: [
      {
        type: "value",
        name: leftUnit ?? "",
        min: axisMin(0),
        axisLine: tokens.axisLine,
        axisLabel: tokens.axisLabel,
        splitLine: tokens.splitLine,
      },
      ...(rightUnit !== undefined
        ? [
            {
              type: "value" as const,
              name: rightUnit,
              position: "right" as const,
              min: axisMin(1),
              axisLine: tokens.axisLine,
              axisLabel: tokens.axisLabel,
              splitLine: { show: false },
            },
          ]
        : []),
    ],
    series,
    // No ECharts `legend` component here -- see the plain DOM legend section
    // rendered above the chart below. A prior version used ECharts' own
    // scrolling legend *inside* the canvas, which had two problems: with many
    // series it could still overlap the plot area, and worse, the exported
    // image only ever captured whichever page of the scroll was currently
    // showing -- a real, separate section doesn't have either issue (though
    // it does mean the legend itself isn't part of the downloaded image,
    // only the chart is).
    tooltip: { trigger: "axis", ...tokens.tooltip },
  };

  return (
    <Stack gap={4} h="100%">
      <Group justify="flex-end">
        <ChartExportMenu chartRef={chartRef} filename="chart-multiple" />
      </Group>
      <Group gap="xs" wrap="wrap" style={{ flexShrink: 0 }}>
        {selected.map((m, i) => (
          <Group key={m.id} gap={4} wrap="nowrap">
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                backgroundColor: seriesColors[i],
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            <Text size="xs" lineClamp={1}>
              {m.name}
            </Text>
          </Group>
        ))}
      </Group>
      <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 150 }}>
        <ReactECharts ref={chartRef} option={option} style={{ height: "100%", width: "100%" }} notMerge lazyUpdate />
      </div>
    </Stack>
  );
}
