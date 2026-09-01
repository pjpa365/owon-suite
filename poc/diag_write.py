#!/usr/bin/env python3
"""Diagnose GATT write behavior on CMD_CHAR_UUID (0xFFF1).

Use this when a documented command (like *RECOrd) fails with a GATT protocol
error such as "Invalid Attribute Value Length" (0x0D). It prints the
characteristic's advertised properties/MTU, then tries a series of known-safe
commands and *RECOrd variants so we can see exactly what this unit's firmware
accepts, instead of guessing.

Phase 1 (DATe/READlen?/READ1?) is safe to repeat -- none of it changes meter
state. Phase 2 (*RECOrd variants) is NOT repeatable: per the manual, a
successful *RECOrd write makes the meter start recording and disconnect BLE
on its own. So phase 2 stops at the first sign of success (a clean write) or
disconnect (which itself is a strong signal that a write succeeded).

Usage:
    python diag_write.py [ADDRESS]
"""

from __future__ import annotations

import argparse
import asyncio

from bleak import BleakClient
from bleak.exc import BleakError

from owon_ble import protocol
from owon_ble.device import find_device


async def try_write(client: BleakClient, label: str, data: bytes, response: bool) -> None:
    try:
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, data, response=response)
        print(f"  OK    len={len(data):>3} response={response!s:<5} {label}: {data!r}")
    except BleakError as e:
        print(f"  FAIL  len={len(data):>3} response={response!s:<5} {label}: {data!r}\n        -> {e}")
    await asyncio.sleep(0.3)


async def main(address: str | None) -> None:
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device()
        address = device.address
        print(f"Found meter at {address}")

    async with BleakClient(address) as client:
        char = client.services.get_characteristic(protocol.CMD_CHAR_UUID)
        print(f"CMD characteristic handle=0x{char.handle:04x} properties={char.properties}")
        print(f"Negotiated MTU: {client.mtu_size} (max single write payload ~{client.mtu_size - 3} bytes)\n")

        print("Phase 1: safe, repeatable commands\n")
        safe_candidates: list[tuple[str, bytes]] = [
            ("DATe", protocol.DATE_CMD),
            ("READlen?", protocol.READLEN_CMD),
            ("READ1?", protocol.READ_CMD),
        ]
        for label, data in safe_candidates:
            for response in (True, False):
                await try_write(client, label, data, response)

        print(
            "\nPhase 2: *RECOrd variants. Each successful write may make the "
            "meter start recording and disconnect BLE on its own -- this "
            "script stops at the first success or disconnect.\n"
        )
        record_candidates: list[tuple[str, bytes]] = [
            ("RECOrd as-is (12B)", protocol.record_command(2, 10)),
            ("RECOrd short count (11B)", protocol.record_command(2, 5)),
            ("RECOrd zero-padded interval (13B)", b"*RECOrd,02,10"),
            ("RECOrd + CRLF (14B)", protocol.record_command(2, 10) + b"\r\n"),
            ("RECOrd + NUL (13B)", protocol.record_command(2, 10) + b"\x00"),
        ]
        for label, data in record_candidates:
            for response in (True, False):
                try:
                    await client.write_gatt_char(protocol.CMD_CHAR_UUID, data, response=response)
                    print(f"  OK    response={response!s:<5} {label}: {data!r}")
                    print(
                        "  -> If the meter's display now shows a recording "
                        "indicator, or the connection drops shortly after "
                        "this, this format was accepted. Stop here."
                    )
                except BleakError as e:
                    print(f"  FAIL  response={response!s:<5} {label}: {data!r}\n        -> {e}")
                except Exception as e:
                    print(
                        f"  Connection lost while trying {label} (response={response}): {e}\n"
                        "  This likely means that write WAS accepted and the meter "
                        "auto-disconnected to start recording -- check its display."
                    )
                    return
                await asyncio.sleep(0.3)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("address", nargs="?", default=None, help="BLE address of the meter")
    args = parser.parse_args()
    asyncio.run(main(args.address))
