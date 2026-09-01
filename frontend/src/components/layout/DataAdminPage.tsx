import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Group, Stack, Table, Text } from "@mantine/core";

import { useDeleteMeasurementPoints, useMeasurementPoints, useMeasurements } from "../../api/measurements";
import { StoredMeasurementBrowser } from "../widgets/StoredMeasurementBrowser";
import { useDateFormat } from "../../utils/dateFormat";
import { AdminMeasurementChart } from "./AdminMeasurementChart";

// Divider is clamped to this range so neither half can be dragged away to
// nothing -- there's always at least a fifth of the page's height left for
// both the lists and the chart.
const MIN_TOP_PCT = 20;
const MAX_TOP_PCT = 80;

// Records are listed in the store's default order (measurement_store.py:
// ORDER BY seq, i.e. oldest first) -- "top" and "bottom" below are relative
// to that order, per Paul's confirmation. If a sort control is added later,
// these two functions need to be reinterpreted relative to whatever order is
// actually displayed at the time.
function AdminRecordsSection({ measurementId }: { measurementId: string }) {
  const points = useMeasurementPoints(measurementId);
  const deletePoints = useDeleteMeasurementPoints();
  const { formatDateTime } = useDateFormat();
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const allIds = useMemo(() => points.data?.map((p) => p.id) ?? [], [points.data]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  function checkedIndexes(): number[] {
    if (!points.data) return [];
    return points.data.reduce<number[]>((acc, p, i) => {
      if (selected.has(p.id)) acc.push(i);
      return acc;
    }, []);
  }

  function deleteIds(ids: number[], confirmMessage: string) {
    if (ids.length === 0) return;
    if (!window.confirm(confirmMessage)) return;
    deletePoints.mutate({ measurementId, pointIds: ids }, { onSuccess: () => setSelected(new Set()) });
  }

  function handleDeleteSelected() {
    const ids = [...selected];
    deleteIds(ids, `Delete ${ids.length} selected data point(s)? This cannot be undone.`);
  }

  function handleDeleteTopThroughSelection() {
    const indexes = checkedIndexes();
    if (indexes.length === 0 || !points.data) return;
    const topIndex = Math.min(...indexes); // topmost checked row = lowest index in the default (oldest-first) order
    const ids = points.data.slice(0, topIndex + 1).map((p) => p.id);
    deleteIds(ids, `Delete ${ids.length} data point(s) from the top of the list through the selected row? This cannot be undone.`);
  }

  function handleDeleteSelectionThroughBottom() {
    const indexes = checkedIndexes();
    if (indexes.length === 0 || !points.data) return;
    const bottomIndex = Math.max(...indexes); // bottommost checked row = highest index
    const ids = points.data.slice(bottomIndex).map((p) => p.id);
    deleteIds(ids, `Delete ${ids.length} data point(s) from the selected row through the bottom of the list? This cannot be undone.`);
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <Text size="xs" c="dimmed">
          {points.data?.length ?? 0} rows
        </Text>
        <Group gap={4}>
          <Button
            size="xs"
            color="red"
            variant="light"
            disabled={selected.size === 0}
            onClick={handleDeleteTopThroughSelection}
          >
            Delete top → selection
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            disabled={selected.size === 0}
            onClick={handleDeleteSelectionThroughBottom}
          >
            Delete selection → bottom
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            disabled={selected.size === 0}
            loading={deletePoints.isPending}
            onClick={handleDeleteSelected}
          >
            Delete selected ({selected.size})
          </Button>
        </Group>
      </Group>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              <Checkbox size="xs" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
            </Table.Th>
            <Table.Th>Time</Table.Th>
            <Table.Th>Value</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {points.data?.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>
                <Checkbox size="xs" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              </Table.Td>
              <Table.Td>
                <Text size="xs">{formatDateTime(p.timestamp)}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{p.value === null ? "OL" : p.display_value}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

// StoredMeasurementBrowser lives in its own file (not a dashboard widget --
// the Measurement table widget it originally shipped as part of was removed,
// Changes ausgust-25.txt item 7) since this page is now its only caller.
export function DataAdminPage() {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // The split isn't persisted -- it resets to 50/50 each time this page is
  // opened, same as e.g. a Live chart widget's pause state resets on reload.
  const [topPct, setTopPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // Unfiltered, same default query StoredMeasurementBrowser itself uses when
  // no filter is active -- only used to default-select the top (newest) row
  // so the page shows something immediately rather than starting empty.
  // Doesn't try to track that browser's own live filter state: if the user
  // has typed a filter there, this may no longer match its top visible row,
  // which only matters until they click a different row themselves.
  const measurements = useMeasurements();

  useEffect(() => {
    if (!selectedId && measurements.data && measurements.data.length > 0) {
      setSelectedId(measurements.data[0].id);
    }
  }, [selectedId, measurements.data]);

  // Plain window-level mouse listeners rather than a library -- there's no
  // splitter/resizable-panel package anywhere in this app yet, and a single
  // drag handle doesn't warrant adding one.
  function handleDividerMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    draggingRef.current = true;

    function onMove(ev: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setTopPct(Math.min(MAX_TOP_PCT, Math.max(MIN_TOP_PCT, pct)));
    }
    function onUp() {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    // Fixed to the viewport height below the header (AppShell.tsx's header
    // is 60px) rather than letting the page grow and the browser window
    // scroll (the previous layout's approach, via StoredMeasurementBrowser's
    // `fullHeight` prop) -- a drag-to-resize split only makes sense within a
    // bounded container, so the top half now scrolls internally instead.
    <Stack ref={containerRef} gap={0} style={{ height: "calc(100vh - 60px)" }}>
      <div style={{ flex: `0 0 ${topPct}%`, minHeight: 0, overflow: "hidden" }}>
        {/* Plain flex row, not Mantine's Grid -- Grid's row height doesn't
            reliably stretch to fill a percentage-height parent the way a
            flex row does, which is what actually caused the "chart floating
            over both lists" bug: each column silently grew past its box
            instead of clipping/scrolling on its own. */}
        <Group h="100%" gap="md" p="md" align="stretch" wrap="nowrap">
          <div style={{ flex: 1, minWidth: 0, height: "100%", overflow: "auto" }}>
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Measurements
              </Text>
              <StoredMeasurementBrowser selectedId={selectedId} onSelect={setSelectedId} fullHeight />
            </Stack>
          </div>

          <div style={{ flex: 1, minWidth: 0, height: "100%", overflow: "auto" }}>
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Data points
              </Text>
              {selectedId ? (
                <AdminRecordsSection measurementId={selectedId} />
              ) : (
                <Text size="sm" c="dimmed">
                  Select a measurement above to browse its data points.
                </Text>
              )}
            </Stack>
          </div>
        </Group>
      </div>

      <div
        onMouseDown={handleDividerMouseDown}
        style={{
          flex: "0 0 6px",
          cursor: "row-resize",
          background: "var(--mantine-color-default-border)",
        }}
      />

      <div style={{ flex: `0 0 ${100 - topPct}%`, minHeight: 0, padding: "8px 16px" }}>
        <AdminMeasurementChart measurementId={selectedId} />
      </div>
    </Stack>
  );
}
