import { useEffect, useRef } from "react";
import ReactECharts from "echarts-for-react";
import { Checkbox, Group, NumberInput, Select, Stack, Text, useComputedColorScheme } from "@mantine/core";

import { useMeasurements, useMeasurementPoints } from "../../api/measurements";
import { useSettings } from "../../api/settings";
import type { MeasurementSummary } from "../../api/types";
import type { WidgetConfig } from "../../state/dashboardStore";
import { computeAutoYMin } from "../../utils/chartAxis";
import { elapsedSeconds } from "../../utils/chartTime";
import { echartsTokens } from "../../utils/echartsTheme";
import { ChartExportMenu } from "./ChartExportMenu";
import { MeasurementPickerList } from "./MeasurementPickerList";

// Chart (single) (Changes ausgust-25.txt item 8): a single stored measurement,
// its full history, with an optional display-time-only transform (never
// persisted -- item 12: "save the original ... not the calculated").
type ChartFunctionType = "shunt-to-current" | "ohm-to-current" | "current-to-power";

function isVoltageUnit(unit: string): boolean {
  return unit.endsWith("V");
}
function isResistanceUnit(unit: string): boolean {
  return unit.endsWith("Ohm");
}
function isCurrentUnit(unit: string): boolean {
  return unit.endsWith("A");
}

function availableFunction(unit: string): { type: ChartFunctionType; label: string; fieldLabel: string } | null {
  if (isVoltageUnit(unit)) {
    return { type: "shunt-to-current", label: "Volt (shunt) to current (A)", fieldLabel: "Shunt resistance (Ω)" };
  }
  if (isResistanceUnit(unit)) {
    return { type: "ohm-to-current", label: "Ohm to current (A)", fieldLabel: "Constant voltage (V)" };
  }
  if (isCurrentUnit(unit)) {
    return { type: "current-to-power", label: "Current to power (W)", fieldLabel: "Constant voltage (V)" };
  }
  return null;
}

function applyFunction(rawValue: number, fn: WidgetConfig["chartFunction"]): number {
  if (!fn) return rawValue;
  if (fn.type === "shunt-to-current") return rawValue / fn.value; // I = U / R
  if (fn.type === "ohm-to-current") return fn.value / rawValue; // I = V / R
  return rawValue * fn.value; // current-to-power: P = I x V
}

function outputUnit(measurementUnit: string, fn: WidgetConfig["chartFunction"]): string {
  if (!fn) return measurementUnit;
  return fn.type === "current-to-power" ? "W" : "A";
}

