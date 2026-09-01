import type { RefObject } from "react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import type ReactECharts from "echarts-for-react";

import { downloadDataUrl } from "../../utils/chartExport";

interface ChartExportMenuProps {
  chartRef: RefObject<ReactECharts | null>;
  filename: string;
  /** Defaults to white -- every chart except the Measurements page's (which
   * has its own independent dark/light switch, AdminMeasurementChart.tsx)
   * always renders on a plain page background, so white was already correct
   * for those. Passing this explicitly is what lets the export follow the
   * chart's *current* toggle instead of always coming out light regardless
   * of it (2026-09-01 bug report). */
  backgroundColor?: string;
}

// architecture.md SS3.7: PNG/JPEG via ECharts' built-in getDataURL, no new
// dependency. SVG deferred -- it needs the chart rendered in ECharts' SVG
// renderer mode rather than the default canvas mode, which is more machinery
// than this "nice to have" format warranted for this pass.
export function ChartExportMenu({ chartRef, filename, backgroundColor = "#fff" }: ChartExportMenuProps) {
  function handleExport(type: "png" | "jpeg") {
    const instance = chartRef.current?.getEchartsInstance();
    if (!instance) return;
    const dataUrl = instance.getDataURL({ type, backgroundColor, pixelRatio: 2 });
    downloadDataUrl(dataUrl, `${filename}.${type === "jpeg" ? "jpg" : "png"}`);
  }

  return (
    <Menu shadow="md" position="bottom-end">
      <Menu.Target>
        <Tooltip label="Download image">
          <ActionIcon size="sm" variant="subtle" aria-label="Export chart image">
            &#8681;
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => handleExport("png")}>Export as PNG</Menu.Item>
        <Menu.Item onClick={() => handleExport("jpeg")}>Export as JPEG</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
