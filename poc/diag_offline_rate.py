#!/usr/bin/env python3
"""Test whether offline recording interval can be set below 1 second (i.e. 0),
and what the meter actually does with it.

The *RECOrd command's interval field is a whole-number uint32 (seconds) --
there is no way to request a genuine fractional interval like 0.5s through
the known protocol format, so "smaller than 1" only means testing interval=0.
The spec (OWON meter specifications.txt) claims interval=0 means "max
recordings (2-3 per second)" -- this has not been validated against hardware.

Because the meter's Bluetooth fully disables during a recording and does not
come back on its own (confirmed elsewhere in this project), software cannot
directly measure how long the recording actually took. This script instead:

  1. Sets the clock via *DATe (so the downloaded header's start-time means
     something).
  2. Starts a recording with interval=0 and a modest count.
  3. Prints the exact moment the command was sent, and asks you to
     (optionally) note when the meter's Bluetooth icon disappears -- the
     confirmed signal that the recording has completed.
  4. Waits for you to manually re-enable BLE (long-press REL/BLE) and
     confirm, then downloads and decodes the recording.
  5. Reports what the header's interval_seconds field actually came back as
     (does the firmware echo 0, or silently substitute something else?), the
     decoded readings, and -- only if you provide a rough elapsed time --
     a computed samples/second figure to compare against the spec's claim.

Usage:
    python diag_offline_rate.py [ADDRESS] [--count 10]
"""

from __future__ import annotations

import argparse
import asyncio
import datetime

from bleak import BleakClient

from owon_ble import protocol
from owon_ble.device import find_device
from offline import download_recording


async def set_clock_and_start_recording(address: str, count: int) -> datetime.datetime:
    sent_dt = datetime.datetime.now()
    date_cmd = protocol.date_command(sent_dt)
    record_cmd = protocol.record_command(0, count)

    async with BleakClient(address) as client:
        print(f"Setting clock to {sent_dt.isoformat(timespec='seconds')} ...")
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, date_cmd, response=True)

        print(f"Starting recording with interval=0, count={count} ...")
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, record_cmd, response=True)

    print("Both commands sent (connection closed on our end right after, as usual).")
    return sent_dt


async def main(address: str | None, count: int) -> None:
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device()
        address = device.address
        print(f"Found meter at {address}")

    sent_dt = await set_clock_and_start_recording(address, count)
    print(f"\nCommand sent at: {sent_dt.strftime('%H:%M:%S.%f')[:-3]}")
    print(
        "If you want to measure the real rate, start a stopwatch NOW and stop it the "
        "moment the meter's Bluetooth icon disappears (that's the confirmed 'recording "
        "complete' signal). This is optional -- skip it if you just want to see what "
        "interval_seconds comes back as."
    )

    input(
        "\nOnce the Bluetooth icon has disappeared, long-press REL/BLE on the meter "
        "until it reappears, then press Enter here to continue..."
    )

    out_path = "offline_rate_test.csv"
    print("\nDownloading the recording to check its header and readings...")
    await download_recording(address, out_path)

    raw_path = out_path.rsplit(".", 1)[0] + "_raw.bin"
    with open(raw_path, "rb") as f:
        data = f.read()

    offset = protocol.find_offline_header_offset(data)
    if offset is None:
        print("\nCould not locate a valid header in the downloaded data -- cannot report.")
        return

    record = protocol.decode_offline_packet(data[offset:])
    h = record.header
    print(f"\nHeader interval_seconds field: {h.interval_seconds}")
    if h.interval_seconds == 0:
        print("-> The firmware echoed back interval=0 as requested (not silently substituted).")
    else:
        print(f"-> The firmware substituted interval={h.interval_seconds} instead of the requested 0.")

    print(f"Readings received: {len(record.readings)} (requested count={count})")
    for i, reading in enumerate(record.readings):
        print(f"  [{i}] {reading}")

    elapsed_str = input(
        "\nIf you timed it, enter the elapsed seconds from start to the Bluetooth icon "
        "disappearing (or press Enter to skip): "
    ).strip()
    if elapsed_str:
        try:
            elapsed = float(elapsed_str)
            rate = count / elapsed if elapsed > 0 else float("nan")
            print(f"\nApprox rate: {count} samples / {elapsed:.1f}s = {rate:.2f} samples/second")
            print("(Spec claims 2-3 samples/second for interval=0 -- compare against that.)")
        except ValueError:
            print("Could not parse that as a number, skipping rate calculation.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("address", nargs="?", default=None, help="BLE address of the meter")
    parser.add_argument("--count", type=int, default=10, help="number of samples to request (kept modest for a quick test)")
    args = parser.parse_args()
    asyncio.run(main(args.address, args.count))
