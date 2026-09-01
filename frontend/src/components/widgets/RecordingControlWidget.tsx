import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import dayjs from "dayjs";
import { useEffect, useState } from "react";

import { useDevices } from "../../api/devices";
import { useAdhocStatus } from "../../api/measurements";
import { useOfflineStatus, useStartOffline, useStopOffline } from "../../api/offlineRecording";
import {
  usePauseOnline,
  useResumeOnline,
  useStartOnline,
  useStopOnline,
  useOnlineStatus,
} from "../../api/onlineRecording";
import { useSettings } from "../../api/settings";
import type {
  Comparator,
  KnownDevice,
  OfflineRecordingStartRequest,
  OfflineStopMode,
  OnlineRecordingStartRequest,
  OnlineRecordingStatus,
  OnlineStopMode,
} from "../../api/types";
import type { WidgetConfig } from "../../state/dashboardStore";
import { useDateFormat } from "../../utils/dateFormat";

const COMPARATOR_OPTIONS: { value: Comparator; label: string }[] = [
  { value: ">", label: ">" },
  { value: ">=", label: "≥" },
  { value: "<", label: "<" },
  { value: "<=", label: "≤" },
];

interface DurationHMS {
  hours: number;
  minutes: number;
  seconds: number;
}
const ZERO_DURATION: DurationHMS = { hours: 0, minutes: 0, seconds: 0 };

function durationTotalSeconds(v: DurationHMS): number {
  return v.hours * 3600 + v.minutes * 60 + v.seconds;
}

// 0/0/0 is an invalid duration (Changes_post_phase5_and_color_design.txt) --
// a recording can't start with this stop condition, so the caller disables
// Start rather than showing a validation error.
function DurationHMSInput({ value, onChange }: { value: DurationHMS; onChange: (v: DurationHMS) => void }) {
  return (
    <Group gap={4} grow>
      <NumberInput
        size="xs"
        label="hrs"
        min={0}
        value={value.hours}
        onChange={(v) => onChange({ ...value, hours: v === "" ? 0 : Number(v) })}
      />
      <NumberInput
        size="xs"
        label="mins"
        min={0}
        max={59}
        value={value.minutes}
        onChange={(v) => onChange({ ...value, minutes: v === "" ? 0 : Number(v) })}
      />
      <NumberInput
        size="xs"
        label="secs"
        min={0}
        max={59}
        value={value.seconds}
        onChange={(v) => onChange({ ...value, seconds: v === "" ? 0 : Number(v) })}
      />
    </Group>
  );
}

// "1:30 min" / "1:02:03 h" -- a plain fixed-duration formatter, distinct from
// formatRemaining() below which formats a countdown to a live end time.
function formatDurationClock(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")} h`;
  return `${m}:${String(sec).padStart(2, "0")} min`;
}

