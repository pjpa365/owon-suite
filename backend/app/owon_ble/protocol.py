"""OWON B41T+ BLE protocol constants and packet decoding.

GATT UUIDs and the live-measurement bit layout are ported from two third-party
open-source projects that independently agree on them (not copied source, just
the same constants/format reimplemented in Python):

- https://github.com/jtcash/OwonB41T   (Windows/C++, targets B41T+ directly)
- https://github.com/DeanCording/owonb35  (Linux/C, sibling B35 series)

The CMD_CHAR_UUID write format (fixed 16-byte buffers) and the offline-record
body layout (type-word + value-words, with a decimal_places==7 overload
sentinel) are NOT what those projects' summarized docs implied -- they were
worked out empirically against a real B41T+ (2026-07-22) after the naive
ASCII-text guesses failed, and are confirmed by the real hardware captures
baked into tests/test_protocol.py. Live-measurement decoding has also been
confirmed against real readings via live.py.
"""

from __future__ import annotations

import datetime
import struct
from dataclasses import dataclass
from enum import IntEnum

# --- GATT UUIDs ----------------------------------------------------------


def _short_uuid(short_id: int) -> str:
    """Expand a 16-bit short UUID using the Bluetooth Base UUID template."""
    return f"0000{short_id:04x}-0000-1000-8000-00805f9b34fb"


SERVICE_UUID = _short_uuid(0xFFF0)
CMD_CHAR_UUID = _short_uuid(0xFFF1)  # write: ASCII text commands
CTRL_CHAR_UUID = _short_uuid(0xFFF3)  # write: 16-bit button-press opcodes
READ_CHAR_UUID = _short_uuid(0xFFF4)  # notify: live measurements + offline data

# The meter's advertised device name. Used as a scan-time fallback identifier:
# confirmed empirically (2026-07-27) that the FFF0 service UUID is NOT
# reliably present in the BLE advertisement itself on Windows (via bleak),
# even at close range and across repeated scans -- despite FFF0 being a real
# GATT service once connected (confirmed earlier via diag_services.py). The
# advertised name has been consistently present, so device.py's find_device()
# matches on either signal.
DEVICE_NAME = "BDM"


# --- Control opcodes (button simulation, write to CTRL_CHAR_UUID) --------


class Control(IntEnum):
    """16-bit values written to CTRL_CHAR_UUID to simulate a button press."""

    SELECT = 0x0101
    RANGE = 0x0102
    HOLD = 0x0103
    REL_BLE = 0x0104
    HZ_DUTY = 0x0105
    MIN_MAX = 0x0106
    AUTO_RANGE = 0x0002  # long-press equivalent of RANGE
    LIGHT = 0x0003  # long-press equivalent of SELECT (backlight)
    BLUETOOTH_OFF = 0x0004  # long-press equivalent of HOLD
    NORMAL = 0x0006  # long-press equivalent of MIN_MAX


# --- ASCII commands (write to CMD_CHAR_UUID) ------------------------------

CMD_LENGTH = 16  # confirmed: CMD_CHAR_UUID rejects writes that aren't exactly this length


def _padded_ascii_command(text: str) -> bytes:
    """Zero-pad an ASCII command to the fixed 16-byte length this characteristic requires."""
    data = text.encode("ascii")
    if len(data) > CMD_LENGTH:
        raise ValueError(f"command {text!r} ({len(data)} bytes) exceeds {CMD_LENGTH}-byte limit")
    return data + b"\x00" * (CMD_LENGTH - len(data))


READLEN_CMD = _padded_ascii_command("*READlen?")
READ_CMD = _padded_ascii_command("*READ1?")


def record_command(interval_seconds: int, count: int) -> bytes:
    """Build the fixed 16-byte command that starts an offline (long-term) recording session.

    Per jtcash/OwonB41T's B41T.cpp sendRecordCommand(): an 8-byte ASCII
    prefix "*RECOrd," followed by interval and count as two little-endian
    uint32 values -- 16 bytes total, no padding needed. This differs from
    the naive ASCII-text guess ("*RECOrd,2,10") tried earlier, which failed
    because it was the wrong length, not the wrong response type.

    Per the manual: the connection disconnects on its own within ~2 seconds
    of this being accepted, after which the meter's Bluetooth is in a
    low-power state (not off) for the whole recording -- this is why its
    Bluetooth icon stays on for the entire duration rather than switching off
    immediately. Only once the recording completes does Bluetooth fully
    disable (icon disappears), and it must be re-enabled on the meter
    (long-press REL/BLE) before reconnecting to use READLEN_CMD / READ_CMD to
    retrieve the data. Max count per the manual is 10,000.
    """
    prefix = b"*RECOrd,"
    return prefix + struct.pack("<II", interval_seconds, count)


def date_command(dt: datetime.datetime | None = None) -> bytes:
    """Build the fixed 16-byte command that sets the meter's clock.

    Per jtcash/OwonB41T's B41T.cpp sendDateCommand(): 5-byte ASCII prefix
    "*DATe" followed by century, year-within-century, month, day, hour,
    minute, second (one byte each), zero-padded to 16 bytes total.
    """
    dt = dt or datetime.datetime.now()
    century, year = divmod(dt.year, 100)
    fields = bytes([century, year, dt.month, dt.day, dt.hour, dt.minute, dt.second])
    data = b"*DATe" + fields
    return data + b"\x00" * (CMD_LENGTH - len(data))


