"""REST route: send a control (button-simulation) command to a connected device."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import mobile_auth, state
from ..models import ControlRequest
from ..owon_ble import protocol

router = APIRouter(prefix="/devices", tags=["control"])


@router.post("/{device_id}/control", dependencies=[Depends(mobile_auth.require_mobile_token)])
async def send_control(device_id: str, body: ControlRequest) -> dict[str, str]:
    try:
        control = protocol.Control[body.control.upper()]
    except KeyError:
        valid = ", ".join(c.name for c in protocol.Control)
        raise HTTPException(status_code=400, detail=f"unknown control {body.control!r}; valid: {valid}") from None

    try:
        await state.connection_manager.send_control(device_id, control)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None

    return {"sent": control.name}
