"""REST routes for the mobile client's PIN gate (Mobile Requirements.txt items
2, 2.1-2.2). The mobile page itself and its static assets are served by
static_site.py, not here -- this is just the PIN check."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import mobile_auth, state

router = APIRouter(prefix="/mobile", tags=["mobile"])


class VerifyPinRequest(BaseModel):
    pin: str


class VerifyPinResponseOut(BaseModel):
    token: str


@router.get("/enabled")
async def mobile_enabled() -> dict[str, bool]:
    """Unauthenticated -- reveals only whether a PIN is configured, nothing
    sensitive, so the mobile page can show "not enabled" instead of a PIN
    prompt it has no way to check (item 2.1)."""
    return {"enabled": bool(state.settings_store.get("mobile_pincode"))}


@router.post("/verify-pin", response_model=VerifyPinResponseOut)
async def verify_pin(request: Request, body: VerifyPinRequest) -> VerifyPinResponseOut:
    client_ip = request.client.host if request.client else "unknown"
    retry_after = mobile_auth.check_pin_lockout(client_ip)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"too many failed attempts; try again in {retry_after:.0f}s",
            headers={"Retry-After": str(int(retry_after) + 1)},
        )
    configured = state.settings_store.get("mobile_pincode")
    if not configured:
        raise HTTPException(status_code=404, detail="mobile access is not enabled")
    if body.pin != configured:
        mobile_auth.record_pin_failure(client_ip)
        raise HTTPException(status_code=401, detail="incorrect PIN")
    mobile_auth.record_pin_success(client_ip)
    return VerifyPinResponseOut(token=mobile_auth.issue_token())


@router.get("/display-settings", dependencies=[Depends(mobile_auth.require_mobile_token)])
async def display_settings() -> dict[str, Any]:
    """Deliberately NOT the full `/settings` payload -- that's PC-only (not in
    mobile_auth's LAN allowlist) precisely because it includes things a phone
    has no business reading, `mobile_pincode` itself first among them. This
    returns only what the mobile chart pane actually needs to match the
    PC dashboard's display settings (chart time axis, chart colors)."""
    settings = state.settings_store.get_all()
    return {"chart_time_mode": settings["chart_time_mode"], "chart_colors": settings["chart_colors"]}