// Forces a re-render every second so "remaining" text (below) visibly counts
// down in real time, rather than only updating whenever the 2s status poll
// happens to land (Changes ausgust-25.txt item 1).
function useTicker(intervalMs: number) {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceRender((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

function formatRemaining(estimatedEndTime: string | null, formatDateTime: (value: string) => string): string | null {
  if (!estimatedEndTime) return null;
  const remainingMs = new Date(estimatedEndTime).getTime() - Date.now();
  if (remainingMs <= 0) return "any moment now";
  const totalSeconds = Math.round(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${clock} remaining (ends ${formatDateTime(estimatedEndTime)})`;
}

export function RecordingControlSettings({
  config,
  onConfigChange,
  devices,
}: {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
  devices: KnownDevice[];
}) {
  const deviceMode = config.deviceMode ?? "any";
  const deviceOptions = devices.map((d) => ({ value: d.id, label: d.name }));

  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        fullWidth
        value={deviceMode}
        onChange={(v) => onConfigChange({ ...config, deviceMode: v as "any" | "selected" })}
        data={[
          { value: "any", label: "Any device" },
          { value: "selected", label: "Selected device" },
        ]}
      />
      {deviceMode === "selected" && (
        <Select
          size="xs"
          label="Device"
          placeholder="Select device"
          data={deviceOptions}
          value={config.deviceId ?? null}
          onChange={(value) => onConfigChange({ ...config, deviceId: value ?? undefined })}
        />
      )}
    </Stack>
  );
}

function ConfigForm({ deviceId }: { deviceId: string }) {
  const start = useStartOnline();

  const [useStartThreshold, setUseStartThreshold] = useState(false);
  const [startComparator, setStartComparator] = useState<Comparator>(">=");
  const [startValue, setStartValue] = useState<number | "">("");

  const [stopMode, setStopMode] = useState<OnlineStopMode>("count");
  const [stopComparator, setStopComparator] = useState<Comparator>("<=");
  const [stopValue, setStopValue] = useState<number | "">("");
  const [sampleCount, setSampleCount] = useState<number | "">(500);
  const [duration, setDuration] = useState<DurationHMS>({ ...ZERO_DURATION, minutes: 10 });
  const [endTime, setEndTime] = useState<string | null>(dayjs().format("YYYY-MM-DD HH:mm:ss"));

  const [intervalSeconds, setIntervalSeconds] = useState<number | "">(5);
  const [averageValues, setAverageValues] = useState(true);
  const [stopOnLowBattery, setStopOnLowBattery] = useState(true);

  const durationInvalid = stopMode === "duration" && durationTotalSeconds(duration) === 0;

  function handleStart() {
    const config: OnlineRecordingStartRequest = {
      start_threshold:
        useStartThreshold && startValue !== "" ? { comparator: startComparator, value: startValue } : null,
      stop_mode: stopMode,
      stop_threshold: stopMode === "threshold" && stopValue !== "" ? { comparator: stopComparator, value: stopValue } : null,
      sample_count: stopMode === "count" && sampleCount !== "" ? sampleCount : null,
      duration_seconds: stopMode === "duration" ? durationTotalSeconds(duration) : null,
      end_time: stopMode === "end_time" && endTime ? dayjs(endTime).toISOString() : null,
      interval_seconds: intervalSeconds === "" ? 0 : intervalSeconds,
      average_values: averageValues,
      stop_on_low_battery: stopOnLowBattery,
    };
    start.mutate({ deviceId, config });
  }

  return (
    <Stack gap="xs">
      <Checkbox
        size="xs"
        label="Start recording when value crosses a threshold"
        checked={useStartThreshold}
        onChange={(e) => setUseStartThreshold(e.currentTarget.checked)}
      />
      {useStartThreshold && (
        <Group gap={4}>
          <Select
            size="xs"
            w={70}
            data={COMPARATOR_OPTIONS}
            value={startComparator}
            onChange={(v) => v && setStartComparator(v as Comparator)}
          />
          <NumberInput size="xs" flex={1} value={startValue} onChange={(v) => setStartValue(v === "" ? "" : Number(v))} />
        </Group>
      )}

      <Text size="xs" fw={600} mt={4}>
        Stop condition
      </Text>
      <SegmentedControl
        size="xs"
        fullWidth
        value={stopMode}
        onChange={(v) => setStopMode(v as OnlineStopMode)}
        data={[
          { value: "threshold", label: "Threshold" },
          { value: "count", label: "Count" },
          { value: "duration", label: "Duration" },
          { value: "end_time", label: "End time" },
        ]}
      />
      {stopMode === "threshold" && (
        <Group gap={4}>
          <Select
            size="xs"
            w={70}
            data={COMPARATOR_OPTIONS}
            value={stopComparator}
            onChange={(v) => v && setStopComparator(v as Comparator)}
          />
          <NumberInput size="xs" flex={1} value={stopValue} onChange={(v) => setStopValue(v === "" ? "" : Number(v))} />
        </Group>
      )}
      {stopMode === "count" && (
        <NumberInput size="xs" min={1} value={sampleCount} onChange={(v) => setSampleCount(v === "" ? "" : Number(v))} />
      )}
      {stopMode === "duration" && <DurationHMSInput value={duration} onChange={setDuration} />}
      {stopMode === "end_time" && (
        <DateTimePicker size="xs" value={endTime} onChange={setEndTime} minDate={new Date()} clearable={false} />
      )}

      <Group gap={4} mt={4}>
        <Text size="xs">Interval (s)</Text>
        <NumberInput size="xs" w={70} max={9999} min={0} value={intervalSeconds} onChange={(v) => setIntervalSeconds(v === "" ? "" : Number(v))} />
      </Group>
      <Text size="xs" c="dimmed">
        0 = recording happens at the rate values are received.
      </Text>
      {intervalSeconds !== "" && intervalSeconds >= 1 && (
        <Checkbox
          size="xs"
          label="Average values within each interval (else use last received value)"
          checked={averageValues}
          onChange={(e) => setAverageValues(e.currentTarget.checked)}
        />
      )}
      <Checkbox
        size="xs"
        label="Stop on low battery"
        checked={stopOnLowBattery}
        onChange={(e) => setStopOnLowBattery(e.currentTarget.checked)}
      />

      {/* Recording action buttons: red border/red text, both light and dark mode
          (Changes ausgust-25.txt items 3-4 -- reverses the earlier accent-color
          decision; red is now used consistently for every recording control). */}
      <Button size="compact-sm" color="red" variant="outline" loading={start.isPending} disabled={durationInvalid} onClick={handleStart}>
        ● Start recording
      </Button>
      {start.isError && (
        <Alert color="red" p="xs">
          {(start.error as Error).message}
        </Alert>
      )}
    </Stack>
  );
}

function ActiveStatus({ deviceId }: { deviceId: string }) {
  const status = useOnlineStatus(deviceId);
  const pause = usePauseOnline();
  const resume = useResumeOnline();
  const stop = useStopOnline();
  const { formatDateTime } = useDateFormat();
  useTicker(1000);

  const s = status.data;
  if (!s) return null;

  const busy = pause.isPending || resume.isPending || stop.isPending;
  const remaining = formatRemaining(s.estimated_end_time, formatDateTime);

  return (
    <Stack gap="xs">
      <Group justify="center" gap={4}>
        <Badge size="sm" color="red" variant={s.waiting_for_start || s.paused ? "outline" : "filled"}>
          {s.waiting_for_start ? "WAITING FOR START" : s.paused ? "PAUSED" : "● RECORDING"}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" ta="center">
        {s.samples_so_far} sample{s.samples_so_far === 1 ? "" : "s"} stored
      </Text>
      {remaining && (
        <Text size="xs" c="dimmed" ta="center">
          {remaining}
        </Text>
      )}
      <Group justify="center" gap={4}>
        {s.paused ? (
          <Button size="compact-xs" color="red" variant="outline" loading={busy} onClick={() => resume.mutate(deviceId)}>
            Resume
          </Button>
        ) : (
          <Button size="compact-xs" color="red" variant="outline" loading={busy} onClick={() => pause.mutate(deviceId)}>
            Pause
          </Button>
        )}
        <Button size="compact-xs" color="red" variant="outline" loading={busy} onClick={() => stop.mutate(deviceId)}>
          Stop
        </Button>
      </Group>
      {(pause.isError || resume.isError || stop.isError) && (
        <Alert color="red" p="xs">
          {((pause.error ?? resume.error ?? stop.error) as Error).message}
        </Alert>
      )}
    </Stack>
  );
}

// Shown once an online recording finishes, until the user explicitly closes
// it (Changes_post_phase5_and_color_design.txt) -- replaces the previous
// unconditional "Last recording finished (manual)." line in the widget body,
// which was confusing there.
function OnlineFinishedPanel({ status, onClose }: { status: OnlineRecordingStatus; onClose: () => void }) {
  return (
    <Stack gap="xs" align="center">
      <Badge size="sm" color="green">
        RECORDING FINISHED
      </Badge>
      <Text size="sm" ta="center">
        {status.measurement_name ?? "(unnamed)"}
      </Text>
      <Text size="xs" c="dimmed" ta="center">
        {status.stop_reason?.replace("_", " ")}
      </Text>
      <Button size="compact-xs" variant="default" onClick={onClose}>
        Close
      </Button>
    </Stack>
  );
}

function OfflineConfigForm({ deviceId }: { deviceId: string }) {
  const start = useStartOffline();
  const onlineStatus = useOnlineStatus(deviceId);
  const adhocStatus = useAdhocStatus(deviceId);
  const settings = useSettings();

  const [intervalSeconds, setIntervalSeconds] = useState<number | "">(10);
  const [stopMode, setStopMode] = useState<OfflineStopMode>("count");
  const [sampleCount, setSampleCount] = useState<number | "">(100);
  const [duration, setDuration] = useState<DurationHMS>({ ...ZERO_DURATION, minutes: 10 });
  const [endTime, setEndTime] = useState<string | null>(dayjs().format("YYYY-MM-DD HH:mm:ss"));

  const durationInvalid = stopMode === "duration" && durationTotalSeconds(duration) === 0;
  // Only relevant when something is actually running that an offline start
  // would knock offline -- not shown unconditionally (Changes_post_phase5).
  const hasActiveLiveRecording = (onlineStatus.data?.active ?? false) || (adhocStatus.data?.active ?? false);
  const setClockOnInit = settings.data?.set_meter_clock_on_offline_init ?? true;
  // Advisory only (Changes_post_phase5_and_color_design.txt) -- doesn't block
  // Start, since an incorrect clock only matters for the end-time stop mode
  // (the meter has to know "now" to know when to stop).
  const showClockWarning = stopMode === "end_time" && !setClockOnInit;

  function handleStart() {
    const config: OfflineRecordingStartRequest = {
      interval_seconds: intervalSeconds === "" ? 1 : intervalSeconds,
      stop_mode: stopMode,
      sample_count: stopMode === "count" && sampleCount !== "" ? sampleCount : null,
      duration_seconds: stopMode === "duration" ? durationTotalSeconds(duration) : null,
      end_time: stopMode === "end_time" && endTime ? dayjs(endTime).toISOString() : null,
      set_clock: setClockOnInit,
    };
    start.mutate({ deviceId, config });
  }

  return (
    <Stack gap="xs">
      {hasActiveLiveRecording && (
        <Alert color="yellow" p="xs">
          Starting an offline recording disconnects the device -- any active ad-hoc or online recording on it will be
          finalized.
        </Alert>
      )}
      <Group gap={4}>
        <Text size="xs">Interval (whole seconds, &gt;0)</Text>
        <NumberInput
          size="xs"
          w={70}
          min={1}
          max={9999}
          step={1}
          value={intervalSeconds}
          onChange={(v) => setIntervalSeconds(v === "" ? "" : Number(v))}
        />
      </Group>

      <Text size="xs" fw={600}>
        Stop condition
      </Text>
      <SegmentedControl
        size="xs"
        fullWidth
        value={stopMode}
        onChange={(v) => setStopMode(v as OfflineStopMode)}
        data={[
          { value: "count", label: "Count" },
          { value: "duration", label: "Duration" },
          { value: "end_time", label: "End time" },
        ]}
      />
      {stopMode === "count" && (
        <>
          <NumberInput
            size="xs"
            min={1}
            max={10000}
            value={sampleCount}
            onChange={(v) => setSampleCount(v === "" ? "" : Number(v))}
          />
          {sampleCount !== "" && intervalSeconds !== "" && (
            <Text size="xs" c="dimmed">
              Duration {formatDurationClock(sampleCount * intervalSeconds)}
            </Text>
          )}
        </>
      )}
      {stopMode === "duration" && (
        <>
          <DurationHMSInput value={duration} onChange={setDuration} />
          {intervalSeconds !== "" && intervalSeconds > 0 && (
            <Text size="xs" c="dimmed">
              Measurement will contain {Math.floor(durationTotalSeconds(duration) / intervalSeconds)} samples
            </Text>
          )}
        </>
      )}
      {stopMode === "end_time" && (
        <DateTimePicker size="xs" value={endTime} onChange={setEndTime} minDate={new Date()} clearable={false} />
      )}
      {showClockWarning && (
        <Alert color="yellow" p="xs">
          The meter's clock isn't set from the system time at initiation (Settings), so its idea of "now" may be
          wrong -- the end time above could stop the recording earlier or later than expected. Enabling that setting
          is advised for end-time-based recordings.
        </Alert>
      )}

      <Text size="xs" c="dimmed">
        Meter clock: {setClockOnInit ? "set at initiation" : "not set"} (Settings)
      </Text>
      <Text size="xs" c="dimmed">
        Max 10,000 samples. Device must already be connected.
      </Text>

      <Button size="compact-sm" color="red" variant="outline" loading={start.isPending} disabled={durationInvalid} onClick={handleStart}>
        ● Start offline recording
      </Button>
      {start.isError && (
        <Alert color="red" p="xs">
          {(start.error as Error).message}
        </Alert>
      )}
    </Stack>
  );
}

const OFFLINE_STATE_LABELS: Record<string, string> = {
  recording: "RECORDING (on meter)",
  awaiting_reconnect: "WAITING FOR RECONNECT",
  downloading: "DOWNLOADING",
  completed: "COMPLETED",
  error: "ERROR",
};

function OfflineActiveStatus({ deviceId }: { deviceId: string }) {
  const status = useOfflineStatus(deviceId);
  const stop = useStopOffline();
  const { formatDateTime } = useDateFormat();
  useTicker(1000);

  const s = status.data;
  if (!s || s.state === "idle") return null;

  const inProgress = s.state === "recording" || s.state === "awaiting_reconnect" || s.state === "downloading";
  const remaining = s.state === "recording" ? formatRemaining(s.estimated_end_time, formatDateTime) : null;

  return (
    <Stack gap="xs">
      <Group justify="center" gap={4}>
        <Badge
          size="sm"
          color={s.state === "error" ? "red" : s.state === "completed" ? "green" : "red"}
          variant={s.state === "recording" ? "filled" : "outline"}
        >
          {OFFLINE_STATE_LABELS[s.state] ?? s.state}
        </Badge>
      </Group>
      {remaining && (
        <Text size="xs" c="dimmed" ta="center">
          {remaining}
        </Text>
      )}
      {s.state === "awaiting_reconnect" && (
        <Text size="xs" c="dimmed" ta="center">
          Long-press Δ/ᛒ button on the meter to re-enable Bluetooth, then, after reconnect, the recording will be
          downloaded and stored.
        </Text>
      )}
      {s.state === "downloading" && (
        <Text size="xs" c="dimmed" ta="center">
          {s.bytes_received}
          {s.expected_bytes ? ` / ${s.expected_bytes}` : ""} bytes received
        </Text>
      )}
      {s.state === "completed" && (
        <Text size="xs" c="dimmed" ta="center">
          Saved as "{s.measurement_name ?? "(unnamed)"}".
        </Text>
      )}
      {s.warning && (
        <Alert color="yellow" p="xs">
          {s.warning}
        </Alert>
      )}
      {s.state === "error" && (
        <Alert color="red" p="xs">
          {s.error}
        </Alert>
      )}
      <Group justify="center">
        {/* Red only while actually stopping a running recording -- once it's
            finished/errored this button reads "Continue" (Changes ausgust-25.txt
            item 1), which isn't a recording action, so it stays neutral like
            other dismiss/close buttons (e.g. OnlineFinishedPanel's Close above). */}
        <Button
          size="compact-xs"
          color={inProgress ? "red" : undefined}
          variant={inProgress ? "outline" : "default"}
          loading={stop.isPending}
          onClick={() => stop.mutate(deviceId)}
        >
          {inProgress ? "Stop" : "Continue"}
        </Button>
      </Group>
      {stop.isError && (
        <Alert color="red" p="xs">
          {(stop.error as Error).message}
        </Alert>
      )}
    </Stack>
  );
}

interface RecordingControlWidgetProps {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}

export function RecordingControlWidget({ config, onConfigChange }: RecordingControlWidgetProps) {
  const devices = useDevices();
  const deviceOptions = (devices.data ?? []).map((d) => ({ value: d.id, label: d.name }));
  const deviceMode = config.deviceMode ?? "any";

  if (deviceMode === "selected") {
    if (!config.deviceId) {
      return (
        <Text size="sm" c="dimmed">
          Pick a device via this widget's gear settings.
        </Text>
      );
    }
    return <RecordingControlBody deviceId={config.deviceId} deviceOptions={deviceOptions} showDevicePicker={false} onConfigChange={onConfigChange} />;
  }

  if (!config.deviceId) {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          Pick a device to configure recording for.
        </Text>
        <Select
          placeholder="Select device"
          data={deviceOptions}
          onChange={(value) => value && onConfigChange({ ...config, deviceId: value })}
        />
      </Stack>
    );
  }

  return (
    <RecordingControlBody deviceId={config.deviceId} deviceOptions={deviceOptions} showDevicePicker onConfigChange={onConfigChange} />
  );
}

function RecordingControlBody({
  deviceId,
  deviceOptions,
  showDevicePicker,
  onConfigChange,
}: {
  deviceId: string;
  deviceOptions: { value: string; label: string }[];
  showDevicePicker: boolean;
  onConfigChange: (config: WidgetConfig) => void;
}) {
  const [mode, setMode] = useState<"online" | "offline">("offline");
  const onlineStatus = useOnlineStatus(deviceId);
  const offlineStatus = useOfflineStatus(deviceId);
  const [dismissedFinishedId, setDismissedFinishedId] = useState<string | null>(null);

  const deviceName = deviceOptions.find((d) => d.value === deviceId)?.label ?? "device";
  const showFinishedPanel =
    !onlineStatus.data?.active && !!onlineStatus.data?.measurement_id && onlineStatus.data.measurement_id !== dismissedFinishedId;

  return (
    <Stack gap="sm">
      {showDevicePicker && (
        <Group justify="flex-end">
          <Select
            size="xs"
            w={140}
            data={deviceOptions}
            value={deviceId}
            onChange={(value) => value && onConfigChange({ deviceId: value })}
          />
        </Group>
      )}

      <SegmentedControl
        size="xs"
        fullWidth
        value={mode}
        onChange={(v) => setMode(v as "online" | "offline")}
        data={[
          { value: "offline", label: `Offline on ${deviceName}` },
          { value: "online", label: "Online (PC)" },
        ]}
      />

      {mode === "online" ? (
        onlineStatus.data?.active ? (
          <ActiveStatus deviceId={deviceId} />
        ) : showFinishedPanel ? (
          <OnlineFinishedPanel status={onlineStatus.data!} onClose={() => setDismissedFinishedId(onlineStatus.data!.measurement_id)} />
        ) : (
          <ConfigForm deviceId={deviceId} />
        )
      ) : offlineStatus.data && offlineStatus.data.state !== "idle" ? (
        <OfflineActiveStatus deviceId={deviceId} />
      ) : (
        <OfflineConfigForm deviceId={deviceId} />
      )}
    </Stack>
  );
}
