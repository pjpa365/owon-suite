import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { ActionIcon, Group, NumberInput, Popover, Stack, Tooltip, useComputedColorScheme } from "@mantine/core";
import { IconDeviceFloppy, IconEraser, IconPlayerPause, IconPlayerPlay, IconTimeline } from "@tabler/icons-react";

import { useSaveBuffer } from "../api/measurements";
import { useMobileDisplaySettings } from "../api/mobile";
import type { MeasurementOut } from "../api/types";
import { useLiveStream } from "../hooks/useLiveStream";
import { computeAutoYMin } from "../utils/chartAxis";
import { elapsedSeconds } from "../utils/chartTime";
import { useDateFormat } from "../utils/dateFormat";
import { echartsTokens } from "../utils/echartsTheme";

// A target label count, not a fixed pixel width -- picking `interval`
// explicitly (rather than leaving it "auto") keeps the SAME relative
// positions labeled every render. Left on "auto", ECharts recomputes which
// indices get a label from the current category count each render, which
// visibly shifts as new points keep arriving (every render during the
// initial fill has a different array length) -- read as the axis "jumping
// between two slightly different timelines" even though the underlying data
// was continuous the whole time.
const TARGET_LABEL_COUNT = 10;
const DEFAULT_WINDOW_SECONDS = 30;

export function MobileChartPane({ deviceId }: { deviceId: string }) {
  const { history, sessionStart } = useLiveStream(deviceId);
  const settings = useMobileDisplaySettings();
  const saveBuffer = useSaveBuffer();
  const colorScheme = useComputedColorScheme("light");
  const { formatTime } = useDateFormat();
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<MeasurementOut[] | null>(null);
  const [clearedAt, setClearedAt] = useState(0);
  const [windowSeconds, setWindowSeconds] = useState(DEFAULT_WINDOW_SECONDS);
  const [windowPopoverOpen, setWindowPopoverOpen] = useState(false);
  // t0 after a manual clear -- latched once to the first point that arrives
  // post-clear, then left alone (same reasoning as useLiveStream.ts's own
  // sessionStart: re-deriving it from the visible array's current first
  // entry would let it drift once that entry eventually falls off the raw
  // buffer's internal cap).
  const clearedSessionStartRef = useRef<string | null>(null);

  function pause() {
    setFrozen(history);
    setPaused(true);
  }

  function resume() {
    setFrozen(null);
    setPaused(false);
  }

  function clear() {
    setClearedAt(Date.now());
    clearedSessionStartRef.current = null;
  }

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => chartRef.current?.getEchartsInstance().resize());
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

  const effectiveHistory = paused && frozen ? frozen : history;
  const sinceClear = effectiveHistory.filter((r) => new Date(r.timestamp).getTime() >= clearedAt);
  // "Chart time axis" (Settings page, applies to every time-based chart, not
  // just the PC ones). Normally the hook's own fixed sessionStart; after a
  // manual clear, latched instead to the first point seen since that clear
  // (once, then left alone -- see clearedSessionStartRef above). Computed
  // from the full since-clear series, NOT the time-windowed one below --
  // this is "elapsed since the session/clear started", which shouldn't reset
  // every time the visible window slides.
  const chartTimeMode = settings.data?.chart_time_mode ?? "absolute";
  if (clearedAt > 0 && clearedSessionStartRef.current === null && sinceClear.length > 0) {
    clearedSessionStartRef.current = sinceClear[0].timestamp;
  }
  const t0 = clearedAt > 0 ? clearedSessionStartRef.current : sessionStart;

  // Time window (the timeline icon below): only ever shows the most recent
  // `windowSeconds` of data, measured from the latest point's own timestamp
  // (not the browser clock, which could disagree slightly with the meter's
  // read timestamps) -- new points enter from the right, and anything older
  // than the window falls off the left as they do, exactly like the PC Live
  // chart's point-count window, just measured in time instead of point count.
  const latestTimestamp = sinceClear.at(-1)?.timestamp;
  const windowCutoff = latestTimestamp ? new Date(latestTimestamp).getTime() - windowSeconds * 1000 : 0;
  const visible = sinceClear.filter((r) => new Date(r.timestamp).getTime() >= windowCutoff);

  const labels = visible.map((r) =>
    chartTimeMode === "relative" && t0 ? `${elapsedSeconds(r.timestamp, t0).toFixed(1)}s` : formatTime(r.timestamp),
  );
  const values = visible.map((r) => r.value);
  const unit = visible.at(-1)?.unit ?? "";
  const color = settings.data?.chart_colors?.[colorScheme]?.[unit];
  const tokens = echartsTokens(colorScheme);
  const yAxisMin = computeAutoYMin(values);
  const labelInterval = Math.max(0, Math.ceil(labels.length / TARGET_LABEL_COUNT) - 1);

  const option = {
    grid: { left: 50, right: 15, top: 15, bottom: 30 },
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
    <Stack gap={4} h="100%" style={{ minHeight: 0 }}>
      <Group justify="center" gap="md">
        <Tooltip label={paused ? "Resume live-stream" : "Pause live-stream"}>
          <ActionIcon
            size="lg"
            variant="default"
            aria-label={paused ? "Resume live-stream" : "Pause live-stream"}
            onClick={() => (paused ? resume() : pause())}
          >
            {paused ? <IconPlayerPlay size={20} /> : <IconPlayerPause size={20} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Save live-stream">
          <ActionIcon
            size="lg"
            variant="default"
            aria-label="Save live-stream"
            loading={saveBuffer.isPending}
            onClick={() => saveBuffer.mutate(deviceId)}
          >
            <IconDeviceFloppy size={20} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Clear live-stream">
          <ActionIcon size="lg" variant="default" aria-label="Clear live-stream" onClick={clear}>
            <IconEraser size={20} />
          </ActionIcon>
        </Tooltip>
        <Popover opened={windowPopoverOpen} onChange={setWindowPopoverOpen} withArrow position="bottom" shadow="md">
          <Popover.Target>
            <Tooltip label="Time window">
              <ActionIcon
                size="lg"
                variant="default"
                aria-label="Time window"
                onClick={() => setWindowPopoverOpen((v) => !v)}
              >
                <IconTimeline size={20} />
              </ActionIcon>
            </Tooltip>
          </Popover.Target>
          <Popover.Dropdown>
            <NumberInput
              label="Seconds to show"
              value={windowSeconds}
              onChange={(v) => {
                const n = typeof v === "number" ? v : Number(v);
                if (Number.isFinite(n) && n >= 1) setWindowSeconds(Math.round(n));
              }}
              min={1}
              step={1}
              allowDecimal={false}
              w={140}
            />
          </Popover.Dropdown>
        </Popover>
      </Group>
      <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 120 }}>
        <ReactECharts ref={chartRef} option={option} style={{ height: "100%", width: "100%" }} notMerge lazyUpdate />
      </div>
    </Stack>
  );
}
