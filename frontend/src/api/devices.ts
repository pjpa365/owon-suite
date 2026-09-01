import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./client";
import type {
  AddDeviceRequest,
  BluetoothStatus,
  DiscoveredDevice,
  KnownDevice,
  MeasurementOut,
  RenameDeviceRequest,
  StatusResponse,
} from "./types";

const DEVICES_KEY = ["devices"] as const;

export function useDevices() {
  return useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => apiFetch<KnownDevice[]>("/devices"),
  });
}

export function useDeviceStatus(deviceId: string | undefined) {
  return useQuery({
    queryKey: ["devices", deviceId, "status"],
    queryFn: () => apiFetch<StatusResponse>(`/devices/${deviceId}/status`),
    enabled: !!deviceId,
    refetchInterval: 3000,
  });
}

export function useLatestReading(deviceId: string | undefined) {
  return useQuery({
    queryKey: ["devices", deviceId, "latest"],
    queryFn: () => apiFetch<MeasurementOut[]>(`/devices/${deviceId}/latest?count=1`),
    enabled: !!deviceId,
    refetchInterval: 2000,
  });
}

export async function discoverDevices(timeout = 10): Promise<DiscoveredDevice[]> {
  return apiFetch<DiscoveredDevice[]>(`/devices/discover?timeout=${timeout}`);
}

// Cheap read of the backend's continuous background scan (discovery_loop.py),
// not a scan trigger itself -- safe to poll. The backend sweep itself only
// refreshes every ~10s, so polling faster than that just re-reads the same
// result; 5s keeps the "New Device Found" prompt reasonably prompt without
// hammering the endpoint.
export function useUnregisteredDevices() {
  return useQuery({
    queryKey: ["devices", "unregistered"],
    queryFn: () => apiFetch<DiscoveredDevice[]>("/devices/unregistered"),
    refetchInterval: 5000,
  });
}

// Cheap read of the backend's continuous background scan's last-checked
// Bluetooth-radio state (discovery_loop.py), same pattern as
// useUnregisteredDevices above -- not a fresh check itself, safe to poll.
export function useBluetoothStatus() {
  return useQuery({
    queryKey: ["devices", "bluetooth-status"],
    queryFn: () => apiFetch<BluetoothStatus>("/devices/bluetooth-status"),
    refetchInterval: 5000,
  });
}

export function useAddDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AddDeviceRequest) =>
      apiFetch<KnownDevice>("/devices", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY }),
  });
}

export function useRenameDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, name, color }: { deviceId: string; name: string; color?: string }) =>
      apiFetch<KnownDevice>(`/devices/${deviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, color } satisfies RenameDeviceRequest),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY }),
  });
}

export function useRemoveDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => apiFetch<void>(`/devices/${deviceId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY }),
  });
}

export function useConnectDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<StatusResponse>(`/devices/${deviceId}/connect`, { method: "POST" }),
    onSuccess: (_data, deviceId) =>
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "status"] }),
  });
}

export function useDisconnectDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<StatusResponse>(`/devices/${deviceId}/disconnect`, { method: "POST" }),
    onSuccess: (_data, deviceId) =>
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "status"] }),
  });
}

export function useSendControl() {
  return useMutation({
    mutationFn: ({ deviceId, control }: { deviceId: string; control: string }) =>
      apiFetch<{ sent: string }>(`/devices/${deviceId}/control`, {
        method: "POST",
        body: JSON.stringify({ control }),
      }),
  });
}
