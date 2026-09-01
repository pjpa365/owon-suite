"""Offline (device-side) recording job state machine (architecture.md SS3.8).

Fundamentally different from ad-hoc/online recording: the meter disconnects
itself once a recording starts and logs internally with no live connection,
so this owns a background asyncio task per device that outlives the request
that started it -- sleep through the recording, retry reconnecting once it
should be done (the user has to physically long-press REL/BLE on the meter
first), then download and decode.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta

from .buffer import BufferedReading
from .connection_manager import ConnectionManager, ConnectionStatus
from .device_manager import DeviceManager
from .measurement_store import MeasurementStore
from .owon_ble import protocol

State = str  # "recording" | "awaiting_reconnect" | "downloading" | "completed" | "error"


@dataclass
class _OfflineJob:
    device_name: str
    interval_seconds: int
    count: int
    set_clock: bool
    state: State
    start_time: datetime
    estimated_end_time: datetime
    bytes_received: int = 0
    expected_bytes: int | None = None
    error: str | None = None
    warning: str | None = None
    measurement_id: str | None = None
    measurement_name: str | None = None
    task: asyncio.Task | None = None


class OfflineRecordingManager:
    _RETRY_INTERVAL = 3.0
    _MAX_COUNT = 10_000

    def __init__(
        self,
        device_manager: DeviceManager,
        connection_manager: ConnectionManager,
        measurement_store: MeasurementStore,
    ) -> None:
        self._device_manager = device_manager
        self._connection_manager = connection_manager
        self._measurement_store = measurement_store
        self._jobs: dict[str, _OfflineJob] = {}

    def status(self, device_id: str) -> dict:
        job = self._jobs.get(device_id)
        if job is None:
            return {
                "state": "idle",
                "start_time": None,
                "estimated_end_time": None,
                "interval_seconds": None,
                "count": None,
                "bytes_received": 0,
                "expected_bytes": None,
                "error": None,
                "warning": None,
                "measurement_id": None,
                "measurement_name": None,
            }
        return {
            "state": job.state,
            "start_time": job.start_time,
            "estimated_end_time": job.estimated_end_time,
            "interval_seconds": job.interval_seconds,
            "count": job.count,
            "bytes_received": job.bytes_received,
            "expected_bytes": job.expected_bytes,
            "error": job.error,
            "warning": job.warning,
            "measurement_id": job.measurement_id,
            "measurement_name": job.measurement_name,
        }

    # Distinguishes normal BLE-write/notify latency (a couple of seconds,
    # tops) or minor clock drift from a meter whose clock was never set --
    # which reports either an out-of-range date (year 0) or one wildly off
    # from when we actually sent the recording command.
    _CLOCK_TOLERANCE_SECONDS = 300.0

    def _resolve_header_start(self, header: protocol.OfflineHeader, job: _OfflineJob) -> tuple[datetime, str | None]:
        """Trust the meter's own recorded start time only if it looks sane;
        otherwise fall back to job.start_time (when we sent the *RECOrd
        command) and report why, per the spec's own acknowledgment that most
        meters' clocks are never set and can't be relied on."""
        try:
            header_start = datetime(header.year, header.month, header.day, header.hour, header.minute, header.second)
        except ValueError:
            return job.start_time, (
                f"the meter returned an invalid date/time for this recording "
                f"(year={header.year}, month={header.month}, day={header.day}) -- timestamps were "
                f"recalculated from when the recording was started instead"
            )

        delta = abs((header_start - job.start_time).total_seconds())
        if delta > self._CLOCK_TOLERANCE_SECONDS:
            return job.start_time, (
                f"the meter's recorded start time ({header_start.isoformat()}) differs from when this "
                f"recording was actually started by {delta:.0f}s -- timestamps were recalculated from the "
                f"configured start time instead"
            )
        return header_start, None

    def _resolve_count(
        self,
        interval_seconds: int,
        stop_mode: str,
        sample_count: int | None,
        duration_seconds: float | None,
        end_time: datetime | None,
    ) -> int:
        if interval_seconds < 1:
            raise ValueError("interval_seconds must be a positive integer")

        if stop_mode == "count":
            if not sample_count or sample_count < 1:
                raise ValueError("stop_mode 'count' requires a positive sample_count")
            count = sample_count
        elif stop_mode == "duration":
            if not duration_seconds or duration_seconds <= 0:
                raise ValueError("stop_mode 'duration' requires a positive duration_seconds")
            count = max(1, round(duration_seconds / interval_seconds))
        elif stop_mode == "end_time":
            if end_time is None:
                raise ValueError("stop_mode 'end_time' requires end_time")
            remaining = (end_time - datetime.now()).total_seconds()
            if remaining <= 0:
                raise ValueError("end_time must be in the future")
            count = max(1, round(remaining / interval_seconds))
        else:
            raise ValueError(f"unknown stop_mode {stop_mode!r}")

        return min(count, self._MAX_COUNT)

    async def start(
        self,
        device_id: str,
        interval_seconds: int,
        stop_mode: str,
        sample_count: int | None = None,
        duration_seconds: float | None = None,
        end_time: datetime | None = None,
        set_clock: bool = True,
    ) -> None:
        existing = self._jobs.get(device_id)
        if existing is not None and existing.state not in ("completed", "error"):
            raise RuntimeError(f"an offline recording is already running for device {device_id!r}")

        known = self._device_manager.get(device_id)
        count = self._resolve_count(interval_seconds, stop_mode, sample_count, duration_seconds, end_time)

        if self._connection_manager.status(device_id) != ConnectionStatus.CONNECTED:
            raise RuntimeError("device must be connected before starting an offline recording")

        driver = self._connection_manager.get_driver(device_id)
        if set_clock:
            await driver.sync_clock()
        await driver.start_offline_recording(interval_seconds, count)

        # The meter disconnects on its own within ~2s regardless (see
        # owon_ble/protocol.py's record_command() docstring) -- disconnect
        # our side now too. This also finalizes any ad-hoc/online recording
        # currently active on this device, same as any other disconnect.
        await self._connection_manager.disconnect(device_id)

        start_time = datetime.now()
        job = _OfflineJob(
            device_name=known.name,
            interval_seconds=interval_seconds,
            count=count,
            set_clock=set_clock,
            state="recording",
            start_time=start_time,
            estimated_end_time=start_time + timedelta(seconds=count * interval_seconds),
        )
        self._jobs[device_id] = job
        job.task = asyncio.create_task(self._run(device_id, job))

    def stop(self, device_id: str) -> None:
        job = self._jobs.get(device_id)
        if job is None:
            raise RuntimeError(f"no offline recording job for device {device_id!r}")
        if job.task is not None:
            job.task.cancel()
        del self._jobs[device_id]

    async def _run(self, device_id: str, job: _OfflineJob) -> None:
        try:
            remaining = (job.estimated_end_time - datetime.now()).total_seconds()
            if remaining > 0:
                await asyncio.sleep(remaining)

            job.state = "awaiting_reconnect"
            while True:
                try:
                    await self._connection_manager.connect(device_id, start_stream=False)
                    break
                except Exception:
                    # Expected to fail repeatedly until the user physically
                    # re-enables BLE on the meter (long-press REL/BLE) -- per
                    # spec this retries indefinitely until it succeeds or
                    # stop() cancels this task, there's no give-up threshold.
                    await asyncio.sleep(self._RETRY_INTERVAL)

            job.state = "downloading"
            driver = self._connection_manager.get_driver(device_id)

            def on_progress(received: int, expected: int | None) -> None:
                job.bytes_received = received
                job.expected_bytes = expected

            try:
                payload = await driver.download_offline_recording(on_progress)
            finally:
                await self._connection_manager.disconnect(device_id)

            offset = protocol.find_offline_header_offset(payload)
            if offset is None:
                raise ValueError("could not locate a valid record header in the downloaded data")
            record = protocol.decode_offline_packet(payload[offset:])

            header_start, job.warning = self._resolve_header_start(record.header, job)
            interval = record.header.interval_seconds or job.interval_seconds
            readings: list[BufferedReading] = []
            for i, r in enumerate(record.readings):
                m = protocol.Measurement(
                    raw=b"",
                    function=r.function,
                    scale_char=r.scale_char,
                    unit_multiplier=protocol.SCALE_MULTIPLIERS[protocol.SCALE_CHARS.index(r.scale_char)],
                    decimal_places=r.decimal_places,
                    value=r.value,
                    status_flags=["OL"] if r.value is None else [],
                )
                readings.append(
                    BufferedReading(timestamp=header_start + timedelta(seconds=i * interval), measurement=m)
                )

            first = readings[0].measurement if readings else None
            end_time = readings[-1].timestamp if readings else header_start
            result = self._measurement_store.create_finalized(
                device_id=device_id,
                device_name=job.device_name,
                kind="offline",
                function=first.function if first else "unknown",
                unit=first.unit if first else "",
                decimal_places=first.decimal_places if first else 0,
                start_time=header_start,
                end_time=end_time,
                readings=readings,
            )
            job.state = "completed"
            job.measurement_id = result.id
            job.measurement_name = result.name
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            job.state = "error"
            job.error = str(exc)
            if self._connection_manager.status(device_id) == ConnectionStatus.CONNECTED:
                try:
                    await self._connection_manager.disconnect(device_id)
                except Exception:
                    pass
