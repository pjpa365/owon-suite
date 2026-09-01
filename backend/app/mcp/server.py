"""MCP server (architecture.md SS5). Part 1: read-only data access. Part 2:
button presses and recording control, added below it in this same file.

Mounted into the main FastAPI app at /mcp (main.py), wrapped by
mcp_auth.McpAuthMiddleware for every access-control concern (the
mcp_enabled/mcp_queries_enabled switches, network reachability, the API
key) -- nothing in this file handles auth itself, so these tool functions
can assume they're only ever reached when access is already allowed. Part 2's
tools are gated by nothing beyond the same mcp_enabled switch Part 1's
list_devices/get_latest_values already use -- there is deliberately no
separate "allow control actions" switch (decided when Part 2 was planned).

Tool docstrings are written for the calling agent, not just for a human
reading the code -- MCPServer surfaces them (plus the type hints) directly as
each tool's description, which is the actual mechanism satisfying
architecture.md SS5.4's "every tool must be properly explained" requirement.

Uses the `mcp` PyPI package's 2.x API (MCPServer, from
mcp.server.mcpserver) -- 1.x's FastMCP class (mcp.server.fastmcp) was renamed
and restructured in 2.0; this file targets whatever `mcp` version
backend/requirements.txt actually pins, currently 2.x.

Every Part 2 tool calls the exact same manager methods the REST routes in
api/control.py and api/recordings.py already call (state.connection_manager
for button presses and quick/online recordings, state.offline_recording_manager
for offline recordings) -- this file adds no new device/recording behavior,
only a second way to reach the behavior that already exists. There is no
control-lock between a person using the dashboard and the AI using this MCP
server, by design: whichever one acts first simply goes first, the same as
two browser tabs racing each other today -- see the Part 2 planning note in
architecture.md SS5.6 for why that's deliberate, not an oversight.

Every tool below returns an actual Pydantic model instance (or a list of
them), never a hand-dumped dict -- MCPServer derives each tool's published
output schema from the return type annotation, and needs a concrete,
schema-representable type to do that. A bare `dict[str, object]` looks
reasonable but silently defeats this: `object` has no JSON Schema
representation, schema generation fails, and MCPServer quietly falls back to
returning only the plain-text-encoded result with no structured JSON
alongside it -- correct per protocol, but not what "give me proper JSON"
wants. Returning real models (or, for `query`'s genuinely column-shape-varies
rows, `dict[str, Any]`) is what actually produces a `structuredContent` field
next to the always-present backwards-compatible text block.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, ValidationError

from .. import config, state
from ..api.recordings import _to_engine_config
from ..connection_manager import ConnectionStatus
from ..models import (
    AdhocStatusOut,
    MeasurementOut,
    MeasurementPointOut,
    MeasurementSummaryOut,
    OfflineRecordingStatusOut,
    OnlineRecordingStartRequest,
    OnlineRecordingStatusOut,
    ThresholdIn,
)
from ..owon_ble import protocol
from . import query as query_module

mcp_server = MCPServer("owon-meter")


@contextmanager
def _reraise_as_tool_error() -> Iterator[None]:
    """Every manager method below (connection_manager/offline_recording_manager)
    raises plain RuntimeError/ValueError for an anticipated failure -- "already
    running", "not connected", "no live data yet", the same errors the REST
    routes turn into a 409/400 response body. MCPServer only forwards a tool's
    message to the calling agent for its own `ToolError`; any other exception
    is deliberately scrubbed down to a generic "Error executing tool X" (to
    avoid leaking internals from a genuine crash), which would otherwise hide
    every one of these expected messages from the agent -- discovered via a
    real "already running" case that came back with no detail at all."""
    try:
        yield
    except (RuntimeError, ValueError) as exc:
        raise ToolError(str(exc)) from None


class DeviceStatusOut(BaseModel):
    """list_devices' combined stored-metadata + live-status shape -- no REST
    equivalent returns exactly this, since the REST API always fetches those
    two things separately (GET /devices vs. GET /devices/{id}/status)."""

    id: str
    name: str
    driver: str
    online: bool


class RecordingStatusOut(BaseModel):
    """recording_status' combined shape -- likewise MCP-only; the REST API
    exposes these three as separate per-mode status endpoints."""

    adhoc: AdhocStatusOut
    online: OnlineRecordingStatusOut
    offline: OfflineRecordingStatusOut


@mcp_server.tool()
def list_devices() -> list[DeviceStatusOut]:
    """List every known meter: its id (used by the other tools), name, and
    whether it's currently online (actively connected over Bluetooth) or
    offline. Device ids from here are what get_latest_values needs."""
    result = []
    for device in state.device_manager.list():
        status = state.connection_manager.status(device.id)
        result.append(
            DeviceStatusOut(
                id=device.id,
                name=device.name,
                driver=device.driver,
                online=status == ConnectionStatus.CONNECTED,
            )
        )
    return result


@mcp_server.tool()
def get_latest_values(device_id: str, count: int = 1) -> list[MeasurementOut]:
    """Get the most recent readings for one device, straight from its live
    buffer (not a stored recording) -- oldest of the returned readings first.
    `count` defaults to 1 (just the current value); the buffer only holds a
    fixed number of recent readings per device, so `count` above that limit
    is capped rather than rejected."""
    count = max(1, min(count, config.BUFFER_SIZE))
    readings = state.buffer_store.latest(device_id, count=count)
    return [MeasurementOut.from_domain(r) for r in readings]


@mcp_server.tool()
def get_measurements(
    device_id: str | None = None,
    name_contains: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    order_by: Literal["start_time", "name", "unit", "device_name"] = "start_time",
    order_dir: Literal["asc", "desc"] = "desc",
) -> list[MeasurementSummaryOut]:
    """List stored recordings (not live data) -- the same recordings visible
    on the Data admin page -- optionally filtered and sorted. Use this to
    find a measurement_id for get_measurement_points, or to check whether a
    just-finished online/offline recording has appeared yet (see
    start_online_recording/start_offline_recording's docstrings for the full
    workflow those go through before a measurement shows up here).

    Filters are all optional and combine with AND: device_id restricts to
    one device (an id from list_devices); name_contains is a case-insensitive
    partial match; date_from/date_to bound the recording's start time.

    order_by picks the sort field (default "start_time"; also "name", "unit",
    "device_name"); order_dir is "asc" or "desc" (default "desc" -- newest
    first for start_time, highest/last-alphabetically first otherwise).
    """
    records = state.measurement_store.list(
        device_id=device_id, name_contains=name_contains, date_from=date_from, date_to=date_to
    )
    summaries = [MeasurementSummaryOut.from_domain(r) for r in records]
    summaries.sort(key=lambda m: getattr(m, order_by), reverse=order_dir == "desc")
    return summaries


@mcp_server.tool()
def get_measurement_points(measurement_id: str, limit: int | None = None) -> list[MeasurementPointOut]:
    """Get the recorded values for one stored measurement, oldest first
    (always time-ordered). Find measurement_id via get_measurements, or from
    what stop_adhoc_recording/stop_online_recording returns, or from
    recording_status once an offline recording's state is "completed".

    limit (optional): return only the first `limit` points instead of all of
    them -- useful for a long recording where you don't need every point.
    Omitted, this returns everything, the same as the Data admin page shows.
    """
    try:
        state.measurement_store.get(measurement_id)
    except KeyError as exc:
        raise ToolError(str(exc)) from None
    points = state.measurement_store.get_points(measurement_id)
    if limit is not None:
        points = points[:limit]
    return [MeasurementPointOut.from_domain(p) for p in points]


@mcp_server.tool()
async def query(sql: str) -> list[dict[str, Any]]:
    """Run a read-only SQL SELECT query against stored (not live) data, for
    questions that span one or more recordings at once -- e.g. "what's the
    highest value in measurement X, and are there any other measurements
    with a higher value within 10 seconds of their own start?".

    Only a single SELECT statement is allowed, and only against these three
    views (never the underlying tables):
    - mcp_devices(id, name, driver)
    - mcp_measurements(id, device_id, device_name, kind, name, unit,
      function, status, start_time, end_time, min_value, max_value,
      avg_value, median_value, count, created_at) -- one row per stored
      recording.
    - mcp_measurement_points(measurement_id, seq, timestamp, value,
      display_value, status_flags) -- the actual recorded values, join to
      mcp_measurements on measurement_id.

    Any query that isn't a plain read against exactly these views is
    rejected outright with an error -- never partially run. Only a short
    allowlist of aggregate functions may be used (count, min, max, avg,
    sum) -- anything else, including scalar/introspection functions, is
    rejected too. Results are capped (a LIMIT is added automatically if the
    query doesn't have one) and the query is abandoned if it runs too long.
    This capability can be switched off independently of the rest of this
    MCP server, in Settings.
    """
    if not state.settings_store.get("mcp_queries_enabled"):
        raise ToolError("the MCP query capability is currently switched off in Settings")
    try:
        return await query_module.run_query(sql)
    except query_module.QueryRejected as exc:
        raise ToolError(str(exc)) from None


# --- Part 2: button presses and recording control (architecture.md SS5.6) --


@mcp_server.tool()
async def press_button(device_id: str, control: str) -> dict[str, str]:
    """Press one of the meter's 10 physical-equivalent buttons on a device,
    the same as pressing it on the meter itself: SELECT, RANGE, AUTO_RANGE,
    HOLD, LIGHT, REL_BLE (the REL/Delta button), BLUETOOTH_OFF, HZ_DUTY,
    MIN_MAX, NORMAL. `control` is case-insensitive. BLUETOOTH_OFF only drops
    the Bluetooth connection to the device -- it doesn't affect any stored or
    live data. Fails if the device isn't currently connected."""
    try:
        button = protocol.Control[control.upper()]
    except KeyError:
        valid = ", ".join(c.name for c in protocol.Control)
        raise ToolError(f"unknown control {control!r}; valid: {valid}") from None
    with _reraise_as_tool_error():
        await state.connection_manager.send_control(device_id, button)
    return {"sent": button.name}


@mcp_server.tool()
def start_adhoc_recording(device_id: str) -> AdhocStatusOut:
    """Start a quick, no-configuration recording for a device -- the same as
    the dashboard's own (Record) button. Fails if a recording of any kind is
    already running for this device, or if the device has no live data yet
    (wait for at least one reading first).

    Workflow: this only starts it -- it keeps running until you call
    stop_adhoc_recording (there's no automatic stop condition, unlike online
    recording). stop_adhoc_recording's own return value is already the
    finished measurement's summary; use get_measurement_points afterwards to
    read the actual recorded values."""
    try:
        state.device_manager.get(device_id)
    except KeyError as exc:
        raise ToolError(str(exc)) from None
    with _reraise_as_tool_error():
        state.connection_manager.start_adhoc(device_id)
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@mcp_server.tool()
def pause_adhoc_recording(device_id: str) -> AdhocStatusOut:
    """Pause an in-progress quick recording for a device. Fails if none is running."""
    with _reraise_as_tool_error():
        state.connection_manager.pause_adhoc(device_id)
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@mcp_server.tool()
def resume_adhoc_recording(device_id: str) -> AdhocStatusOut:
    """Resume a paused quick recording for a device. Fails if none is paused."""
    with _reraise_as_tool_error():
        state.connection_manager.resume_adhoc(device_id)
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@mcp_server.tool()
def stop_adhoc_recording(device_id: str) -> MeasurementSummaryOut:
    """Stop an in-progress quick recording for a device and finalize it as a
    stored data set, returning a summary of what was recorded (min/max/avg,
    sample count, time range). Fails if none is running."""
    with _reraise_as_tool_error():
        measurement_id = state.connection_manager.stop_adhoc(device_id)
    record = state.measurement_store.get(measurement_id)
    return MeasurementSummaryOut.from_domain(record)


@mcp_server.tool()
def start_online_recording(
    device_id: str,
    stop_mode: Literal["threshold", "count", "duration", "end_time"],
    start_threshold: ThresholdIn | None = None,
    stop_threshold: ThresholdIn | None = None,
    sample_count: int | None = None,
    duration_seconds: float | None = None,
    end_time: datetime | None = None,
    interval_seconds: float = 0.0,
    average_values: bool = True,
    stop_on_low_battery: bool = True,
) -> OnlineRecordingStatusOut:
    """Start a full online (PC-side) recording for a device -- the same
    options as the dashboard's Recording control widget, "Online (PC)" mode.

    stop_mode picks which stop condition applies, and which other argument it
    requires:
    - "threshold": stop_threshold must be set (e.g. {"comparator": ">",
      "value": 5.0} to stop once the reading exceeds 5.0).
    - "count": sample_count must be a positive number of readings.
    - "duration": duration_seconds must be a positive number of seconds.
    - "end_time": end_time must be set, and must not be in the past.

    start_threshold (optional): if set, recording doesn't actually begin
    until a reading crosses this threshold, rather than starting immediately.
    interval_seconds: minimum seconds between saved samples (0 saves every
    reading as it arrives). average_values: when sampling on an interval,
    save the average of the readings seen during that interval rather than
    just the last one. stop_on_low_battery: also stop automatically if the
    meter reports a low battery.

    Fails if a recording of any kind is already running for this device, or
    if the device has no live data yet.

    Workflow: after starting, call recording_status (its "online" field) to
    check progress -- active stays true while it's running, samples_so_far
    and estimated_end_time show how far along it is. It stops either when
    you call stop_online_recording, or on its own once the stop condition is
    met (or on low battery, if stop_on_low_battery). Either way, once it's
    no longer active, recording_status's online.measurement_id/
    measurement_name identify the finished measurement -- or use
    get_measurements if you weren't the one watching when it stopped. Then
    get_measurement_points reads the actual recorded values.
    """
    try:
        state.device_manager.get(device_id)
    except KeyError as exc:
        raise ToolError(str(exc)) from None
    try:
        body = OnlineRecordingStartRequest(
            start_threshold=start_threshold,
            stop_mode=stop_mode,
            stop_threshold=stop_threshold,
            sample_count=sample_count,
            duration_seconds=duration_seconds,
            end_time=end_time,
            interval_seconds=interval_seconds,
            average_values=average_values,
            stop_on_low_battery=stop_on_low_battery,
        )
    except ValidationError as exc:
        raise ToolError(str(exc)) from None
    with _reraise_as_tool_error():
        config_ = _to_engine_config(body)
        state.connection_manager.start_online(device_id, config_)
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@mcp_server.tool()
def pause_online_recording(device_id: str) -> OnlineRecordingStatusOut:
    """Pause an in-progress online recording for a device. Fails if none is running."""
    with _reraise_as_tool_error():
        state.connection_manager.pause_online(device_id)
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@mcp_server.tool()
def resume_online_recording(device_id: str) -> OnlineRecordingStatusOut:
    """Resume a paused online recording for a device. Fails if none is paused."""
    with _reraise_as_tool_error():
        state.connection_manager.resume_online(device_id)
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@mcp_server.tool()
def stop_online_recording(device_id: str) -> MeasurementSummaryOut:
    """Stop an in-progress online recording for a device and finalize it as a
    stored data set, returning a summary of what was recorded. Fails if none
    is running. Use get_measurement_points with the returned id to read the
    actual recorded values."""
    with _reraise_as_tool_error():
        measurement_id = state.connection_manager.stop_online(device_id)
    record = state.measurement_store.get(measurement_id)
    return MeasurementSummaryOut.from_domain(record)


@mcp_server.tool()
async def start_offline_recording(
    device_id: str,
    interval_seconds: int,
    stop_mode: Literal["count", "duration", "end_time"],
    sample_count: int | None = None,
    duration_seconds: float | None = None,
    end_time: datetime | None = None,
    set_clock: bool = True,
) -> OfflineRecordingStatusOut:
    """Start a device-side ("offline") recording for a device -- the same as
    the dashboard's Recording control widget, "Offline (device)" mode. Once
    started, the meter records autonomously and disconnects from the PC by
    itself; downloading the finished recording afterwards still needs a
    person to physically long-press REL/BLE on the meter to reconnect it --
    this tool can start an offline recording, but can't complete the
    download on its own.

    stop_mode is one of "count", "duration", "end_time" (no threshold option
    for offline recordings, since the meter isn't reporting live values back
    while recording):
    - "count": sample_count must be a positive number of readings.
    - "duration": duration_seconds must be a positive number of seconds.
    - "end_time": end_time must be set.
    set_clock: set the meter's own clock from this PC's current time before
    starting -- recommended when using "end_time", since the meter's own
    clock can otherwise drift from real time.

    Fails if a recording is already running for this device, or if the
    device isn't currently connected.

    Workflow -- this one needs a person's physical involvement partway
    through, which you can't do yourself, so track it by calling
    recording_status (its "offline" field, specifically its `state`) again
    whenever it's relevant, rather than assuming this call alone finished
    the job:
    1. Right after this call, state is "recording" -- the meter is
       recording on its own; the PC connection has already been dropped.
    2. Once the meter's own stop condition is reached, state becomes
       "awaiting_reconnect" -- someone needs to physically long-press
       REL/BLE on the meter itself to reconnect it. There is no way to
       trigger or speed this up remotely; if asked to check progress before
       that's happened, say so plainly rather than guessing when it will.
    3. Once reconnected, state moves through "downloading" automatically
       (no action needed) to "completed", at which point
       recording_status's offline.measurement_id/measurement_name identify
       the finished measurement -- or "error" if something went wrong
       (offline.error explains what).
    4. Once "completed", use get_measurement_points (or get_measurements
       first, if you don't already have the id) to read the actual
       recorded values.
    """
    try:
        state.device_manager.get(device_id)
    except KeyError as exc:
        raise ToolError(str(exc)) from None
    with _reraise_as_tool_error():
        await state.offline_recording_manager.start(
            device_id,
            interval_seconds=interval_seconds,
            stop_mode=stop_mode,
            sample_count=sample_count,
            duration_seconds=duration_seconds,
            end_time=end_time,
            set_clock=set_clock,
        )
    return OfflineRecordingStatusOut(**state.offline_recording_manager.status(device_id))


@mcp_server.tool()
def stop_offline_recording(device_id: str) -> OfflineRecordingStatusOut:
    """Stop an in-progress offline (device-side) recording job for a device.
    Only meaningful before it reaches "completed" (see
    start_offline_recording's docstring for the state sequence) -- once the
    meter has reconnected and finished downloading on its own, there's
    nothing left to stop. Fails if no job exists for this device at all."""
    with _reraise_as_tool_error():
        state.offline_recording_manager.stop(device_id)
    return OfflineRecordingStatusOut(**state.offline_recording_manager.status(device_id))


@mcp_server.tool()
def recording_status(device_id: str) -> RecordingStatusOut:
    """Check whether a recording is currently running for a device, across
    all three recording types at once -- quick ("adhoc"), online (PC-side),
    and offline (device-side) -- so you can see what's already happening
    before trying to start something new, rather than needing three separate
    checks. Normally at most one of these three is active for a device at a
    time; starting a second kind while one is already running fails. This
    only reports status, never values -- once a recording has finished
    (online: no longer active; offline: state "completed"), use
    get_measurements or get_measurement_points to retrieve the actual
    recorded data."""
    return RecordingStatusOut(
        adhoc=AdhocStatusOut(**state.connection_manager.adhoc_status(device_id)),
        online=OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id)),
        offline=OfflineRecordingStatusOut(**state.offline_recording_manager.status(device_id)),
    )
