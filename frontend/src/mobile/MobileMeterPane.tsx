import { Anchor, Badge, Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";

import { useSendControl } from "../api/devices";
import { usePauseAdhoc, useResumeAdhoc, useStartAdhoc, useStopAdhoc, useAdhocStatus } from "../api/measurements";
import { CONTROL_OPTIONS } from "../api/types";
import { CONTROL_LABELS } from "../controlLabels";
import { useLiveStream } from "../hooks/useLiveStream";
import { formatUnit } from "../utils/formatUnit";

// Mirrors the PC Meter display widget's RecordColumn (LiveValueWidget.tsx),
// laid out horizontally instead of as a side column -- same red
// record/pause/stop convention, top-right of the meter section.
function MobileRecordControls({ deviceId }: { deviceId: string }) {
  const status = useAdhocStatus(deviceId);
  const start = useStartAdhoc();
  const pause = usePauseAdhoc();
  const resume = useResumeAdhoc();
  const stop = useStopAdhoc();

  const active = status.data?.active ?? false;
  const paused = status.data?.paused ?? false;
  const busy = start.isPending || pause.isPending || resume.isPending || stop.isPending;

  if (!active) {
    return (
      <Button size="compact-sm" color="red" variant="outline" loading={busy} onClick={() => start.mutate(deviceId)}>
        ● Record
      </Button>
    );
  }

  return (
    <Group gap={6} wrap="nowrap">
      <span
        className={paused ? undefined : "pulse-glow"}
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          flexShrink: 0,
          ...(paused
            ? { border: "2px solid var(--mantine-color-red-filled)" }
            : { backgroundColor: "var(--mantine-color-red-filled)" }),
        }}
      />
      {paused ? (
        <Button size="compact-sm" color="red" variant="outline" loading={busy} onClick={() => resume.mutate(deviceId)}>
          Resume
        </Button>
      ) : (
        <Button size="compact-sm" color="red" variant="outline" loading={busy} onClick={() => pause.mutate(deviceId)}>
          Pause
        </Button>
      )}
      <Button size="compact-sm" color="red" variant="outline" loading={busy} onClick={() => stop.mutate(deviceId)}>
        Stop
      </Button>
    </Group>
  );
}

export function MobileMeterPane({
  deviceId,
  showButtons,
  onToggleButtons,
}: {
  deviceId: string;
  showButtons: boolean;
  onToggleButtons: () => void;
}) {
  const { latest } = useLiveStream(deviceId);
  const sendControl = useSendControl();

  return (
    <Stack gap="sm" h="100%" style={{ minHeight: 0 }}>
      <Group justify="flex-end" wrap="nowrap">
        <MobileRecordControls deviceId={deviceId} />
      </Group>

      <Stack gap="sm" align="center" justify="center" style={{ flex: 1, minHeight: 0 }}>
        <Text c="dimmed" size="sm">
          {latest?.function ?? "waiting for data…"}
        </Text>
        {latest ? (
          <Group gap={0} align="baseline" wrap="nowrap">
            {/* Fixed-width gutter (in em, so it scales with the responsive
                font size below) for a leading "-", never inline with the
                digits themselves -- otherwise the sign sits flush against
                the first digit with no visual gap, which is what read as
                "overlapping". Reserved even when there's no sign, so a
                reading crossing zero doesn't shift the digits sideways. */}
            <Text
              component="span"
              fw={700}
              lh={1}
              ta="right"
              style={{ fontSize: "min(16vw, 88px)", width: "0.6em", flexShrink: 0 }}
            >
              {latest.display_value.startsWith("-") ? "−" : ""}
            </Text>
            <Text component="span" fw={700} lh={1} style={{ fontSize: "min(16vw, 88px)" }}>
              {latest.display_value.replace(/^-/, "")}
            </Text>
            <Text component="span" fw={700} lh={1} ml={6} style={{ fontSize: "min(8vw, 44px)" }}>
              {formatUnit(latest.unit)}
            </Text>
          </Group>
        ) : (
          <Text fw={700} lh={1} style={{ fontSize: "min(16vw, 88px)" }}>
            —
          </Text>
        )}
        <Group gap={4} justify="center">
          {latest?.status_flags.map((flag) => (
            <Badge key={flag} size="xs" variant="light">
              {flag}
            </Badge>
          ))}
        </Group>
      </Stack>

      {/* Plain clickable text, not a button -- Mantine's Button (even
          "subtle") still paints a visible focus/pressed background on
          mobile taps, which is what looked like "no button, then suddenly a
          real button" after the first tap (a lingering :focus state). Anchor
          never gets that box, only a text-color/underline change. */}
      <Anchor component="button" ta="center" size="xs" underline="never" onClick={onToggleButtons}>
        {showButtons ? "Hide buttons" : "Show buttons"}
      </Anchor>
      {showButtons && (
        <SimpleGrid cols={5} spacing={4}>
          {CONTROL_OPTIONS.map((control) => (
            <Button
              key={control}
              size="xs"
              variant="default"
              h={34}
              styles={{ label: { whiteSpace: "normal", fontSize: 9.5, lineHeight: 1.1, textAlign: "center" } }}
              onClick={() => sendControl.mutate({ deviceId, control })}
            >
              {CONTROL_LABELS[control]}
            </Button>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
