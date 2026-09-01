import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  ColorInput,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
  useMantineColorScheme,
} from "@mantine/core";

import { API_BASE } from "../../api/client";
import { useMeasurements } from "../../api/measurements";
import { useSettings, useUpdateSettings } from "../../api/settings";
import type { ChartColorSet, ChartTimeMode, ColorScheme } from "../../api/types";
import { DEFAULT_DATE_TIME_FORMAT, formatDateTime } from "../../utils/dateFormat";

// A starter list so the color-picker section isn't empty before any
// measurement exists yet -- units actually seen in stored measurements are
// added to this automatically.
const COMMON_UNITS = ["V", "mV", "A", "Ohm", "MOhm", "W", "Wh", "Ah", "Hz", "F", "%", "C"];

// Mirrors backend/app/settings_store.py's _CHART_COLORS_LIGHT/_DARK -- used
// only as a fallback before the real settings have loaded, so the picker
// still shows sensible starting colors rather than blanks. See that file for
// the full reasoning behind these exact values, including why Farad and
// Fahrenheit (both unit string "F") deliberately share one color, and why
// scale-prefixed units (MOhm, mV, ...) each need their own literal entry.
const DEFAULT_CHART_COLORS: ChartColorSet = {
  light: {
    V: "#005fa9",
    mV: "#0f6e8c",
    A: "#9b3a0d",
    Ah: "#00746f",
    Ohm: "#6b46a0",
    MOhm: "#9c3f83",
    W: "#007551",
    Wh: "#3658ac",
    Hz: "#715d00",
    "%": "#9d3343",
    C: "#873a82",
    F: "#426c00",
  },
  dark: {
    V: "#55a9ff",
    mV: "#5fc8e8",
    A: "#f18156",
    Ah: "#00c1b9",
    Ohm: "#b48df4",
    MOhm: "#e08fd0",
    W: "#00c296",
    Wh: "#76a1ff",
    Hz: "#bba500",
    "%": "#f37986",
    C: "#d87fd1",
    F: "#85b749",
  },
};

// Mirrors backend/app/naming.py's TOKENS / DEFAULT_TEMPLATE.
const NAMING_TOKENS = ["device_name", "start_time", "min_value", "max_value", "unit", "duration", "count"];
// The min-max clause is wrapped in [...] so it's automatically dropped when a
// measurement has no valid readings -- see previewTemplate() below, which
// mirrors naming.py's render() so both example lines reflect that live.
const DEFAULT_NAMING_TEMPLATE =
  "{device_name}: {start_time}; [(min-max) {min_value} - {max_value} {unit}; ]Duration {duration}; {count} values";

// Sample values for the live preview -- lets someone see what their edited
// template will actually produce without needing to finish a real recording
// first. Matches the worked example from the original specification.
const SAMPLE_TOKENS: Record<string, string> = {
  device_name: "MyMeter",
  start_time: "23-07-2026 11:23:23.747",
  min_value: "12.0",
  max_value: "12.3",
  unit: "V DC",
  duration: "1:12 min",
  count: "32",
};

const OPTIONAL_BLOCK_RE = /\[([^[\]]*)\]/g;
const TOKEN_RE = /\{(\w+)\}/g;

/** Mirrors backend/app/naming.py's render(): a [...] section referencing a
 * `missing` token is dropped whole; everything else is substituted normally
 * (unknown tokens left as literal "{whatever}" so a typo stays visible). */
function previewTemplate(template: string, missing: ReadonlySet<string> = new Set()): string {
  const withoutOptionalBlocks = template.replace(OPTIONAL_BLOCK_RE, (_match, content: string) => {
    const tokensInBlock = [...content.matchAll(TOKEN_RE)].map((m) => m[1]);
    return tokensInBlock.some((t) => missing.has(t)) ? "" : content;
  });
  return withoutOptionalBlocks.replace(TOKEN_RE, (match, token: string) =>
    missing.has(token) ? "" : (SAMPLE_TOKENS[token] ?? match),
  );
}

