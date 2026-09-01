"""Shared network-reachability helper -- used by mobile_auth.py and
mcp_auth.py, both of which gate a narrow LAN-reachable surface behind "is
this caller the PC itself" plus their own separate credential. Split out
once a second feature (MCP, architecture.md SS5.3) needed the exact same
loopback check mobile_auth.py already had, rather than each feature keeping
its own copy.
"""

from __future__ import annotations

LOOPBACK_HOSTS = {"127.0.0.1", "::1"}


def is_loopback(host: str | None) -> bool:
    return host in LOOPBACK_HOSTS
