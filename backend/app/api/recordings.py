"""REST routes: Save Buffer, per-device ad-hoc recording, and per-device
online (threshold/interval) recording -- each start/pause/resume/stop/status."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import mobile_auth, state
from ..models import (
    AdhocStatusOut,
    MeasurementSummaryOut,
    OfflineRecordingStartRequest,
    OfflineRecordingStatusOut,
    OnlineRecordingStartRequest,
    OnlineRecordingStatusOut,
)
from ..online_recording import OnlineRecordingConfig, ThresholdConfig

router = APIRouter(prefix="/devices/{device_id}/recordings", tags=["recordings"])


def _to_engine_config(body: OnlineRecordingStartRequest) -> OnlineRecordingConfig:
    def threshold(t) -> ThresholdConfig | None:
        return ThresholdConfig(comparator=t.comparator, value=t.value) if t else None

    return OnlineRecordingConfig(
        start_threshold=threshold(body.start_threshold),
        stop_mode=body.stop_mode,
        stop_threshold=threshold(body.stop_threshold),
        sample_count=body.sample_count,
        duration_seconds=body.duration_seconds,
        end_time=body.end_time,
        interval_seconds=body.interval_seconds,
        average_values=body.average_values,
        stop_on_low_battery=body.stop_on_low_battery,
    )


@router.post(
    "/save-buffer", response_model=MeasurementSummaryOut, dependencies=[Depends(mobile_auth.require_mobile_token)]
)
async def save_buffer(device_id: str) -> MeasurementSummaryOut:
    try:
        known = state.device_manager.get(device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None

    readings = state.buffer_store.all(device_id)
    if not readings:
        raise HTTPException(status_code=409, detail="the live buffer for this device is empty")

    record = state.measurement_store.save_buffer(device_id, known.name, readings)
    return MeasurementSummaryOut.from_domain(record)


@router.post(
    "/adhoc/start", response_model=AdhocStatusOut, dependencies=[Depends(mobile_auth.require_mobile_token)]
)
async def start_adhoc(device_id: str) -> AdhocStatusOut:
    try:
        state.device_manager.get(device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    try:
        state.connection_manager.start_adhoc(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@router.post(
    "/adhoc/pause", response_model=AdhocStatusOut, dependencies=[Depends(mobile_auth.require_mobile_token)]
)
async def pause_adhoc(device_id: str) -> AdhocStatusOut:
    try:
        state.connection_manager.pause_adhoc(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@router.post(
    "/adhoc/resume", response_model=AdhocStatusOut, dependencies=[Depends(mobile_auth.require_mobile_token)]
)
async def resume_adhoc(device_id: str) -> AdhocStatusOut:
    try:
        state.connection_manager.resume_adhoc(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@router.post(
    "/adhoc/stop", response_model=MeasurementSummaryOut, dependencies=[Depends(mobile_auth.require_mobile_token)]
)
async def stop_adhoc(device_id: str) -> MeasurementSummaryOut:
    try:
        measurement_id = state.connection_manager.stop_adhoc(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    record = state.measurement_store.get(measurement_id)
    return MeasurementSummaryOut.from_domain(record)


@router.get(
    "/adhoc/status", response_model=AdhocStatusOut, dependencies=[Depends(mobile_auth.require_mobile_token)]
)
async def adhoc_status(device_id: str) -> AdhocStatusOut:
    return AdhocStatusOut(**state.connection_manager.adhoc_status(device_id))


@router.post("/online/start", response_model=OnlineRecordingStatusOut)
async def start_online(device_id: str, body: OnlineRecordingStartRequest) -> OnlineRecordingStatusOut:
    try:
        state.device_manager.get(device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    try:
        config = _to_engine_config(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    try:
        state.connection_manager.start_online(device_id, config)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@router.post("/online/pause", response_model=OnlineRecordingStatusOut)
async def pause_online(device_id: str) -> OnlineRecordingStatusOut:
    try:
        state.connection_manager.pause_online(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@router.post("/online/resume", response_model=OnlineRecordingStatusOut)
async def resume_online(device_id: str) -> OnlineRecordingStatusOut:
    try:
        state.connection_manager.resume_online(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@router.post("/online/stop", response_model=MeasurementSummaryOut)
async def stop_online(device_id: str) -> MeasurementSummaryOut:
    try:
        measurement_id = state.connection_manager.stop_online(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    record = state.measurement_store.get(measurement_id)
    return MeasurementSummaryOut.from_domain(record)


@router.get("/online/status", response_model=OnlineRecordingStatusOut)
async def online_status(device_id: str) -> OnlineRecordingStatusOut:
    return OnlineRecordingStatusOut(**state.connection_manager.online_status(device_id))


@router.post("/offline/start", response_model=OfflineRecordingStatusOut)
async def start_offline(device_id: str, body: OfflineRecordingStartRequest) -> OfflineRecordingStatusOut:
    try:
        state.device_manager.get(device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    try:
        await state.offline_recording_manager.start(
            device_id,
            interval_seconds=body.interval_seconds,
            stop_mode=body.stop_mode,
            sample_count=body.sample_count,
            duration_seconds=body.duration_seconds,
            end_time=body.end_time,
            set_clock=body.set_clock,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return OfflineRecordingStatusOut(**state.offline_recording_manager.status(device_id))


@router.post("/offline/stop", response_model=OfflineRecordingStatusOut)
async def stop_offline(device_id: str) -> OfflineRecordingStatusOut:
    try:
        state.offline_recording_manager.stop(device_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return OfflineRecordingStatusOut(**state.offline_recording_manager.status(device_id))


@router.get("/offline/status", response_model=OfflineRecordingStatusOut)
async def offline_status(device_id: str) -> OfflineRecordingStatusOut:
    return OfflineRecordingStatusOut(**state.offline_recording_manager.status(device_id))
