"""Online (PC-side) threshold/interval recording engine (architecture.md SS3.8).

Distinct from ad-hoc recording (connection_manager._AdhocSession): this adds an
optional start-threshold gate, a choice of stop condition (threshold / sample
count / duration / end-time), interval-based sampling with optional averaging,
and a stop-on-low-battery option -- per the specification's "recording
control" UI element (online/PC recording).

Runs entirely off the live-measurement callback already wired into
connection_manager -- no separate polling task. The low-battery and
stop-threshold conditions are evaluated against every raw reading (not gated
by the sampling interval) so the reaction is immediate: time-critical
reactions belong in this threshold engine, not in a UI poll loop
(architecture.md SS5). Duration/end-time stop conditions are wall-clock but
are still only actually checked when a reading arrives -- if the meter stops
sending, the recording won't auto-stop until the next reading (or
disconnect). No background timer task exists to close that gap yet.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from .buffer import BufferedReading
from .owon_ble import protocol

Comparator = Literal[">", ">=", "<", "<="]
StopMode = Literal["threshold", "count", "duration", "end_time"]
StopReason = Literal["threshold", "count", "duration", "end_time", "low_battery", "manual", "disconnected"]


def _compare(value: float | None, comparator: Comparator, threshold: float) -> bool:
    # An OL/overload reading (value is None) can't cross a numeric threshold
    # in either direction -- treat it as "doesn't match" and wait for the next
    # valid reading, rather than crashing (protocol.py's decode_measurement()
    # can now produce None; this engine runs off every live reading).
    if value is None:
        return False
    if comparator == ">":
        return value > threshold
    if comparator == ">=":
        return value >= threshold
    if comparator == "<":
        return value < threshold
    if comparator == "<=":
        return value <= threshold
    raise ValueError(f"unknown comparator {comparator!r}")


@dataclass
class ThresholdConfig:
    comparator: Comparator
    value: float


@dataclass
class OnlineRecordingConfig:
    start_threshold: ThresholdConfig | None
    stop_mode: StopMode
    stop_threshold: ThresholdConfig | None
    sample_count: int | None
    duration_seconds: float | None
    end_time: datetime | None
    interval_seconds: float
    average_values: bool
    stop_on_low_battery: bool

    def __post_init__(self) -> None:
        if self.interval_seconds < 0:
            raise ValueError("interval_seconds must be >= 0")
        if self.stop_mode == "threshold" and self.stop_threshold is None:
            raise ValueError("stop_mode 'threshold' requires stop_threshold")
        if self.stop_mode == "count" and not self.sample_count:
            raise ValueError("stop_mode 'count' requires a positive sample_count")
        if self.stop_mode == "duration" and not self.duration_seconds:
            raise ValueError("stop_mode 'duration' requires a positive duration_seconds")
        if self.stop_mode == "end_time" and self.end_time is None:
            raise ValueError("stop_mode 'end_time' requires end_time")


class OnlineRecordingSession:
    """One in-progress online recording for a single device.

    Mirrors the ad-hoc session's in-memory-until-finalize model
    (architecture.md SS3.3): points accumulate here and are bulk-written via
    measurement_store.create_finalized() only once the session is finalized.
    """

    def __init__(
        self,
        config: OnlineRecordingConfig,
        device_name: str,
        function: str,
        unit: str,
        decimal_places: int,
    ) -> None:
        self.config = config
        self.device_name = device_name
        self.function = function
        self.unit = unit
        self.decimal_places = decimal_places
        self.paused = False
        self.waiting_for_start = config.start_threshold is not None
        # Derived entirely from reading timestamps, not wall-clock time at
        # construction -- both the immediate-start and threshold-gated-start
        # cases set this from the first reading actually ingested, so there's
        # a single, testable source of truth for "when did this recording
        # really start" (matters for duration/end-time stop conditions).
        self.start_time: datetime | None = None
        self.points: list[BufferedReading] = []
        self._bucket: list[BufferedReading] = []
        self._last_flush: datetime | None = None
        # True until the first reading of the current sampling window (either
        # the session's start, or right after a resume) sets _last_flush --
        # that reading establishes the window baseline but is never flushed
        # on its own (unless interval_seconds == 0), so a resume doesn't
        # produce a premature single-reading sample the way reusing
        # `_last_flush is None` as the signal once did.
        self._awaiting_window_start = True

    def estimated_end_time(self) -> datetime | None:
        """Best-effort end-time estimate for a countdown display. None when
        there's no reliable basis (threshold-based stop, or count-based stop
        with interval_seconds == 0 -- samples arrive as fast as the meter
        streams, so there's nothing to project from)."""
        if self.start_time is None:
            return None
        c = self.config
        if c.stop_mode == "end_time":
            return c.end_time
        if c.stop_mode == "duration":
            assert c.duration_seconds is not None
            return self.start_time + timedelta(seconds=c.duration_seconds)
        if c.stop_mode == "count" and c.interval_seconds > 0 and c.sample_count:
            remaining = max(c.sample_count - len(self.points), 0)
            return datetime.now() + timedelta(seconds=remaining * c.interval_seconds)
        return None

    def pause(self) -> None:
        self.paused = True
        self._bucket = []
        self._awaiting_window_start = True

    def resume(self) -> None:
        self.paused = False

    def ingest(self, reading: BufferedReading) -> StopReason | None:
        """Feed one live reading. Returns a stop reason once the session
        should be finalized by the caller, else None."""
        m = reading.measurement
        c = self.config

        if self.waiting_for_start:
            assert c.start_threshold is not None
            if _compare(m.value, c.start_threshold.comparator, c.start_threshold.value):
                self.waiting_for_start = False
                self.start_time = reading.timestamp
            else:
                return None
        elif self.start_time is None:
            self.start_time = reading.timestamp

        if self.paused:
            return None

        if c.stop_on_low_battery and "LOW_BATTERY" in m.status_flags:
            self._flush()
            self.points.append(reading)
            return "low_battery"

        if c.stop_mode == "threshold":
            assert c.stop_threshold is not None
            if _compare(m.value, c.stop_threshold.comparator, c.stop_threshold.value):
                self._flush()
                self.points.append(reading)
                return "threshold"

        if c.stop_mode == "duration":
            assert self.start_time is not None and c.duration_seconds is not None
            if (reading.timestamp - self.start_time).total_seconds() >= c.duration_seconds:
                self._flush()
                return "duration"

        if c.stop_mode == "end_time":
            assert c.end_time is not None
            if reading.timestamp >= c.end_time:
                self._flush()
                return "end_time"

        self._bucket.append(reading)
        if self._awaiting_window_start:
            self._last_flush = reading.timestamp
            self._awaiting_window_start = False
            due = c.interval_seconds <= 0
        else:
            due = c.interval_seconds <= 0 or (reading.timestamp - self._last_flush).total_seconds() >= c.interval_seconds
        if due:
            self._flush()
            self._last_flush = reading.timestamp
            if c.stop_mode == "count" and c.sample_count and len(self.points) >= c.sample_count:
                return "count"
        return None

    def _flush(self) -> None:
        """Collapse the pending bucket into a single stored point (average or
        last-value, per config) and clear it. No-op if the bucket is empty
        (e.g. an early stop fired before any reading was bucketed)."""
        if not self._bucket:
            return
        if self.config.average_values and self.config.interval_seconds >= 1:
            values = [r.measurement.value for r in self._bucket if r.measurement.value is not None]
            last = self._bucket[-1].measurement
            avg_value = statistics.fmean(values) if values else last.value
            merged_flags = sorted({f for r in self._bucket for f in r.measurement.status_flags})
            stored = protocol.Measurement(
                raw=last.raw,
                function=last.function,
                scale_char=last.scale_char,
                unit_multiplier=last.unit_multiplier,
                decimal_places=last.decimal_places,
                value=avg_value,
                status_flags=merged_flags,
            )
            self.points.append(BufferedReading(timestamp=self._bucket[-1].timestamp, measurement=stored))
        else:
            self.points.append(self._bucket[-1])
        self._bucket = []
