"""FastAPI application entry point.

Run with:  python run.py   (from the backend/ directory, with
backend/.venv activated) -- host/port/reload come from backend/config.env,
not a hardcoded default. See run.py for why the launcher lives in a separate
script rather than a `if __name__ == "__main__":` block here.

Then open http://<HOST>:<PORT>/docs (config.env's default: 127.0.0.1:10765)
for the interactive Swagger UI.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import discovery_loop, mcp_auth, mobile_auth, static_site
from .api import calculations, control, devices, measurements, mobile, recordings, settings, ws
from .mcp.server import mcp_server


class _ForwardToPath:
    """Adapts an ASGI app that expects `scope["path"]` to already equal
    `target_path` for use as a plain Starlette Route endpoint registered at
    some other exact path.

    Needed because `Starlette.Mount("/mcp", app)` only ever matches
    "/mcp/..." -- something after the slash -- never the bare "/mcp" with
    nothing following it (a well-known Starlette routing gotcha, not
    something this app controls). Without this, a client hitting bare
    "/mcp" (exactly how MCP client configs conventionally write the URL,
    including this app's own manual) falls through every route below and
    lands in static_site's catch-all static-file mount, which flatly
    rejects any non-GET method with a misleading "Method Not Allowed" --
    that's the bug this class exists to close, discovered via a real
    Postman request. A plain function couldn't do this instead: Starlette
    detects those via `inspect.isfunction`/`ismethod` and wraps them as a
    Request-in-Response-out handler, which would break the raw
    ASGI (scope, receive, send) signature the mounted app needs -- a class
    instance skips that wrapping and is passed through as-is.
    """

    def __init__(self, app: ASGIApp, target_path: str) -> None:
        self._app = app
        self._target_path = target_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope = dict(scope)
        scope["path"] = self._target_path
        await self._app(scope, receive, send)


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Continuous background BLE scan for auto-connect/new-device detection
    # (discovery_loop.py) -- runs for the app's whole lifetime, not tied to
    # any request or websocket connection.
    task = asyncio.create_task(discovery_loop.run_forever())
    # The MCP server's streamable-HTTP transport needs its session manager
    # running for the whole app lifetime too, same idea as the scan loop.
    async with mcp_server.session_manager.run():
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="Suite for OWON Devices backend", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(devices.router)
app.include_router(control.router)
app.include_router(recordings.router)
app.include_router(measurements.router)
app.include_router(calculations.router)
app.include_router(settings.router)
app.include_router(ws.router)
app.include_router(mobile.router)


@app.middleware("http")
async def restrict_to_loopback(request: Request, call_next):
    """The PC dashboard and its full API/settings/calculations surface stay
    reachable only from this PC, forever, regardless of the mobile/MCP
    features' state -- only mobile_auth's and mcp_auth's short allowlists
    are exempted (Mobile Requirements.txt items 1.2-1.3; architecture.md
    SS5.3). Runs before routing, so this only sees the raw method+path, not
    the underlying route's own auth (mobile_auth.require_mobile_token /
    mcp_auth.McpAuthMiddleware handle the actual credential check, on top of
    this layer just deciding what's reachable from the network at all).
    Doesn't apply to WebSocket connections at all -- Starlette's HTTP
    middleware skips non-HTTP ASGI scopes -- so ws.py's handler carries its
    own equivalent guard directly.
    """
    host = request.client.host if request.client else None
    lan_allowed = mobile_auth.is_lan_allowed(request.method, request.url.path) or mcp_auth.is_lan_allowed(
        request.url.path
    )
    if not mobile_auth.is_loopback(host) and not lan_allowed:
        return JSONResponse({"detail": "not reachable from this network"}, status_code=403)
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# The MCP server itself (architecture.md SS5) -- wrapped in its own
# credential/feature-switch middleware, independent of and in addition to
# the loopback-restriction middleware above. Registered before static_site's
# catch-all mount, same reasoning as /health.
mcp_asgi_app = mcp_auth.McpAuthMiddleware(
    # streamable_http_app() defaults to mounting its own internal route at
    # "/mcp" -- since this outer app.mount() below already puts it under
    # "/mcp", streamable_http_path="/" makes the inner route match right at
    # that mount's root instead of doubling up into "/mcp/mcp".
    mcp_server.streamable_http_app(streamable_http_path="/")
)
# Handles the bare "/mcp" address (see _ForwardToPath's docstring); the
# Mount below handles "/mcp/" and anything under it. Both point at the same
# app instance, so either form behaves identically.
app.add_route(mcp_auth.MOUNT_PATH_PREFIX, _ForwardToPath(mcp_asgi_app, "/"), methods=["GET", "POST", "DELETE"])
app.mount(mcp_auth.MOUNT_PATH_PREFIX, mcp_asgi_app)

# Registered last, deliberately: static_site's catch-all static-file mount
# matches every path as a fallback, so anything that needs to win on its own
# path (this router's own routes above, /health, /mcp) must already be
# registered before this call -- Starlette matches routes in registration
# order.
static_site.mount(app)
