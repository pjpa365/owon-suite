import { useComputedColorScheme } from "@mantine/core";
import { useEffect, useState } from "react";
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import type { KnownDevice, MeasurementSummary } from "../../api/types";
import { useDevices } from "../../api/devices";
import { useMeasurements } from "../../api/measurements";
import { getDeviceColor } from "../../deviceColors";
import { WIDGET_MANUAL_SECTION } from "./ManualContent";
import { ChartMultipleSettings, ChartMultipleWidget, unitsInPlay } from "../widgets/ChartMultipleWidget";
import { ChartSingleSettings, ChartSingleWidget } from "../widgets/ChartSingleWidget";
import { DeviceListWidget } from "../widgets/DeviceListWidget";
import { LiveChartSettings, LiveChartWidget } from "../widgets/LiveChartWidget";
import { MeterDisplaySettings, MeterDisplayWidget } from "../widgets/LiveValueWidget";
import { RecordingControlSettings, RecordingControlWidget } from "../widgets/RecordingControlWidget";
import { ScatterChartWidget } from "../widgets/ScatterChartWidget";
import { WidgetContainer } from "../widgets/WidgetContainer";
import { useDashboardStore, type Dashboard, type WidgetConfig, type WidgetInstance } from "../../state/dashboardStore";

const WIDGET_TITLES: Record<WidgetInstance["type"], string> = {
  "device-list": "Devices",
  "live-value": "Meter display",
  "live-chart": "Live chart",
  "recording-control": "Recording control",
  "scatter-chart": "Scatter/XY chart",
  "chart-single": "Chart (single)",
  "chart-multiple": "Chart (multiple)",
};

// Widgets bound to exactly one device get their header tinted to that
// device's identity color (theme-tokens.md SS4) and their title suffixed
// with the device's name (section 6); widgets that can span multiple devices
// (scatter chart, chart (multiple)) or none in particular (device list)
// always stay neutral/unsuffixed. Chart (single) is device-scoped too, but
// via the *selected measurement's* device (config.deviceId is set alongside
// measurementId when a measurement is picked -- see ChartSingleWidget.tsx),
// not a dedicated device picker of its own.
const DEVICE_SCOPED_TYPES = new Set<WidgetInstance["type"]>(["live-value", "live-chart", "recording-control", "chart-single"]);

function renderWidgetBody(widget: WidgetInstance, onConfigChange: (config: WidgetConfig) => void) {
  switch (widget.type) {
    case "device-list":
      return <DeviceListWidget />;
    case "live-value":
      return <MeterDisplayWidget config={widget.config} onConfigChange={onConfigChange} />;
    case "live-chart":
      return <LiveChartWidget config={widget.config} onConfigChange={onConfigChange} />;
    case "recording-control":
      return <RecordingControlWidget config={widget.config} onConfigChange={onConfigChange} />;
    case "scatter-chart":
      return <ScatterChartWidget config={widget.config} onConfigChange={onConfigChange} />;
    case "chart-single":
      return <ChartSingleWidget config={widget.config} onConfigChange={onConfigChange} />;
    case "chart-multiple":
      return <ChartMultipleWidget config={widget.config} onConfigChange={onConfigChange} />;
  }
}

// Per-widget-type gear settings (section 5) -- undefined means no gear icon
// at all (device-list, scatter-chart don't have anything to configure yet).
function renderWidgetSettings(
  widget: WidgetInstance,
  onConfigChange: (config: WidgetConfig) => void,
  devices: KnownDevice[],
) {
  switch (widget.type) {
    case "live-value":
      return <MeterDisplaySettings config={widget.config} onConfigChange={onConfigChange} devices={devices} />;
    case "live-chart":
      return <LiveChartSettings config={widget.config} onConfigChange={onConfigChange} devices={devices} />;
    case "recording-control":
      return <RecordingControlSettings config={widget.config} onConfigChange={onConfigChange} devices={devices} />;
    case "chart-single":
      return <ChartSingleSettings config={widget.config} onConfigChange={onConfigChange} />;
    case "chart-multiple":
      return <ChartMultipleSettings config={widget.config} onConfigChange={onConfigChange} />;
    default:
      return undefined;
  }
}

