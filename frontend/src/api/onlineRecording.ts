import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./client";
import type { MeasurementSummary, OnlineRecordingStartRequest, OnlineRecordingStatus } from "./types";

const MEASUREMENTS_KEY = ["measurements"] as const;

export function useOnlineStatus(deviceId: string | undefined) {
  return useQuery({
    queryKey: ["devices", deviceId, "online-status"],
    queryFn: () => apiFetch<OnlineRecordingStatus>(`/devices/${deviceId}/recordings/online/status`),
    enabled: !!deviceId,
    refetchInterval: 2000,
  });
}

export function useStartOnline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, config }: { deviceId: string; config: OnlineRecordingStartRequest }) =>
      apiFetch<OnlineRecordingStatus>(`/devices/${deviceId}/recordings/online/start`, {
        method: "POST",
        body: JSON.stringify(config),
      }),
    onSuccess: (_data, { deviceId }) =>
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "online-status"] }),
  });
}

function useOnlineAction(action: "pause" | "resume" | "stop") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<OnlineRecordingStatus | MeasurementSummary>(`/devices/${deviceId}/recordings/online/${action}`, {
        method: "POST",
      }),
    onSuccess: (_data, deviceId) => {
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "online-status"] });
      queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
    },
  });
}

export function usePauseOnline() {
  return useOnlineAction("pause");
}
export function useResumeOnline() {
  return useOnlineAction("resume");
}
export function useStopOnline() {
  return useOnlineAction("stop");
}
