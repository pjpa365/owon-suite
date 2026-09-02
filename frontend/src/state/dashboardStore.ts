import type { Layout, LayoutItem } from "react-grid-layout";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WidgetType =
  | "device-list"
  | "live-value"
  | "live-chart"
  | "recording-control"
  | "scatter-chart"
  | "chart-single"
  | "chart-multiple";

export interface WidgetConfig {
  deviceId?: string;
  measurementId?: string;
  measurementIdX?: string;
  measurementIdY?: string;
  /** Chart (multiple) (per-widget gear settings): the set of measurement IDs
   * plotted together, locked to at most 2 different units. */
  measurementIds?: string[];
  /** Live chart (per-widget gear settings). */
  pointCount?: number;
  /** Meter display (per-widget gear settings). */
  hideDeviceButtons?: boolean;
  /** Recording control (per-widget gear settings): "any" keeps the in-body
   * device picker (today's only behavior); "selected" locks to `deviceId`,
   * set via the gear instead. */
  deviceMode?: "any" | "selected";
  /** Chart (single) (per-widget gear settings): a display-time-only transform
   * applied to each raw value before plotting -- never persisted. */
  chartFunction?: { type: "shunt-to-current" | "ohm-to-current" | "current-to-power"; value: number };
  /** Live chart / Chart (single) / Chart (multiple) (per-widget gear settings):
   * rounds the y-axis minimum down to the nearest "nice" boundary below the
   * current data minimum instead of forcing 0 into view, so a small ripple on
   * top of a high baseline is actually visible. Defaults to enabled when
   * unset. For Chart (multiple), applies independently to each of the (up to
   * two) y-axes. */
  autoYOffset?: boolean;
}

export interface WidgetInstance {
  id: string;
  type: WidgetType;
  config: WidgetConfig;
}

export interface Dashboard {
  id: string;
  name: string;
  layout: Layout;
  widgets: WidgetInstance[];
}

// First-draft min/default sizes per widget type (grid: 12 cols, 60px rows) --
// deliberately a guess to be tuned via the live grid-block overlay shown
// while resizing (Changes_post_phase5_and_color_design.txt SS6), not a final
// value. minW/minH is a hard floor the user can't resize below.
export const WIDGET_SIZES: Record<WidgetType, { w: number; h: number; minW: number; minH: number }> = {
  "device-list": { w: 3, h: 6, minW: 2, minH: 3 },
  "live-value": { w: 4, h: 5, minW: 3, minH: 3 },
  "live-chart": { w: 6, h: 5, minW: 3, minH: 3 },
  "recording-control": { w: 4, h: 7, minW: 3, minH: 5 },
  "scatter-chart": { w: 6, h: 5, minW: 3, minH: 3 },
  "chart-single": { w: 6, h: 5, minW: 3, minH: 3 },
  "chart-multiple": { w: 7, h: 5, minW: 4, minH: 3 },
};

function makeId(): string {
  return crypto.randomUUID();
}

function makeDashboard(name: string): Dashboard {
  return { id: makeId(), name, layout: [], widgets: [] };
}

// A brand-new install's first dashboard isn't empty -- it starts with a
// small, useful default layout (Devices + Meter display side by side, Live
// chart below) instead of a blank grid nobody's told to fill in themselves.
// Only ever used the very first time (see initialDashboard below); anyone
// with an existing persisted dashboard keeps exactly what they already have
// -- zustand's `persist` middleware only falls back to this when localStorage
// has nothing stored yet.
function makeDefaultMainDashboard(): Dashboard {
  const devices: WidgetInstance = { id: makeId(), type: "device-list", config: {} };
  const meter: WidgetInstance = { id: makeId(), type: "live-value", config: {} };
  const chart: WidgetInstance = { id: makeId(), type: "live-chart", config: {} };
  return {
    id: makeId(),
    name: "Main",
    widgets: [devices, meter, chart],
    layout: [
      { i: devices.id, x: 0, y: 0, w: 3, h: 6, minW: WIDGET_SIZES["device-list"].minW, minH: WIDGET_SIZES["device-list"].minH },
      { i: meter.id, x: 3, y: 0, w: 5, h: 6, minW: WIDGET_SIZES["live-value"].minW, minH: WIDGET_SIZES["live-value"].minH },
      { i: chart.id, x: 0, y: 6, w: 8, h: 6, minW: WIDGET_SIZES["live-chart"].minW, minH: WIDGET_SIZES["live-chart"].minH },
    ],
  };
}

