#!/usr/bin/env python3
"""Enumerate every GATT service/characteristic the meter actually advertises,
and read the value of every readable one.

So far, every script in this project only ever looks at the custom 0xFFF0
service's 4 characteristics (0xFFF1/3/4). A full enumeration turned up a
standard Device Information Service (0x180A) we'd never read, and two
undocumented custom characteristics -- 0xFFF2 and 0xFFF5 -- that neither
reference project's docs mention at all. This reads every 'read'-capable
characteristic and prints both its raw hex and a best-effort text decode, so
we can see what's actually in them instead of just listing UUIDs.

Usage:
    python diag_services.py [ADDRESS]
"""

from __future__ import annotations

import argparse
import asyncio

from bleak import BleakClient
from bleak.exc import BleakError

from owon_ble.device import find_device


def _try_decode_text(data: bytes) -> str | None:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text if text.isprintable() else None


async def main(address: str | None) -> None:
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device()
        address = device.address
        print(f"Found meter at {address}")

    async with BleakClient(address) as client:
        print(f"Connected to {address}.\n")
        for service in client.services:
            print(f"Service {service.uuid}  ({service.description or 'no description'})")
            for char in service.characteristics:
                props = ",".join(char.properties)
                print(f"  Characteristic {char.uuid}  handle=0x{char.handle:04x}  properties=[{props}]")

                if "read" in char.properties:
                    try:
                        data = await client.read_gatt_char(char.uuid)
                    except BleakError as e:
                        print(f"    -> read failed: {e}")
                    else:
                        text = _try_decode_text(bytes(data))
                        text_repr = f'  text="{text}"' if text else ""
                        print(f"    -> {len(data)} bytes: {bytes(data).hex()}{text_repr}")

                for desc in char.descriptors:
                    print(f"    Descriptor {desc.uuid}  handle=0x{desc.handle:04x}")
            print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", nargs="?", default=None, help="BLE address of the meter")
    args = parser.parse_args()
    asyncio.run(main(args.address))