export function ChartSingleSettings({
  config,
  onConfigChange,
}: {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}) {
  const measurements = useMeasurements();
  const selected = measurements.data?.find((m) => m.id === config.measurementId);
  const fn = selected ? availableFunction(selected.unit) : null;

  function handleSelect(m: MeasurementSummary) {
    onConfigChange({ ...config, measurementId: m.id, deviceId: m.device_id, chartFunction: undefined });
  }

  return (
    <Stack gap="xs">
      <Text size="xs" fw={600}>
        Measurement
      </Text>
      <MeasurementPickerList
        selectionMode="single"
        selectedIds={new Set(config.measurementId ? [config.measurementId] : [])}
        onToggle={handleSelect}
      />
      <Checkbox
        label="Auto Y-axis offset"
        checked={config.autoYOffset ?? true}
        onChange={(e) => onConfigChange({ ...config, autoYOffset: e.currentTarget.checked })}
      />
      {selected && (
        <Stack gap={4} pt={4}>
          <Select
            size="xs"
            label="Function"
            placeholder="No function"
            clearable
            data={fn ? [{ value: fn.type, label: fn.label }] : []}
            value={config.chartFunction?.type ?? null}
            onChange={(value) =>
              onConfigChange({
                ...config,
                chartFunction: value
                  ? { type: value as ChartFunctionType, value: config.chartFunction?.value ?? 0 }
                  : undefined,
              })
            }
          />
          {config.chartFunction && fn && (
            <NumberInput
              size="xs"
              label={fn.fieldLabel}
              value={config.chartFunction.value}
              onChange={(v) =>
                onConfigChange({
                  ...config,
                  chartFunction: { type: config.chartFunction!.type, value: v === "" ? 0 : Number(v) },
                })
              }
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

interface ChartSingleWidgetProps {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}

export function ChartSingleWidget({ config }: ChartSingleWidgetProps) {
  const settings = useSettings();
  const measurements = useMeasurements();
  const points = useMeasurementPoints(config.measurementId);
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorScheme = useComputedColorScheme("light");
  const tokens = echartsTokens(colorScheme);

  // Same resize-observer approach as LiveChartWidget/ScatterChartWidget --
  // echarts-for-react's own auto-resize doesn't reliably fire on a grid-item
  // resize alone.
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

  if (!config.measurementId) {
    return (
      <Text size="sm" c="dimmed">
        Pick a measurement via this widget's gear settings.
      </Text>
    );
  }

  const measurement = measurements.data?.find((m) => m.id === config.measurementId);
  const unit = measurement ? outputUnit(measurement.unit, config.chartFunction) : "";
  const color = settings.data?.chart_colors?.[colorScheme]?.[unit];
  const chartTimeMode = settings.data?.chart_time_mode ?? "absolute";

  const validPoints = (points.data ?? []).filter((p) => p.value !== null);
  const t0 = validPoints[0]?.timestamp;
  const data: [number, number][] = validPoints.map((p) => [
    chartTimeMode === "relative" && t0 ? elapsedSeconds(p.timestamp, t0) : new Date(p.timestamp).getTime(),
    applyFunction(p.value as number, config.chartFunction),
  ]);
  const yAxisMin =
    (config.autoYOffset ?? true) ? computeAutoYMin(data.map(([, v]) => v)) : undefined;

  const option = {
    grid: { left: 55, right: 20, top: 20, bottom: 40 },
    // A real time/value axis (not the fixed-window category axis Live chart
    // uses) -- this shows a whole stored recording's history, not a live
    // sliding window, so ECharts' own "nice" tick-interval algorithm (which
    // automatically steps between coarser/finer round intervals as the
    // widget is resized) is exactly the auto-scaling behavior requested.
    // "relative" mode (global chart-time-axis setting) plots elapsed seconds
    // since this measurement's own first point instead of real time, so it
    // needs a plain "value" axis rather than "time".
    xAxis: {
      type: chartTimeMode === "relative" ? "value" : "time",
      name: chartTimeMode === "relative" ? "s" : undefined,
      axisLine: tokens.axisLine,
      axisLabel: tokens.axisLabel,
      splitLine: tokens.splitLine,
    },
    yAxis: {
      type: "value",
      name: unit,
      min: yAxisMin,
      axisLine: tokens.axisLine,
      axisLabel: tokens.axisLabel,
      splitLine: tokens.splitLine,
    },
    series: [
      {
        type: "line",
        showSymbol: false,
        data,
        ...(color ? { itemStyle: { color }, lineStyle: { color } } : {}),
      },
    ],
    tooltip: { trigger: "axis", ...tokens.tooltip },
  };

  return (
    <Stack gap={4} h="100%">
      <Group justify="flex-end">
        <ChartExportMenu chartRef={chartRef} filename="chart-single" />
      </Group>
      <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 150 }}>
        {data.length > 0 ? (
          <ReactECharts
            ref={chartRef}
            option={option}
            style={{ height: "100%", width: "100%" }}
            notMerge
            lazyUpdate
          />
        ) : (
          <Text size="sm" c="dimmed">
            {points.isLoading ? "Loading…" : "No data points in this measurement."}
          </Text>
        )}
      </div>
    </Stack>
  );
}
