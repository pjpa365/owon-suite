"""REST routes: the Ah / Watt-hour / Shunt-current calculators and the
generic two-series alignment endpoint used by the scatter/XY chart widget
(architecture.md SS3.5)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import calculations, state
from ..measurement_store import MeasurementRecord
from ..models import (
    AhRequest,
    AhResponseOut,
    AlignRequest,
    AlignResponseOut,
    CalculatedPointOut,
    CalculationStatsOut,
    OhmsLawRequest,
    OhmsLawResponseOut,
    ShuntCurrentRequest,
    ShuntCurrentResponseOut,
    WattHourRequest,
    WattHourResponseOut,
)

router = APIRouter(prefix="/calculations", tags=["calculations"])


def _get_measurement(measurement_id: str) -> MeasurementRecord:
    try:
        return state.measurement_store.get(measurement_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


def _series_points(measurement_id: str) -> list[calculations.SeriesPoint]:
    points = state.measurement_store.get_points(measurement_id)
    return [calculations.SeriesPoint(timestamp=p.timestamp, value=p.value) for p in points if p.value is not None]


def _is_current_unit(unit: str) -> bool:
    return unit.endswith("A")


def _is_voltage_unit(unit: str) -> bool:
    return unit.endswith("V")


def _is_resistance_unit(unit: str) -> bool:
    return unit.endswith("Ohm")


_OHMS_LAW_OUTPUT_FUNCTION = {"V": "Calculated Voltage", "A": "Calculated Current", "Ohm": "Calculated Resistance"}


def _ohms_law_quantity(unit: str) -> str:
    if _is_voltage_unit(unit):
        return "V"
    if _is_current_unit(unit):
        return "I"
    if _is_resistance_unit(unit):
        return "R"
    raise ValueError(f"measurement unit {unit!r} is not a voltage, current, or resistance unit")


@router.post("/ah", response_model=AhResponseOut)
async def calculate_ah(body: AhRequest) -> AhResponseOut:
    measurement = _get_measurement(body.measurement_id)
    if not _is_current_unit(measurement.unit):
        raise HTTPException(status_code=400, detail=f"measurement unit {measurement.unit!r} is not a current unit")

    points = _series_points(body.measurement_id)
    try:
        result = calculations.ah(points)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return AhResponseOut(stats=CalculationStatsOut.from_domain(result.stats), ah_value=result.ah_value)


@router.post("/watt-hour", response_model=WattHourResponseOut)
async def calculate_watt_hour(body: WattHourRequest) -> WattHourResponseOut:
    current_measurement = _get_measurement(body.current_measurement_id) if body.current_measurement_id else None
    voltage_measurement = _get_measurement(body.voltage_measurement_id) if body.voltage_measurement_id else None

    if current_measurement and not _is_current_unit(current_measurement.unit):
        raise HTTPException(
            status_code=400, detail=f"current measurement unit {current_measurement.unit!r} is not a current unit"
        )
    if voltage_measurement and not _is_voltage_unit(voltage_measurement.unit):
        raise HTTPException(
            status_code=400, detail=f"voltage measurement unit {voltage_measurement.unit!r} is not a voltage unit"
        )

    current_points = _series_points(body.current_measurement_id) if current_measurement else None
    voltage_points = _series_points(body.voltage_measurement_id) if voltage_measurement else None

    try:
        result = calculations.watt_hour(
            current_points,
            voltage_points,
            default_current=body.default_current,
            default_voltage=body.default_voltage,
            tolerance=body.tolerance if body.tolerance is not None else calculations.DEFAULT_DURATION_TOLERANCE,
            sync_offset_seconds=body.sync_offset_seconds,
        )
    except (ValueError, calculations.AlignmentError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    created_measurement_id = None
    if body.create_dataset:
        sources = [m for m in (current_measurement, voltage_measurement) if m is not None]
        primary = sources[0]
        created = state.measurement_store.create_calculated(
            device_id=primary.device_id,
            device_name=primary.device_name,
            function="Calculated Power",
            unit="W",
            decimal_places=max(m.decimal_places for m in sources),
            points=result.power_points,
            source_measurement_ids=[m.id for m in sources],
        )
        created_measurement_id = created.id

    return WattHourResponseOut(
        stats=CalculationStatsOut.from_domain(result.stats),
        watt_hour_value=result.watt_hour_value,
        created_measurement_id=created_measurement_id,
    )


@router.post("/shunt-current", response_model=ShuntCurrentResponseOut)
async def calculate_shunt_current(body: ShuntCurrentRequest) -> ShuntCurrentResponseOut:
    voltage_measurement = _get_measurement(body.voltage_measurement_id)
    if not _is_voltage_unit(voltage_measurement.unit):
        raise HTTPException(
            status_code=400, detail=f"measurement unit {voltage_measurement.unit!r} is not a voltage unit"
        )
    voltage_points = _series_points(body.voltage_measurement_id)

    try:
        result = calculations.shunt_current(voltage_points, body.resistance_ohms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    created_measurement_id = None
    if body.store:
        created = state.measurement_store.create_calculated(
            device_id=voltage_measurement.device_id,
            device_name=voltage_measurement.device_name,
            function="Calculated Current",
            unit="A",
            decimal_places=voltage_measurement.decimal_places,
            points=result.current_points,
            source_measurement_ids=[voltage_measurement.id],
        )
        created_measurement_id = created.id

    return ShuntCurrentResponseOut(
        stats=CalculationStatsOut.from_domain(result.stats),
        points=[CalculatedPointOut.from_domain(p) for p in result.current_points],
        created_measurement_id=created_measurement_id,
    )


@router.post("/ohms-law", response_model=OhmsLawResponseOut)
async def calculate_ohms_law(body: OhmsLawRequest) -> OhmsLawResponseOut:
    measurement = _get_measurement(body.measurement_id)
    try:
        primary_quantity = _ohms_law_quantity(measurement.unit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if body.constant_quantity == primary_quantity:
        raise HTTPException(
            status_code=400, detail="constant_quantity must differ from the measurement's own quantity"
        )

    points = _series_points(body.measurement_id)
    try:
        result = calculations.ohms_law_transform(points, primary_quantity, body.constant_quantity, body.constant_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    created_measurement_id = None
    if body.create_dataset:
        created = state.measurement_store.create_calculated(
            device_id=measurement.device_id,
            device_name=measurement.device_name,
            function=_OHMS_LAW_OUTPUT_FUNCTION[result.output_unit],
            unit=result.output_unit,
            decimal_places=measurement.decimal_places,
            points=result.output_points,
            source_measurement_ids=[measurement.id],
        )
        created_measurement_id = created.id

    return OhmsLawResponseOut(
        stats=CalculationStatsOut.from_domain(result.stats),
        points=[CalculatedPointOut.from_domain(p) for p in result.output_points],
        output_unit=result.output_unit,
        created_measurement_id=created_measurement_id,
    )


@router.post("/align", response_model=AlignResponseOut)
async def align(body: AlignRequest) -> AlignResponseOut:
    _get_measurement(body.measurement_id_a)  # 404s if missing
    _get_measurement(body.measurement_id_b)
    series_a = _series_points(body.measurement_id_a)
    series_b = _series_points(body.measurement_id_b)

    try:
        aligned = calculations.align_series(
            series_a,
            series_b,
            tolerance=body.tolerance if body.tolerance is not None else calculations.DEFAULT_DURATION_TOLERANCE,
            sync_offset_seconds=body.sync_offset_seconds,
        )
    except calculations.AlignmentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    return AlignResponseOut(
        timestamps=aligned.timestamps,
        values_a=aligned.values_a,
        values_b=aligned.values_b,
        interpolated_a=aligned.interpolated_a,
        interpolated_b=aligned.interpolated_b,
    )
