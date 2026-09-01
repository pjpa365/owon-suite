import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { ActionIcon, Button, ColorSwatch, Group, Modal, Stack, Text, TextInput, useComputedColorScheme } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";

import {
  discoverDevices,
  useAddDevice,
  useBluetoothStatus,
  useConnectDevice,
  useDeviceStatus,
  useDevices,
  useDisconnectDevice,
  useRemoveDevice,
  useRenameDevice,
  useUnregisteredDevices,
} from "../../api/devices";
import { useSettings } from "../../api/settings";
import type { DiscoveredDevice, KnownDevice } from "../../api/types";
import { DEVICE_COLORS, getDeviceColor } from "../../deviceColors";

interface AddDeviceForm {
  name: string;
  address: string;
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        display: "inline-block",
        flexShrink: 0,
        // -filled resolves via the theme's primaryShade (shade 6 light / 4 dark, main.tsx),
        // so this follows light/dark automatically without reading colorScheme in JS.
        backgroundColor: connected ? "var(--mantine-color-green-filled)" : "var(--mantine-color-red-filled)",
      }}
    />
  );
}

// Device identity color picker (theme-tokens.md SS4) -- shows the exact same
// tint values a selected color will apply to that device's widget headers,
// not a separately-tuned "vivid" preview (an earlier design draft did that
// and it was confusing: "the dots don't represent the color in the header").
function DeviceColorPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const colorScheme = useComputedColorScheme("light");
  return (
    <Group gap={6}>
      {DEVICE_COLORS.map((c) => (
        <ColorSwatch
          key={c.key}
          color={colorScheme === "dark" ? c.headerDark : c.headerLight}
          size={24}
          style={{
            cursor: "pointer",
            outline: value === c.key ? "2px solid var(--mantine-color-brand-6)" : "2px solid transparent",
            outlineOffset: 2,
          }}
          onClick={() => onChange(c.key)}
        />
      ))}
    </Group>
  );
}

function AddDeviceModal({
  opened,
  onClose,
  prefill,
}: {
  opened: boolean;
  onClose: () => void;
  /** Pre-fills address/name from the "New Device Found" prompt below. */
  prefill?: DiscoveredDevice | null;
}) {
  const addDevice = useAddDevice();
  const knownDevices = useDevices();
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null);
  // Auto-suggested next-in-rotation color (mirrors device_manager.add()'s
  // fallback), so the picker doesn't default to blank -- freely overridable.
  const [color, setColor] = useState(DEVICE_COLORS[(knownDevices.data?.length ?? 0) % DEVICE_COLORS.length].key);
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    formState: { errors },
  } = useForm<AddDeviceForm>({ defaultValues: { name: "", address: "" } });

  useEffect(() => {
    if (opened && prefill) {
      setValue("address", prefill.address);
      setValue("name", prefill.name);
    }
  }, [opened, prefill, setValue]);

  const knownAddresses = new Set(knownDevices.data?.map((d) => d.address) ?? []);
  const newlyFound = (found ?? []).filter((d) => !knownAddresses.has(d.address));

  async function handleDiscover() {
    setDiscovering(true);
    setDiscoverError(null);
    setFound(null);
    try {
      setFound(await discoverDevices());
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  }

  function handlePick(device: DiscoveredDevice) {
    setValue("address", device.address);
    if (!getValues("name")) {
      setValue("name", device.name);
    }
  }

  function onSubmit(values: AddDeviceForm) {
    addDevice.mutate(
      { ...values, color },
      {
        onSuccess: () => {
          reset();
          setFound(null);
          setColor(DEVICE_COLORS[(knownDevices.data?.length ?? 0) % DEVICE_COLORS.length].key);
          onClose();
        },
      },
    );
  }

  function handleClose() {
    reset();
    setDiscoverError(null);
    setFound(null);
    onClose();
  }

  return (
    <Modal opened={opened} onClose={handleClose} title="Add device">
      <Stack>
        <Button onClick={handleDiscover} loading={discovering} fullWidth>
          Discover nearby meters
        </Button>

        {discoverError && (
          <Text c="red" size="sm">
            {discoverError}
          </Text>
        )}

        {found !== null && !discovering && (
          <Stack gap={4}>
            {newlyFound.length > 0 ? (
              <>
                <Text size="xs" c="dimmed">
                  Select a meter to fill in its address:
                </Text>
                {newlyFound.map((device) => (
                  <Button
                    key={device.address}
                    variant="light"
                    justify="space-between"
                    fullWidth
                    onClick={() => handlePick(device)}
                  >
                    <Group justify="space-between" wrap="nowrap" style={{ width: "100%" }}>
                      <Text size="sm">{device.name}</Text>
                      <Text size="xs" c="dimmed">
                        {device.address}
                      </Text>
                    </Group>
                  </Button>
                ))}
              </>
            ) : (
              <Text size="sm" c="dimmed">
                No new meters found. Make sure the meter's Bluetooth is enabled
                (long-press REL/BLE until the Bluetooth icon appears).
              </Text>
            )}
          </Stack>
        )}

        <form onSubmit={handleSubmit(onSubmit)}>
          <Stack>
            <TextInput
              label="Bluetooth Address"
              placeholder="Discover a meter above, or type it in"
              error={errors.address && "Bluetooth address is required"}
              {...register("address", { required: true })}
            />
            <TextInput
              label="Device Name"
              placeholder="e.g. Bench meter"
              error={errors.name && "Device name is required"}
              {...register("name", { required: true })}
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Identity color
              </Text>
              <DeviceColorPicker value={color} onChange={setColor} />
            </Stack>
            <Button type="submit" loading={addDevice.isPending}>
              Add
            </Button>
          </Stack>
        </form>
      </Stack>
    </Modal>
  );
}

