#!/usr/bin/env python3
"""Connect to an OWON meter and print every live measurement to the console.

Usage:
    python live.py [ADDRESS] [--timeout SECONDS]

If ADDRESS is omitted, scans for a nearby meter automatically.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime

from bleak import BleakClient

from owon_ble import protocol
from owon_ble.device import find_device


def handle_notification(_handle, data: bytearray) -> None:
    data = bytes(data)
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    if protocol.is_measurement_packet(data):
        m = protocol.decode_measurement(data)
        print(f"[{ts}] {m}   (raw={data.hex()})")
    else:
        print(f"[{ts}] non-measurement notification (raw={data.hex()}, len={len(data)})")


async def main(address: str | None, timeout: float) -> None:
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device(timeout=timeout)
        address = device.address
        print(f"Found meter at {address}")

    async with BleakClient(address) as client:
        print(f"Connected to {address}. Subscribing to notifications on {protocol.READ_CHAR_UUID}...")
        await client.start_notify(protocol.READ_CHAR_UUID, handle_notification)
        print("Listening for measurements. Press Ctrl+C to stop.\n")
        try:
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            await client.stop_notify(protocol.READ_CHAR_UUID)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", nargs="?", default=None, help="BLE address of the meter")
    parser.add_argument("--timeout", type=float, default=10.0, help="auto-scan timeout in seconds")
    args = parser.parse_args()
    asyncio.run(main(args.address, args.timeout))
