"""Process-wide singletons shared by the API routers.

Kept in one module (rather than constructed inside main.py and threaded
through as FastAPI dependencies) since Phase 1 has exactly one process and no
test suite yet exercising these in isolation; revisit if/when that changes.
"""

from __future__ import annotations

from . import config, db as db_module
from .buffer import CyclicBufferStore
from .connection_manager import ConnectionManager
from .device_manager import DeviceManager
from .measurement_store import MeasurementStore
from .offline_recording import OfflineRecordingManager
from .settings_store import SettingsStore

_conn = db_module.connect()
# For the MCP query tool (architecture.md SS5.2): NOT a real independent
# read-only connection -- DuckDB refuses to open a second connection to the
# same file in the same process with a different access mode than one
# already open ("Can't open a connection to same database file with a
# different configuration than existing connections"), so a genuine
# engine-enforced read-only backstop isn't available here without moving the
# MCP server into its own process. .cursor() instead gives a second handle
# safe to use from a different thread (needed for mcp/query.py's
# asyncio.to_thread execution) sharing the same writable database -- so
# mcp/query.py's own validation (single SELECT, view whitelist, forbidden
# keywords) is the only line of defense, not a backstop behind an engine-level
# one. See mcp/query.py's module docstring for the corrected safety-layer list.
readonly_conn = _conn.cursor()

device_manager = DeviceManager(_conn)
settings_store = SettingsStore(_conn)
measurement_store = MeasurementStore(_conn, settings_store)
# One fixed, hardcoded app parameter (architecture.md SS3.3), read from the
# same config.env HOST/PORT already comes from, not a separate constant --
# see config.py's BUFFER_SIZE.
buffer_store = CyclicBufferStore(maxlen=config.BUFFER_SIZE)
connection_manager = ConnectionManager(device_manager, buffer_store, measurement_store)
offline_recording_manager = OfflineRecordingManager(device_manager, connection_manager, measurement_store)
