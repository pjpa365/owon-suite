import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./client";
import type {
  AdhocStatus,
  MeasurementFilters,
  MeasurementOut,
  MeasurementPoint,
  MeasurementSummary,
  RenameMeasurementRequest,
} from "./types";

const MEASUREMENTS_KEY = ["measurements"] as const;

function buildQuery(filters: MeasurementFilters): string {
  const params = new URLSearchParams();
  if (filters.device_id) params.set("device_id", filters.device_id);
  if (filters.name_contains) params.set("name_contains", filters.name_contains);
  if (filters.date_from) params.set("date_from", filters.date_from);
  if (filters.date_to) params.set("date_to", filters.date_to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useMeasurements(filters: MeasurementFilters = {}) {
  return useQuery({
    queryKey: [...MEASUREMENTS_KEY, filters],
    queryFn: () => apiFetch<MeasurementSummary[]>(`/measurements${buildQuery(filters)}`),
  });
}

export function useMeasurementPoints(measurementId: string | undefined) {
  return useQuery({
    queryKey: [...MEASUREMENTS_KEY, measurementId, "points"],
    queryFn: () => apiFetch<MeasurementPoint[]>(`/measurements/${measurementId}/points`),
    enabled: !!measurementId,
  });
}

// Chart (multiple) (Changes ausgust-25.txt item 10): fetches each selected
// measurement's points independently. Same query key shape as
// useMeasurementPoints above, so results are cache-shared/deduped with any
// other place already fetching points for the same measurement.
export function useMultipleMeasurementPoints(measurementIds: string[]) {
  return useQueries({
    queries: measurementIds.map((id) => ({
      queryKey: [...MEASUREMENTS_KEY, id, "points"],
      queryFn: () => apiFetch<MeasurementPoint[]>(`/measurements/${id}/points`),
    })),
  });
}

export function useRenameMeasurement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ measurementId, name }: { measurementId: string; name: string }) =>
      apiFetch<MeasurementSummary>(`/measurements/${measurementId}`, {
        method: "PATCH",
        body: JSON.stringify({ name } satisfies RenameMeasurementRequest),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY }),
  });
}

export function useDeleteMeasurement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (measurementId: string) => apiFetch<void>(`/measurements/${measurementId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY }),
  });
}

export function useDeleteMeasurementPoints() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ measurementId, pointIds }: { measurementId: string; pointIds: number[] }) =>
      apiFetch<MeasurementSummary>(`/measurements/${measurementId}/points:delete`, {
        method: "POST",
        body: JSON.stringify({ point_ids: pointIds }),
      }),
    onSuccess: (_data, { measurementId }) => {
      queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
      queryClient.invalidateQueries({ queryKey: [...MEASUREMENTS_KEY, measurementId, "points"] });
    },
  });
}

export function useSaveBuffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<MeasurementSummary>(`/devices/${deviceId}/recordings/save-buffer`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY }),
  });
}

export function useAdhocStatus(deviceId: string | undefined) {
  return useQuery({
    queryKey: ["devices", deviceId, "adhoc-status"],
    queryFn: () => apiFetch<AdhocStatus>(`/devices/${deviceId}/recordings/adhoc/status`),
    enabled: !!deviceId,
    refetchInterval: 2000,
  });
}

function useAdhocAction(action: "start" | "pause" | "resume" | "stop") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<AdhocStatus | MeasurementSummary>(`/devices/${deviceId}/recordings/adhoc/${action}`, {
        method: "POST",
      }),
    onSuccess: (_data, deviceId) => {
      queryClient.invalidateQueries({ queryKey: ["devices", deviceId, "adhoc-status"] });
      queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
    },
  });
}

export function useStartAdhoc() {
  return useAdhocAction("start");
}
export function usePauseAdhoc() {
  return useAdhocAction("pause");
}
export function useResumeAdhoc() {
  return useAdhocAction("resume");
}
export function useStopAdhoc() {
  return useAdhocAction("stop");
}

/** Rows currently held in a device's cyclic buffer (used by the live-buffer view of the measurement table widget). */
export function useLiveBufferRows(deviceId: string | undefined, count = 200) {
  return useQuery({
    queryKey: ["devices", deviceId, "latest", count],
    queryFn: () => apiFetch<MeasurementOut[]>(`/devices/${deviceId}/latest?count=${count}`),
    enabled: !!deviceId,
    refetchInterval: 1000,
  });
}
