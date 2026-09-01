import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./client";
import type { OfflineRecordingStartRequest, OfflineRecordingStatus } from "./types";

const MEASUREMENTS_KEY = ["measurements"] as const;

export function useOfflineStatus(deviceId: string | undefined) {
  return useQuery({
    queryKey: ["devices", deviceId, "offline-status"],
    queryFn: () => apiFetch<OfflineRecordingStatus>(`/devices/${deviceId}/recordings/offline/status`),
    enabled: !!deviceId,
    refetchInterval: 2000,
  });
}

export function useStartOffline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, config }: { deviceId: string; config: OfflineRecordingStartRequest }) =>
      apiFetch<OfflineRecordingStatus>(`/devices/${deviceId}/recordings/offline/start`, {
        method: "POST",
        body: JSON.stringify(config),
      }),
    onSuccess: (_data, { deviceId }) =>
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "offline-status"] }),
  });
}

export function useStopOffline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<OfflineRecordingStatus>(`/devices/${deviceId}/recordings/offline/stop`, { method: "POST" }),
    onSuccess: (_data, deviceId) => {
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "offline-status"] });
      queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
    },
  });
}
