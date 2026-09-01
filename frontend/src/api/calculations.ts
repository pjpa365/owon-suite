import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./client";
import type {
  AhRequest,
  AhResponse,
  AlignRequest,
  AlignResponse,
  OhmsLawRequest,
  OhmsLawResponse,
  ShuntCurrentRequest,
  ShuntCurrentResponse,
  WattHourRequest,
  WattHourResponse,
} from "./types";

const MEASUREMENTS_KEY = ["measurements"] as const;

export function useCalculateAh() {
  return useMutation({
    mutationFn: (body: AhRequest) =>
      apiFetch<AhResponse>("/calculations/ah", { method: "POST", body: JSON.stringify(body) }),
  });
}

export function useCalculateWattHour() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WattHourRequest) =>
      apiFetch<WattHourResponse>("/calculations/watt-hour", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      if (data.created_measurement_id) {
        queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
      }
    },
  });
}

export function useCalculateShuntCurrent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ShuntCurrentRequest) =>
      apiFetch<ShuntCurrentResponse>("/calculations/shunt-current", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      if (data.created_measurement_id) {
        queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
      }
    },
  });
}

export function useCalculateOhmsLaw() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OhmsLawRequest) =>
      apiFetch<OhmsLawResponse>("/calculations/ohms-law", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      if (data.created_measurement_id) {
        queryClient.invalidateQueries({ queryKey: MEASUREMENTS_KEY });
      }
    },
  });
}

/** Aligns two measurements onto a shared timeline -- used by the scatter/XY chart widget. */
export function useAlign(measurementIdA: string | undefined, measurementIdB: string | undefined) {
  return useQuery({
    queryKey: ["calculations", "align", measurementIdA, measurementIdB],
    queryFn: () =>
      apiFetch<AlignResponse>("/calculations/align", {
        method: "POST",
        body: JSON.stringify({
          // Non-null: queryFn only runs once `enabled` (both ids present) is true.
          measurement_id_a: measurementIdA!,
          measurement_id_b: measurementIdB!,
        } satisfies AlignRequest),
      }),
    enabled: !!measurementIdA && !!measurementIdB,
  });
}
