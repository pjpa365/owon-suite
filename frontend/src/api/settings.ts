import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "./client";
import type { AppSettings } from "./types";

const SETTINGS_KEY = ["settings"] as const;

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiFetch<AppSettings>("/settings"),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (partial: Partial<AppSettings>) =>
      apiFetch<AppSettings>("/settings", { method: "PATCH", body: JSON.stringify(partial) }),
    onSuccess: (data) => {
      // The PATCH response is already the full, merged settings object --
      // write it straight into the cache instead of a redundant refetch.
      queryClient.setQueryData(SETTINGS_KEY, data);
    },
  });
}
