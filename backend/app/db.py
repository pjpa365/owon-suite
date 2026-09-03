"""DuckDB connection and schema (architecture.md SS2).

One process-wide connection, reused synchronously by the repository/store
modules below -- DuckDB is embedded and fast enough at this data volume (per
the specification, "the total amount of data is not very high") that
offloading calls to a thread pool isn't warranted; revisit only if profiling
ever says otherwise.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

from . import config

DEFAULT_DB_PATH = config.DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS known_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    driver TEXT NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS measurement_point_seq;

CREATE TABLE IF NOT EXISTS measurements (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    function TEXT NOT NULL,
    decimal_places INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    min_value DOUBLE,
    max_value DOUBLE,
    avg_value DOUBLE,
    median_value DOUBLE,
    count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS measurement_points (
    id BIGINT PRIMARY KEY DEFAULT nextval('measurement_point_seq'),
    measurement_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    value DOUBLE,
    display_value TEXT NOT NULL,
    status_flags TEXT NOT NULL DEFAULT ''
);

-- Provenance for calculated/derived measurements (architecture.md SS3.5):
-- one row per source, so a calculation with 1 source (Shunt-current) or 2
-- (Watt-hour) is represented uniformly, without dedicated columns per case.
CREATE TABLE IF NOT EXISTS measurement_lineage (
    measurement_id TEXT NOT NULL,
    source_measurement_id TEXT NOT NULL
);

-- Generic key-value store for live/UI settings (dark mode, per-unit chart
-- colors, naming template, and whatever else Phase 5+ adds) -- deliberately
-- schemaless (JSON-encoded values) so a new setting is "add a default and
-- read it somewhere", not a migration. Distinct from backend/config.env,
-- which holds settings that affect backend *behavior* and require a
-- restart -- this table is for settings the frontend applies live.
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# MCP server read-only query surface (architecture.md SS5.1) -- a query run
# through the MCP server's query tool is only ever permitted to reference
# these three views, never the base tables directly (app_settings above all,
# since it holds the mobile PIN in plaintext). CREATE OR REPLACE, not IF NOT
# EXISTS: these carry no data of their own, so it's always safe to redefine
# them to match whatever this file currently says. Created *after* the
# column migrations below run, not as part of _SCHEMA above -- mcp_devices
# references known_devices.hidden, which doesn't exist yet on a pre-existing
# database until _ensure_device_hidden_column has run.
_MCP_VIEWS = """
CREATE OR REPLACE VIEW mcp_devices AS
    SELECT id, name, driver FROM known_devices WHERE NOT hidden;

-- `kind` is exposed here as `recording_mode` -- the underlying column/Pydantic
-- field name is unchanged everywhere else (REST API, frontend, `measurements`
-- table) on purpose: "kind" reads as "kind of measurement" (temperature/
-- voltage/...), which is actually what `function` means, and that collision
-- caused a real wrong-query incident from an MCP-calling agent. Renaming only
-- the query-tool-facing view column removes the confusing name exactly where
-- an agent guesses at column meaning from names alone, without touching
-- anything else that already depends on the real column being called "kind".
CREATE OR REPLACE VIEW mcp_measurements AS
    SELECT id, device_id, device_name, kind AS recording_mode, name, unit,
           function, status, start_time, end_time, min_value, max_value,
           avg_value, median_value, count, created_at
    FROM measurements;

CREATE OR REPLACE VIEW mcp_measurement_points AS
    SELECT measurement_id, seq, timestamp, value, display_value, status_flags
    FROM measurement_points;
"""


def _ensure_device_color_column(conn: duckdb.DuckDBPyConnection) -> None:
    """Migration for the per-device identity color (theme-tokens.md SS4):
    `known_devices` predates this column, so `CREATE TABLE IF NOT EXISTS`
    above never adds it to an existing DB -- checked and added by hand
    instead. Existing rows default to 'coral' (the first curated swatch,
    see device_manager.DEVICE_COLOR_KEYS); re-pick via the device list UI
    if that's not the color you want for a pre-existing device."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info('known_devices')").fetchall()}
    if "color" not in columns:
        # DuckDB doesn't support adding a NOT NULL constraint via ALTER TABLE
        # ADD COLUMN ("Adding columns with constraints not yet supported") --
        # DEFAULT alone is fine and is all that's needed here, since every
        # write path (device_manager.add()/set_color()) always supplies a value.
        conn.execute("ALTER TABLE known_devices ADD COLUMN color TEXT DEFAULT 'coral'")


def _ensure_device_hidden_column(conn: duckdb.DuckDBPyConnection) -> None:
    """Migration for soft-delete (Changes_post_phase5_and_color_design.txt):
    "removing" a device only hides it so its measurements stay associated with
    the same id if it's ever re-added -- see device_manager.remove()/add()."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info('known_devices')").fetchall()}
    if "hidden" not in columns:
        conn.execute("ALTER TABLE known_devices ADD COLUMN hidden BOOLEAN DEFAULT false")


def connect(db_path: Path = DEFAULT_DB_PATH) -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect(str(db_path))
    conn.execute(_SCHEMA)
    _ensure_device_color_column(conn)
    _ensure_device_hidden_column(conn)
    conn.execute(_MCP_VIEWS)
    return conn


