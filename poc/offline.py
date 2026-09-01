#!/usr/bin/env python3
"""Start or download an OWON meter's offline (long-term) recording.

Usage:
    python offline.py start [ADDRESS] --interval 10 --count 100
    python offline.py download [ADDRESS] --out readings.csv

'start' sends the *RECOrd command; the meter then disconnects BLE on its own
and logs internally. Power-cycle-safe: reconnect any time later and run
'download' to retrieve the data as a CSV file.
"""

from __future__ import annotations

import argparse
import asyncio
import csv

from bleak import BleakClient

from owon_ble import protocol
from owon_ble.device import find_device


async def start_recording(address: str, interval: int, count: int) -> None:
    async with BleakClient(address) as client:
        cmd = protocol.record_command(interval, count)
        print(f"Sending: {cmd!r} ({len(cmd)} bytes)")
        # Earlier 0x0D "Invalid Attribute Value Length" errors were caused by
        # sending the wrong LENGTH (variable-length ASCII text), not the
        # wrong response type -- this characteristic requires exactly 16
        # bytes and does support Write Request (see protocol.CMD_LENGTH).
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, cmd, response=True)
    print(
        "Recording command sent. The meter's Bluetooth is now in a low-power state for "
        "the duration of the recording -- its Bluetooth icon will stay on the whole "
        "time, then disappear once the recording completes. At that point, re-enable "
        "BLE on the meter (long-press REL/BLE) before running 'download' to retrieve it."
    )


async def download_recording(address: str, out_path: str) -> None:
    chunks: list[bytes] = []
    header_offset: int | None = None
    expected_total: int | None = None
    done = asyncio.Event()

    def handle_notification(_handle, data: bytearray) -> None:
        nonlocal header_offset, expected_total
        chunks.append(bytes(data))
        buf = b"".join(chunks)

        # The stream is preceded by a variable-length run of leftover live
        # echo/filler packets before the real header -- locate it rather
        # than assume it starts at byte 0.
        if header_offset is None:
            header_offset = protocol.find_offline_header_offset(buf)

        if (
            header_offset is not None
            and expected_total is None
            and len(buf) >= header_offset + protocol.OFFLINE_HEADER_LENGTH
        ):
            header = protocol.decode_offline_header(buf[header_offset:])
            expected_total = header_offset + protocol.OFFLINE_HEADER_LENGTH + header.byte_count

        if expected_total is not None and len(buf) >= expected_total:
            done.set()

    async with BleakClient(address) as client:
        await client.start_notify(protocol.READ_CHAR_UUID, handle_notification)

        print(f"Requesting record length: {protocol.READLEN_CMD!r}")
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, protocol.READLEN_CMD, response=True)
        await asyncio.sleep(1)

        print(f"Requesting record data: {protocol.READ_CMD!r}")
        await client.write_gatt_char(protocol.CMD_CHAR_UUID, protocol.READ_CMD, response=True)

        try:
            await asyncio.wait_for(done.wait(), timeout=30)
        except asyncio.TimeoutError:
            print("Warning: expected byte count not reached within 30s, decoding what was received so far.")

        await client.stop_notify(protocol.READ_CHAR_UUID)

    payload = b"".join(chunks)
    chunk_lengths = [len(c) for c in chunks]
    print(f"Received {len(payload)} bytes across {len(chunks)} notification(s).")
    print(f"Per-notification lengths: {chunk_lengths}")

    raw_path = out_path.rsplit(".", 1)[0] + "_raw.bin"
    with open(raw_path, "wb") as f:
        f.write(payload)
    print(f"Saved raw payload ({len(payload)} bytes) to {raw_path} for inspection.")

    offset = protocol.find_offline_header_offset(payload)
    if offset is None:
        print("Could not locate a valid record header in the received data. Nothing decoded.")
        return
    if offset > 0:
        print(f"Skipped {offset} leading byte(s) of leftover live-stream data before the real header.")

    try:
        record = protocol.decode_offline_packet(payload[offset:])
    except ValueError as e:
        print(f"Could not decode as an offline record ({e}). Raw bytes are saved for inspection.")
        return

    h = record.header
    print(
        f"Recording started {h.year:04d}-{h.month:02d}-{h.day:02d} "
        f"{h.hour:02d}:{h.minute:02d}:{h.second:02d}, interval={h.interval_seconds}s, "
        f"{len(record.readings)} readings"
    )

    with open(out_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["index", "value", "unit", "function"])
        for i, reading in enumerate(record.readings):
            value = "OL" if reading.value is None else reading.value
            writer.writerow([i, value, reading.unit, reading.function])
    print(f"Saved {len(record.readings)} readings to {out_path}")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)

    p_start = sub.add_parser("start", help="start a long-term recording session on the meter")
    p_start.add_argument("address", nargs="?", default=None)
    p_start.add_argument("--interval", type=int, default=10, help="seconds between samples")
    p_start.add_argument("--count", type=int, default=100, help="number of samples (max 10000)")

    p_dl = sub.add_parser("download", help="download a completed recording as CSV")
    p_dl.add_argument("address", nargs="?", default=None)
    p_dl.add_argument("--out", default="offline_readings.csv", help="output CSV path")

    args = parser.parse_args()

    address = args.address
    if address is None:
        print("No address given, scanning for a meter...")
        device = await find_device()
        address = device.address
        print(f"Found meter at {address}")

    if args.action == "start":
        await start_recording(address, args.interval, args.count)
    elif args.action == "download":
        await download_recording(address, args.out)


if __name__ == "__main__":
    asyncio.run(main())
