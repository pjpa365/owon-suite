import { useEffect, useReducer } from "react";

import { wsUrl } from "../api/client";
import type { MeasurementOut } from "../api/types";
import { MAX_BUFFER_SIZE } from "../config";
import { useDashboardStore } from "./dashboardStore";

// Cross-tab shared live-chart data (Changes_post_phase5_and_color_design.txt):
// every Live chart widget watching the same device -- on any dashboard, active
// tab or not -- must see the exact same history, and that history must survive
// switching away from and back to a tab. A per-widget WebSocket/buffer (the
// old useLiveStream approach) can't do that, since switching tabs unmounts the
// widget and destroys its component state. This module owns one WebSocket +
// history buffer per device, keyed independently of which widgets are
// currently mounted, driven by useLiveChartOrchestrator() (mounted once, at
// the app root, so it keeps running regardless of the active tab).

const MAX_HISTORY = MAX_BUFFER_SIZE; // mirrors useLiveStream.ts's cap, and the backend's real buffer size
const RECONNECT_DELAY_MS = 2000;

interface DeviceStream {
  socket: WebSocket | null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  history: MeasurementOut[];
  lastUnit: string | null;
  // The "relative" chart-time-axis mode's t0 -- deliberately NOT derived from
  // history[0] (a real bug: once a widget's configured window size reaches
  // MAX_HISTORY, the oldest *retained* sample and the oldest *visible* sample
  // become the same entry, evicted together on every new reading, which
  // silently drags "t0" forward in real time instead of leaving it fixed --
  // the same historical point then reports a *smaller* elapsed time on every
  // later render, which is what read as "the same dip shows different times").
  // Set once when a stream starts (or restarts after a clear/unit change) and
  // never touched again, so it stays a true fixed reference regardless of how
  // MAX_HISTORY trims the retained array.
  sessionStart: string | null;
  listeners: Set<() => void>;
}

const streams = new Map<string, DeviceStream>();
let wantedDevices = new Set<string>();

function notify(stream: DeviceStream) {
  stream.listeners.forEach((listener) => listener());
}

function connect(deviceId: string) {
  let stream = streams.get(deviceId);
  // A stream entry existing isn't the same as being connected -- useLiveChartHistory
  // below pre-creates an empty placeholder (socket: null) so a listener has
  // something to attach to before this orchestrator has run yet. Because React
  // fires child effects before parent effects on mount, and this orchestrator
  // lives above every widget that calls useLiveChartHistory, that placeholder is
  // reliably created *before* this function's first real call for a device --
  // so guarding on "an entry exists" (rather than "a socket exists") meant this
  // branch always returned early and no Live chart widget ever actually opened a
  // WebSocket. Only skip if there's a real socket or a reconnect already pending;
  // otherwise open one using (not replacing) whatever placeholder is there.
  if (stream?.socket || stream?.retryTimer) return;
  if (!stream) {
    stream = { socket: null, retryTimer: undefined, history: [], lastUnit: null, sessionStart: null, listeners: new Set() };
    streams.set(deviceId, stream);
  }

  function open() {
    const current = streams.get(deviceId);
    if (!current) return;
    const socket = new WebSocket(wsUrl(`/ws/${deviceId}`));
    current.socket = socket;

    socket.onmessage = (event) => {
      const reading = JSON.parse(event.data) as MeasurementOut;
      // Defensive: never append the exact same reading twice in a row (same
      // timestamp). Couldn't pin down a concrete double-delivery mechanism in
      // this file or the backend (connection_manager.py broadcasts each
      // reading exactly once, per-subscriber, no replay-on-subscribe), but
      // this guards against it regardless of cause, and can't drop a real
      // distinct reading -- the backend timestamps at BLE-notification time,
      // far coarser than two genuinely different readings could ever collide on.
      if (current.history.at(-1)?.timestamp === reading.timestamp) {
        return;
      }
      // A device switching measurement mode (e.g. A -> V) must not leave stale
      // readings from the old unit mixed into the chart -- drop everything
      // buffered so far rather than showing a mixed-unit line.
      if (current.lastUnit !== null && reading.unit !== current.lastUnit) {
        current.history = [];
        current.sessionStart = null;
      }
      current.lastUnit = reading.unit;
      if (current.sessionStart === null) {
        current.sessionStart = reading.timestamp;
      }
      const next = [...current.history, reading];
      current.history = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
      notify(current);
    };

    socket.onclose = () => {
      if (streams.get(deviceId) === current && wantedDevices.has(deviceId)) {
        current.retryTimer = setTimeout(open, RECONNECT_DELAY_MS);
      }
    };
  }

  open();
}

/** Wipes a device's shared history (Changes ausgust-25.txt: Live chart "clear"
 * icon) -- clears every Live chart widget watching this device at once, since
 * they all share this one buffer. The socket itself is untouched; new
 * readings keep arriving and accumulate from empty. */
export function clearHistory(deviceId: string): void {
  const stream = streams.get(deviceId);
  if (!stream) return;
  stream.history = [];
  stream.sessionStart = null;
  notify(stream);
}

function disconnect(deviceId: string) {
  const stream = streams.get(deviceId);
  if (!stream) return;
  clearTimeout(stream.retryTimer);
  stream.socket?.close();
  streams.delete(deviceId);
}

function setWantedDevices(deviceIds: Set<string>) {
  wantedDevices = deviceIds;
  for (const id of deviceIds) connect(id);
  for (const id of [...streams.keys()]) {
    if (!deviceIds.has(id)) disconnect(id);
  }
}

/** Mounted once at the app root -- derives which devices have at least one
 * Live chart widget somewhere (any dashboard, not just the active one) and
 * keeps exactly those devices' streams alive. A device with zero Live chart
 * widgets anywhere isn't collected at all. */
export function useLiveChartOrchestrator() {
  const dashboards = useDashboardStore((s) => s.dashboards);

  useEffect(() => {
    const wanted = new Set<string>();
    for (const dashboard of dashboards) {
      for (const widget of dashboard.widgets) {
        if (widget.type === "live-chart" && widget.config.deviceId) {
          wanted.add(widget.config.deviceId);
        }
      }
    }
    setWantedDevices(wanted);
  }, [dashboards]);
}

/** Read-only view of a device's shared history buffer, re-rendering the
 * caller whenever new data arrives. `sessionStart` is the fixed t0 for
 * "relative" chart-time-axis mode -- see DeviceStream.sessionStart above for
 * why this isn't just `history[0]?.timestamp`. */
export function useLiveChartHistory(deviceId: string | undefined): { history: MeasurementOut[]; sessionStart: string | null } {
  const [, forceRender] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    if (!deviceId) return;
    let stream = streams.get(deviceId);
    if (!stream) {
      // Nothing is collecting this device yet (e.g. the widget mounted before
      // the orchestrator's effect ran) -- start an empty buffer so the
      // listener has something to attach to; the orchestrator will open the
      // actual socket on its next pass since this widget existing means the
      // device is now wanted.
      stream = { socket: null, retryTimer: undefined, history: [], lastUnit: null, sessionStart: null, listeners: new Set() };
      streams.set(deviceId, stream);
    }
    const listener = () => forceRender();
    stream.listeners.add(listener);
    return () => {
      stream?.listeners.delete(listener);
    };
  }, [deviceId]);

  if (!deviceId) return { history: [], sessionStart: null };
  const stream = streams.get(deviceId);
  return { history: stream?.history ?? [], sessionStart: stream?.sessionStart ?? null };
}
