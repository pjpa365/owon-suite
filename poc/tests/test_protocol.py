"""Unit tests for owon_ble.protocol decode logic.

These do NOT require hardware -- they build synthetic byte packets matching
the documented bit layout and check the decoder against known-expected
values. If the real meter's bytes don't match these expectations once you
test with live.py/offline.py against actual hardware, update the layout in
owon_ble/protocol.py and these tests together.
"""

from __future__ import annotations

import struct

import pytest

from owon_ble import protocol


def _pack_measurement(function_index: int, scale_index: int, decimal_places: int, magnitude: int, negative: bool, status_bits: int) -> bytes:
    word0 = 0xF000 | (function_index << 6) | (scale_index << 3) | decimal_places
    word2 = magnitude | (0x8000 if negative else 0)
    return struct.pack("<HHH", word0, status_bits, word2)


def test_is_measurement_packet_true_for_marker_byte():
    data = _pack_measurement(function_index=0, scale_index=4, decimal_places=2, magnitude=0, negative=False, status_bits=0)
    assert protocol.is_measurement_packet(data)


def test_is_measurement_packet_false_for_wrong_length():
    assert not protocol.is_measurement_packet(b"\x00" * 5)
    assert not protocol.is_measurement_packet(b"\x00" * 7)


def test_decode_measurement_positive_value():
    # function=3 (A AC), scale=3 ('m'), decimal=2, magnitude=1234 -> 12.34 mA AC
    data = _pack_measurement(function_index=3, scale_index=3, decimal_places=2, magnitude=1234, negative=False, status_bits=0)
    m = protocol.decode_measurement(data)
    assert m.function == "A AC"
    assert m.scale_char == "m"
    assert m.decimal_places == 2
    assert m.value == pytest.approx(12.34)
    assert m.unit == "mA"
    assert m.status_flags == []


def test_decode_measurement_negative_value_and_status_flags():
    # HOLD (bit0) + MAX (bit5) => status word 0x21
    data = _pack_measurement(function_index=3, scale_index=3, decimal_places=2, magnitude=1234, negative=True, status_bits=0x21)
    m = protocol.decode_measurement(data)
    assert m.value == pytest.approx(-12.34)
    assert m.status_flags == ["HOLD", "MAX"]
    assert "HOLD" in str(m) and "MAX" in str(m)


def test_decode_measurement_wrong_length_raises():
    with pytest.raises(ValueError):
        protocol.decode_measurement(b"\x00" * 4)


def test_record_command_formatting():
    cmd = protocol.record_command(10, 100)
    assert len(cmd) == protocol.CMD_LENGTH
    assert cmd[:8] == b"*RECOrd,"
    assert struct.unpack_from("<II", cmd, 8) == (10, 100)


def test_readlen_and_read_cmd_are_fixed_length_and_zero_padded():
    assert len(protocol.READLEN_CMD) == protocol.CMD_LENGTH
    assert protocol.READLEN_CMD.startswith(b"*READlen?")
    assert protocol.READLEN_CMD[9:] == b"\x00" * 7

    assert len(protocol.READ_CMD) == protocol.CMD_LENGTH
    assert protocol.READ_CMD.startswith(b"*READ1?")
    assert protocol.READ_CMD[7:] == b"\x00" * 9


def test_date_command_formatting():
    import datetime

    cmd = protocol.date_command(datetime.datetime(2026, 7, 22, 14, 30, 5))
    assert len(cmd) == protocol.CMD_LENGTH
    assert cmd[:5] == b"*DATe"
    assert cmd[5:12] == bytes([20, 26, 7, 22, 14, 30, 5])
    assert cmd[12:] == b"\x00" * 4


def test_uuids_expand_from_short_ids():
    assert protocol.SERVICE_UUID == "0000fff0-0000-1000-8000-00805f9b34fb"
    assert protocol.CMD_CHAR_UUID == "0000fff1-0000-1000-8000-00805f9b34fb"
    assert protocol.CTRL_CHAR_UUID == "0000fff3-0000-1000-8000-00805f9b34fb"
    assert protocol.READ_CHAR_UUID == "0000fff4-0000-1000-8000-00805f9b34fb"


