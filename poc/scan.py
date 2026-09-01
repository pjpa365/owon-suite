#!/usr/bin/env python3
"""Discover nearby BLE devices and highlight any OWON meter found.

Usage:
    python scan.py [--timeout SECONDS]
"""

from __future__ import annotations

import argparse
import asyncio

from bleak import BleakScanner

from owon_ble import protocol


async def main(timeout: float) -> None:
    print(f"Scanning for BLE devices for {timeout:.0f}s...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)

    if not found:
        print("No BLE devices found.")
        return

    print(f"\nFound {len(found)} device(s):\n")
    for address, (device, adv) in found.items():
        service_uuids = adv.service_uuids or []
        is_owon = protocol.SERVICE_UUID in [u.lower() for u in service_uuids]
        marker = "  <-- looks like an OWON meter (FFF0 service)" if is_owon else ""
        name = device.name or "(unknown name)"
        print(f"  {address}  rssi={adv.rssi:>5}  {name}{marker}")

    print(
        "\nIf your meter isn't listed, long-press REL/BLE on the meter until "
        "the Bluetooth icon appears on its display, then re-run this script."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=8.0, help="scan duration in seconds")
    args = parser.parse_args()
    asyncio.run(main(args.timeout))
