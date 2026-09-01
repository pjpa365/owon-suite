"""REST routes: measurement CRUD (list/filter, rename, delete, points, delete-points)."""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import state
from ..models import (
    DeletePointsRequest,
    MeasurementPointOut,
    MeasurementSummaryOut,
    RenameMeasurementRequest,
)

_INVALID_FILENAME_CHARS = re.compile(r'[\\/*?:"<>|]')


def _sanitize_filename(name: str) -> str:
    return _INVALID_FILENAME_CHARS.sub("_", name).strip() or "measurement"

router = APIRouter(prefix="/measurements", tags=["measurements"])


@router.get("", response_model=list[MeasurementSummaryOut])
async def list_measurements(
    device_id: str | None = None,
    name_contains: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> list[MeasurementSummaryOut]:
    records = state.measurement_store.list(
        device_id=device_id, name_contains=name_contains, date_from=date_from, date_to=date_to
    )
    return [MeasurementSummaryOut.from_domain(r) for r in records]


@router.get("/{measurement_id}", response_model=MeasurementSummaryOut)
async def get_measurement(measurement_id: str) -> MeasurementSummaryOut:
    try:
        record = state.measurement_store.get(measurement_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return MeasurementSummaryOut.from_domain(record)


@router.get("/{measurement_id}/points", response_model=list[MeasurementPointOut])
async def get_measurement_points(measurement_id: str) -> list[MeasurementPointOut]:
    try:
        state.measurement_store.get(measurement_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    points = state.measurement_store.get_points(measurement_id)
    return [MeasurementPointOut.from_domain(p) for p in points]


@router.get("/{measurement_id}/export.csv")
async def export_measurement_csv(measurement_id: str) -> StreamingResponse:
    try:
        measurement = state.measurement_store.get(measurement_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    points = state.measurement_store.get_points(measurement_id)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["timestamp", "value", "display_value", "unit", "status_flags"])
    for p in points:
        writer.writerow(
            [
                p.timestamp.isoformat(),
                "" if p.value is None else p.value,
                p.display_value,
                measurement.unit,
                ";".join(p.status_flags),
            ]
        )
    buffer.seek(0)

    filename = f"{_sanitize_filename(measurement.name)}.csv"
    return StreamingResponse(
        buffer,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.patch("/{measurement_id}", response_model=MeasurementSummaryOut)
async def rename_measurement(measurement_id: str, body: RenameMeasurementRequest) -> MeasurementSummaryOut:
    try:
        record = state.measurement_store.rename(measurement_id, body.name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return MeasurementSummaryOut.from_domain(record)


@router.delete("/{measurement_id}", status_code=204)
async def delete_measurement(measurement_id: str) -> None:
    try:
        state.measurement_store.delete(measurement_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


@router.post("/{measurement_id}/points:delete", response_model=MeasurementSummaryOut)
async def delete_measurement_points(measurement_id: str, body: DeletePointsRequest) -> MeasurementSummaryOut:
    try:
        record = state.measurement_store.delete_points(measurement_id, body.point_ids)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return MeasurementSummaryOut.from_domain(record)
