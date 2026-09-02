"""REST routes: known-device registry, connect/disconnect, status, live buffer."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import discovery_loop, mobile_auth, state
from ..driver import OwonB41TDriver
from ..models import (
    AddDeviceRequest,
    BluetoothStatusOut,
    DiscoveredDeviceOut,
    KnownDeviceOut,
    MeasurementOut,
    RenameDeviceRequest,
    StatusResponse,
)

router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("/discover", response_model=list[DiscoveredDeviceOut])
async def discover(timeout: float = 10.0) -> list[DiscoveredDeviceOut]:
    """Scan for nearby meters and return their BLE addresses (doesn't register them)."""
    try:
        found = await OwonB41TDriver.discover(timeout=timeout)
    except Exception as exc:  # BLE adapter/scan failures surface as 502, not 500
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return [DiscoveredDeviceOut(address=d.address, name=d.name) for d in found]


@router.get("", response_model=list[KnownDeviceOut], dependencies=[Depends(mobile_auth.require_mobile_token)])
async def list_devices() -> list[KnownDeviceOut]:
    return [KnownDeviceOut.from_domain(d) for d in state.device_manager.list()]


@router.get("/unregistered", response_model=list[DiscoveredDeviceOut])
async def unregistered_devices() -> list[DiscoveredDeviceOut]:
    """Devices seen advertising as an OWON meter in the most recent background
    scan sweep (discovery_loop.py) that aren't yet in known_devices -- drives
    the Devices widget's "New Device Found" prompt. Unlike GET /devices/discover,
    this doesn't trigger a scan itself; it's a cheap read of the continuous
    background loop's last result, safe to poll frequently."""
    return [DiscoveredDeviceOut(address=d["address"], name=d["name"]) for d in discovery_loop.unregistered_devices()]


@router.get("/bluetooth-status", response_model=BluetoothStatusOut)
async def bluetooth_status() -> BluetoothStatusOut:
    """Cheap read of the background scan loop's last-checked PC Bluetooth-radio
    state (discovery_loop.py) -- not a fresh check itself, safe to poll
    frequently. `enabled` is None when the check couldn't run (non-Windows, no
    known device registered yet, or the platform check itself failed) --
    treat None as "unknown", not "disabled"."""
    return BluetoothStatusOut(enabled=discovery_loop.bluetooth_enabled())


@router.post("", response_model=KnownDeviceOut)
async def add_device(body: AddDeviceRequest) -> KnownDeviceOut:
    try:
        device = state.device_manager.add(name=body.name, address=body.address, driver=body.driver, color=body.color)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    discovery_loop.remove_from_unregistered(device.address)
    return KnownDeviceOut.from_domain(device)


@router.patch("/{device_id}", response_model=KnownDeviceOut)
async def rename_device(device_id: str, body: RenameDeviceRequest) -> KnownDeviceOut:
    try:
        device = state.device_manager.rename(device_id, body.name)
        if body.color is not None:
            device = state.device_manager.set_color(device_id, body.color)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return KnownDeviceOut.from_domain(device)


@router.delete("/{device_id}", status_code=204)
async def remove_device(device_id: str) -> None:
    try:
        state.device_manager.remove(device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


@router.post("/{device_id}/connect", response_model=StatusResponse)
async def connect_device(device_id: str) -> StatusResponse:
    try:
        await state.connection_manager.connect(device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except Exception as exc:  # BLE connect failures surface as 502, not 500
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return StatusResponse(device_id=device_id, status=state.connection_manager.status(device_id))


@router.post("/{device_id}/disconnect", response_model=StatusResponse)
async def disconnect_device(device_id: str) -> StatusResponse:
    await state.connection_manager.disconnect(device_id)
    return StatusResponse(device_id=device_id, status=state.connection_manager.status(device_id))


@router.get("/{device_id}/status", response_model=StatusResponse)
async def device_status(device_id: str) -> StatusResponse:
    return StatusResponse(device_id=device_id, status=state.connection_manager.status(device_id))


@router.get("/{device_id}/latest", response_model=list[MeasurementOut])
async def latest_readings(device_id: str, count: int = 1) -> list[MeasurementOut]:
    readings = state.buffer_store.latest(device_id, count=count)
    return [MeasurementOut.from_domain(r) for r in readings]
