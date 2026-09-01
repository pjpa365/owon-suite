"""In-memory per-device cyclic buffer (architecture.md SS3.3).

Not DuckDB-backed -- this is a transient, high-frequency overwrite-in-place
structure, deliberately separate from persisted measurements (Phase 3).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime

from .owon_ble import protocol

DEFAULT_MAXLEN = 1000


@dataclass
class BufferedReading:
    timestamp: datetime
    measurement: protocol.Measurement


class CyclicBufferStore:
    """Holds one ring buffer per device id."""

    def __init__(self, maxlen: int = DEFAULT_MAXLEN) -> None:
        self._maxlen = maxlen
        self._buffers: dict[str, deque[BufferedReading]] = {}

    def append(self, device_id: str, measurement: protocol.Measurement) -> BufferedReading:
        buffer = self._buffers.setdefault(device_id, deque(maxlen=self._maxlen))
        reading = BufferedReading(timestamp=datetime.now(), measurement=measurement)
        buffer.append(reading)
        return reading

    def latest(self, device_id: str, count: int = 1) -> list[BufferedReading]:
        buffer = self._buffers.get(device_id)
        if not buffer:
            return []
        return list(buffer)[-count:]

    def all(self, device_id: str) -> list[BufferedReading]:
        """Every reading currently held for device_id, oldest first (used by Save Buffer)."""
        buffer = self._buffers.get(device_id)
        return list(buffer) if buffer else []

    def clear(self, device_id: str) -> None:
        self._buffers.pop(device_id, None)
