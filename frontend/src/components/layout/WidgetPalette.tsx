import { Button, Menu } from "@mantine/core";

import { useDashboardStore, type WidgetType } from "../../state/dashboardStore";

const WIDGET_LABELS: Record<WidgetType, string> = {
  "device-list": "Device list",
  "live-value": "Meter display",
  "live-chart": "Live chart",
  "recording-control": "Recording control",
  "scatter-chart": "Scatter/XY chart",
  "chart-single": "Chart (single)",
  "chart-multiple": "Chart (multiple)",
};

export function WidgetPalette({ dashboardId }: { dashboardId: string }) {
  const addWidget = useDashboardStore((s) => s.addWidget);
  const lockEditing = useDashboardStore((s) => s.lockEditing);

  if (lockEditing) return null;

  return (
    <Menu shadow="md" position="bottom-end">
      <Menu.Target>
        <Button size="xs" variant="light">
          Add widget
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {(Object.entries(WIDGET_LABELS) as [WidgetType, string][]).map(([type, label]) => (
          <Menu.Item key={type} onClick={() => addWidget(dashboardId, type)}>
            {label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
