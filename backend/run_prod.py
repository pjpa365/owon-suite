#!/usr/bin/env python3
"""Production entry point: starts the backend with no auto-reload, over plain
HTTP, bound to host/port from backend/config.env. Run by the installed app's
Start Menu shortcut / start-app script and (optionally) the Windows Service --
see install.ps1.

Deliberately not HTTPS (unlike run_lan.py): this serves a purely local
install (config.env's HOST defaults to 127.0.0.1), so there's no Screen Wake
Lock / secure-context requirement to satisfy, and no self-signed-certificate
browser warning to explain to an installed-app user.

Safe to import app.main directly (no --reload here) -- the DuckDB double-
import hazard run.py's docstring describes is specifically a --reload
artifact and doesn't apply without it, same reasoning as run_lan.py.
"""

from __future__ import annotations

if __name__ == "__main__":
    import uvicorn

    from app import config

    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, reload=False)
