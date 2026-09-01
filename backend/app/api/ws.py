"""WebSocket route: continuous live-measurement push for one device."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import mobile_auth, state
from ..models import MeasurementOut

router = APIRouter(tags=["live"])


@router.websocket("/ws/{device_id}")
async def live_stream(websocket: WebSocket, device_id: str) -> None:
    # WebSocket connections don't pass through main.py's HTTP middleware at
    # all (Starlette only applies @app.middleware("http") to the http ASGI
    # scope), so the mobile client's loopback+token gate is re-implemented
    # here directly. Browsers can't set custom headers on a WS handshake, so
    # the token travels as a query param instead of mobile_auth's usual header.
    host = websocket.client.host if websocket.client else None
    if not mobile_auth.is_loopback(host):
        token = websocket.query_params.get("token")
        if not mobile_auth.verify_token(token):
            await websocket.close(code=1008)
            return

    await websocket.accept()
    queue = state.connection_manager.subscribe(device_id)
    try:
        while True:
            reading = await queue.get()
            out = MeasurementOut.from_domain(reading)
            await websocket.send_json(out.model_dump(mode="json"))
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        state.connection_manager.unsubscribe(device_id, queue)