# Real payloads captured from an actual OWON B41T+ (2026-07-22), leads-open and
# leads-touching offline recordings, --interval 2 --count 5 each (trimmed to
# just the header + body; the full raw capture also has some leading live-echo
# packets and trailing 0xFF notification padding that aren't part of the
# record itself). These are the ground truth that pinned down the real
# (non-obvious) offline format: a 16-byte header, then a "type word"
# (function/scale/decimal, or decimal_places==7 as an overload/OL sentinel)
# followed by raw value-words, re-emitting a new type word whenever the
# range/function changes mid-recording.
_OPEN_CIRCUIT_PAYLOAD = bytes.fromhex("0000000000000000020000000c00000037f100000000000000000000")
_CLOSED_CIRCUIT_PAYLOAD = bytes.fromhex("0000000000000000020000000c00000022f107000700070007000700")

# Full, untrimmed raw notification streams as actually received over BLE,
# including the variable-length leading echo/filler noise before the real
# header (3 echo packets here) and trailing 0xFF padding -- exercises
# find_offline_header_offset() end-to-end, not just decode_offline_packet().
_OPEN_CIRCUIT_FULL_STREAM = bytes.fromhex(
    "37f10400000037f10400000037f104000000ffffffffffffffffffffffffffffffffffffffff"
    "0000000000000000020000000c00000037f100000000000000000000"
    "ffffffffffffffffffffffffffffffffffffffff"
)

# Real voltage-measurement capture (2026-07-23), --interval 1 --count 10,
# leads across a ~1.6V source. Only 2 leading echo packets this time (the
# count varies), plus trailing live-stream packets bleeding through after the
# record ends -- decode_offline_packet() must ignore those using byte_count,
# not just read to the end of the buffer.
_VOLTAGE_FULL_STREAM = bytes.fromhex(
    "".join(
        [
            "24f00400030024f004000100ffffffffffffffffffffffffffffffffffffffff0000000000000000",
            "010000001600000024f0f23ef23ef23ef23ef23ef23ef23ef23ef23ef23effffffffffffffffffff",
            "ffffffffffffffffffff24f00400010024f00400010024f00400010024f00400020024f004000200",
            "24f00400010024f00400010024f00400010024f00400010024f00400010024f00400010024f00400",
            "010024f00400010024f00400010024f00400010024f00400010024f00400010024f00400010024f0",
            "0400010024f00400010024f00400010024f00400010024f00400010024f00400010024f004000100",
            "24f00400010024f00400010024f00400000024f00400000024f00400010024f00400010024f00400",
            "010024f00400010024f00400010024f00400010024f00400000024f00400000024f00400000024f0",
            "0400000024f00400000024f00400000024f00400000024f00400000024f00400000024f004000000",
            "24f00400000024f00400000024f00400000024f00400000024f00400000024f00400000024f00400",
            "000024f00400000024f00400000024f00400000024f00400000024f00400000024f00400000024f0",
            "0400000024f004000000",
        ]
    )
)


# Real temperature capture (2026-07-22), --interval 3 --count 20, cooling from
# ~27C. Trimmed to header+body (see _OPEN_CIRCUIT_FULL_STREAM/_VOLTAGE_FULL_STREAM
# for the untrimmed-stream case already covered by other tests).
_TEMPERATURE_PAYLOAD = bytes.fromhex(
    "0000000000000000030000002a00000021f20f010e010e010d010d010d010d010d010d010d010d01"
    "0d010d010d010d010d010d010d010d010d01"
)

# Real capture (2026-07-23) from poc/diag_datetime.py: *DATe was sent with the
# PC's local time 2026-07-23 13:16:28, immediately followed by *RECOrd
# (--interval 1 --count 3). This is the confirmation that date_command()
# actually works -- the header's timestamp exactly matches what was sent
# (previous captures all show a zero/unset date because the clock was never
# set beforehand). The meter happened to be on the Ohm range with leads open
# at the time, hence the OL readings.
_DATETIME_SET_PAYLOAD = bytes.fromhex("141a07170d101c00010000000800000037f1000000000000")