# --- Live measurement decoding --------------------------------------------

FUNCTIONS = [
    "V DC",  # 0
    "V AC",  # 1
    "A DC",  # 2
    "A AC",  # 3
    "Ohm",  # 4
    "Farad",  # 5
    "Hz",  # 6
    "Duty",  # 7
    "TempC",  # 8
    "TempF",  # 9
    "Volts Diode",  # 10
    "Ohms Continuity",  # 11
    "hFE",  # 12
    "NCV/ADP",  # 13
]

_BASE_UNITS = {
    "V DC": "V",
    "V AC": "V",
    "A DC": "A",
    "A AC": "A",
    "Ohm": "Ohm",
    "Farad": "F",
    "Hz": "Hz",
    "Duty": "%",
    "TempC": "C",
    "TempF": "F",
    "Volts Diode": "V",
    "Ohms Continuity": "Ohm",
    "hFE": "",
    "NCV/ADP": "",
}

SCALE_CHARS = ["%", "n", "u", "m", "", "k", "M", "G"]
SCALE_MULTIPLIERS = [0.01, 1e-9, 1e-6, 1e-3, 1.0, 1e3, 1e6, 1e9]

# Bit position -> status name within the second uint16 word of a live packet.
STATUS_BITS = ["HOLD", "REL", "AUTO", "LOW_BATTERY", "MIN", "MAX", "OL", "MAXMIN"]


@dataclass
class Measurement:
    raw: bytes
    function: str
    scale_char: str
    unit_multiplier: float
    decimal_places: int
    value: float | None  # None means overload / no valid reading (e.g. open circuit)
    status_flags: list[str]

    @property
    def display_value(self) -> str:
        if self.value is None:
            return "OL"
        return f"{self.value:.{self.decimal_places}f}"

    @property
    def unit(self) -> str:
        return f"{self.scale_char}{_BASE_UNITS.get(self.function, '')}"

    def __str__(self) -> str:
        flags = f" [{', '.join(self.status_flags)}]" if self.status_flags else ""
        return f"{self.display_value} {self.unit}{flags}"


def is_measurement_packet(data: bytes) -> bool:
    """True if this looks like a live-measurement notification.

    Live packets are 6 bytes with the top nibble of the first word's high
    byte set to 0xF (i.e. raw byte index 1 is >= 0xF0), distinguishing them
    from offline-record data packets on the same notify characteristic.
    """
    return len(data) == 6 and data[1] >= 0xF0


# A decimal_places value of 7 (0b111, the max a 3-bit field can hold) is a
# sentinel meaning "no valid reading" (overload / open circuit) -- confirmed
# by recording with the leads open: the type-word decodes with
# decimal_places=7 and the value-word(s) that follow are zero. Shared by both
# the live-packet decoder below and the offline-record decoder further down
# in this file -- same bit layout, same sentinel, both require the value word
# to also be zero (not decimal_places==7 alone).
_OVERLOAD_DECIMAL_PLACES = 7


def decode_measurement(data: bytes) -> Measurement:
    """Decode a 6-byte live-measurement notification from READ_CHAR_UUID.

    Layout (little-endian uint16 x3):
      word0: marker(bits12-15) | reserved(bits10-11) | function(bits6-9)
             | scale(bits3-5) | decimal_places(bits0-2)
      word1: status flag bits, see STATUS_BITS (bit 0 = HOLD ... bit 7 = MAXMIN)
      word2: signed-magnitude reading (bit15 = sign, bits0-14 = magnitude),
             scaled by 10^-decimal_places
    """
    if len(data) != 6:
        raise ValueError(f"expected 6-byte measurement packet, got {len(data)} bytes")

    word0, word1, word2 = struct.unpack("<HHH", data)

    function_index = (word0 >> 6) & 0x0F
    scale_index = (word0 >> 3) & 0x07
    decimal_places = word0 & 0x07

    magnitude = word2 & 0x7FFF
    sign = -1 if (word2 & 0x8000) else 1

    # Same decimal_places==7 overload sentinel used for offline records
    # (_OVERLOAD_DECIMAL_PLACES above), applied here to the live path too --
    # previously only decoded here, never checked, which is why an
    # open-circuit Ohm reading rendered as a bogus "0.0000000 MOhm" instead of
    # OL. Also requires magnitude == 0 (Changes ausgust-25.txt item 2): a
    # decimal_places of 7 alone isn't treated as sufficient on its own.
    overload = decimal_places == _OVERLOAD_DECIMAL_PLACES and magnitude == 0
    value = None if overload else sign * magnitude / (10**decimal_places)

    status_flags = [name for bit, name in enumerate(STATUS_BITS) if word1 & (1 << bit)]

    function = FUNCTIONS[function_index] if function_index < len(FUNCTIONS) else f"unknown({function_index})"

    return Measurement(
        raw=bytes(data),
        function=function,
        scale_char=SCALE_CHARS[scale_index],
        unit_multiplier=SCALE_MULTIPLIERS[scale_index],
        decimal_places=decimal_places,
        value=value,
        status_flags=status_flags,
    )