export function SettingsModal({
  opened,
  onClose,
  onOpenManual,
}: {
  opened: boolean;
  onClose: () => void;
  onOpenManual?: (section?: string) => void;
}) {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const measurements = useMeasurements();
  const { setColorScheme } = useMantineColorScheme();

  const [darkMode, setDarkMode] = useState<ColorScheme>("auto");
  const [chartColors, setChartColors] = useState<ChartColorSet>(DEFAULT_CHART_COLORS);
  const [template, setTemplate] = useState("");
  const [dateFormat, setDateFormat] = useState(DEFAULT_DATE_TIME_FORMAT);
  const [autoConnect, setAutoConnect] = useState(true);
  const [setMeterClock, setSetMeterClock] = useState(true);
  const [chartTimeMode, setChartTimeMode] = useState<ChartTimeMode>("absolute");
  const [showDateFormatHelp, setShowDateFormatHelp] = useState(false);
  const [mobilePincode, setMobilePincode] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpQueriesEnabled, setMcpQueriesEnabled] = useState(false);
  const [mcpApiKey, setMcpApiKey] = useState("");

  // Everything here is a local draft, committed together by the single Save
  // button in the header -- re-seeded from the persisted settings each time
  // the modal is (re)opened, discarding any unsaved edits from a previous
  // cancelled session.
  useEffect(() => {
    if (opened && settings.data) {
      setDarkMode(settings.data.dark_mode);
      setChartColors(settings.data.chart_colors);
      setTemplate(settings.data.naming_template);
      setDateFormat(settings.data.date_format);
      setAutoConnect(settings.data.auto_connect);
      setSetMeterClock(settings.data.set_meter_clock_on_offline_init);
      setChartTimeMode(settings.data.chart_time_mode);
      setMobilePincode(settings.data.mobile_pincode ?? "");
      setMcpEnabled(settings.data.mcp_enabled);
      setMcpQueriesEnabled(settings.data.mcp_queries_enabled);
      setMcpApiKey(settings.data.mcp_api_key ?? "");
    }
  }, [opened, settings.data]);

  const knownUnits = Array.from(
    new Set([...COMMON_UNITS, ...(measurements.data ?? []).map((m) => m.unit)]),
  ).sort();

  let dateFormatPreview: string;
  try {
    dateFormatPreview = formatDateTime(new Date(), dateFormat);
  } catch {
    dateFormatPreview = "(invalid format)";
  }

  function handleDarkModeChange(value: string) {
    const mode = value as ColorScheme;
    setDarkMode(mode);
    setColorScheme(mode); // live preview; persisted on Save like everything else
  }

  function handleColorChange(mode: "light" | "dark", unit: string, color: string) {
    setChartColors((prev) => ({ ...prev, [mode]: { ...prev[mode], [unit]: color } }));
  }

  function handleResetTemplate() {
    setTemplate(DEFAULT_NAMING_TEMPLATE);
  }

  function handleSave() {
    updateSettings.mutate(
      {
        dark_mode: darkMode,
        chart_colors: chartColors,
        naming_template: template,
        date_format: dateFormat,
        auto_connect: autoConnect,
        set_meter_clock_on_offline_init: setMeterClock,
        chart_time_mode: chartTimeMode,
        mobile_pincode: mobilePincode.trim() === "" ? null : mobilePincode.trim(),
        mcp_enabled: mcpEnabled,
        mcp_queries_enabled: mcpQueriesEnabled,
        mcp_api_key: mcpApiKey.trim() === "" ? null : mcpApiKey.trim(),
      },
      { onSuccess: onClose },
    );
  }

  // Closing without saving (X, Esc, backdrop click) must undo the live dark-
  // mode preview -- otherwise an unsaved selection would stick until the
  // next full reload, even though nothing was actually persisted.
  function handleCancel() {
    setColorScheme(settings.data?.dark_mode ?? "auto");
    onClose();
  }

  return (
    <Modal
      opened={opened}
      onClose={handleCancel}
      size="1100px"
      title={
        <Group justify="space-between" wrap="nowrap" style={{ flex: 1 }}>
          <Title order={4}>Settings</Title>
          <Button size="xs" loading={updateSettings.isPending} onClick={handleSave}>
            Save
          </Button>
        </Group>
      }
    >
      <Stack gap="md">
        {updateSettings.isError && (
          <Alert color="red" title="Couldn't save settings">
            {(updateSettings.error as Error).message}
          </Alert>
        )}

        <Paper withBorder radius="md" p="sm">
          <Text size="sm" fw={600} mb="xs">
            Appearance
          </Text>
          <SegmentedControl
            data={[
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
              { label: "Auto", value: "auto" },
            ]}
            value={darkMode}
            onChange={handleDarkModeChange}
          />
        </Paper>

        <SimpleGrid cols={2} spacing="md">
          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={600} mb="xs">
              Chart time axis
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              Applies to every time-based chart (Live chart, Chart (single), Chart (multiple)).
            </Text>
            <SegmentedControl
              data={[
                { label: "Time of measurement", value: "absolute" },
                { label: "Relative to first data point", value: "relative" },
              ]}
              value={chartTimeMode}
              onChange={(v) => setChartTimeMode(v as ChartTimeMode)}
            />
          </Paper>

          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={600} mb="xs">
              Date &amp; time format
            </Text>
            <Stack gap={4}>
              <TextInput value={dateFormat} onChange={(e) => setDateFormat(e.currentTarget.value)} />
              <Text size="xs" c="dimmed">
                Preview: {dateFormatPreview}
              </Text>
              <Anchor size="xs" onClick={() => setShowDateFormatHelp((v) => !v)}>
                {showDateFormatHelp ? "Hide" : "What tokens can I use?"}
              </Anchor>
              {showDateFormatHelp && (
                <Text size="xs" c="dimmed">
                  Common tokens: yyyy (year), MM (month), dd (day), HH (24h hour), mm (minute), ss (second). The
                  format is split on its first space into a date part and a time part, so screens that show only a
                  date or only a time use just that half -- e.g. "dd-MM-yyyy HH:mm:ss" gives date part "dd-MM-yyyy"
                  and time part "HH:mm:ss".
                </Text>
              )}
            </Stack>
          </Paper>
        </SimpleGrid>

        <SimpleGrid cols={2} spacing="md">
          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={600} mb="xs">
              Devices
            </Text>
            <Stack gap="xs">
              <Switch
                label="Auto-connect when a known device's Bluetooth is on"
                checked={autoConnect}
                onChange={(e) => setAutoConnect(e.currentTarget.checked)}
              />
              <Switch
                label="Set meter's clock from system time when initiating an offline recording"
                checked={setMeterClock}
                onChange={(e) => setSetMeterClock(e.currentTarget.checked)}
              />
            </Stack>
          </Paper>

          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={600} mb="xs">
              Mobile access
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              Set a 4-digit PIN to let phones on this network open a phone-friendly meter view at{" "}
              <Text span fw={600}>
                /mobile
              </Text>
              . Leave it blank to keep mobile access switched off entirely.
            </Text>
            <Group align="flex-start" wrap="wrap">
              <TextInput
                label="PIN"
                placeholder="e.g. 4821"
                maxLength={4}
                w={140}
                value={mobilePincode}
                onChange={(e) => setMobilePincode(e.currentTarget.value.replace(/\D/g, "").slice(0, 4))}
              />
              {mobilePincode.length === 4 && (
                <Stack gap={4} align="center">
                  <img
                    src={`${API_BASE}/settings/mobile-qr`}
                    alt="QR code for mobile access"
                    width={120}
                    height={120}
                    style={{ borderRadius: 8, border: "1px solid var(--mantine-color-default-border)" }}
                  />
                  <Text size="xs" c="dimmed">
                    Scan with a phone on this network
                  </Text>
                </Stack>
              )}
            </Group>
          </Paper>
        </SimpleGrid>

        <SimpleGrid cols={2} spacing="md">
          <Paper withBorder radius="md" p="sm">
            <Text size="sm" fw={600}>
              Default chart colors
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              Separate light/dark columns so each keeps good contrast on its own background.
            </Text>
            <Stack gap={4}>
              <Group justify="space-between" wrap="nowrap">
                <Text size="xs" c="dimmed" style={{ flex: 1 }} />
                <Text size="xs" c="dimmed" w={110} ta="center">
                  Light
                </Text>
                <Text size="xs" c="dimmed" w={110} ta="center">
                  Dark
                </Text>
              </Group>
              {knownUnits.map((unit) => (
                <Group key={unit} justify="space-between" wrap="nowrap">
                  <Text size="sm" style={{ flex: 1 }}>
                    {unit}
                  </Text>
                  <ColorInput
                    size="xs"
                    w={110}
                    value={chartColors.light?.[unit] ?? ""}
                    onChange={(color) => handleColorChange("light", unit, color)}
                  />
                  <ColorInput
                    size="xs"
                    w={110}
                    value={chartColors.dark?.[unit] ?? ""}
                    onChange={(color) => handleColorChange("dark", unit, color)}
                  />
                </Group>
              ))}
            </Stack>
          </Paper>

          <Stack gap="md">
            <Paper withBorder radius="md" p="sm">
              <Text size="sm" fw={600}>
                Measurement naming template
              </Text>
              <Text size="xs" c="dimmed" mb="xs">
                Data sets are automatically named using the template below when a recording finishes. You can
                customize it to your liking. Available tokens: {NAMING_TOKENS.map((t) => `{${t}}`).join(", ")}. A
                section wrapped in [square brackets] is left out automatically in the rare case a measurement has
                no valid readings at all.
              </Text>

              <Stack gap={4}>
                <Textarea
                  label="Template"
                  autosize
                  minRows={2}
                  value={template}
                  onChange={(e) => setTemplate(e.currentTarget.value)}
                />
                <Text size="xs" c="dimmed">
                  Example: {previewTemplate(template)}
                </Text>
              </Stack>

              <Group justify="flex-end" mt="sm">
                <Button size="xs" variant="subtle" onClick={handleResetTemplate}>
                  Reset to default
                </Button>
              </Group>
            </Paper>

            <Paper withBorder radius="md" p="sm">
              <Group justify="space-between" mb="xs">
                <Text size="sm" fw={600}>
                  MCP server
                </Text>
                <Anchor size="xs" onClick={() => onOpenManual?.("mcp-server")}>
                  What is this / what's allowed?
                </Anchor>
              </Group>
              <Text size="xs" c="dimmed" mb="xs">
                Lets an AI assistant (e.g. Claude Desktop) read your devices and stored recordings, press
                buttons, and start/stop recordings over the network. Off by default; a person using this app can
                never be locked out by it.
              </Text>
              <Stack gap="xs">
                <Switch
                  label="Enable MCP server"
                  checked={mcpEnabled}
                  onChange={(e) => setMcpEnabled(e.currentTarget.checked)}
                />
                <Switch
                  label="Allow ad-hoc data queries"
                  checked={mcpQueriesEnabled}
                  onChange={(e) => setMcpQueriesEnabled(e.currentTarget.checked)}
                />
                <TextInput
                  label="API key"
                  placeholder="Choose any key; the MCP client must send the same one"
                  value={mcpApiKey}
                  onChange={(e) => setMcpApiKey(e.currentTarget.value)}
                />
              </Stack>
            </Paper>
          </Stack>
        </SimpleGrid>
      </Stack>
    </Modal>
  );
}
