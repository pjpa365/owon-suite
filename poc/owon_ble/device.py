"""Shared BLE connection helpers for the OWON B41T+ PoC scripts."""

from __future__ import annotations

from bleak import BleakScanner
from bleak.backends.device import BLEDevice

from . import protocol


async def find_device(timeout: float = 10.0) -> BLEDevice:
    """Scan for a nearby meter advertising the OWON FFF0 service or name.

    Raises RuntimeError with a hint if nothing is found -- most commonly
    because BLE isn't enabled on the meter yet (long-press REL/BLE until the
    Bluetooth icon appears on its display).
    """

    def _matches(device: BLEDevice, adv_data) -> bool:
        service_uuids = adv_data.service_uuids or []
        if protocol.SERVICE_UUID in [u.lower() for u in service_uuids]:
            return True
        name = (adv_data.local_name or device.name or "").strip()
        return name.upper() == protocol.DEVICE_NAME

    device = await BleakScanner.find_device_by_filter(_matches, timeout=timeout)
    if device is None:
        raise RuntimeError(
            "No OWON meter found. Make sure it is powered on and BLE is "
            "enabled (long-press REL/BLE until the Bluetooth icon appears "
            "on the meter's display), then try again."
        )
    return device
