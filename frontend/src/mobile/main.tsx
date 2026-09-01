import "@mantine/core/styles.css";
import "../index.css";

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { ApiError } from "../api/client.ts";
import { cssVariablesResolver, theme } from "../theme.ts";
import { MobileApp } from "./MobileApp.tsx";
import { MobileThemeContext } from "./MobileThemeContext.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    // A 401/403 will never succeed by blindly retrying it -- letting React
    // Query's default 3x exponential backoff run anyway (2026-09-01 bug
    // report: mobile PIN screen took 5-7s to appear, because MobileApp's
    // optimistic /devices check had to exhaust all 3 retries against a stale
    // token before falling back to the PIN screen) just delays reaching the
    // error state that's needed to react to it. Other failures still get the
    // default retry behavior.
    queries: { retry: (failureCount, error) => error instanceof ApiError && [401, 403].includes(error.status) ? false : failureCount < 3 },
  },
});

function Root() {
  // In-memory only, deliberately not Mantine's persisted color scheme --
  // see MobileThemeContext.tsx for why. Undefined = no override yet (follows
  // the OS/light-dark-auto default, same as before this existed).
  const [forcedScheme, setForcedScheme] = useState<"light" | "dark" | undefined>(undefined);

  return (
    <MantineProvider
      defaultColorScheme="auto"
      forceColorScheme={forcedScheme}
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
    >
      <QueryClientProvider client={queryClient}>
        <MobileThemeContext.Provider
          value={{ toggle: (current) => setForcedScheme(current === "dark" ? "light" : "dark") }}
        >
          <MobileApp />
        </MobileThemeContext.Provider>
      </QueryClientProvider>
    </MantineProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
