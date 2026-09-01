import { Button, Center, ColorSwatch, Group, Loader, Stack, Text, Title, useComputedColorScheme } from "@mantine/core";

import { useDevices } from "../api/devices";
import { getDeviceColor } from "../deviceColors";
import { requestFullscreenBestEffort } from "./fullscreen";

export function MobileDevicePicker({ onSelect }: { onSelect: (deviceId: string) => void }) {
  const devices = useDevices();
  const colorScheme = useComputedColorScheme("light");

  function handleSelect(deviceId: string) {
    // Called synchronously from the tap itself so it still counts as a user
    // gesture (Mobile Requirements.txt follow-up: go fullscreen without a
    // separate step).
    requestFullscreenBestEffort();
    onSelect(deviceId);
  }

  return (
    <Center mih="100vh" p="md">
      <Stack w="100%" maw={420} gap="sm">
        <Title order={3} ta="center">
          Pick a meter
        </Title>
        {devices.isLoading && (
          <Center>
            <Loader />
          </Center>
        )}
        {devices.data?.length === 0 && (
          <Text ta="center" c="dimmed" size="sm">
            No devices registered yet — add one from the PC dashboard first.
          </Text>
        )}
        {devices.data?.map((device) => {
          const swatch = getDeviceColor(device.color);
          const dot = colorScheme === "dark" ? swatch.dotDark : swatch.dotLight;
          return (
            <Button key={device.id} size="lg" variant="default" onClick={() => handleSelect(device.id)}>
              <Group gap="xs" wrap="nowrap" w="100%">
                <ColorSwatch color={dot} size={14} />
                <Text fw={600}>{device.name}</Text>
              </Group>
            </Button>
          );
        })}
      </Stack>
    </Center>
  );
}
