"""Serves the built frontend in LAN mode (Mobile Requirements.txt item 1) --
a no-op in normal dev mode, where frontend/dist doesn't exist and the PC
dashboard is served by Vite's own dev server instead. Mounted once from
main.py so app.main:app is identical between run.py (dev) and run_lan.py
(LAN) -- only the uvicorn host binding differs between the two launchers.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

DIST_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


def mount(app: FastAPI) -> None:
    if not DIST_DIR.is_dir():
        return

    # Registered before the catch-all mount below, so these two exact paths
    # win for their own clean URLs -- Starlette matches routes in the order
    # they were added, and a Mount's path ("/") would otherwise match first.
    @app.get("/")
    async def dashboard_page() -> FileResponse:
        return FileResponse(DIST_DIR / "index.html")

    @app.get("/mobile")
    async def mobile_page() -> FileResponse:
        return FileResponse(DIST_DIR / "mobile.html")

    # Everything else the build produced: the hashed JS/CSS chunks under
    # assets/, and whatever frontend/public/ had (favicon, logo, icon sprite)
    # copied verbatim to the dist root and referenced by an absolute path in
    # the app's own markup (e.g. AppShell.tsx's <img src="/logo.svg">) -- one
    # mount covers both without needing to know that file list up front.
    app.mount("/", StaticFiles(directory=DIST_DIR), name="dist-root")
