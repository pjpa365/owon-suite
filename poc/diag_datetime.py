#!/usr/bin/env python3
"""Test setting the meter's clock via *DATe, then verify it via a short recording.

There is no known command to directly query the meter's current stored
date/time -- date_command() has been implemented and unit-tested against the
expected byte layout, but never exercised against real hardware (see the
"Open items" section of docs/protocol-spec.md). The only way to observe
whether it actually took effect is indirectly, through the header of a
subsequently-started offline recording (docs/protocol-spec.md section 6.3).

This script:
  1. Connects once and sends *DATe (the PC's current local time), then
     immediately *RECOrd with a short interval/count so the recording
     finishes quickly and its header's start-time should be close to the
     time the clock was just set.
  2. Waits for the recording to finish, then prompts you to manually
     re-enable BLE on the meter (long-press REL/BLE) -- confirmed elsewhere
     that Bluetooth fully disables once a recording completes and does not
     come back on its own.
  3. Reconnects, downloads the recording, and compares its header's
     date/time fields against what was actually sent.

Usage:
    python diag_datetime.py [ADDRESS] [--interval 1] [--count 3]
"""

from __future__ import annotations

import argparse
import asyncio
import datetime

from bleak import BleakClient

from owon_ble import protocol
from owon_ble.device import find_device
from offline import download_recording

MATCH_TOLERANCE_SECONDS = 5


async def set_clock_and_start_recording(address: str, interval: int, count: int) -> datetime.datetime:
    sent_dt = datetime.datetime.now()
    date_cmd = protocol.date_command(sent_dt)
    record_cmd = protocol.record_command(interval, count)

    async with BleakClient(address) as client:
        print(f"Setting clock to {sent_dt.isoformat(timespec='seconds')} ...")
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, date_cmd, response=True)

        print(f"Starting a short recording: interval={interval}s, count={count}")
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, record_cmd, response=True)

    print("Both commands sent (connection closed on our end right after, as usual).")
    return sent_dt


def compare(sent_dt: datetime.datetime, header: protocol.OfflineHeader) -> None:
    print(
        f"\nHeader read back from meter: "
        f"{header.year:04d}-{header.month:02d}-{header.day:02d} "
        f"{header.hour:02d}:{header.minute:02d}:{header.second:02d}"
    )
    print(
        f"Clock was set to:            "
        f"{sent_dt.year:04d}-{sent_dt.month:02d}-{sent_dt.day:02d} "
        f"{sent_dt.hour:02d}:{sent_dt.minute:02d}:{sent_dt.second:02d}"
    )

    try:
        header_dt = datetime.datetime(
            header.year, header.month, header.day, header.hour, header.minute, header.second
        )
    except ValueError:
        print(
            "\nRESULT: could not build a valid datetime from the header fields "
            "(looks like the clock is still unset/zero) -- *DATe does not appear "
            "to have taken effect."
        )
        return

    delta = (header_dt - sent_dt).total_seconds()
    print(f"\nDifference: {delta:+.0f} seconds")
    if abs(delta) <= MATCH_TOLERANCE_SECONDS:
        print("RESULT: MATCH -- *DATe successfully set the meter's clock.")
    else:
        print("RESULT: MISMATCH -- clock does not appear to reflect what was sent.")


async def main(address: str | None, interval: int, count: int) -> None:
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device()
        address = device.address
        print(f"Found meter at {address}")

    sent_dt = await set_clock_and_start_recording(address, interval, count)

    wait_seconds = interval * count + 3
    print(
        f"\nWaiting ~{wait_seconds}s for the recording to finish (the meter's "
        "Bluetooth will be in a low-power state, then fully disable once done -- "
        "its icon will disappear)."
    )
    await asyncio.sleep(wait_seconds)

    input(
        "\nRecording should be complete now. Long-press REL/BLE on the meter until "
        "the Bluetooth icon reappears, then press Enter here to continue..."
    )

    out_path = "datetime_test.csv"
    print("\nDownloading the recording to check its header...")
    await download_recording(address, out_path)

    raw_path = out_path.rsplit(".", 1)[0] + "_raw.bin"
    with open(raw_path, "rb") as f:
        data = f.read()

    offset = protocol.find_offline_header_offset(data)
    if offset is None:
        print("\nCould not locate a valid header in the downloaded data -- cannot compare.")
        return

    header = protocol.decode_offline_header(data[offset:])
    compare(sent_dt, header)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("address", nargs="?", default=None, help="BLE address of the meter")
    parser.add_argument("--interval", type=int, default=1, help="seconds between samples (kept short for a quick test)")
    parser.add_argument("--count", type=int, default=3, help="number of samples (kept short for a quick test)")
    args = parser.parse_args()
    asyncio.run(main(args.address, args.interval, args.count))
