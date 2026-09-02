import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Checkbox, Group, Select, SimpleGrid, Stack, Text } from "@mantine/core";

import { useDevices, useSendControl } from "../../api/devices";
import { useAdhocStatus, usePauseAdhoc, useResumeAdhoc, useStartAdhoc, useStopAdhoc } from "../../api/measurements";
import { CONTROL_OPTIONS, type KnownDevice } from "../../api/types";
import { CONTROL_LABELS } from "../../controlLabels";
import { useLiveStream } from "../../hooks/useLiveStream";
import type { WidgetConfig } from "../../state/dashboardStore";
import { formatUnit } from "../../utils/formatUnit";

interface MeterDisplayWidgetProps {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
}

export function MeterDisplaySettings({
  config,
  onConfigChange,
  devices,
}: {
  config: WidgetConfig;
  onConfigChange: (config: WidgetConfig) => void;
  devices: KnownDevice[];
}) {
  const deviceOptions = devices.map((d) => ({ value: d.id, label: d.name }));

  return (
    <Stack gap="xs">
      <Select
        size="xs"
        label="Device"
        placeholder="Select device"
        data={deviceOptions}
        value={config.deviceId ?? null}
        onChange={(value) => onConfigChange({ ...config, deviceId: value ?? undefined })}
      />
      <Checkbox
        label="Hide device buttons"
        checked={config.hideDeviceButtons ?? false}
        onChange={(e) => onConfigChange({ ...config, hideDeviceButtons: e.currentTarget.checked })}
      />
    </Stack>
  );
}

