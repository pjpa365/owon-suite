import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { Group, SegmentedControl, Stack, Text, useComputedColorScheme } from "@mantine/core";

import { useMeasurementPoints, useMeasurements } from "../../api/measurements";
import { useSettings } from "../../api/settings";
import { computeAutoYMin } from "../../utils/chartAxis";
import { sanitizeFilename } from "../../utils/chartExport";
import { elapsedSeconds } from "../../utils/chartTime";
import { echartsTokens } from "../../utils/echartsTheme";
import { ChartExportMenu } from "../widgets/ChartExportMenu";

// No dedicated "chart plot background" token exists anywhere else in the app
// (every other chart just inherits the page's background) -- this is the
// first chart with its own independent dark/light switch, decoupled from the
// app's own theme, so it needs an explicit background of its own. Reuses the
// existing dark tooltip background token for visual consistency with the
// rest of the app's dark mode rather than inventing a new color.
const DARK_CHART_BACKGROUND = "#181e24";

/** Measurements page (DataAdminPage.tsx): a chart of whichever measurement is
 * currently selected above, built the same way ChartSingleWidget draws its
 * chart -- but with its own local time-mode and dark/light switches instead
 * of following the app-wide Settings page, per Paul's explicit request that
 * this chart's look stays independent of the rest of the page/app. */
export function AdminMeasurementChart({ measurementId }: { measurementId: string | undefined }) {
  const settings = useSettings();
  const measurements = useMeasurements();
  const points = useMeasurementPoints(measurementId);
  const chartRef = useRef<ReactECharts>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const globalColorScheme = useComputedColorScheme("light");
  const [darkMode, setDarkMode] = useState(false);
  const [timeMode, setTimeMode] = useState<"absolute" | "relative">("absolute");
  const colorScheme = darkMode ? "dark" : "light";
  const tokens = echartsTokens(colorScheme);

  // Seeds both switches from the app-wide defaults (Settings page's dark mode
  // and Chart time axis) exactly once, the first time they're available --
  // same "apply once, then let the user override without being fought"
  // pattern AppShell.tsx already uses for the app's own dark/light mode
  // (appliedInitialScheme), not re-run on every settings/theme change
  // afterward since these two switches are then independent of the rest of
  // the app by design.
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (!appliedDefaults.current && settings.data) {
      setDarkMode(globalColorScheme === "dark");
      setTimeMode(settings.data.chart_time_mode);
      appliedDefaults.current = true;
    }
  }, [settings.data, globalColorScheme]);

  // Same resize-observer approach as ChartSingleWidget -- echarts-for-react's
  // own auto-resize doesn't reliably fire when the surrounding area resizes
  // (here: dragging the page's own top/bottom divider).
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

  if (!measurementId) {
    return (
      <Text size="sm" c="dimmed">
        Select a measurement above to see its chart here.
      </Text>
    );
  }

  const measurement = measurements.data?.find((m) => m.id === measurementId);
  const unit = measurement?.unit ?? "";
  const color = settings.data?.chart_colors?.[colorScheme]?.[unit];

  const validPoints = (points.data ?? []).filter((p) => p.value !== null);
  const t0 = validPoints[0]?.timestamp;
  const data: [number, number][] = validPoints.map((p) => [
    timeMode === "relative" && t0 ? elapsedSeconds(p.timestamp, t0) : new Date(p.timestamp).getTime(),
    p.value as number,
  ]);
  const yAxisMin = computeAutoYMin(data.map(([, v]) => v));

  const option = {
    backgroundColor: darkMode ? DARK_CHART_BACKGROUND : "#ffffff",
    grid: { left: 55, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: timeMode === "relative" ? "value" : "time",
      name: timeMode === "relative" ? "s" : undefined,
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
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" fw={600} lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
          {measurement?.name ?? ""}
        </Text>
        <Group gap="md" wrap="nowrap" align="flex-end">
          {/* Time and Theme deliberately use the identical control type/size
              -- matching each other, and matching how the Settings page
              already presents these same two choices elsewhere in the app
              -- rather than a segmented control next to an unrelated-looking
              switch. Export keeps the same icon-menu button used by every
              other chart's export control app-wide, just given the same
              small label treatment for row-level consistency. */}
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              Time
            </Text>
            <SegmentedControl
              size="xs"
              data={[
                { label: "Time of measurement", value: "absolute" },
                { label: "Relative", value: "relative" },
              ]}
              value={timeMode}
              onChange={(v) => setTimeMode(v as "absolute" | "relative")}
            />
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              Theme
            </Text>
            <SegmentedControl
              size="xs"
              data={[
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
              ]}
              value={darkMode ? "dark" : "light"}
              onChange={(v) => setDarkMode(v === "dark")}
            />
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              Export
            </Text>
            <ChartExportMenu
              chartRef={chartRef}
              filename={sanitizeFilename(measurement?.name ?? "measurement")}
              backgroundColor={darkMode ? DARK_CHART_BACKGROUND : "#ffffff"}
            />
          </Stack>
        </Group>
      </Group>
      <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
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