def test_find_offline_header_offset_on_real_streams():
    assert protocol.find_offline_header_offset(_OPEN_CIRCUIT_FULL_STREAM) == 38
    assert protocol.find_offline_header_offset(_VOLTAGE_FULL_STREAM) == 32
    assert protocol.find_offline_header_offset(b"\x00" * 10) is None  # not enough data yet


def test_decode_offline_packet_from_full_voltage_stream():
    offset = protocol.find_offline_header_offset(_VOLTAGE_FULL_STREAM)
    record = protocol.decode_offline_packet(_VOLTAGE_FULL_STREAM[offset:])
    assert record.header.interval_seconds == 1
    assert len(record.readings) == 10
    for reading in record.readings:
        assert reading.function == "V DC"
        assert reading.value == pytest.approx(1.6114)


def test_decode_offline_packet_temperature_capture():
    record = protocol.decode_offline_packet(_TEMPERATURE_PAYLOAD)
    assert record.header.interval_seconds == 3
    assert len(record.readings) == 20
    values = [r.value for r in record.readings]
    assert values[0] == pytest.approx(27.1)
    assert values[-1] == pytest.approx(26.9)
    for reading in record.readings:
        assert reading.function == "TempC"


def test_decode_offline_header_reflects_clock_set_via_date_command():
    header = protocol.decode_offline_header(_DATETIME_SET_PAYLOAD)
    assert (header.year, header.month, header.day) == (2026, 7, 23)
    assert (header.hour, header.minute, header.second) == (13, 16, 28)
    assert header.interval_seconds == 1


def test_decode_offline_header_from_real_capture():
    header = protocol.decode_offline_header(_CLOSED_CIRCUIT_PAYLOAD)
    assert header.year == 0  # century=0, year=0 -- clock was never set via *DATe
    assert header.interval_seconds == 2
    assert header.byte_count == 12


def test_decode_offline_packet_open_circuit_is_overload():
    record = protocol.decode_offline_packet(_OPEN_CIRCUIT_PAYLOAD)
    assert len(record.readings) == 5
    for reading in record.readings:
        assert reading.value is None
        assert reading.function == "Ohm"
        assert "OL" in str(reading)


def test_decode_offline_packet_closed_circuit_readings():
    record = protocol.decode_offline_packet(_CLOSED_CIRCUIT_PAYLOAD)
    assert len(record.readings) == 5
    for reading in record.readings:
        assert reading.value == pytest.approx(0.07)
        assert reading.function == "Ohm"
        assert reading.scale_char == ""
        assert reading.unit == "Ohm"


def test_decode_offline_packet_type_word_changes_mid_recording():
    # 1 type-word (Ohm, decimal=2) + 2 values, then OL type-word + 1 value,
    # then back to Ohm (decimal=2) + 2 values -- simulates range/state changing
    # mid-recording, as seen when toggling leads open/closed during one recording.
    ohm_type = struct.pack("<H", 0xF000 | (4 << 6) | (4 << 3) | 2)
    ol_type = struct.pack("<H", 0xF000 | (4 << 6) | (4 << 3) | 7)
    body = (
        ohm_type
        + struct.pack("<H", 130)
        + struct.pack("<H", 23)
        + ol_type
        + struct.pack("<H", 0)
        + ohm_type
        + struct.pack("<H", 16)
        + struct.pack("<H", 14)
    )
    header = bytes(8) + struct.pack("<II", 2, len(body))
    record = protocol.decode_offline_packet(header + body)

    values = [r.value for r in record.readings]
    assert values == pytest.approx([1.30, 0.23, None, 0.16, 0.14])


def test_decode_offline_header_too_short_raises():
    with pytest.raises(ValueError):
        protocol.decode_offline_header(b"\x00" * 10)
