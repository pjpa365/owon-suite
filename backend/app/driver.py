"""Instrument-driver abstraction.

A common interface that the OWON B41T+'s BLE support implements today, so a
different meter brand or instrument type can implement the same interface
later without touching device_manager.py, connection_manager.py, or the API
layer (see architecture.md SS9, "think bigger").

There is exactly one concrete driver right now (OwonB41TDriver). It is a thin
wrapper around the already-validated owon_ble package -- no new protocol
logic lives here.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from bleak import BleakClient

from .owon_ble import protocol
from .owon_ble.device import find_devices

MeasurementCallback = Callable[[protocol.Measurement], None]


@dataclass
class DiscoveredDevice:
    address: str
    name: str


class MeterDriver(ABC):
    """Interface a device driver must implement to plug into the connection manager."""

    @abstractmethod
    async def connect(self, address: str) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @property
    @abstractmethod
    def is_connected(self) -> bool: ...

    @abstractmethod
    async def start_live_stream(self, callback: MeasurementCallback) -> None:
        """Begin pushing decoded measurements to callback as they arrive."""
        ...

    @abstractmethod
    async def stop_live_stream(self) -> None: ...

    @abstractmethod
    async def send_control(self, control: protocol.Control) -> None:
        """Simulate a physical button press."""
        ...

    @abstractmethod
    async def sync_clock(self) -> None:
        """Set the meter's internal clock to the PC's current time."""
        ...

    @abstractmethod
    async def start_offline_recording(self, interval_seconds: int, count: int) -> None:
        """Send the on-meter recording command. The meter disconnects on its
        own shortly after this succeeds -- callers must not assume the
        connection survives this call."""
        ...

    @abstractmethod
    async def download_offline_recording(self, on_progress: Callable[[int, int | None], None]) -> bytes:
        """Request and collect a completed offline recording's raw bytes.

        on_progress(bytes_received_so_far, expected_total_or_None) is called
        after every notification -- expected_total is None until the header
        (which carries byte_count) has arrived."""
        ...

    @staticmethod
    @abstractmethod
    async def discover(timeout: float = 10.0) -> list[DiscoveredDevice]:
        """Scan for nearby meters of this driver's type; return all found."""
        ...


class OwonB41TDriver(MeterDriver):
    """MeterDriver implementation for the OWON B41T+, wrapping owon_ble."""

    def __init__(self) -> None:
        self._client: BleakClient | None = None

    async def connect(self, address: str) -> None:
        client = BleakClient(address)
        await client.connect()
        self._client = client

    async def disconnect(self) -> None:
        if self._client is not None:
            await self._client.disconnect()
            self._client = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    async def start_live_stream(self, callback: MeasurementCallback) -> None:
        if self._client is None:
            raise RuntimeError("not connected")

        def _on_notify(_handle: int, data: bytearray) -> None:
            raw = bytes(data)
            if protocol.is_measurement_packet(raw):
                callback(protocol.decode_measurement(raw))

        await self._client.start_notify(protocol.READ_CHAR_UUID, _on_notify)

    async def stop_live_stream(self) -> None:
        if self._client is not None:
            await self._client.stop_notify(protocol.READ_CHAR_UUID)

    async def send_control(self, control: protocol.Control) -> None:
        if self._client is None:
            raise RuntimeError("not connected")
        await self._client.write_gatt_char(
            protocol.CTRL_CHAR_UUID, control.to_bytes(2, "little"), response=False
        )

    async def sync_clock(self) -> None:
        if self._client is None:
            raise RuntimeError("not connected")
        await self._client.write_gatt_char(protocol.CMD_CHAR_UUID, protocol.date_command(), response=True)

    async def start_offline_recording(self, interval_seconds: int, count: int) -> None:
        if self._client is None:
            raise RuntimeError("not connected")
        cmd = protocol.record_command(interval_seconds, count)
        await self._client.write_gatt_char(protocol.CMD_CHAR_UUID, cmd, response=True)

    # No new data for this long during a download is treated as a stall, not
    # a fixed overall deadline -- per docs/protocol-spec.md SS8, download
    # transfer speed for a large (up to 10,000-sample) recording is unknown,
    # so a single fixed timeout for the whole transfer would either be too
    # short for a big one or too tolerant of a genuinely stuck small one.
    _DOWNLOAD_IDLE_TIMEOUT = 15.0

    async def download_offline_recording(self, on_progress: Callable[[int, int | None], None]) -> bytes:
        if self._client is None:
            raise RuntimeError("not connected")

        chunks: list[bytes] = []
        header_offset: int | None = None
        expected_total: int | None = None
        activity = asyncio.Event()
        done = asyncio.Event()

        def handle_notification(_handle: int, data: bytearray) -> None:
            nonlocal header_offset, expected_total
            chunks.append(bytes(data))
            buf = b"".join(chunks)

            if header_offset is None:
                header_offset = protocol.find_offline_header_offset(buf)
            if (
                header_offset is not None
                and expected_total is None
                and len(buf) >= header_offset + protocol.OFFLINE_HEADER_LENGTH
            ):
                header = protocol.decode_offline_header(buf[header_offset:])
                expected_total = header_offset + protocol.OFFLINE_HEADER_LENGTH + header.byte_count

            on_progress(len(buf), expected_total)
            activity.set()
            if expected_total is not None and len(buf) >= expected_total:
                done.set()

        await self._client.start_notify(protocol.READ_CHAR_UUID, handle_notification)
        try:
            await self._client.write_gatt_char(protocol.CMD_CHAR_UUID, protocol.READLEN_CMD, response=True)
            await asyncio.sleep(1)
            await self._client.write_gatt_char(protocol.CMD_CHAR_UUID, protocol.READ_CMD, response=True)

            while not done.is_set():
                activity.clear()
                try:
                    await asyncio.wait_for(activity.wait(), timeout=self._DOWNLOAD_IDLE_TIMEOUT)
                except TimeoutError:
                    received = len(b"".join(chunks))
                    total = expected_total if expected_total is not None else "?"
                    raise TimeoutError(
                        f"offline download stalled -- no data received for "
                        f"{self._DOWNLOAD_IDLE_TIMEOUT:.0f}s ({received} of {total} bytes so far)"
                    ) from None
        finally:
            await self._client.stop_notify(protocol.READ_CHAR_UUID)

        return b"".join(chunks)

    @staticmethod
    async def discover(timeout: float = 10.0) -> list[DiscoveredDevice]:
        devices = await find_devices(timeout=timeout)
        return [
            DiscoveredDevice(address=d.address, name=(d.name or protocol.DEVICE_NAME).strip())
            for d in devices
        ]
