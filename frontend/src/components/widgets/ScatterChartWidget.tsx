import { useMemo, useRef } from "react";
import ReactECharts from "echarts-for-react";
import { Group, Select, Stack, Text, useComputedColorScheme } from "@mantine/core";

import { useAlign } from "../../api/calculations";
import { useMeasurements } from "../../api/measurements";
import type { WidgetConfig } from "../../state/dashboardStore";
import { echartsTokens } from "../../utils/echartsTheme";
import { ChartExportMenu } from "./ChartExportMenu";

interface ScatterChartWidgetProps {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}

export function ScatterChartWidget({ config, onConfigChange }: ScatterChartWidgetProps) {
  const measurements = useMeasurements();
  const align = useAlign(config.measurementIdX, config.measurementIdY);
  const chartRef = useRef<ReactECharts>(null);
  const colorScheme = useComputedColorScheme("light");
  const tokens = echartsTokens(colorScheme);

  const allOptions = (measurements.data ?? []).map((m) => ({ value: m.id, label: m.name }));
  const xOptions = allOptions.filter((o) => o.value !== config.measurementIdY);
  const yOptions = allOptions.filter((o) => o.value !== config.measurementIdX);

  const xMeasurement = measurements.data?.find((m) => m.id === config.measurementIdX);
  const yMeasurement = measurements.data?.find((m) => m.id === config.measurementIdY);

  // Interpolated points (from either source series) are rendered as a
  // separate, visually distinct series -- architecture.md SS7's requirement
  // that they never look identical to actually-measured points.
  const scatterData = useMemo(() => {
    const actual: [number, number][] = [];
    const interpolated: [number, number][] = [];
    if (align.data) {
      align.data.values_a.forEach((x, i) => {
        const y = align.data!.values_b[i];
        if (align.data!.interpolated_a[i] || align.data!.interpolated_b[i]) {
          interpolated.push([x, y]);
        } else {
          actual.push([x, y]);
        }
      });
    }
    return { actual, interpolated };
  }, [align.data]);

  const option = {
    grid: { left: 55, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: "value",
      name: xMeasurement?.unit ?? "X",
      axisLine: tokens.axisLine,
      axisLabel: tokens.axisLabel,
      splitLine: tokens.splitLine,
    },
    yAxis: {
      type: "value",
      name: yMeasurement?.unit ?? "Y",
      axisLine: tokens.axisLine,
      axisLabel: tokens.axisLabel,
      splitLine: tokens.splitLine,
    },
    series: [
      { type: "scatter", name: "Measured", symbolSize: 6, data: scatterData.actual },
      {
        type: "scatter",
        name: "Interpolated",
        symbolSize: 6,
        itemStyle: { color: "var(--mantine-color-gray-5)" },
        data: scatterData.interpolated,
      },
    ],
    legend: { top: 0, right: 0, ...tokens.legend },
    tooltip: { trigger: "item", ...tokens.tooltip },
  };

  return (
    <Stack gap={4} h="100%">
      <Group justify="space-between" wrap="nowrap">
        <Select
          size="xs"
          placeholder="X-axis measurement"
          data={xOptions}
          value={config.measurementIdX ?? null}
          onChange={(value) => onConfigChange({ ...config, measurementIdX: value ?? undefined })}
        />
        <ChartExportMenu chartRef={chartRef} filename="scatter-chart" />
      </Group>
      <Select
        size="xs"
        placeholder="Y-axis measurement"
        data={yOptions}
        value={config.measurementIdY ?? null}
        onChange={(value) => onConfigChange({ ...config, measurementIdY: value ?? undefined })}
      />
      {align.isError && (
        <Text size="xs" c="red">
          {(align.error as Error).message}
        </Text>
      )}
      {!config.measurementIdX || !config.measurementIdY ? (
        <Text size="sm" c="dimmed">
          Pick two measurements to plot one against the other.
        </Text>
      ) : (
        <div style={{ flex: 1, minWidth: 0, minHeight: 150 }}>
          <ReactECharts
            ref={chartRef}
            option={option}
            style={{ height: "100%", width: "100%" }}
            notMerge
            lazyUpdate
          />
        </div>
      )}
    </Stack>
  );
}
