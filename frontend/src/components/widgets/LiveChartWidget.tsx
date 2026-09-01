import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { ActionIcon, Checkbox, Group, NumberInput, Select, Stack, Text, Tooltip, useComputedColorScheme } from "@mantine/core";
import { IconDeviceFloppy, IconEraser, IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";

import type { KnownDevice, MeasurementOut } from "../../api/types";
import { useSaveBuffer } from "../../api/measurements";
import { useSettings } from "../../api/settings";
import { MAX_BUFFER_SIZE } from "../../config";
import type { WidgetConfig } from "../../state/dashboardStore";
import { clearHistory, useLiveChartHistory } from "../../state/liveChartStream";
import { computeAutoYMin } from "../../utils/chartAxis";
import { elapsedSeconds } from "../../utils/chartTime";
import { useDateFormat } from "../../utils/dateFormat";
import { echartsTokens } from "../../utils/echartsTheme";
import { ChartExportMenu } from "./ChartExportMenu";

const DEFAULT_POINT_COUNT = 60;
const MIN_POINT_COUNT = 10;
const MAX_POINT_COUNT = MAX_BUFFER_SIZE; // matches the backend's real buffer size (config.ts)

interface LiveChartWidgetProps {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}

export function LiveChartSettings({
  config,
  onConfigChange,
  devices,
}: {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
  devices: KnownDevice[];
}) {
  const deviceOptions = devices.map((d) => ({ value: d.id, label: d.name }));

  return (
    <Stack gap="xs">
      <Select
        size="xs"
        label="Device"
        placeholder="Select device"
        data={deviceOptions}
        value={config.deviceId ?? null}
        onChange={(value) => onConfigChange({ ...config, deviceId: value ?? undefined })}
      />
      <NumberInput
        size="xs"
        label="Number of values (horizontal)"
        min={MIN_POINT_COUNT}
        max={MAX_POINT_COUNT}
        value={config.pointCount ?? DEFAULT_POINT_COUNT}
        onChange={(value) => onConfigChange({ ...config, pointCount: value === "" ? undefined : Number(value) })}
      />
      <Checkbox
        label="Auto Y-axis offset"
        checked={config.autoYOffset ?? true}
        onChange={(e) => onConfigChange({ ...config, autoYOffset: e.currentTarget.checked })}
      />
    </Stack>
  );
}

export function LiveChartWidget({ config }: LiveChartWidgetProps) {
  const settings = useSettings();
  // Shared per-device buffer (liveChartStream.ts) rather than this widget's
  // own WebSocket -- every Live chart widget watching the same device (any
  // dashboard, active tab or not) sees the exact same data, and it survives
  // this widget unmounting/remounting when its tab isn't active.
  const { history, sessionStart } = useLiveChartHistory(config.deviceId);
  const saveBuffer = useSaveBuffer();
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorScheme = useComputedColorScheme("light"); // resolves "auto" to the actual rendered surface
  const { formatTime } = useDateFormat();

  // Pause/unpause (Changes_post_phase5_and_color_design.txt) is purely local
  // to this widget instance -- the underlying shared stream above keeps
  // collecting regardless, so a second chart on the same device is
  // unaffected. Pausing just freezes the slice of `history` this widget
  // renders from; unpausing drops straight back to the live tail, which is
  // "adds all missed values at once" for free since nothing was ever queued
  // separately.
  const [paused, setPaused] = useState(false);
  const [frozenHistory, setFrozenHistory] = useState<MeasurementOut[] | null>(null);

  function togglePause() {
    setFrozenHistory(paused ? null : history);
    setPaused((p) => !p);
  }

  // echarts-for-react's own auto-resize relies on detecting a size change on
  // its root element, which didn't reliably fire when only the *grid item*
  // around it resized (the reported "resize doesn't resize the chart, leaves
  // dead space" bug) -- watching the chart's actual container directly and
  // calling .resize() explicitly is more robust than relying on that.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      chartRef.current?.getEchartsInstance().resize();
    });
    observer.observe(node);
    // A couple of rAF ticks after mount wasn't enough on its own (2026-09-01
    // bug report, still reproduced after that attempt: chart rendered too
    // narrow after a page reload, until the widget was manually resized) --
    // whatever delays the surrounding grid layout settling to its final size
    // isn't reliably bounded to a couple of frames. Poll for up to 2s after
    // mount and force a resize with the container's actual measured size
    // whenever it disagrees with what ECharts currently thinks it is, rather
    // than betting on one specific delay or trusting resize()'s own
    // auto-detection of the container size.
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

  if (!config.deviceId) {
    return (
      <Text size="sm" c="dimmed">
        Pick a device via this widget's gear settings.
      </Text>
    );
  }

  const deviceId = config.deviceId;
  const pointCount = config.pointCount ?? DEFAULT_POINT_COUNT;
  const effectiveHistory = paused && frozenHistory ? frozenHistory : history;
  // Fixed-width, non-compressing window (Changes_post_phase5_and_color_design.txt,
  // "Live chart widget"): a category axis with exactly `pointCount` slots, not a
  // time-value axis. The old `type: "time"` axis rescaled its domain to whatever
  // span was currently buffered, which is what read as "compression" whenever the
  // meter's sample rate wasn't perfectly constant -- a category axis has uniform
  // spacing between points regardless of their real-world time gaps, so the line
  // only ever grows left-to-right and the oldest point drops off the left once full.
  const visiblePoints = effectiveHistory.slice(-pointCount);
  const chartTimeMode = settings.data?.chart_time_mode ?? "absolute";
  // "relative" (the global chart-time-axis setting): t0 is fixed at the true
  // start of this device's whole session (liveChartStream.ts's sessionStart),
  // not derived from the buffered history's own first entry -- that array
  // gets trimmed once it exceeds the shared buffer's internal cap, which
  // silently dragged this forward in real time whenever a widget's configured
  // window size reached that same cap (real bug: the oldest *retained* and
  // oldest *visible* samples became the same one, evicted together).
  const t0 = sessionStart;
  const labels = visiblePoints.map((reading) =>
    chartTimeMode === "relative" && t0 ? `${elapsedSeconds(reading.timestamp, t0).toFixed(1)}s` : formatTime(reading.timestamp),
  );
  const values = visiblePoints.map((reading) => reading.value);

  const unit = visiblePoints.at(-1)?.unit ?? "";
  const color = settings.data?.chart_colors?.[colorScheme]?.[unit];
  const tokens = echartsTokens(colorScheme);
  const yAxisMin = (config.autoYOffset ?? true) ? computeAutoYMin(values) : undefined;
  // A fixed interval (not ECharts' "auto") so the SAME relative positions
  // stay labeled every render -- "auto" recomputes which indices get a label
  // from the current category count each time, which visibly shifts as
  // points keep arriving during the fill phase (a longer array each render
  // picks different label indices), reading as the axis "jumping between two
  // slightly different timelines" even though the data itself was continuous.
  // Based on how many points are actually visible right now, not the
  // widget's configured window size -- computing it off the configured size
  // instead meant a widget set to show e.g. 250 points had almost every
  // label suppressed during the first couple of minutes, while only a
  // handful of real points existed yet to label.
  const labelInterval = Math.max(0, Math.ceil(visiblePoints.length / 12) - 1);

  const option = {
    grid: { left: 55, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: false,
      axisLine: tokens.axisLine,
      axisLabel: { ...tokens.axisLabel, interval: labelInterval },
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
        data: values,
        ...(color ? { itemStyle: { color }, lineStyle: { color } } : {}),
      },
    ],
    tooltip: { trigger: "axis", ...tokens.tooltip },
  };

  return (
    <Stack gap={4} h="100%">
      <Group justify="flex-end" wrap="nowrap" gap={4}>
        <Tooltip label={paused ? "Unpause" : "Pause"}>
          <ActionIcon size="sm" variant="default" aria-label={paused ? "Unpause" : "Pause"} onClick={togglePause}>
            {paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Save buffer as measurement">
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="Save buffer as measurement"
            loading={saveBuffer.isPending}
            onClick={() => saveBuffer.mutate(deviceId)}
          >
            <IconDeviceFloppy size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Clear chart">
          <ActionIcon size="sm" variant="default" aria-label="Clear chart" onClick={() => clearHistory(deviceId)}>
            <IconEraser size={14} />
          </ActionIcon>
        </Tooltip>
        <ChartExportMenu chartRef={chartRef} filename="live-chart" />
      </Group>
      {/* minWidth: 0 -- without it this flex item can't shrink below its own
          content's natural width (the canvas's last-rendered size), which is
          what caused a horizontal scrollbar to appear instead of the chart
          actually shrinking when the widget was made narrower. */}
      <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 150 }}>
        <ReactECharts
          ref={chartRef}
          option={option}
          style={{ height: "100%", width: "100%" }}
          notMerge={false}
          lazyUpdate
        />
      </div>
    </Stack>
  );
}