function nextLayoutItem(existing: Layout, id: string, type: WidgetType): LayoutItem {
  const maxY = existing.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const size = WIDGET_SIZES[type];
  return { i: id, x: 0, y: maxY, w: size.w, h: size.h, minW: size.minW, minH: size.minH };
}

interface DashboardState {
  dashboards: Dashboard[];
  defaultDashboardId: string;
  activeDashboardId: string;
  // Global (not per-dashboard) editing lock -- Changes_post_phase5_and_color_design.txt
  // SS8: when true, resizing/moving/deleting/configuring widgets and adding new
  // widgets/dashboards is blocked everywhere; widget *contents* stay interactive.
  lockEditing: boolean;
  // Set right after addWidget() so the dashboard grid can scroll the new widget
  // into view once, then clear it -- deliberately not persisted (purely a
  // one-shot UI cue, not app state worth remembering across reloads).
  focusWidgetId: string | null;
  setActiveDashboard: (id: string) => void;
  addDashboard: (name: string) => void;
  renameDashboard: (id: string, name: string) => void;
  removeDashboard: (id: string) => void;
  setDefaultDashboard: (id: string) => void;
  toggleLockEditing: () => void;
  clearFocusWidget: () => void;
  addWidget: (dashboardId: string, type: WidgetType) => void;
  removeWidget: (dashboardId: string, widgetId: string) => void;
  updateWidgetConfig: (dashboardId: string, widgetId: string, config: WidgetConfig) => void;
  updateLayout: (dashboardId: string, layout: Layout) => void;
}

const initialDashboard = makeDefaultMainDashboard();

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      dashboards: [initialDashboard],
      defaultDashboardId: initialDashboard.id,
      activeDashboardId: initialDashboard.id,
      lockEditing: false,
      focusWidgetId: null,

      setActiveDashboard: (id) => set({ activeDashboardId: id }),

      toggleLockEditing: () => set((state) => ({ lockEditing: !state.lockEditing })),

      clearFocusWidget: () => set({ focusWidgetId: null }),

      addDashboard: (name) =>
        set((state) => {
          const dashboard = makeDashboard(name);
          return { dashboards: [...state.dashboards, dashboard], activeDashboardId: dashboard.id };
        }),

      renameDashboard: (id, name) =>
        set((state) => ({
          dashboards: state.dashboards.map((d) => (d.id === id ? { ...d, name } : d)),
        })),

      removeDashboard: (id) =>
        set((state) => {
          if (state.dashboards.length <= 1) {
            return state; // always keep at least one dashboard
          }
          const dashboards = state.dashboards.filter((d) => d.id !== id);
          const defaultDashboardId =
            state.defaultDashboardId === id ? dashboards[0].id : state.defaultDashboardId;
          const activeDashboardId =
            state.activeDashboardId === id ? dashboards[0].id : state.activeDashboardId;
          return { dashboards, defaultDashboardId, activeDashboardId };
        }),

      setDefaultDashboard: (id) => set({ defaultDashboardId: id }),

      addWidget: (dashboardId, type) =>
        set((state) => {
          const widget: WidgetInstance = { id: makeId(), type, config: {} };
          return {
            dashboards: state.dashboards.map((d) =>
              d.id !== dashboardId
                ? d
                : {
                    ...d,
                    widgets: [...d.widgets, widget],
                    layout: [...d.layout, nextLayoutItem(d.layout, widget.id, type)],
                  },
            ),
            focusWidgetId: widget.id,
          };
        }),

      removeWidget: (dashboardId, widgetId) =>
        set((state) => ({
          dashboards: state.dashboards.map((d) =>
            d.id !== dashboardId
              ? d
              : {
                  ...d,
                  widgets: d.widgets.filter((w) => w.id !== widgetId),
                  layout: d.layout.filter((item) => item.i !== widgetId),
                },
          ),
        })),

      updateWidgetConfig: (dashboardId, widgetId, config) =>
        set((state) => ({
          dashboards: state.dashboards.map((d) =>
            d.id !== dashboardId
              ? d
              : {
                  ...d,
                  widgets: d.widgets.map((w) =>
                    w.id === widgetId ? { ...w, config: { ...w.config, ...config } } : w,
                  ),
                },
          ),
        })),

      updateLayout: (dashboardId, layout) =>
        set((state) => ({
          dashboards: state.dashboards.map((d) => (d.id === dashboardId ? { ...d, layout } : d)),
        })),
    }),
    {
      name: "owon-dashboard-store",
      partialize: (state) => ({
        dashboards: state.dashboards,
        defaultDashboardId: state.defaultDashboardId,
        lockEditing: state.lockEditing,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.activeDashboardId = state.defaultDashboardId;
        }
      },
    },
  ),
);
