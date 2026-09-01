#!/usr/bin/env python3
"""LAN entry point: serves the app on the network (0.0.0.0) over HTTPS, using
the production frontend build (static_site.py) instead of Vite's dev server,
for the mobile client (Mobile Requirements.txt). Run via serve-lan.ps1, not
directly -- that script builds the frontend first.

HTTPS (not plain HTTP) specifically because some browser features the mobile
client wants -- the Screen Wake Lock API in particular -- only work in a
secure context, which plain HTTP can never satisfy regardless of browser/OS.
See tls.py for the self-signed-certificate approach and its trade-offs.

No --reload here (unlike run.py), so this can import the app directly: the
DuckDB-double-import hazard run.py's docstring describes is specifically a
--reload artifact (the reload worker re-imports the entry script in a fresh
subprocess) that doesn't apply without it.
"""

from __future__ import annotations

if __name__ == "__main__":
    import sys

    import uvicorn

    from app import config, lan_ip, tls

    ip = lan_ip.detect_lan_ip()
    if not ip:
        print("Couldn't determine this PC's LAN IP address -- can't issue a matching certificate.", file=sys.stderr)
        sys.exit(1)

    cert_path, key_path = tls.ensure_cert(ip)

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=config.PORT,
        reload=False,
        ssl_certfile=str(cert_path),
        ssl_keyfile=str(key_path),
    )
