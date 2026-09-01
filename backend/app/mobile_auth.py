"""Access control for the mobile client (Mobile Requirements.txt items 1-2).

Two independent layers, kept separate on purpose:

1. Network reachability -- everything is loopback-only by default; only a
   short, exactly-anchored allowlist of (method, path) pairs may be reached
   from a non-loopback address at all (enforced by main.py's middleware, plus
   a manual check in ws.py's handler -- websocket connections don't pass
   through HTTP middleware at all).
2. A PIN-derived token -- required in addition, on those allowlisted
   endpoints, whenever the caller isn't loopback (the PC's own dashboard
   never needs one). The token is HMAC(mobile_token_secret, mobile_pincode)
   -- not an issued/tracked value -- so verifying it is "recompute and
   compare" against the two inputs' *current* values in settings_store
   (persisted in the same DuckDB file as everything else), rather than a
   lookup into an in-memory set. Two consequences, both intentional:
   - A backend restart no longer signs every phone out (2026-09-01 bug
     report: it used to, because the old design tracked issued tokens in an
     in-memory `set()` that a restart wiped, even though the phone's own
     saved token in localStorage was still fine).
   - Changing the PIN still invalidates every outstanding token for free --
     the token depends on the PIN's current value, so an old token simply
     stops matching once the PIN changes, no explicit "clear tokens on PIN
     change" bookkeeping needed (api/settings.py used to call clear_tokens()
     for this; that call and this module's old _tokens set are both gone).
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time

from fastapi import Header, HTTPException, Request

from . import state
from .network import is_loopback


# Exactly what's reachable from a non-loopback address, beyond loopback.
# Anchored full-path patterns, not prefixes -- e.g. "/devices" has many
# sibling endpoints (discover, unregistered, bluetooth-status, connect/
# disconnect, status, latest, full add/rename/remove) that must stay
# loopback-only, so a bare "/devices" prefix would over-expose them.
_LAN_ALLOWED: list[tuple[str, re.Pattern[str]]] = [
    ("GET", re.compile(r"^/devices$")),
    ("POST", re.compile(r"^/devices/[^/]+/control$")),
    ("POST", re.compile(r"^/devices/[^/]+/recordings/adhoc/(start|pause|resume|stop)$")),
    ("GET", re.compile(r"^/devices/[^/]+/recordings/adhoc/status$")),
    ("POST", re.compile(r"^/devices/[^/]+/recordings/save-buffer$")),
    ("GET", re.compile(r"^/mobile$")),
    ("GET", re.compile(r"^/mobile/enabled$")),
    ("POST", re.compile(r"^/mobile/verify-pin$")),
    ("GET", re.compile(r"^/mobile/display-settings$")),
]
_LAN_ALLOWED_PREFIXES = ("/assets/",)
# Static files frontend/public/ contributes to the dist root (favicon, logo,
# icon sprite) -- referenced by an absolute path in the app's own markup, so
# the mobile page needs these reachable too (see static_site.py).
_LAN_ALLOWED_EXACT_PATHS = {"/favicon.ico", "/favicon.svg", "/logo.svg", "/icons.svg"}


def is_lan_allowed(method: str, path: str) -> bool:
    if path.startswith(_LAN_ALLOWED_PREFIXES) or path in _LAN_ALLOWED_EXACT_PATHS:
        return True
    return any(method == m and pattern.fullmatch(path) for m, pattern in _LAN_ALLOWED)


def _token_secret() -> str:
    secret = state.settings_store.get("mobile_token_secret")
    if not secret:
        secret = secrets.token_hex(32)
        state.settings_store.update({"mobile_token_secret": secret})
    return str(secret)


def issue_token() -> str:
    """Only meaningful right after verify_pin confirms body.pin == the
    configured PIN -- this just recomputes the same value verify_token()
    will independently derive later, it doesn't mint or store anything new."""
    pin = state.settings_store.get("mobile_pincode")
    return hmac.new(_token_secret().encode(), str(pin).encode(), hashlib.sha256).hexdigest()


def verify_token(token: str | None) -> bool:
    if not token:
        return False
    pin = state.settings_store.get("mobile_pincode")
    if not pin:
        return False
    return hmac.compare_digest(token, issue_token())


async def require_mobile_token(request: Request, x_mobile_token: str | None = Header(default=None)) -> None:
    """Route dependency for the handful of existing endpoints the mobile
    client reuses (see _LAN_ALLOWED above) -- a no-op for the PC's own
    loopback traffic, and a 401 for a LAN caller without a valid token."""
    host = request.client.host if request.client else None
    if is_loopback(host):
        return
    if not verify_token(x_mobile_token):
        raise HTTPException(status_code=401, detail="missing or invalid mobile token")


# --- PIN brute-force lockout (2026-08-31 security review, finding 6) -------
#
# /mobile/verify-pin previously had no limit at all on wrong guesses -- a
# 4-digit PIN is only 10,000 combinations, confirmed crackable in seconds
# with modest concurrency and no throttling whatsoever. Per-caller-IP,
# in-memory (same lifetime/scope as _tokens above -- resets on a backend
# restart, which only the PC's own operator can trigger, not an attacker).
# First 3 wrong attempts are free (a real person fat-fingering their own PIN
# shouldn't get locked out); every attempt after that doubles the lockout
# duration, capped so a single burst can't lock a caller out for absurdly
# long. A correct PIN clears the counter entirely.

_FREE_ATTEMPTS = 3
_BASE_LOCKOUT_SECONDS = 1.0
_MAX_LOCKOUT_SECONDS = 300.0

_pin_failures: dict[str, int] = {}
_pin_locked_until: dict[str, float] = {}


def check_pin_lockout(client_ip: str) -> float | None:
    """Returns remaining lockout seconds if this caller is currently locked
    out, else None."""
    locked_until = _pin_locked_until.get(client_ip)
    if locked_until is None:
        return None
    remaining = locked_until - time.monotonic()
    return remaining if remaining > 0 else None


def record_pin_failure(client_ip: str) -> None:
    count = _pin_failures.get(client_ip, 0) + 1
    _pin_failures[client_ip] = count
    if count > _FREE_ATTEMPTS:
        lockout = min(_MAX_LOCKOUT_SECONDS, _BASE_LOCKOUT_SECONDS * 2 ** (count - _FREE_ATTEMPTS - 1))
        _pin_locked_until[client_ip] = time.monotonic() + lockout


def record_pin_success(client_ip: str) -> None:
    _pin_failures.pop(client_ip, None)
    _pin_locked_until.pop(client_ip, None)
