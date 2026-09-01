"""Shared BLE connection helpers for the OWON B41T+ PoC scripts."""

from __future__ import annotations

from bleak import BleakScanner
from bleak.backends.device import BLEDevice

from . import protocol


def _matches(device: BLEDevice, adv_data) -> bool:
    service_uuids = adv_data.service_uuids or []
    if protocol.SERVICE_UUID in [u.lower() for u in service_uuids]:
        return True
    name = (adv_data.local_name or device.name or "").strip()
    return name.upper() == protocol.DEVICE_NAME


async def find_devices(timeout: float = 10.0) -> list[BLEDevice]:
    """Scan for all nearby meters advertising the OWON FFF0 service or name.

    Returns an empty list if none are found -- most commonly because BLE
    isn't enabled on the meter yet (long-press REL/BLE until the Bluetooth
    icon appears on its display). Unlike a single-result scan, this keeps
    listening for the full timeout so multiple nearby meters can all show up
    for the user to pick from.
    """
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    return [device for device, adv_data in found.values() if _matches(device, adv_data)]
