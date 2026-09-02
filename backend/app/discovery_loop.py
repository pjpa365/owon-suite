"""Continuous background BLE scan for auto-connect and new-device detection
(Changes_post_phase5_and_color_design.txt, "Devices widget").

Distinct from the manual, one-shot scan behind the "Discover nearby meters"
button (api/devices.py's GET /devices/discover): this one runs for the whole
life of the process, independent of which dashboard tab (if any) is active,
since the requirement is auto-connect working "even when the devices list is
not on the active dashboard". Runs continuously back-to-back using the same
10s timeout as the existing manual scan (confirmed with Paul as an acceptable
BLE-adapter load, in preference to a fast, short-timeout poll).
"""

from __future__ import annotations

import asyncio
import logging

from . import state
from .connection_manager import ConnectionStatus
from .driver import OwonB41TDriver

logger = logging.getLogger(__name__)

SCAN_TIMEOUT = 10.0

# Devices seen in the most recent sweep that advertise as an OWON meter (by
# the same name/service-UUID match find_devices() uses) but aren't yet in
# known_devices -- read by GET /devices/unregistered for the "New Device
# Found" prompt. Module-level like buffer_store's in-memory state: there's
# exactly one scan loop for the process's lifetime.
_unregistered: list[dict[str, str]] = []

# Last-checked state of the PC's Bluetooth radio, read by GET
# /devices/bluetooth-status for the Devices widget (Changes ausgust-25.txt
# item 1). None means "unknown" -- see _check_bluetooth_enabled().
_bluetooth_enabled: bool | None = None


def unregistered_devices() -> list[dict[str, str]]:
    return list(_unregistered)


def remove_from_unregistered(address: str) -> None:
    """Called right after a device is added (api/devices.py's POST /devices)
    so the "New Device Found" prompt clears on the next poll instead of
    waiting for the next ~10s scan tick to recompute this list itself."""
    global _unregistered
    _unregistered = [d for d in _unregistered if d["address"] != address]


def bluetooth_enabled() -> bool | None:
    return _bluetooth_enabled


async def _check_bluetooth_enabled() -> bool | None:
    """Best-effort check of whether the PC's Bluetooth radio is powered on.

    Windows-specific (via the WinRT Radios API, already installed transitively
    through bleak's Windows backend -- no new dependency) -- deliberately not
    generalized to other platforms, since there's nothing to test that
    abstraction against yet (per CLAUDE.md's "think bigger" note: this is a
    single-platform implementation, not a cross-platform one). Per Paul: this
    must never raise or otherwise disrupt the scan loop -- any failure here
    (wrong platform, WinRT API unavailable, no Bluetooth radio present on this
    particular device) just falls back to "unknown" and the caller should hide
    the warning rather than show a false one.
    """
    try:
        import winrt.windows.devices.radios as radios
    except Exception:
        return None

    try:
        found = await radios.Radio.get_radios_async()
        for radio in found:
            if radio.kind == radios.RadioKind.BLUETOOTH:
                return radio.state == radios.RadioState.ON
        return None
    except Exception:
        logger.exception("Bluetooth radio state check failed")
        return None


async def _tick() -> None:
    global _unregistered, _bluetooth_enabled

    known = state.device_manager.list()
    if known:
        _bluetooth_enabled = await _check_bluetooth_enabled()

    try:
        found = await OwonB41TDriver.discover(timeout=SCAN_TIMEOUT)
    except Exception:
        logger.exception("background BLE scan failed")
        return

    known_addresses = {d.address for d in known}
    found_addresses = {d.address for d in found}

    _unregistered = [
        {"address": d.address, "name": d.name} for d in found if d.address not in known_addresses
    ]

    if not state.settings_store.get("auto_connect"):
        return

    for device in known:
        if device.address not in found_addresses:
            continue
        if state.connection_manager.status(device.id) == ConnectionStatus.CONNECTED:
            continue
        try:
            await state.connection_manager.connect(device.id)
        except Exception:
            logger.exception("auto-connect failed for device %s", device.id)


async def run_forever() -> None:
    while True:
        await _tick()