# --- Offline (long-term) record decoding ----------------------------------

OFFLINE_HEADER_LENGTH = 16


def _is_type_word(word: int) -> bool:
    """True if this looks like a function/scale/decimal descriptor word.

    Same marker convention as live packets: top byte >= 0xF0.
    """
    return (word >> 8) >= 0xF0


def find_offline_header_offset(data: bytes, max_scan: int = 128) -> int | None:
    """Find where a real offline-record header begins within a raw notify stream.

    The stream from READ_CHAR_UUID is not just header+body: it's preceded by
    a variable number of leftover live-style "echo" packets and a filler
    chunk (observed as 2-3 identical 6-byte packets, then one 20-byte block
    of 0xFF) before the real 16-byte header actually starts. Rather than
    assume a fixed offset, scan for the first 2-byte-aligned position whose
    would-be interval/byte_count fields (at offset+8) look plausible (a
    small non-negative interval in seconds -- 0 is a valid, confirmed
    request meaning "max rate" -- and a small even byte_count) -- the
    leading noise reliably fails this check. Returns None if nothing
    plausible is found yet (e.g. not enough data received so far).
    """
    limit = min(max_scan, len(data) - OFFLINE_HEADER_LENGTH)
    for offset in range(0, limit + 1, 2):
        interval_seconds, byte_count = struct.unpack_from("<II", data, offset + 8)
        if 0 <= interval_seconds <= 3600 and 0 < byte_count <= 20000 and byte_count % 2 == 0:
            return offset
    return None


@dataclass
class OfflineHeader:
    year: int
    month: int
    day: int
    hour: int
    minute: int
    second: int
    interval_seconds: int
    byte_count: int


@dataclass
class OfflineReading:
    value: float | None  # None means overload / no valid reading (e.g. open circuit)
    function: str
    scale_char: str
    decimal_places: int

    @property
    def unit(self) -> str:
        return f"{self.scale_char}{_BASE_UNITS.get(self.function, '')}"

    def __str__(self) -> str:
        if self.value is None:
            return f"OL {self.unit}"
        return f"{self.value:.{self.decimal_places}f} {self.unit}"


@dataclass
class OfflineRecord:
    header: OfflineHeader
    readings: list[OfflineReading]


def decode_offline_header(data: bytes) -> OfflineHeader:
    """Decode the 16-byte header that precedes downloaded offline-record data."""
    if len(data) < OFFLINE_HEADER_LENGTH:
        raise ValueError(f"expected at least {OFFLINE_HEADER_LENGTH} header bytes, got {len(data)}")

    century, year, month, day, hour, minute, second, _pad = data[0:8]
    interval_seconds, byte_count = struct.unpack_from("<II", data, 8)

    return OfflineHeader(
        year=century * 100 + year,
        month=month,
        day=day,
        hour=hour,
        minute=minute,
        second=second,
        interval_seconds=interval_seconds,
        byte_count=byte_count,
    )


def decode_offline_packet(data: bytes) -> OfflineRecord:
    """Decode a fully-reassembled offline-record download.

    Confirmed shape (from real hardware captures, see docs/ notes): 16-byte
    header, then header.byte_count bytes of body. The body is a sequence of
    uint16 words: any word whose top byte is >= 0xF0 is a "type word" (same
    function/scale/decimal_places bit layout as a live packet's word0) that
    applies to all following value-words until the next type-word -- the
    meter re-emits a type-word whenever the range/function changes mid
    recording. A type-word with decimal_places == 7 means "overload / no
    valid reading" (e.g. open-circuit ohms) for the value-words it covers.
    Every other word is a signed-magnitude value (bit15 = sign, bits0-14 =
    magnitude) scaled by the active decimal_places.
    """
    header = decode_offline_header(data)
    body = data[OFFLINE_HEADER_LENGTH : OFFLINE_HEADER_LENGTH + header.byte_count]

    readings: list[OfflineReading] = []
    function = "unknown"
    scale_char = ""
    decimal_places = 0
    overload = False

    for offset in range(0, len(body) - 1, 2):
        (word,) = struct.unpack_from("<H", body, offset)

        if _is_type_word(word):
            function_index = (word >> 6) & 0x0F
            scale_index = (word >> 3) & 0x07
            decimal_places = word & 0x07
            function = FUNCTIONS[function_index] if function_index < len(FUNCTIONS) else f"unknown({function_index})"
            scale_char = SCALE_CHARS[scale_index]
            overload = decimal_places == _OVERLOAD_DECIMAL_PLACES
            continue

        if overload:
            value = None
        else:
            magnitude = word & 0x7FFF
            sign = -1 if (word & 0x8000) else 1
            value = sign * magnitude / (10**decimal_places)

        readings.append(
            OfflineReading(value=value, function=function, scale_char=scale_char, decimal_places=decimal_places)
        )

    return OfflineRecord(header=header, readings=readings)
