"""REST routes for the live/UI settings store (architecture.md SS3.6).

Deliberately untyped (plain dict in/out, not a fixed Pydantic model) --
settings_store.py is schemaless by design, and a fixed response model here
would defeat that: every new setting would need this router touched too.
"""

from __future__ import annotations

import io
from typing import Any

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, HTTPException, Response

from .. import config, lan_ip, naming, state, tls

router = APIRouter(prefix="/settings", tags=["settings"])


def _validate_pincode(pin: object) -> None:
    """None/empty disables the mobile client; otherwise must be exactly 4
    digits (Mobile Requirements.txt item 2.1)."""
    if pin in (None, ""):
        return
    if not (isinstance(pin, str) and pin.isdigit() and len(pin) == 4):
        raise ValueError("mobile PIN must be exactly 4 digits, or blank to disable mobile access")


def _validate_naming_template(template: str) -> None:
    """A naming template is now user-editable, so an unknown token or bad
    format-string syntax must be rejected here -- at the settings boundary --
    rather than surfacing as a 500 the next time a recording is finalized.
    Validated with every token present (nothing "missing"), which also
    exercises the [...]-optional-section handling, not just plain str.format."""
    dummy = dict.fromkeys(naming.TOKENS, "")
    try:
        naming.render(template, dummy)
    except (KeyError, ValueError, IndexError) as exc:
        raise ValueError(f"invalid naming template ({exc})") from exc


@router.get("")
async def get_settings() -> dict[str, Any]:
    return state.settings_store.get_all()


@router.patch("")
async def update_settings(body: dict[str, Any]) -> dict[str, Any]:
    if "naming_template" in body:
        try:
            _validate_naming_template(body["naming_template"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
    if "mobile_pincode" in body:
        try:
            _validate_pincode(body["mobile_pincode"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        # Changing or clearing the PIN signs every phone back out immediately
        # (Mobile Requirements.txt item 2.2) for free -- mobile_auth's token
        # is HMAC-derived from the PIN's current value, so an old token
        # simply stops matching once this update() call below changes it;
        # no explicit invalidation step needed here.
    return state.settings_store.update(body)


@router.get("/mobile-qr")
async def mobile_qr() -> Response:
    """PC-only (not in mobile_auth's LAN allowlist) -- an SVG QR code encoding
    this PC's mobile URL, for the Settings page (item 2.4)."""
    ip = lan_ip.detect_lan_ip()
    if not ip:
        raise HTTPException(status_code=503, detail="couldn't determine this PC's LAN address")
    scheme = "https" if tls.current_cert_exists() else "http"
    url = f"{scheme}://{ip}:{config.PORT}/mobile"
    image = qrcode.make(url, image_factory=qrcode.image.svg.SvgImage)
    buffer = io.BytesIO()
    image.save(buffer)

    # qrcode's SVG factories draw only the dark modules, with no background
    # of their own -- left as-is, the "light" areas are transparent and show
    # through to whatever's behind the <img> (broken specifically in dark
    # mode: the whole code reads as dark-on-dark). Inject an explicit white
    # background rect so it looks the same regardless of theme or where it's
    # embedded, rather than relying on the embedding page to paint one.
    svg_text = buffer.getvalue().decode("utf-8")
    insert_at = svg_text.index(">", svg_text.index("<svg")) + 1
    svg_text = f'{svg_text[:insert_at]}<rect width="100%" height="100%" fill="white"/>{svg_text[insert_at:]}'
    return Response(content=svg_text, media_type="image/svg+xml")