function RenameDeviceModal({ device, onClose }: { device: KnownDevice | null; onClose: () => void }) {
  const renameDevice = useRenameDevice();
  const { register, handleSubmit } = useForm<{ name: string }>({
    values: { name: device?.name ?? "" },
  });
  const [color, setColor] = useState(device?.color ?? DEVICE_COLORS[0].key);

  // Re-seed when a different device is targeted -- `device` is only reassigned
  // (not a fresh object each render) when a different row's rename is clicked.
  useEffect(() => {
    setColor(device?.color ?? DEVICE_COLORS[0].key);
  }, [device]);

  function onSubmit(values: { name: string }) {
    if (!device) return;
    renameDevice.mutate({ deviceId: device.id, name: values.name, color }, { onSuccess: onClose });
  }

  return (
    <Modal opened={!!device} onClose={onClose} title="Rename device">
      <form onSubmit={handleSubmit(onSubmit)}>
        <Stack>
          <TextInput label="Name" {...register("name", { required: true })} />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Identity color
            </Text>
            <DeviceColorPicker value={color} onChange={setColor} />
          </Stack>
          <Button type="submit" loading={renameDevice.isPending}>
            Save
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

function DeviceRow({
  device,
  onRename,
}: {
  device: KnownDevice;
  onRename: (device: KnownDevice) => void;
}) {
  const status = useDeviceStatus(device.id);
  const connect = useConnectDevice();
  const disconnect = useDisconnectDevice();
  const removeDevice = useRemoveDevice();
  const colorScheme = useComputedColorScheme("light");

  const isConnected = status.data?.status === "connected";
  const swatch = getDeviceColor(device.color);
  const identityDotColor = colorScheme === "dark" ? swatch.dotDark : swatch.dotLight;

  // Blink the row 3x on a connection-state transition (offline->online green,
  // online->offline red) -- purely client-side, derived from the existing 3s
  // status poll, not a backend push. `prevConnected` starts at the first
  // known value so mount never counts as a transition.
  const prevConnected = useRef<boolean | null>(null);
  const [blink, setBlink] = useState<"green" | "red" | null>(null);
  useEffect(() => {
    if (status.data === undefined) return;
    if (prevConnected.current !== null && prevConnected.current !== isConnected) {
      setBlink(isConnected ? "green" : "red");
      const timer = setTimeout(() => setBlink(null), 1500);
      prevConnected.current = isConnected;
      return () => clearTimeout(timer);
    }
    prevConnected.current = isConnected;
  }, [isConnected, status.data]);

  function handleToggleConnect() {
    if (isConnected) {
      disconnect.mutate(device.id);
    } else {
      connect.mutate(device.id);
    }
  }

  function handleDelete() {
    if (window.confirm(`Remove "${device.name}" from known devices?`)) {
      removeDevice.mutate(device.id);
    }
  }

  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      style={{
        borderRadius: "var(--mantine-radius-sm)",
        animation: blink ? `blink-${blink} 0.5s ease-in-out 3` : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap">
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            display: "inline-block",
            flexShrink: 0,
            backgroundColor: identityDotColor,
          }}
        />
        <div>
          <Text size="sm" fw={500}>
            {device.name}
          </Text>
          <Text size="xs" c="dimmed">
            {device.address}
          </Text>
        </div>
      </Group>
      <Group gap={4} wrap="nowrap">
        <StatusDot connected={isConnected} />
        <Button
          size="xs"
          variant="default"
          loading={connect.isPending || disconnect.isPending}
          onClick={handleToggleConnect}
        >
          {isConnected ? "Disconnect" : "Connect"}
        </Button>
        <ActionIcon size="sm" variant="subtle" onClick={() => onRename(device)} aria-label="Rename">
          ✎
        </ActionIcon>
        <ActionIcon size="sm" variant="subtle" color="red" onClick={handleDelete} aria-label="Delete">
          <IconTrash size={14} />
        </ActionIcon>
      </Group>
    </Group>
  );
}

export function DeviceListWidget() {
  const devices = useDevices();
  const unregistered = useUnregisteredDevices();
  const settings = useSettings();
  const bluetoothStatus = useBluetoothStatus();
  const [addOpen, setAddOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<KnownDevice | null>(null);
  const [prefill, setPrefill] = useState<DiscoveredDevice | null>(null);

  const newDevice = unregistered.data?.[0] ?? null;
  // false, not null/undefined -- null/undefined means "unknown" (no known
  // device yet, check unsupported on this platform/machine, etc.) and should
  // never show a false-alarm warning (Changes ausgust-25.txt item 1).
  const bluetoothDisabled = bluetoothStatus.data?.enabled === false;

  function handleAddNewDevice() {
    setPrefill(newDevice);
    setAddOpen(true);
  }

  function handleCloseAdd() {
    setAddOpen(false);
    setPrefill(null);
  }

  return (
    <Stack gap="xs" h="100%">
      {bluetoothDisabled ? (
        <Text size="xs" c="red">
          Bluetooth is currently not enabled/on. Please enable Bluetooth on this Computer.
        </Text>
      ) : (
        settings.data?.auto_connect && (
          <Text size="xs" c="dimmed">
            Auto connects to known devices
          </Text>
        )
      )}

      {newDevice && (
        <Button size="xs" color="accent" className="blink-attention" onClick={handleAddNewDevice}>
          New Device Found. Add it
        </Button>
      )}

      {devices.isLoading && <Text size="sm">Loading…</Text>}
      {devices.isError && (
        <Text size="sm" c="red">
          Could not load devices — check that the backend is running.
        </Text>
      )}
      {devices.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No devices registered. Add your first device.
        </Text>
      )}

      <Stack gap="sm">
        {devices.data?.map((device) => (
          <DeviceRow key={device.id} device={device} onRename={setRenameTarget} />
        ))}
      </Stack>

      <Button size="xs" variant="default" onClick={() => setAddOpen(true)}>
        Add device
      </Button>

      <AddDeviceModal opened={addOpen} onClose={handleCloseAdd} prefill={prefill} />
      <RenameDeviceModal device={renameTarget} onClose={() => setRenameTarget(null)} />
    </Stack>
  );
}
