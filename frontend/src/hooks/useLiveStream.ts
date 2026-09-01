import { useEffect, useRef, useState } from "react";

import { wsUrl } from "../api/client";
import type { MeasurementOut } from "../api/types";
import { MAX_BUFFER_SIZE } from "../config";

// Generous cap on the raw buffer kept per device -- individual widgets slice
// their own configured window (LiveChartWidget's pointCount) out of this, so
// this only needs to be at least as large as the biggest window on offer.
// Mirrors the backend's real cyclic buffer size (config.ts/BUFFER_SIZE) so
// this can never silently cap lower than what the server actually retains.
const MAX_HISTORY = MAX_BUFFER_SIZE;
const RECONNECT_DELAY_MS = 2000;

export function useLiveStream(deviceId: string | undefined) {
  const [latest, setLatest] = useState<MeasurementOut | null>(null);
  const [history, setHistory] = useState<MeasurementOut[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  // Fixed t0 for "relative" chart-time-axis mode -- deliberately NOT
  // history[0]?.timestamp, which gets silently dragged forward once the
  // buffer exceeds MAX_HISTORY and starts evicting its own oldest entries
  // (see liveChartStream.ts's sessionStart field for the full explanation;
  // this is the same bug, same fix, for the mobile client's chart pane,
  // which shows the whole buffer rather than a separately-sized window).
  const sessionStartRef = useRef<string | null>(null);

  useEffect(() => {
    setLatest(null);
    setHistory([]);
    sessionStartRef.current = null;

    if (!deviceId) {
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const socket = new WebSocket(wsUrl(`/ws/${deviceId}`));
      socketRef.current = socket;

      socket.onmessage = (event) => {
        const reading = JSON.parse(event.data) as MeasurementOut;
        if (sessionStartRef.current === null) {
          sessionStartRef.current = reading.timestamp;
        }
        setLatest(reading);
        setHistory((prev) => {
          const next = [...prev, reading];
          return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });
      };

      socket.onclose = () => {
        if (!cancelled) {
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [deviceId]);

  return { latest, history, sessionStart: sessionStartRef.current };
}
