# Application architecture

This document captures the technical architecture for the full OWON meter application,
derived from `OWON meter specifications.txt`. It reflects decisions made and open items
still remaining as of 2026-07-23.

## 1. High-level shape

Client-server application:

- **Backend**: Python. Owns all device communication (BLE via `bleak`, building directly
  on the validated protocol layer in `poc/owon_ble/`), the database, calculation engine,
  and exposes a **REST API** (discrete commands/CRUD) plus a **streaming channel**
  (WebSocket) for continuous live data push. A Python ASGI framework (FastAPI is the
  natural fit, given the async requirements from BLE + WebSocket + REST together) is
  recommended but not yet explicitly locked in.
- **Frontend**: a local web app — **React** + **react-grid-layout** for the
  dashboard/"portal" layout system (palette of widgets, drag/resize/place, persisted
  per-window layout), talking to the backend over REST + WebSocket.
- **MCP server**: a thin layer on top of the same REST API and streaming channel — not a
  second implementation of device logic. See §5.

```
 ┌─────────────┐        REST (commands, CRUD)        ┌──────────────────────┐
 │   React      │ ───────────────────────────────────▶│                      │
 │   frontend   │◀─────────────────────────────────── │   Python backend     │──── bleak/BLE ──▶ meter(s)
 │ (react-grid- │        WebSocket (live data)         │  (device mgr, conn   │
 │   layout,    │◀════════════════════════════════════│  mgr, DuckDB, calc   │
 │   ECharts)   │                                      │  engine, scheduler)  │
 └─────────────┘                                      └──────────┬───────────┘
                                                                   │ same REST + streaming
                                                        ┌──────────▼───────────┐
                                                        │     MCP server        │
                                                        │ (scoped credentials,  │
                                                        │  no delete access)    │
                                                        └───────────────────────┘
```

## 2. Database: DuckDB

Chosen over SQLite (fine, but row-oriented — not as naturally fast for the
aggregation/calculation-heavy queries the spec calls for) and over TimescaleDB/InfluxDB
(purpose-built for time-series and excellent at scale, but require running a separate
database server — too heavy a deployment story for a single-user desktop tool at the
data volumes described).

