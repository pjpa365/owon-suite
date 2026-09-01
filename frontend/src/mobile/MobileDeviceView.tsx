import { useState } from "react";
import { ActionIcon, Group, Stack, Text, Tooltip, useComputedColorScheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowLeft, IconInfoCircle, IconMoonStars, IconSun } from "@tabler/icons-react";

import { useDevices } from "../api/devices";
import { getDeviceColor } from "../deviceColors";
import { exitFullscreenBestEffort } from "./fullscreen";
import { MobileChartPane } from "./MobileChartPane";
import { MobileHelpModal } from "./MobileHelpModal";
import { MobileMeterPane } from "./MobileMeterPane";
import { useMobileThemeToggle } from "./MobileThemeContext";
import { useWakeLock } from "./useWakeLock";

export function MobileDeviceView({ deviceId, onBack }: { deviceId: string; onBack: () => void }) {
  const devices = useDevices();
  const device = devices.data?.find((d) => d.id === deviceId);
  const colorScheme = useComputedColorScheme("light");
  // Portrait: meter+buttons on top, chart below. Landscape: meter+buttons
  // left, chart right (Mobile Requirements.txt item 3).
  const isPortrait = useMediaQuery("(orientation: portrait)", true);
  const [showButtons, setShowButtons] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const toggleTheme = useMobileThemeToggle();

  // Kept awake for as long as this page (the meter+chart view) is open --
  // Android Chrome only, see useWakeLock.ts.
  useWakeLock(true);

  const swatch = getDeviceColor(device?.color);
  const headerColor = colorScheme === "dark" ? swatch.headerDark : swatch.headerLight;

  function handleBack() {
    exitFullscreenBestEffort();
    onBack();
  }

  return (
    <Stack h="100vh" gap={0} style={{ minHeight: 0 }}>
      {/* Extra horizontal padding (beyond the vertical xs) so the back arrow
          sits in from the left edge and the icon cluster in from the right
          edge, rather than flush against either -- easier to hit accurately
          with a thumb than a corner-hugging tap target. */}
      <Group justify="space-between" px="lg" py="xs" wrap="nowrap" style={{ backgroundColor: headerColor, flexShrink: 0 }}>
        <Group gap={6} wrap="nowrap">
          <ActionIcon variant="subtle" onClick={handleBack} aria-label="Back to device list">
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Text fw={600}>{device?.name ?? "…"}</Text>
        </Group>
        <Group gap={8} wrap="nowrap">
          <Tooltip label="Dark/light mode (this session only)">
            <ActionIcon variant="subtle" onClick={() => toggleTheme(colorScheme)} aria-label="Toggle dark mode">
              {colorScheme === "dark" ? <IconSun size={18} /> : <IconMoonStars size={18} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="How to use this">
            <ActionIcon variant="subtle" onClick={() => setShowHelp(true)} aria-label="How to use this">
              <IconInfoCircle size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isPortrait ? "column" : "row" }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, padding: 8, overflow: "auto" }}>
          <MobileMeterPane
            deviceId={deviceId}
            showButtons={showButtons}
            onToggleButtons={() => setShowButtons((v) => !v)}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, padding: 8 }}>
          <MobileChartPane deviceId={deviceId} />
        </div>
      </div>
      <MobileHelpModal opened={showHelp} onClose={() => setShowHelp(false)} />
    </Stack>
  );
}