export function DashboardGrid({
  dashboard,
  onOpenManual,
}: {
  dashboard: Dashboard;
  onOpenManual: (section: string) => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  const updateLayout = useDashboardStore((s) => s.updateLayout);
  const removeWidget = useDashboardStore((s) => s.removeWidget);
  const updateWidgetConfig = useDashboardStore((s) => s.updateWidgetConfig);
  const lockEditing = useDashboardStore((s) => s.lockEditing);
  const focusWidgetId = useDashboardStore((s) => s.focusWidgetId);
  const clearFocusWidget = useDashboardStore((s) => s.clearFocusWidget);
  const devices = useDevices();
  const measurements = useMeasurements();
  const colorScheme = useComputedColorScheme("light");

  // "w x h" of whichever widget is currently being resized, so the sizing
  // constants in dashboardStore's WIDGET_SIZES can be tuned by eye (section 6).
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null);

  // Scroll to the bottom of the page once after a widget is added (section 7)
  // -- widgets are always appended at the bottom of the first column, so
  // this is what makes the addition actually visible to the user. Simpler
  // than scrolling to the specific widget's node: react-grid-layout keeps its
  // own internal copy of the layout, synced from our `layout` prop one render
  // *after* ours, so the new grid item (and its final height) isn't actually
  // painted yet on the render where this effect first fires -- a couple of
  // rAF ticks lets that catch up before reading how tall the page now is.
  useEffect(() => {
    if (!focusWidgetId) return;
    let cancelled = false;

    function scrollToBottom() {
      if (cancelled) return;
      const scrollingElement = document.scrollingElement ?? document.documentElement;
      scrollingElement.scrollTo({ top: scrollingElement.scrollHeight, behavior: "smooth" });
      clearFocusWidget();
    }

    requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    return () => {
      cancelled = true;
    };
  }, [focusWidgetId, clearFocusWidget]);

  function deviceFor(widget: WidgetInstance) {
    if (!DEVICE_SCOPED_TYPES.has(widget.type) || !widget.config.deviceId) return undefined;
    return devices.data?.find((d) => d.id === widget.config.deviceId);
  }

  function headerColorFor(widget: WidgetInstance): string | undefined {
    const device = deviceFor(widget);
    if (!device) return undefined;
    const swatch = getDeviceColor(device.color);
    return colorScheme === "dark" ? swatch.headerDark : swatch.headerLight;
  }

  function titleFor(widget: WidgetInstance): string {
    // Chart (single): "Chart - <name of the selected measurement>" (item 8),
    // not the generic "<type> — <device>" pattern every other widget uses.
    if (widget.type === "chart-single") {
      const measurement = measurements.data?.find((m) => m.id === widget.config.measurementId);
      return measurement ? `Chart - ${measurement.name}` : WIDGET_TITLES[widget.type];
    }
    // Chart (multiple): "Chart - <x> measurements, <unit-left> <unit-right>" (item 10).
    if (widget.type === "chart-multiple") {
      const ids = widget.config.measurementIds ?? [];
      if (ids.length === 0) return WIDGET_TITLES[widget.type];
      const selected = ids
        .map((id) => measurements.data?.find((m) => m.id === id))
        .filter((m): m is MeasurementSummary => !!m);
      const units = unitsInPlay(selected);
      return `Chart - ${selected.length} measurements, ${units.join(" ")}`;
    }
    const device = deviceFor(widget);
    return device ? `${WIDGET_TITLES[widget.type]} — ${device.name}` : WIDGET_TITLES[widget.type];
  }

  function handleLayoutChange(layout: Layout) {
    updateLayout(dashboard.id, layout);
  }

  if (dashboard.widgets.length === 0) {
    return (
      <div ref={containerRef} style={{ padding: "2rem", textAlign: "center", color: "var(--mantine-color-dimmed)" }}>
        This dashboard has no widgets yet — use "Add widget" to get started.
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={dashboard.layout}
          gridConfig={{ cols: 12, rowHeight: 60, margin: [8, 8] }}
          dragConfig={{ enabled: !lockEditing, handle: ".widget-drag-handle" }}
          resizeConfig={{ enabled: !lockEditing }}
          onLayoutChange={handleLayoutChange}
          onResize={(_layout, _oldItem, newItem) => {
            if (newItem) setResizing({ id: newItem.i, w: newItem.w, h: newItem.h });
          }}
          onResizeStop={() => setResizing(null)}
        >
          {dashboard.widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetContainer
                title={titleFor(widget)}
                onRemove={() => removeWidget(dashboard.id, widget.id)}
                headerColor={headerColorFor(widget)}
                locked={lockEditing}
                sizeOverlay={resizing?.id === widget.id ? `${resizing.w} x ${resizing.h}` : undefined}
                settingsContent={renderWidgetSettings(
                  widget,
                  (config) => updateWidgetConfig(dashboard.id, widget.id, config),
                  devices.data ?? [],
                )}
                onShowManual={() => onOpenManual(WIDGET_MANUAL_SECTION[widget.type])}
              >
                {renderWidgetBody(widget, (config) => updateWidgetConfig(dashboard.id, widget.id, config))}
              </WidgetContainer>
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
