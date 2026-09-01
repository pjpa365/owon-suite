#!/usr/bin/env python3
"""Dev entry point: starts the backend with auto-reload, using host/port from
backend/config.env.

Deliberately a separate script, not a `if __name__ == "__main__":` block
inside app/main.py: uvicorn's --reload worker on Windows re-imports the
*entry script's own module* in a fresh subprocess. If that entry script were
app/main.py itself, the parent process running it would already have
imported the whole app (and opened the DuckDB connection, via
app/state.py) before ever reaching the launcher code -- then the reload
worker imports it all again in its own process and collides with the
parent's still-open DuckDB handle. Keeping the launcher in a script that
does NOT import app.main at module level means only the reload worker ever
imports it, exactly once.
"""

from __future__ import annotations

if __name__ == "__main__":
    import uvicorn

    from app import config

    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, reload=True)
