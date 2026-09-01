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

A thin translation layer over the REST API, the streaming channel, and a read-only query
surface over the database — not a second implementation of device/data logic. Reachable
from the LAN, not just the local PC (like the mobile client — see
`Mobile Requirements.txt`), protected by the access-control model in §5.3. Built in two
parts, both now shipped: **Part 1** (this section's query/data-access design, read-only)
and **Part 2** (§5.6 — button presses and recording control).

### 5.1 Data access

- **Live values**: "get latest X values" for a device, X from 1 (current value) up to the
  cyclic buffer's fixed size (§3.3) — not a literal continuous push into the model (see
  rationale below).
- **Device list**: name, driver, and **live connection status** (online/offline) per known
  device. Status is runtime state in the connection manager (§3.2), never persisted, so
  this is a dedicated tool call combining stored device metadata with a live status
  lookup — it cannot be answered by the SQL query capability below on its own, since that
  can only ever see what's actually in the database.
- **List/filter stored recordings, and fetch one recording's points**: `get_measurements`
  (device/name/date-range filters, plus sorting by name/start time/unit/device — sorting
  that doesn't exist in the REST API at all, added here as an MCP-only convenience) and
  `get_measurement_points` (every value for one recording, oldest first, with an optional
  cap on how many to return — omitted, returns all of them). These reuse
  `measurement_store.list()`/`get_points()` directly, the same methods the Data admin
  page's REST routes call — no new storage-layer logic. Exists alongside the `query` tool
  below, not instead of it: these two are the straightforward "find/read a recording"
  path; `query` is for questions that need actual SQL (joins, aggregates across
  recordings) that a plain list/fetch can't answer.
- **Ad-hoc read-only queries** (new): the MCP client can pass a SQL query, run against
  three purpose-built **views** — not the raw base tables:
  - `mcp_devices` — id, name, driver (no BT address; an agent has no need for it).
  - `mcp_measurements` — the stored-measurement metadata (device, name, unit, function,
    status, time range, min/max/avg/median, count).
  - `mcp_measurement_points` — the actual time-series values, joinable to
    `mcp_measurements` by `measurement_id`.
  - (Deliberately no lineage view — an agent can already discover a calculated
    measurement's sources by querying `mcp_measurements` itself if that's ever exposed
    there; not worth a fourth view for now.)
  - Example use case directly from the spec: "from measurement X, find the max value; are
    there any other measurements with a value higher than that within 10 seconds of their
    own start?" — answerable in one query against these views, without a bespoke tool for
    every possible question shape.
  - **Everything else in the database — `app_settings` above all, since it holds the
    mobile PIN in plaintext — is unreachable by query validation** (§5.2): the query
    layer only permits SQL that references these three views, not the base tables, so no
    query shape accepted by that check can see anything else.

### 5.2 Making ad-hoc queries safe

Originally planned as two independent layers (a validated query text, backed by a
database-engine-enforced read-only connection as a hard backstop). Building it surfaced a
real constraint: DuckDB refuses to open a second connection to the same database file, in
the same process, with a different access mode than one already open — and the app's
main connection is writable and open for its entire lifetime, so a genuinely separate,
engine-enforced read-only connection to the same file isn't available without moving the
query surface into its own process. That's more complexity than this feature currently
warrants, so the query connection is instead a second handle onto the *same* writable
connection (safe to use from a different thread), and query-text validation is the only
thing standing between an ad-hoc query and the real database — not a backstop behind an
engine-level guarantee:

1. **Query validation, rejecting the whole query on any violation** (no partial
   results): must be a single `SELECT` statement (no stacked/semicolon-separated
   statements), only referencing the three views above, and only calling a short
   allowlist of aggregate functions (`count`/`min`/`max`/`avg`/`sum`). Anything that
   fails this check returns an error, not a truncated or best-effort result. Since this
   is the only layer standing between a query and the real database, a gap here is a
   real gap — and a real one was found: a first-pass **regex-based** validator (matching
   table names via `\bfrom\s+(\w+)`) was defeated two independent ways during a security
   review (2026-08-31) — a double-quoted identifier (`FROM "app_settings"`) and an
   old-style comma-join (`FROM mcp_devices, app_settings`) both slip past a regex anchored
   only on the token immediately following `FROM`/`JOIN`, either of which handed back the
   real settings table (plaintext mobile PIN, MCP API key) in full. A third gap: a query
   with no `FROM`/`JOIN` at all had nothing for that regex to inspect, and DuckDB's own
   `current_setting()` through it leaked a real filesystem path. Fixed by replacing the
   regex with a real parser (`sqlglot`, parsed against the DuckDB dialect): every table
   reference and every function call in the parsed tree is walked and checked, which
   quoting/comma-joins/schema-qualification/CTEs can't fool the way text-pattern matching
   could, and a query touching zero tables (or calling anything outside the function
   allowlist) is rejected outright. See `security-test-plan.md` for the full test
   results.
2. **Executed off the main thread** (`asyncio.to_thread(...)` or equivalent), not just on
   a separate connection object. The app today runs everything synchronously on one event
   loop; without this, an expensive analytical query would still freeze that loop (and
   therefore live BLE ingestion and every other request) for its entire duration. DuckDB's
   Python bindings release the GIL during query execution, so a background-thread query
   genuinely runs alongside the rest of the app instead of blocking it. A query timeout
   and a hard row-limit are part of this layer too.
   - Even with this in place, running very large/complex ad-hoc queries during an
     actively-running recording is still not recommended practice — the manual (§5.4)
     should say so as guidance, distinct from what's technically enforced above.

### 5.3 Access control

- **Global settings** (§3.6): `mcp_enabled` (off by default), `mcp_queries_enabled` (a
  second, independent checkbox — the query surface can be switched off even while the
  rest of MCP is on), `mcp_api_key` (a plain string the user sets themselves, blank by
  default).
- **Network layer**: reuses the exact two-layer model already built for the mobile
  client — everything stays loopback-only by default; only the specific MCP endpoint
  paths are exempted for LAN callers, the same allowlist mechanism as `mobile_auth.py`,
  extended to cover them.
- **Credential layer**: the LAN-exempted MCP paths additionally require the configured
  `mcp_api_key` as a request header. A blank/unset key means MCP refuses every request
  outright, the same "blank = feature does nothing yet" convention as the mobile PIN.
  Deliberately **not** an IP allowlist as the primary gate — the LAN certificate work
  already demonstrated that IP addresses on this network aren't as stable as they look
  (DHCP), so an IP-keyed gate would fail the same way the certificate did the moment a
  lease changes. A key-based credential doesn't care what address the request came from.
- **Deleting anything is out of scope entirely** — not exposed by any MCP tool, Part 1 or
  Part 2, full stop.
- **No control-lock/banner between a human user and an active MCP session.** (An earlier
  draft of this document proposed one; explicitly dropped.) MCP must never be able to
  lock a user out of controlling their own meter. Both the UI and MCP can send control
  actions at any time; neither blocks the other, and whichever command reaches the meter
  last simply takes effect — the same as if two people pressed buttons on the same meter
  in quick succession. Read/live-data access was always unrestricted for both regardless.

### 5.4 Documentation

Every MCP tool needs to explain, for the agent reading it, what it does, its parameters,
and — where an order matters (e.g. the offline-recording workflow: initiate, poll status,
detect reconnect, confirm download completion, retrieve the resulting measurement by
name) — that sequence explicitly. The user manual gets its own MCP section covering the
same tools from the human side, plus concretely how to point a real MCP client (e.g.
Claude Desktop) at this server: the connection URL and where the API key goes in that
client's config, verified against the actual implementation once built (not written
speculatively ahead of it) — a global-settings link should jump straight to this section.

