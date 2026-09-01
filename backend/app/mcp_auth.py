"""Access control for the MCP server (architecture.md SS5.3) -- the same
two-layer model as mobile_auth.py (network reachability, then a credential),
using an API key instead of a PIN-derived token: an MCP client isn't walked
through an interactive PIN screen the way a phone is, so the key is just a
plain string the user sets in Settings and pastes into their MCP client's
config, checked directly rather than exchanged for a session token.

Implemented as a small ASGI middleware, not a FastAPI route dependency: the
MCP server itself is a third-party ASGI app (mcp_server/server.py) mounted
as a sub-application, so there are no individual FastAPI route decorators of
ours to attach a Depends() to -- this wraps the whole mount instead. It also
folds in the mcp_enabled/mcp_queries_enabled toggles here (see settings_store
.py) rather than in the tool implementations, so a disabled feature refuses
every request before any MCP-specific logic ever runs.
"""

from __future__ import annotations

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from . import state
from .network import is_loopback

MOUNT_PATH_PREFIX = "/mcp"


def is_lan_allowed(path: str) -> bool:
    """Whether `path` is part of the MCP surface at all -- used by main.py's
    general loopback-restriction middleware, which runs before this one and
    otherwise has no reason to let a non-loopback request through at all."""
    return path == MOUNT_PATH_PREFIX or path.startswith(MOUNT_PATH_PREFIX + "/")


class McpAuthMiddleware:
    """Wraps the mounted MCP ASGI app: refuses everything if the feature is
    switched off, then requires either loopback or a matching X-MCP-Key
    header for any other caller."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        if not state.settings_store.get("mcp_enabled"):
            await JSONResponse({"detail": "MCP server is not enabled"}, status_code=404)(scope, receive, send)
            return

        client = scope.get("client")
        host = client[0] if client else None
        if not is_loopback(host):
            headers = dict(scope.get("headers") or [])
            provided = headers.get(b"x-mcp-key", b"").decode()
            configured = state.settings_store.get("mcp_api_key")
            if not configured or provided != configured:
                await JSONResponse({"detail": "missing or invalid MCP API key"}, status_code=401)(scope, receive, send)
                return

        await self.app(scope, receive, send)
