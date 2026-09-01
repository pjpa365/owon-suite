import { Checkbox, Group, ScrollArea, Stack, Text, UnstyledButton, useComputedColorScheme } from "@mantine/core";

import { useMeasurements } from "../../api/measurements";
import type { MeasurementSummary } from "../../api/types";

// Chart (single)/(multiple) gear-settings picker (Changes ausgust-25.txt
// items 8/10): deliberately no filters or search, unlike StoredMeasurementBrowser
// -- just the plain list, newest first (the measurements list's default sort,
// measurement_store.py's `ORDER BY start_time DESC`), with ~7 rows visible in
// the scroll window and the rest reachable by scrolling.
const VISIBLE_ROWS = 7;
const ROW_HEIGHT = 46;

interface MeasurementPickerListProps {
  selectionMode: "single" | "multi";
  selectedIds: ReadonlySet<string>;
  onToggle: (measurement: MeasurementSummary) => void;
  /** Multi-select only: greys out and disables a row that can't be added
   * given what's already selected (Chart (multiple)'s 2-unit lock). */
  isDisabled?: (measurement: MeasurementSummary) => boolean;
}

export function MeasurementPickerList({ selectionMode, selectedIds, onToggle, isDisabled }: MeasurementPickerListProps) {
  const measurements = useMeasurements();
  const colorScheme = useComputedColorScheme("light");

  return (
    <ScrollArea.Autosize mah={VISIBLE_ROWS * ROW_HEIGHT}>
      <Stack gap={2}>
        {measurements.isLoading && (
          <Text size="xs" c="dimmed" p="xs">
            Loading…
          </Text>
        )}
        {measurements.data?.length === 0 && (
          <Text size="xs" c="dimmed" p="xs">
            No stored measurements yet.
          </Text>
        )}
        {measurements.data?.map((m) => {
          const selected = selectedIds.has(m.id);
          const disabled = isDisabled?.(m) ?? false;
          return (
            <UnstyledButton
              key={m.id}
              disabled={disabled}
              onClick={() => onToggle(m)}
              style={{
                padding: "4px 8px",
                borderRadius: "var(--mantine-radius-sm)",
                opacity: disabled ? 0.4 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
                // Selection stays brand-blue always (theme-tokens.md SS9), same
                // convention as StoredMeasurementBrowser's row selection.
                background: selected ? (colorScheme === "dark" ? "oklch(27% 0.03 251)" : "var(--mantine-color-brand-0)") : undefined,
              }}
            >
              <Group gap={6} wrap="nowrap">
                {selectionMode === "multi" && <Checkbox size="xs" checked={selected} disabled={disabled} readOnly />}
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Text size="xs" fw={500} lineClamp={1}>
                    {m.name}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {m.device_name} · {m.unit} · {m.count} values
                  </Text>
                </Stack>
              </Group>
            </UnstyledButton>
          );
        })}
      </Stack>
    </ScrollArea.Autosize>
  );
}