### 5.5 Why not a literal continuous stream (for live values)

MCP's primitives are tools (request/response) and resources (with update notifications,
surfaced at the host application's discretion — not a guaranteed continuous injection
into model context). A raw 2-3-reading/second firehose would also be a poor fit for how
LLMs are actually useful — better suited to being asked a question, or reacting to a
meaningful event, than watching every sample. Time-critical reactions (e.g. "stop
immediately at threshold") belong in the backend's own threshold engine (§3.8), not
routed through an LLM round-trip per sample.

### 5.6 Part 2 — button presses and recording control

Twelve tools, added to `backend/app/mcp/server.py` alongside Part 1's three
(`list_devices`, `get_latest_values`, `query`), each calling the exact same manager
methods the REST routes in `api/control.py`/`api/recordings.py` already call — no new
device/recording behavior, just a second way to reach the behavior that already exists:

- `press_button` — all ten of the meter's physical-button equivalents in one tool,
  including Bluetooth-off (an agent can legitimately be told to disconnect the meter when
  a session is finished; it only drops the agent's own BLE link, not any stored data).
- `start_adhoc_recording` / `pause_adhoc_recording` / `resume_adhoc_recording` /
  `stop_adhoc_recording` — the dashboard's own quick, no-configuration recording.
- `start_online_recording` / `pause_online_recording` / `resume_online_recording` /
  `stop_online_recording` — the Recording control widget's "Online (PC)" mode, same
  parameters (start/stop thresholds, sample count/duration/end-time stop conditions,
  interval, averaging, stop-on-low-battery).
- `start_offline_recording` / `stop_offline_recording` — the "Offline (device)" mode.
  Starting it still causes the meter to disconnect from the PC by itself, same as the UI
  equivalent; downloading the finished recording afterwards still needs a person to
  physically long-press REL/BLE on the meter — an agent can start this, not finish it.
- `recording_status` — one combined check across all three recording types for a device,
  so an agent can see what's already running before trying to start something new.

**Every recording tool's docstring spells out the full workflow, not just what that one
call does** — added after building Part 2 and finding, in practice, that a tool doing only
its one narrow job leaves the calling agent guessing what to do next. Concretely:
`start_online_recording`'s docstring says to poll `recording_status` for progress and
where the finished measurement's id turns up once it stops; `start_offline_recording`'s
spells out the exact state sequence (`recording` → `awaiting_reconnect` → `downloading` →
`completed`/`error`) including the plain fact that the reconnect step needs a person
physically at the meter and can't be done or hurried remotely; both point at
`get_measurements`/`get_measurement_points` (§5.1) as the last step, once a recording's
actually finished, to retrieve the data itself — none of the status/control tools return
recorded values, only metadata about what's happening.

**No new access-control switch.** Decided when Part 2 was planned: these tools are gated
by nothing beyond the existing `mcp_enabled` switch (§5.3), the same gate Part 1's
`list_devices`/`get_latest_values` already use — no separate "allow control actions" or
"allow recording control" toggle, even though the two were discussed as an option. The
existing `mcp_queries_enabled` switch is untouched and still gates only the `query` tool.

### 5.7 Considered and declined: a chart-image tool

Discussed: an MCP tool that would render one or more measurements into a chart picture
(PNG/JPG), similar to the Chart (multiple) widget's own "download as image" feature, so an
AI assistant could hand back an actual picture instead of just numbers. A full plan was
drafted (legend baked into the image, per-measurement relative time, up to 2 units/axes,
auto Y-axis offset, point markers on every sample, reusing the same per-unit chart colors
already configured in Settings) but deliberately not built, for two reasons given when
declining it:

1. **It would need its own, separate chart-drawing code.** Every chart today is drawn in
   the browser (JavaScript, ECharts) — nothing on the backend draws anything. A chart-image
   tool would mean a second, independent implementation of "how to draw a chart," written
   in Python against a different charting library, alongside the existing frontend one —
   two places that could quietly drift apart over time rather than one shared source of
   truth.
2. **The result would look different from the dashboard's own charts regardless.** Matching
   fonts, spacing, and rendering quirks exactly across two completely different charting
   libraries (one browser-based, one server-side) realistically isn't achievable, so the
   image handed to an AI assistant would never quite match what the dashboard itself shows
   — undermining the main reason to want a picture in the first place.

Revisit this if a real need for it comes up again, but it's not part of the MCP server
today.

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
