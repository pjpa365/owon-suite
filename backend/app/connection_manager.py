"""Owns live device connections (architecture.md SS3.2).

Scanning/connect-state, reconnection handling, and per-device ad-hoc
recording (spec: "Only one ad-hoc measurement can run at [a] time" --
interpreted per-device, since the app already supports multiple simultaneous
meters). This is also designated as the single enforcement point for the
future UI/MCP control-lock (architecture.md SS5) -- Phase 1 has only one
actor (the REST API), so there is nothing to arbitrate yet, but any lock
added in Phase 6 must live in acquire_control()/release_control() below
rather than duplicated per caller.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from .buffer import BufferedReading, CyclicBufferStore
from .device_manager import DeviceManager
from .driver import MeterDriver, OwonB41TDriver
from .measurement_store import MeasurementStore
from .online_recording import OnlineRecordingConfig, OnlineRecordingSession
from .owon_ble import protocol

DRIVER_REGISTRY: dict[str, type[MeterDriver]] = {
    "owon_b41t": OwonB41TDriver,
}


class ConnectionStatus(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTED = "connected"


@dataclass
class _AdhocSession:
    """An in-progress ad-hoc recording, held entirely in memory until Stop.

    Mirrors the cyclic buffer's own "explicitly transient" reasoning
    (architecture.md SS3.3): nothing is written to the database until the
    user deliberately finalizes it, so live recording never pays a
    per-point DB round trip -- only measurement_store.create_finalized()'s
    single bulk write on stop_adhoc()/disconnect() does.
    """

    device_name: str
    function: str
    unit: str
    decimal_places: int
    start_time: datetime
    paused: bool = False
    points: list[BufferedReading] = field(default_factory=list)


class ConnectionManager:
    def __init__(
        self,
        device_manager: DeviceManager,
        buffer_store: CyclicBufferStore,
        measurement_store: MeasurementStore,
    ) -> None:
        self._device_manager = device_manager
        self._buffer_store = buffer_store
        self._measurement_store = measurement_store
        self._drivers: dict[str, MeterDriver] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._adhoc: dict[str, _AdhocSession] = {}
        self._online: dict[str, OnlineRecordingSession] = {}
        self._online_last_stop: dict[str, dict] = {}
        # device_ids with an active live-measurement notify subscription --
        # a connect() made on behalf of an offline-recording download
        # (start_stream=False) doesn't set this, so disconnect() knows not
        # to call stop_live_stream() on a characteristic nothing subscribed to.
        self._streaming: set[str] = set()

    def _lock_for(self, device_id: str) -> asyncio.Lock:
        return self._locks.setdefault(device_id, asyncio.Lock())

    def status(self, device_id: str) -> ConnectionStatus:
        driver = self._drivers.get(device_id)
        if driver is not None and driver.is_connected:
            return ConnectionStatus.CONNECTED
        return ConnectionStatus.DISCONNECTED

    async def connect(self, device_id: str, start_stream: bool = True) -> None:
        """start_stream=False connects the driver without subscribing to live
        measurements -- used by the offline-recording reconnect step, which
        needs the connection but wants the READ_CHAR_UUID notify channel free
        for its own download-format packets instead of live-measurement ones."""
        known = self._device_manager.get(device_id)
        driver_cls = DRIVER_REGISTRY[known.driver]

        async with self._lock_for(device_id):
            if self.status(device_id) == ConnectionStatus.CONNECTED:
                return
            driver = driver_cls()
            await driver.connect(known.address)

            if start_stream:
                def _on_measurement(measurement: protocol.Measurement) -> None:
                    reading = self._buffer_store.append(device_id, measurement)
                    self._broadcast(device_id, reading)
                    self._record_adhoc_point(device_id, reading)
                    self._record_online_point(device_id, reading)

                await driver.start_live_stream(_on_measurement)
                self._streaming.add(device_id)

            self._drivers[device_id] = driver

    def get_driver(self, device_id: str) -> MeterDriver:
        """Direct driver access for callers that need offline-recording-
        specific methods not part of the generic connect/control API."""
        driver = self._drivers.get(device_id)
        if driver is None:
            raise RuntimeError(f"device {device_id!r} is not connected")
        return driver

    async def disconnect(self, device_id: str) -> None:
        async with self._lock_for(device_id):
            driver = self._drivers.pop(device_id, None)
            if driver is None:
                return
            if device_id in self._streaming:
                await driver.stop_live_stream()
                self._streaming.discard(device_id)
            await driver.disconnect()
            self._buffer_store.clear(device_id)

            # Don't lose an in-progress ad-hoc or online recording if the
            # device drops out from under it -- finalize whatever was
            # captured so far.
            session = self._adhoc.pop(device_id, None)
            if session is not None:
                self._finalize_adhoc(device_id, session)

            online_session = self._online.pop(device_id, None)
            if online_session is not None:
                measurement_id, measurement_name = self._finalize_online(device_id, online_session, "disconnected")
                self._online_last_stop[device_id] = {
                    "measurement_id": measurement_id,
                    "measurement_name": measurement_name,
                    "stop_reason": "disconnected",
                }

    async def send_control(self, device_id: str, control: protocol.Control) -> None:
        driver = self._drivers.get(device_id)
        if driver is None or not driver.is_connected:
            raise RuntimeError(f"device {device_id!r} is not connected")
        await driver.send_control(control)

    def subscribe(self, device_id: str) -> asyncio.Queue:
        """Register a queue that receives every measurement for device_id (used by the WebSocket route)."""
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(device_id, set()).add(queue)
        return queue

    def unsubscribe(self, device_id: str, queue: asyncio.Queue) -> None:
        subscribers = self._subscribers.get(device_id)
        if subscribers:
            subscribers.discard(queue)

    def _broadcast(self, device_id: str, reading: BufferedReading) -> None:
        for queue in self._subscribers.get(device_id, ()):
            queue.put_nowait(reading)

    # --- ad-hoc recording (per device) ------------------------------------

    def _record_adhoc_point(self, device_id: str, reading: BufferedReading) -> None:
        session = self._adhoc.get(device_id)
        if session is None or session.paused:
            return
        session.points.append(reading)

    def adhoc_status(self, device_id: str) -> dict:
        session = self._adhoc.get(device_id)
        if session is None:
            return {"active": False, "paused": False, "measurement_id": None}
        return {"active": True, "paused": session.paused, "measurement_id": None}

    def start_adhoc(self, device_id: str) -> None:
        if device_id in self._adhoc:
            raise RuntimeError(f"an ad-hoc recording is already running for device {device_id!r}")

        latest = self._buffer_store.latest(device_id, count=1)
        if not latest:
            raise RuntimeError("no live data yet for this device -- wait for the first reading before recording")
        reading = latest[0]
        known = self._device_manager.get(device_id)

        self._adhoc[device_id] = _AdhocSession(
            device_name=known.name,
            function=reading.measurement.function,
            unit=reading.measurement.unit,
            decimal_places=reading.measurement.decimal_places,
            start_time=reading.timestamp,
        )

    def pause_adhoc(self, device_id: str) -> None:
        self._require_adhoc(device_id).paused = True

    def resume_adhoc(self, device_id: str) -> None:
        self._require_adhoc(device_id).paused = False

    def stop_adhoc(self, device_id: str) -> str:
        session = self._require_adhoc(device_id)
        del self._adhoc[device_id]
        return self._finalize_adhoc(device_id, session)

    def _finalize_adhoc(self, device_id: str, session: _AdhocSession) -> str:
        record = self._measurement_store.create_finalized(
            device_id=device_id,
            device_name=session.device_name,
            kind="adhoc",
            function=session.function,
            unit=session.unit,
            decimal_places=session.decimal_places,
            start_time=session.start_time,
            end_time=datetime.now(),
            readings=session.points,
        )
        return record.id

    def _require_adhoc(self, device_id: str) -> _AdhocSession:
        session = self._adhoc.get(device_id)
        if session is None:
            raise RuntimeError(f"no ad-hoc recording is running for device {device_id!r}")
        return session

    # --- online (threshold/interval) recording (per device) ---------------
    #
    # Independent of ad-hoc: both can run at once on the same device, each
    # writing its own measurement from the same live stream.

    def _record_online_point(self, device_id: str, reading: BufferedReading) -> None:
        session = self._online.get(device_id)
        if session is None:
            return
        stop_reason = session.ingest(reading)
        if stop_reason is not None:
            del self._online[device_id]
            measurement_id, measurement_name = self._finalize_online(device_id, session, stop_reason)
            self._online_last_stop[device_id] = {
                "measurement_id": measurement_id,
                "measurement_name": measurement_name,
                "stop_reason": stop_reason,
            }

    def online_status(self, device_id: str) -> dict:
        session = self._online.get(device_id)
        if session is not None:
            return {
                "active": True,
                "paused": session.paused,
                "waiting_for_start": session.waiting_for_start,
                "start_time": session.start_time,
                "samples_so_far": len(session.points),
                "estimated_end_time": session.estimated_end_time(),
                "stop_reason": None,
                "measurement_id": None,
                "measurement_name": None,
            }
        last = self._online_last_stop.get(device_id)
        return {
            "active": False,
            "paused": False,
            "waiting_for_start": False,
            "start_time": None,
            "samples_so_far": 0,
            "estimated_end_time": None,
            "stop_reason": last["stop_reason"] if last else None,
            "measurement_id": last["measurement_id"] if last else None,
            "measurement_name": last["measurement_name"] if last else None,
        }

    def start_online(self, device_id: str, config: OnlineRecordingConfig) -> None:
        if device_id in self._online:
            raise RuntimeError(f"an online recording is already running for device {device_id!r}")

        latest = self._buffer_store.latest(device_id, count=1)
        if not latest:
            raise RuntimeError("no live data yet for this device -- wait for the first reading before recording")
        reading = latest[0]
        known = self._device_manager.get(device_id)

        self._online[device_id] = OnlineRecordingSession(
            config=config,
            device_name=known.name,
            function=reading.measurement.function,
            unit=reading.measurement.unit,
            decimal_places=reading.measurement.decimal_places,
        )
        self._online_last_stop.pop(device_id, None)

    def pause_online(self, device_id: str) -> None:
        self._require_online(device_id).pause()

    def resume_online(self, device_id: str) -> None:
        self._require_online(device_id).resume()

    def stop_online(self, device_id: str) -> str:
        session = self._require_online(device_id)
        del self._online[device_id]
        measurement_id, measurement_name = self._finalize_online(device_id, session, "manual")
        self._online_last_stop[device_id] = {
            "measurement_id": measurement_id,
            "measurement_name": measurement_name,
            "stop_reason": "manual",
        }
        return measurement_id

    def _finalize_online(self, device_id: str, session: OnlineRecordingSession, stop_reason: str) -> tuple[str, str]:
        record = self._measurement_store.create_finalized(
            device_id=device_id,
            device_name=session.device_name,
            kind="online",
            function=session.function,
            unit=session.unit,
            decimal_places=session.decimal_places,
            start_time=session.start_time or datetime.now(),
            end_time=datetime.now(),
            readings=session.points,
        )
        return record.id, record.name

    def _require_online(self, device_id: str) -> OnlineRecordingSession:
        session = self._online.get(device_id)
        if session is None:
            raise RuntimeError(f"no online recording is running for device {device_id!r}")
        return session
