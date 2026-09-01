import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "./index.css";

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { ApiError } from "./api/client.ts";
import { cssVariablesResolver, theme } from "./theme.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    // A 401/403 will never succeed by blindly retrying it -- letting React
    // Query's default 3x exponential backoff run anyway (2026-09-01 bug
    // report: mobile PIN screen took 5-7s to appear) just delays reaching
    // the error state that's needed to react to it. Other failures still get
    // the default retry behavior.
    queries: { retry: (failureCount, error) => error instanceof ApiError && [401, 403].includes(error.status) ? false : failureCount < 3 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto" theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
