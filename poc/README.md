# OWON B41T+ BLE PoC

A small set of command-line scripts that connect to the OWON B41T+ multimeter over
Bluetooth LE, print live readings to the console, let you simulate button presses, and
start/download the meter's offline (long-term) recordings. This is a proof-of-concept to
validate the BLE protocol before building the full desktop app — see
`../docs/python-vs-rust-comparison.md` for the language decision behind it.

## Requirements

- Windows 11 or Ubuntu Desktop with a Bluetooth 4.0+ (BLE) adapter
- Python 3.10 or later
- The meter, powered on, with BLE enabled: **long-press the REL/BLE button until the
  Bluetooth icon appears on the meter's display.** BLE turns itself off after 10 minutes
  idle (two beeps warn first), so re-enable it if a connection attempt fails.

## Install

```bash
cd poc
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux
source .venv/bin/activate

pip install -r requirements.txt
```

On Ubuntu, no extra system packages are normally needed — `bleak` talks to the BlueZ
daemon that ships with Ubuntu Desktop over D-Bus. If you hit permission errors, make sure
your user is in the `bluetooth` group (or check `bluetoothctl` works standalone first).

## Usage

All scripts accept an optional BLE address as the first argument; if omitted, they scan
for a nearby OWON meter automatically (a few seconds).

### 1. Find your meter

```bash
python scan.py
```

Lists nearby BLE devices and flags any advertising the OWON `FFF0` service. Note the
address of your meter for the other scripts if auto-discovery doesn't find it.

### 2. Watch live readings

```bash
python live.py
# or: python live.py AA:BB:CC:DD:EE:FF
```

Connects, subscribes to notifications, and prints each measurement as it arrives:
value, unit (with scale prefix), and any active status flags (HOLD, REL, AUTO,
LOW_BATTERY, MIN, MAX, OL, MAXMIN). Ctrl+C to stop.

### 3. Send control commands (simulate button presses)

```bash
python control.py
```

Connects and shows an interactive numbered menu (select, range, hold, backlight,
rel/BLE toggle, hz/duty, min/max, etc.). Pick a number to send that command; `q` to quit.

### 4. Long-term (offline) recording

```bash
# Start logging every 10 seconds for 100 samples (max 10,000). The meter's
# Bluetooth goes into a low-power state for the whole recording (its Bluetooth
# icon stays on) and fully disables only once the recording completes.
python offline.py start --interval 10 --count 100

# ... wait for the recording to finish ...

# Re-enable BLE on the meter (long-press REL/BLE until the icon reappears --
# it will have fully turned off when the recording completed), then:
python offline.py download --out readings.csv
```

## Running the tests

The protocol decoding logic (`owon_ble/protocol.py`) has unit tests that don't need the
physical meter — they check the decoder against synthetic packets matching the documented
bit layout.

```bash
cd poc
pip install -r requirements-dev.txt
pytest
```

## Status: validated against real hardware

The protocol in `owon_ble/protocol.py` started as a reconstruction from two third-party
open-source projects (see the module docstring), but has since been confirmed end-to-end
against a real OWON B41T+ (2026-07-22): scanning, live decoding, button-press control,
and the full offline record start/download round-trip all work, including two real
hardware captures (leads-open and leads-shorted) baked in as regression tests in
`tests/test_protocol.py`.

Two things worth knowing if you build on this:

- **CMD_CHAR_UUID (0xFFF1) requires exactly 16-byte writes** using a real GATT Write
  Request (`response=True`) — not the variable-length ASCII text or write-without-response
  the reference projects seemed to imply. `record_command()`/`date_command()` and the
  padded `READLEN_CMD`/`READ_CMD` constants already build the correct fixed-length buffers.
- **Offline-record decoding**: the body isn't a flat array of raw magnitudes under one
  fixed unit — it's a sequence of words where a "type word" (function/scale/decimal, or
  `decimal_places == 7` as an overload/OL sentinel) applies to all following value-words
  until a new type-word appears, which happens whenever the range/function changes
  mid-recording. `decode_offline_packet()` handles this already.
- **The meter's clock is never set** by these scripts, so downloaded recordings currently
  report a bogus/zero timestamp in the header. `protocol.date_command()` exists and is
  tested, but nothing calls it yet — wire it into `offline.py` (e.g. before `start`) if
  real timestamps matter for the next stage.
