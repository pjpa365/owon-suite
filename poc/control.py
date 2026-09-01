#!/usr/bin/env python3
"""Send button-simulation commands to an OWON meter over BLE.

Usage:
    python control.py [ADDRESS]

Connects, then shows an interactive menu of button presses to send. Each
option corresponds to a write on CTRL_CHAR_UUID -- see owon_ble/protocol.py
for the exact opcodes.
"""

from __future__ import annotations

import argparse
import asyncio
import struct

from bleak import BleakClient

from owon_ble import protocol
from owon_ble.device import find_device

MENU: dict[str, tuple[str, protocol.Control]] = {
    "1": ("Select", protocol.Control.SELECT),
    "2": ("Range (short press: next manual range)", protocol.Control.RANGE),
    "3": ("Auto range (long press)", protocol.Control.AUTO_RANGE),
    "4": ("Hold", protocol.Control.HOLD),
    "5": ("Backlight (long press)", protocol.Control.LIGHT),
    "6": ("Rel / toggle BLE (long press = BLE off)", protocol.Control.REL_BLE),
    "7": ("Hz/Duty", protocol.Control.HZ_DUTY),
    "8": ("Min/Max", protocol.Control.MIN_MAX),
    "9": ("Normal (long press, exits min/max)", protocol.Control.NORMAL),
    "0": ("Bluetooth off (long press)", protocol.Control.BLUETOOTH_OFF),
}


async def send_control(client: BleakClient, opcode: protocol.Control) -> None:
    payload = struct.pack("<H", int(opcode))
    # This meter's custom characteristics declare the 'write' GATT property
    # but reject actual Write Requests with ATT error 0x0D regardless of
    # content (confirmed on CMD_CHAR_UUID via diag_write.py); only Write
    # Without Response is accepted by the firmware.
    await client.write_gatt_char(protocol.CTRL_CHAR_UUID, payload, response=False)
    print(f"Sent {opcode.name} (0x{int(opcode):04x})")


def print_menu() -> None:
    print("\nCommands:")
    for key, (label, _) in MENU.items():
        print(f"  {key}: {label}")
    print("  q: quit")


async def main(address: str | None) -> None:
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device()
        address = device.address
        print(f"Found meter at {address}")

    async with BleakClient(address) as client:
        print(f"Connected to {address}.")
        while True:
            print_menu()
            choice = input("> ").strip().lower()
            if choice == "q":
                break
            if choice in MENU:
                _, opcode = MENU[choice]
                await send_control(client, opcode)
            else:
                print("Unknown option.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", nargs="?", default=None, help="BLE address of the meter")
    args = parser.parse_args()
    asyncio.run(main(args.address))
