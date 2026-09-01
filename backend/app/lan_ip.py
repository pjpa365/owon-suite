"""Best-effort detection of this PC's LAN-facing IP address, for the mobile
client's QR code (Mobile Requirements.txt item 2.4). Portable (stdlib socket
only, no packets actually sent -- UDP "connect" just asks the OS to pick the
route/local address it would use) -- unlike discovery_loop.py's Windows-only
Bluetooth-radio check, there's no platform-specific API needed here, so this
works the same on Windows/Mac/Linux.
"""

from __future__ import annotations

import socket


def detect_lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(1.0)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None
