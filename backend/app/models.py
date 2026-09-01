"""Pydantic request/response schemas for the REST API."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from . import calculations
from .buffer import BufferedReading
from .connection_manager import ConnectionStatus
from .device_manager import KnownDevice
from .measurement_store import MeasurementPointRecord, MeasurementRecord


class KnownDeviceOut(BaseModel):
    id: str
    name: str
    address: str
    driver: str
    color: str

    @classmethod
    def from_domain(cls, device: KnownDevice) -> "KnownDeviceOut":
        return cls(id=device.id, name=device.name, address=device.address, driver=device.driver, color=device.color)


class AddDeviceRequest(BaseModel):
    name: str
    address: str
    driver: str = "owon_b41t"
    color: str | None = None  # one of device_manager.DEVICE_COLOR_KEYS; auto-assigned if omitted


class RenameDeviceRequest(BaseModel):
    name: str
    color: str | None = None  # optional: also update the device's identity color in the same call


class DiscoveredDeviceOut(BaseModel):
    address: str
    name: str


class BluetoothStatusOut(BaseModel):
    # None means "unknown" -- the check couldn't run (non-Windows, the WinRT
    # Radios API isn't available, no Bluetooth radio was enumerable, or there's
    # no known device yet to bother checking for). Callers should treat None
    # as "don't show a warning", not as "disabled" (Changes ausgust-25.txt item 1).
    enabled: bool | None


class StatusResponse(BaseModel):
    device_id: str
    status: ConnectionStatus


class ControlRequest(BaseModel):
    control: str  # name of a protocol.Control member, e.g. "HOLD"


class MeasurementOut(BaseModel):
    timestamp: datetime
    function: str
    unit: str
    value: float | None  # None means overload / no valid reading (e.g. open circuit -- "OL")
    display_value: str
    status_flags: list[str]

    @classmethod
    def from_domain(cls, reading: BufferedReading) -> "MeasurementOut":
        m = reading.measurement
        return cls(
            timestamp=reading.timestamp,
            function=m.function,
            unit=m.unit,
            value=m.value,
            display_value=m.display_value,
            status_flags=m.status_flags,
        )


class MeasurementSummaryOut(BaseModel):
    id: str
    device_id: str
    device_name: str
    kind: str
    name: str
    unit: str
    function: str
    status: str
    start_time: datetime
    end_time: datetime | None
    min_value: float | None
    max_value: float | None
    avg_value: float | None
    median_value: float | None
    count: int
    source_measurement_ids: list[str]

    @classmethod
    def from_domain(cls, m: MeasurementRecord) -> "MeasurementSummaryOut":
        return cls(
            id=m.id,
            device_id=m.device_id,
            device_name=m.device_name,
            kind=m.kind,
            name=m.name,
            unit=m.unit,
            function=m.function,
            status=m.status,
            start_time=m.start_time,
            end_time=m.end_time,
            min_value=m.min_value,
            max_value=m.max_value,
            avg_value=m.avg_value,
            median_value=m.median_value,
            count=m.count,
            source_measurement_ids=m.source_measurement_ids,
        )


class MeasurementPointOut(BaseModel):
    id: int
    seq: int
    timestamp: datetime
    value: float | None
    display_value: str
    status_flags: list[str]

    @classmethod
    def from_domain(cls, p: MeasurementPointRecord) -> "MeasurementPointOut":
        return cls(
            id=p.id,
            seq=p.seq,
            timestamp=p.timestamp,
            value=p.value,
            display_value=p.display_value,
            status_flags=p.status_flags,
        )


class RenameMeasurementRequest(BaseModel):
    name: str


class DeletePointsRequest(BaseModel):
    point_ids: list[int]


class AdhocStatusOut(BaseModel):
    active: bool
    paused: bool
    measurement_id: str | None


class ThresholdIn(BaseModel):
    comparator: Literal[">", ">=", "<", "<="]
    value: float


class OnlineRecordingStartRequest(BaseModel):
    start_threshold: ThresholdIn | None = None
    stop_mode: Literal["threshold", "count", "duration", "end_time"]
    stop_threshold: ThresholdIn | None = None
    sample_count: int | None = None
    duration_seconds: float | None = None
    end_time: datetime | None = None
    interval_seconds: float = 0.0
    average_values: bool = True
    stop_on_low_battery: bool = True


class OnlineRecordingStatusOut(BaseModel):
    active: bool
    paused: bool
    waiting_for_start: bool
    start_time: datetime | None
    samples_so_far: int
    estimated_end_time: datetime | None
    stop_reason: str | None
    measurement_id: str | None
    measurement_name: str | None


class OfflineRecordingStartRequest(BaseModel):
    interval_seconds: int
    stop_mode: Literal["count", "duration", "end_time"]
    sample_count: int | None = None
    duration_seconds: float | None = None
    end_time: datetime | None = None
    set_clock: bool = True


class OfflineRecordingStatusOut(BaseModel):
    state: Literal["idle", "recording", "awaiting_reconnect", "downloading", "completed", "error"]
    start_time: datetime | None
    estimated_end_time: datetime | None
    interval_seconds: int | None
    count: int | None
    bytes_received: int
    expected_bytes: int | None
    error: str | None
    warning: str | None
    measurement_id: str | None
    measurement_name: str | None


# --- Calculation engine (architecture.md SS3.5) ----------------------------


class CalculationStatsOut(BaseModel):
    duration_seconds: float
    count: int
    min_value: float | None
    max_value: float | None
    avg_value: float | None
    median_value: float | None

    @classmethod
    def from_domain(cls, stats: calculations.Stats) -> "CalculationStatsOut":
        return cls(
            duration_seconds=stats.duration_seconds,
            count=stats.count,
            min_value=stats.min_value,
            max_value=stats.max_value,
            avg_value=stats.avg_value,
            median_value=stats.median_value,
        )


class CalculatedPointOut(BaseModel):
    timestamp: datetime
    value: float | None
    interpolated: bool

    @classmethod
    def from_domain(cls, p: calculations.CalculatedPoint) -> "CalculatedPointOut":
        return cls(timestamp=p.timestamp, value=p.value, interpolated=p.interpolated)


class AhRequest(BaseModel):
    measurement_id: str


class AhResponseOut(BaseModel):
    stats: CalculationStatsOut
    ah_value: float


class WattHourRequest(BaseModel):
    current_measurement_id: str | None = None
    voltage_measurement_id: str | None = None
    default_current: float | None = None
    default_voltage: float | None = None
    tolerance: float | None = None
    sync_offset_seconds: float = 0.0
    create_dataset: bool = False


class WattHourResponseOut(BaseModel):
    stats: CalculationStatsOut
    watt_hour_value: float
    created_measurement_id: str | None = None


class ShuntCurrentRequest(BaseModel):
    voltage_measurement_id: str
    resistance_ohms: float
    store: bool = False


class ShuntCurrentResponseOut(BaseModel):
    stats: CalculationStatsOut
    points: list[CalculatedPointOut]
    created_measurement_id: str | None = None


class OhmsLawRequest(BaseModel):
    measurement_id: str
    constant_quantity: Literal["V", "I", "R"]
    constant_value: float
    create_dataset: bool = False


class OhmsLawResponseOut(BaseModel):
    stats: CalculationStatsOut
    points: list[CalculatedPointOut]
    output_unit: str
    created_measurement_id: str | None = None


class AlignRequest(BaseModel):
    measurement_id_a: str
    measurement_id_b: str
    tolerance: float | None = None
    sync_offset_seconds: float = 0.0


class AlignResponseOut(BaseModel):
    timestamps: list[datetime]
    values_a: list[float]
    values_b: list[float]
    interpolated_a: list[bool]
    interpolated_b: list[bool]