function RecordColumn({ deviceId }: { deviceId: string }) {
  const status = useAdhocStatus(deviceId);
  const start = useStartAdhoc();
  const pause = usePauseAdhoc();
  const resume = useResumeAdhoc();
  const stop = useStopAdhoc();

  const active = status.data?.active ?? false;
  const paused = status.data?.paused ?? false;
  const busy = start.isPending || pause.isPending || resume.isPending || stop.isPending;

  // A plain dot rather than a text badge (Changes_post_phase5_and_color_design.txt,
  // "Live value / Meter display widget") -- filled while actively recording,
  // hollow while paused, so the paused state is still visible without adding text.
  const dotStyle: CSSProperties = {
    width: 18,
    height: 18,
    borderRadius: "50%",
    alignSelf: "center",
    ...(paused
      ? { border: "2px solid var(--mantine-color-red-filled)" }
      : { backgroundColor: "var(--mantine-color-red-filled)" }),
  };

  return (
    <Stack gap={6} align="stretch" style={{ width: 64, flexShrink: 0 }}>
      {active ? (
        <span className={paused ? undefined : "pulse-glow"} style={dotStyle} />
      ) : (
        <Button size="compact-xs" color="red" variant="outline" loading={busy} onClick={() => start.mutate(deviceId)}>
          ● Record
        </Button>
      )}
      {active && (
        <>
          {paused ? (
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
        </>
      )}
    </Stack>
  );
}

// Reference sizes for the label/sign/digits/unit block, scaled uniformly to
// fit the widget (see the ResizeObserver effect below). The unit is fixed at
// exactly half the digit size by construction, and the sign gutter's fixed
// width keeps digits from shifting left/right when a "-" appears/disappears.
const BASE_LABEL_SIZE = 40;
const BASE_DIGIT_SIZE = 120;
const BASE_UNIT_SIZE = BASE_DIGIT_SIZE * 0.5;
const BASE_SIGN_WIDTH = BASE_DIGIT_SIZE * 0.32;
const MIN_SCALE = 0.15;
const MAX_SCALE = 1.35;

export function MeterDisplayWidget({ config }: MeterDisplayWidgetProps) {
  // A deviceId that no longer matches any known device (the device was
  // deleted, possibly re-added as a new one) must be treated the same as
  // unset -- otherwise this falls through to "connected" rendering that
  // will never receive data, permanently stuck on "waiting for data…".
  const devices = useDevices();
  const hasValidDevice = !!config.deviceId && !!devices.data?.some((d) => d.id === config.deviceId);
  const { latest } = useLiveStream(hasValidDevice ? config.deviceId : undefined);
  const sendControl = useSendControl();
  const fitContainerRef = useRef<HTMLDivElement>(null);
  const fitContentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Renders the label/sign/digits/unit block at fixed reference font sizes,
  // measures its natural (untransformed) box, and scales the whole block
  // uniformly via CSS transform to exactly fill the available width and
  // height -- never wrapping to a second line and never overflowing into
  // scrollbars, regardless of how many digits or how long the unit is.
  // `transform` doesn't affect layout size, so reading scrollWidth/Height off
  // fitContentRef always reflects the pre-scale natural size, which is what
  // makes recomputing the scale from it (rather than from a width/height
  // heuristic on the digit count) safe to do on every relevant render.
  useEffect(() => {
    const container = fitContainerRef.current;
    const content = fitContentRef.current;
    if (!container || !content) return;

    function recompute() {
      if (!container || !content) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const contentWidth = content.scrollWidth;
      const contentHeight = content.scrollHeight;
      if (!cw || !ch || !contentWidth || !contentHeight) return;
      const next = Math.min(cw / contentWidth, ch / contentHeight, MAX_SCALE);
      setScale(Number.isFinite(next) && next > 0 ? Math.max(MIN_SCALE, next) : MIN_SCALE);
    }

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [latest?.display_value, latest?.unit, latest?.function]);

  if (!hasValidDevice) {
    return (
      <Text size="sm" c="dimmed">
        Pick a device via this widget's gear settings.
      </Text>
    );
  }

  const deviceId = config.deviceId as string;

  return (
    <Stack gap={config.hideDeviceButtons ? 4 : "sm"} h="100%">
      <Group align="flex-start" wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            // Flex items default to min-width/min-height: auto (i.e. "never
            // shrink below content size") -- without overriding both, this
            // couldn't shrink past its own content's natural size, which is
            // exactly the "resizing the widget doesn't resize the digits" bug
            // this whole scale-to-fit approach exists to avoid.
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        >
          <div
            ref={fitContainerRef}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              ref={fitContentRef}
              style={{
                transform: `scale(${scale})`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                whiteSpace: "nowrap",
              }}
            >
              <div style={{ fontSize: BASE_LABEL_SIZE, lineHeight: 1.2, color: "var(--mantine-color-dimmed)" }}>
                {latest?.function ?? "waiting for data…"}
              </div>
              {latest ? (
                // A leading "-" is rendered in a fixed-width gutter to the left
                // of the digits (not inline as part of one string) so a sign
                // appearing/disappearing never shifts the digits themselves
                // left or right -- same fixed sign position a real meter has.
                <div style={{ display: "flex", alignItems: "baseline" }}>
                  <span
                    style={{
                      fontWeight: 700,
                      lineHeight: 1,
                      fontSize: BASE_DIGIT_SIZE,
                      width: BASE_SIGN_WIDTH,
                      // Right-aligned so the sign sits close to the digits it
                      // belongs to rather than at the far left of its gutter
                      // -- but flush against the gutter's own right edge
                      // (0 gap to the digit span that follows) is what read
                      // as the sign visually touching/overlapping the first
                      // digit, regardless of how wide the gutter itself was.
                      // This padding is the actual fix; the gutter's fixed
                      // width alone only stopped the digits from *shifting*
                      // when a sign appears/disappears.
                      textAlign: "right",
                      paddingRight: BASE_DIGIT_SIZE * 0.06,
                      flexShrink: 0,
                    }}
                  >
                    {latest.display_value.startsWith("-") ? "−" : ""}
                  </span>
                  <span style={{ fontWeight: 700, lineHeight: 1, fontSize: BASE_DIGIT_SIZE }}>
                    {latest.display_value.replace(/^-/, "")}
                  </span>
                  <span style={{ fontWeight: 700, lineHeight: 1, fontSize: BASE_UNIT_SIZE, marginLeft: 8 }}>
                    {formatUnit(latest.unit)}
                  </span>
                </div>
              ) : (
                <span style={{ fontWeight: 700, lineHeight: 1, fontSize: BASE_DIGIT_SIZE }}>—</span>
              )}
            </div>
          </div>
          <Group justify="center" gap={4} style={{ flexShrink: 0 }}>
            {latest?.status_flags.map((flag) => (
              <Badge key={flag} size="xs" variant="light">
                {flag}
              </Badge>
            ))}
          </Group>
        </div>

        <RecordColumn deviceId={deviceId} />
      </Group>

      {!config.hideDeviceButtons && (
        <SimpleGrid cols={5} spacing={4}>
          {CONTROL_OPTIONS.map((control) => (
            <Button
              key={control}
              size="compact-xs"
              variant="default"
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
