import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch, setMobileToken } from "./client";
import type { ChartColorSet, ChartTimeMode } from "./types";

export function useMobileEnabled() {
  return useQuery({
    queryKey: ["mobile", "enabled"],
    queryFn: () => apiFetch<{ enabled: boolean }>("/mobile/enabled"),
  });
}

interface MobileDisplaySettings {
  chart_time_mode: ChartTimeMode;
  chart_colors: ChartColorSet;
}

// Deliberately a separate, narrow endpoint from the PC dashboard's full
// /settings -- that one isn't reachable from a phone at all (not in
// mobile_auth's LAN allowlist), specifically because it also carries
// mobile_pincode itself among other PC-only settings.
export function useMobileDisplaySettings() {
  return useQuery({
    queryKey: ["mobile", "display-settings"],
    queryFn: () => apiFetch<MobileDisplaySettings>("/mobile/display-settings"),
  });
}

export function useVerifyPin() {
  return useMutation({
    mutationFn: (pin: string) =>
      apiFetch<{ token: string }>("/mobile/verify-pin", {
        method: "POST",
        body: JSON.stringify({ pin }),
      }),
    onSuccess: (data) => setMobileToken(data.token),
  });
}
