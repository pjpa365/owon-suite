import type { CSSProperties } from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { IconTrash } from "@tabler/icons-react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core";

import { API_BASE } from "../../api/client";
import { useDevices } from "../../api/devices";
import { useDeleteMeasurement, useMeasurements, useRenameMeasurement } from "../../api/measurements";
import type { MeasurementSummary } from "../../api/types";
import { CHIP_HUES, chipStyle } from "../../utils/statusChip";
import { CalculatedBadge, CalculationModal } from "./CalculationModal";

// The raw date input has no Mantine equivalent, so (like RecordingControlWidget's
// datetime-local field) it needs explicit theme-aware colors -- left unstyled it
// keeps a plain white background/black text regardless of the app's dark mode.
const DATE_INPUT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: "4px 8px",
  backgroundColor: "var(--mantine-color-body)",
  color: "var(--mantine-color-text)",
  border: "1px solid var(--mantine-color-default-border)",
  borderRadius: "var(--mantine-radius-sm)",
};

function RenameMeasurementModal({
  measurement,
  onClose,
}: {
  measurement: MeasurementSummary | null;
  onClose: () => void;
}) {
  const renameMeasurement = useRenameMeasurement();
  const { register, handleSubmit } = useForm<{ name: string }>({
    values: { name: measurement?.name ?? "" },
  });

  function onSubmit(values: { name: string }) {
    if (!measurement) return;
    renameMeasurement.mutate({ measurementId: measurement.id, name: values.name }, { onSuccess: onClose });
  }

  return (
    <Modal opened={!!measurement} onClose={onClose} title="Rename measurement">
      <form onSubmit={handleSubmit(onSubmit)}>
        <Stack>
          <TextInput label="Name" {...register("name", { required: true })} />
          <Button type="submit" loading={renameMeasurement.isPending}>
            Save
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

export function StoredMeasurementBrowser({
  selectedId,
  onSelect,
  fullHeight,
}: {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** Data admin page: the list should use the whole page's natural scroll
   * instead of a small internal scrollbox -- the dashboard widget (no
   * `fullHeight`) keeps the compact, fixed-height ScrollArea since it has to
   * fit inside a widget card. */
  fullHeight?: boolean;
}) {
  const devices = useDevices();
  const colorScheme = useComputedColorScheme("light");
  const [deviceFilter, setDeviceFilter] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [renameTarget, setRenameTarget] = useState<MeasurementSummary | null>(null);
  const [calcTarget, setCalcTarget] = useState<MeasurementSummary | null>(null);

  const measurements = useMeasurements({
    device_id: deviceFilter ?? undefined,
    name_contains: nameFilter || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  });
  const deleteMeasurement = useDeleteMeasurement();

  const deviceOptions = (devices.data ?? []).map((d) => ({ value: d.id, label: d.name }));
  // fullHeight (Data admin page): plain div, no cap -- the whole page scrolls
  // instead of a small internal scrollbox.
  const TableWrapper = fullHeight ? "div" : ScrollArea.Autosize;

  function handleDelete(measurement: MeasurementSummary) {
    if (window.confirm(`Delete measurement "${measurement.name}"? This cannot be undone.`)) {
      deleteMeasurement.mutate(measurement.id, {
        onSuccess: () => {
          if (selectedId === measurement.id) onSelect("");
        },
      });
    }
  }

  return (
    <Stack gap="xs">
      <Group gap={4} wrap="wrap">
        {/* position="top" (not the Mantine default "bottom") -- with the Device
            filter specifically, "bottom" put the tooltip right over the open
            dropdown list, hiding it (Changes ausgust-25.txt item 9). */}
        <Tooltip label="Only show measurements recorded on this device" position="top" withArrow>
          <Select
            placeholder="Device"
            size="xs"
            w={120}
            clearable
            data={deviceOptions}
            value={deviceFilter}
            onChange={setDeviceFilter}
          />
        </Tooltip>
        <Tooltip label="Only show measurements whose name contains this text" position="top" withArrow>
          <TextInput
            placeholder="Name contains…"
            size="xs"
            w={140}
            value={nameFilter}
            onChange={(e) => setNameFilter(e.currentTarget.value)}
          />
        </Tooltip>
        <Tooltip label="Only show measurements that started on or after this date" position="top" withArrow>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={DATE_INPUT_STYLE}
          />
        </Tooltip>
        <Tooltip label="Only show measurements that started on or before this date" position="top" withArrow>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={DATE_INPUT_STYLE} />
        </Tooltip>
      </Group>

      {measurements.isLoading && (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      )}
      {measurements.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No measurements match.
        </Text>
      )}

      <TableWrapper {...(fullHeight ? {} : { mah: 160 })}>
        <Table striped highlightOnHover>
          <Table.Tbody>
            {measurements.data?.map((m) => (
              <Table.Tr
                key={m.id}
                onClick={() => onSelect(m.id)}
                style={{
                  cursor: "pointer",
                  // Selection stays brand-blue always (theme-tokens.md SS9), never device- or
                  // status-colored, so it's never confused with either of those.
                  ...(m.id === selectedId
                    ? { background: colorScheme === "dark" ? "oklch(27% 0.03 251)" : "var(--mantine-color-brand-0)" }
                    : {}),
                }}
              >
                <Table.Td
                  style={
                    m.id === selectedId
                      ? {
                          borderLeft: `3px solid ${
                            colorScheme === "dark" ? "var(--mantine-color-brand-4)" : "var(--mantine-color-brand-6)"
                          }`,
                        }
                      : undefined
                  }
                >
                  <Text size="xs" fw={500} lineClamp={1}>
                    {m.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {m.device_name} · {m.unit} · {m.count} values
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Badge size="xs" style={chipStyle(CHIP_HUES.neutral, colorScheme)}>
                      {m.status}
                    </Badge>
                    <CalculatedBadge measurement={m} />
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label="Rename" withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameTarget(m);
                        }}
                      >
                        ✎
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Calculate" withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Calculate"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCalcTarget(m);
                        }}
                      >
                        ∑
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Export CSV" withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Export CSV"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(`${API_BASE}/measurements/${m.id}/export.csv`, "_blank");
                        }}
                      >
                        &#8681;
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete" withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        aria-label="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(m);
                        }}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </TableWrapper>

      <RenameMeasurementModal measurement={renameTarget} onClose={() => setRenameTarget(null)} />
      {calcTarget && <CalculationModal measurement={calcTarget} onClose={() => setCalcTarget(null)} />}
    </Stack>
  );
}