DuckDB is embedded (no server/install), columnar/OLAP-optimized (fits "must be very
fast... in charts and calculations" directly), and has real headroom if higher-throughput
instruments are added later (see §10) — without forcing a server-based deployment today.
The data-access layer should stay thin (one repository module, not raw SQL scattered
throughout) so a future move to a server-based DB, if data volume ever truly demands it,
isn't a rewrite.

**Schema shape**: persisted measurement data points live in a **shared table** with a
`measurement_id` (and `device_id` where relevant) column — not one table per device or
per measurement. This is the standard normalized time-series shape and is exactly
DuckDB's sweet spot (columnar scans filtered by ID).

**Computed stats persisted, not recomputed on demand**: once a measurement is finalized,
its min/max/average/median/duration/count are computed once and stored as real columns
on the measurement's metadata row — needed by the naming engine (§4) and also directly
useful for the measurement list's search/filter/sort requirement.

## 3. Core components

### 3.1 Device manager
Registry of known meters: custom name + BT address + config, persisted independently of
live connection state. A meter can be "known" without being "connected." Handles
rename/delete-registration (data stays; only the registration entry is removed).

### 3.2 Connection manager
Owns actual live device connections: scanning/auto-discovery, per-device connect state
(the green/red dot), reconnection handling. Also the **single enforcement point for the
control-lock** between UI and MCP (§5) — both the UI's action handlers and the
MCP-facing API calls must go through this same check, not two independently-implemented
paths.

### 3.3 Cyclic buffer
**In-memory only, per device** — one ring buffer (e.g. `collections.deque(maxlen=N)`)
per connected device, held in the running server process. Not DuckDB-backed: DuckDB is
built for bulk analytical scans, not high-frequency single-row overwrite-in-place, and the
spec's own "Save Buffer" action already frames the buffer as explicitly transient — the
deliberate act of promoting its contents into a real persisted measurement.

`N` is a single, fixed, hardcoded app parameter (currently 1000, matching the spec) — not
a live-editable setting, and deliberately defined in exactly **one place** rather than as
matching-but-separate constants on the backend and frontend (a real, hit gotcha: an
earlier separate frontend-only display cap of 500 for the Live chart widget, unrelated to
this value, was mistaken for the same number drifting out of sync). Defined in
`backend/config.env` (the same file already holding `HOST`/`PORT`) and read by both sides
via the exact mechanism already in place for those: the backend reads it directly at
startup to construct the buffer; `vite.config.ts` reads the same file at build time and
injects it into the frontend bundle the same way it already does for the API base URL, so
neither side can drift from the other. The MCP server's "get last X values" tool (§5)
validates its `X` against this same backend-side value directly, in-process — no
propagation needed there at all.

### 3.4 Naming/templating engine
Python's built-in `str.format()` with a small, fixed, closed set of named tokens
(`device_name`, `start_time`, `min_value`, `max_value`, `unit`, `duration`, `count`,
etc.) — not a general-purpose template engine like Jinja2, which would be the wrong tool
for a fixed vocabulary with no loops/conditionals needed.

**Two-phase naming**: an initial, basic name (device + start-time only — the only tokens
available immediately) is assigned when a measurement/recording begins; it's replaced
with the full templated name once the measurement is finalized and the remaining stats
(min/max/duration/count) are known. Applies uniformly to ad-hoc recordings, online
recordings, and offline-recording downloads.

### 3.5 Calculation engine
Ah, Watt-hour, and Shunt-current (**`I = U / R`**, corrected from the spec's original
`I = U x R`). Deliberately factored as a shared module (not inline per-button logic) for
concrete, non-hypothetical reasons:

- **Shared time-series alignment/interpolation utility** — needed by Watt-hour (aligning
  two differently-sampled series) and now also by the new scatter/XY chart (§7), so the
  tricky alignment logic is written and tested once, not duplicated.
  - Method: **linear interpolation** between known points.
  - Range: output trimmed to the **overlapping period only** between the two source
    series — no extrapolation past either series' start/end.
  - Duration-tolerance (currently ~10% in the spec) is an **app setting**, not hardcoded.
  - Optional **manual sync-point** override for measurements not started at the same
    real-world moment.
  - Interpolated data points must be visually distinguishable (different color) from
    actually-measured points wherever displayed (scatter chart specifically).
- **Shared stats computation** (min/max/avg/median/duration) — the same shape needed by
  all three calculations *and* by the naming engine (§3.4); computed once, not
  re-derived per consumer.
- **Lineage/provenance** — calculated/derived measurements reference their source
  measurement(s); centralized here rather than reimplemented per calculation type.
- Plain functions (`given a time series + parameters, produce a result`), independently
  unit-testable without UI/DB involvement.

### 3.6 Settings store
JSON/config file. Holds: per-unit default chart colors, naming templates, dark/light mode,
"set clock before offline job" default, calculation duration-tolerance, the mobile
client's PIN (see the mobile-access work), and similar app-wide settings that are safe to
change live, without a restart. **Not** the cyclic buffer size (§3.3) — that's a fixed
startup parameter from `config.env`, deliberately outside this live-editable store, so
there's no way for a PATCH here to create a value that looks authoritative but doesn't
actually match what the running buffer was built with.

MCP-related additions (§5): `mcp_enabled` (bool, default off), `mcp_queries_enabled`
(bool, default off, only meaningful when the above is on), `mcp_api_key` (string, blank by
default — same "blank means the feature does nothing yet" convention as the mobile PIN,
not a system-generated secret; the user sets their own value here and pastes the same
string into their MCP client's config).

### 3.7 Export module
CSV (required) + other table-based formats (nice-to-have, exact list TBD — e.g. XLSX).
Chart image export: PNG/JPEG via ECharts' built-in toolbox/`getDataURL` support (no new
dependency); SVG via ECharts' SVG renderer mode instead of the default canvas renderer.

### 3.8 Background scheduler
Offline-recording countdown timers, "waiting for BT reconnect" polling after a recording
completes, online-recording threshold/low-battery monitoring, pause/resume handling.

## 4. API layer

- **REST**: discrete device commands (button-equivalent actions), CRUD on
  devices/measurements/settings, initiating offline/online recordings with parameters.
- **Streaming channel (WebSocket)**: continuous live-data push — feeds both the React
  frontend's live widgets/charts *and* the MCP server's data-access needs (§5). Pure REST
  cannot serve this; it needs the same push channel the UI already requires.

## 5. MCP server

A thin translation layer over the same REST API, streaming channel, and
database the UI itself uses — not a second implementation of device/data
logic. Reachable from the LAN as well as the local PC, gated behind an
`mcp_enabled` setting (off by default) plus an API key.

It has two parts:

- **Read-only data access** — device list and live connection status,
  latest live values, listing/fetching stored recordings, and an ad-hoc SQL
  query tool scoped to a handful of purpose-built read-only views (not the
  raw database tables), so an AI agent can answer real analytical questions
  without a bespoke tool for every possible question shape.
- **Device and recording control** — the same button presses and
  start/pause/stop actions the dashboard itself exposes, calling the exact
  same backend logic the REST API calls — no duplicated device/recording
  behavior.

Deleting anything is out of scope for MCP entirely, in both parts.

## 6. Frontend

- **React** + **react-grid-layout** for the dashboard/"portal" system: a palette of
  pre-built widget types, drag/resize/place within a window, per-window layout persisted,
  multiple independent windows, default startup window, dark/light mode.
- **Apache ECharts** for charting: native dual-Y-axis, native "nice" tick generation,
  native real-time streaming updates, native log-scale support (for the spec's
  forward-looking axis note), free/no licensing cost (unlike Highcharts, which requires
  a paid commercial license beyond strictly personal/non-commercial use).

## 7. UI components (widget types)

- **Device list** — known meters, connection status dot, add/rename/delete registration.
- **Live-value widget** — large-digit current-value display + merged device-control
  buttons (Hold/Range/BT-off/etc.) for the same meter. Deliberate exception to the
  general "components are standalone" rule, since these two are meter-specific and
  tightly coupled.
- **Measurement table** — rows of timestamp/value for a selected dataset (live buffer,
  stored recording, ad-hoc recording, or calculated measurement).
- **Line chart** — single or multi-measurement, dual-Y-axis for up to 2 distinct units,
  grid toggle, "nice" tick axes, per-unit default colors, smooth real-time scrolling when
  bound to the cyclic buffer.
- **Scatter/XY chart** *(new)* — plots one measurement (X-axis) against another
  (Y-axis), rather than both against time. User selects the time-alignment between the
  two datasets; uses the same interpolation utility as Watt-hour (§3.5); interpolated
  points rendered in a visually distinct color from actually-measured points. Classic
  electrical use case: V-I characteristic curves.
- **Recording control** — offline/online configuration, countdown, status, thresholds,
  pause/stop.
- **No gauge/dial widget** — considered, explicitly rejected.

For the multi-measurement line chart and the scatter chart alike: once 2 units are
selected, the measurement picker **proactively filters out** incompatible units (rather
than allowing an invalid selection and showing an error afterward), and the UI clearly
indicates which 2 units are currently selected/required.

## 8. Open items / backlog

- **Offline recording `interval=0` tested against hardware (2026-07-23)** — accepted by
  the meter (not rejected or substituted) and measured at roughly ~500 samples/second,
  far above the specification's assumed 2-3/second (see `docs/protocol-spec.md` §6.1.1
  for the full finding and measurement caveats). **Design note: the application should
  constrain user-facing recording intervals to `> 0`.** It remains unconfirmed whether
  `interval=0`'s ~500/s represents genuinely independent fast measurements or duplicated
  writes of a value that may only update at the slower live rate internally — until
  that's resolved, exposing `0`/"max rate" as a selectable option risks implying a time
  resolution that may not actually exist. Revisit once the pending
  changing-signal-during-recording test (§6.1.1 of the protocol spec) settles it.
- Exact list of "other table-based export formats" beyond CSV not yet decided.
- Detailed MCP tool/resource schema deliberately deferred (see §5).

## 9. Extensibility ("think bigger")

Per the project's working agreement (`CLAUDE.md`), architecture decisions should avoid
dead-ends that would force a rewrite if the project expands beyond the OWON B41T+:

- **Instrument driver abstraction**: a common interface that today's OWON B41T+/BLE
  support implements one way, so other brands or instrument *types* can implement the
  same interface differently later, without touching the rest of the app.
- **Chart-type extension point**: line + scatter cover the current need; a
  frequency-domain (FFT/spectrum) chart and a digital timing-diagram chart become
  relevant specifically if oscilloscope/logic-analyzer support is added later — not
  needed now, but the chart-widget abstraction should have room for new chart types
  without a redesign.
- **API/MCP surface** should stay reasonably generic across device/instrument types from
  the start, even though only OWON multimeters exist today.
