# OWON B41T+ BLE Protocol Specification

Reverse-engineered and empirically validated against a physical OWON B41T+ multimeter
(2026-07-22/23), building on two third-party open-source projects for the initial GATT
layout and live-packet format:

- https://github.com/jtcash/OwonB41T (Windows/C++, targets B41T+ directly)
- https://github.com/DeanCording/owonb35 (Linux/C, sibling B35 series)

Everything marked **Confirmed** below has been verified against real hardware (either
by observing the meter's display/behavior directly, or by decoding real captured bytes).
Everything marked **Assumed** is carried over from the reference projects but not yet
independently exercised. The reference implementation is `poc/owon_ble/protocol.py`
(plus `scan.py`, `live.py`, `control.py`, `offline.py`, `diag_write.py`), with real
hardware captures baked in as regression tests in `poc/tests/test_protocol.py`.

---

## 1. Transport and device identification

- The meter is a standard **Bluetooth Low Energy (BLE)** peripheral. **Confirmed**: it
  connects over a PC's ordinary built-in/USB Bluetooth radio via the OS's native BLE
  stack (WinRT on Windows, BlueZ on Linux) — **no special dongle is required**, despite
  OWON's own Windows software ("multimeterBLE") requiring a proprietary TI CC2540 USB
  dongle presented as a virtual COM port. That dongle-based path is a separate,
  unrelated mechanism this protocol does not need.
- **Confirmed**: the meter advertises itself with the BLE device name **`BDM`**. This
  name is **not unique** — every unit of this meter family advertises the same name, so
  if multiple OWON meters are powered on nearby, you cannot distinguish them by name
  alone. Distinguish by BLE address instead (shown by a scan), or power on only one
  meter at a time during setup and note its address for reuse.
- **Confirmed** (2026-07-27, on Windows/`bleak`): scan-time discovery **cannot rely on
  the `0xFFF0` service UUID being present in the BLE advertisement**, even though `0xFFF0`
  is a real, confirmed GATT service once connected (§2.1). Across repeated scans at close
  range, `BleakScanner`'s advertisement data for this meter consistently omitted the
  service UUID list entry, while the advertised **name (`BDM`) was present every time**.
  The working discovery filter (`owon_ble/device.py`'s `find_device()`) therefore matches
  on **either** the `0xFFF0` service UUID **or** the advertised name equalling `BDM`
  (case-insensitive) — not the service UUID alone, which was the original (broken)
  assumption. Likely cause: the service UUID may only appear in a scan-response packet
  that isn't always captured/merged by the OS BLE stack, rather than the primary
  advertisement — not independently confirmed, but consistent with the symptom.
- **Confirmed**: BLE must be explicitly enabled on the meter before it advertises —
  **long-press the REL/BLE button until the Bluetooth icon appears on the display.**
  It is not on by default at power-on.
- **Confirmed** (from the manual): BLE auto-disables after **10 minutes of idle**
  (no active connection/interaction); the meter beeps twice as a warning just before
  disabling it. Typical range is ~10 m, up to ~20 m in open, unobstructed space.
- **Confirmed** (from the manual): while BLE is active, the meter's own auto
  power-off/sleep timer is disabled — it won't shut itself off while connected.

---

## 2. GATT layout

One custom service, three characteristics, all under the short-UUID convention (16-bit
short ID expanded via the standard Bluetooth Base UUID template:
`0000XXXX-0000-1000-8000-00805F9B34FB`).

| Purpose | Short ID | Full UUID | Properties | Direction |
|---|---|---|---|---|
| Service | `0xFFF0` | `0000fff0-0000-1000-8000-00805f9b34fb` | — | — |
| Command characteristic | `0xFFF1` | `0000fff1-0000-1000-8000-00805f9b34fb` | `read`, `write` | PC → meter |
| Control characteristic | `0xFFF3` | `0000fff3-0000-1000-8000-00805f9b34fb` | write | PC → meter |
| Data characteristic | `0xFFF4` | `0000fff4-0000-1000-8000-00805f9b34fb` | notify | meter → PC |

**Confirmed**: `0xFFF1`'s advertised properties are exactly `['read', 'write']` — no
`write-without-response` is advertised, and (see §4) it genuinely requires proper GATT
**Write Request** semantics, not fire-and-forget.

**Confirmed**: `0xFFF4` carries **both** live measurement notifications and offline
(long-term recording) download data — the two are told apart by packet shape/content,
not by a different characteristic.

### Connection procedure

1. Scan for BLE advertisements; the meter's device name is `BDM`.
2. Connect (standard GATT connect).
3. Discover the `0xFFF0` service and the characteristics needed (`0xFFF1`/`0xFFF3`/`0xFFF4`
   — see §2.1 for two more that exist but aren't part of the working protocol).
4. Subscribe to notifications on `0xFFF4` (`0xFFF4`'s CCCD, "Notify").
5. You will immediately start receiving live measurement packets (§3) at the meter's
   own display update rate.

### 2.1 Full GATT enumeration (2026-07-23, `poc/diag_services.py`)

A complete service/characteristic enumeration (not just the `0xFFF0` service used by
everything else in this doc) turned up the following. Mostly not useful, but worth
recording so it isn't re-investigated from scratch later:

- **No standard Current Time Service (`0x1805`)** is present. This closes out the
  question of whether the meter's clock can be read directly instead of via an offline
  recording's header (§6.3/§6.4) — it can't; there is no GATT-standard alternative.
- **Generic Access Profile (`0x1800`)**: the GAP Device Name characteristic (`0x2A00`)
  reads `"LILLIPUT"` — apparently the underlying BLE module's OEM/vendor default name,
  distinct from the `BDM` name actually used in advertisements (§1). Peripheral
  Preferred Connection Parameters (`0x2A04`) decode to min/max connection interval
  100–200ms, 0 slave latency, 10s supervision timeout — a preferred (not necessarily
  negotiated) parameter set implying the link can plausibly sustain several
  notifications/second, which is at least *consistent with* offline downloads being
  faster than the ~2/s live rate (§6.2.2), though still not a direct measurement.
- **Device Information Service (`0x180A`)**: present, but **every string field just
  contains its own generic placeholder text** — Model Number String literally reads
  `"Model Number"`, Serial Number String reads `"Serial Number"`, Firmware/Hardware/
  Software Revision and Manufacturer Name are the same pattern, System ID reads all
  zeros, and the IEEE Certification field reads `"experimental"`. This looks like an
  unmodified BLE-module SDK template — **none of it is real OWON-specific device
  metadata**. Not useful for identifying a specific unit.
- **`0xFFF1`** (the command characteristic) has a static, apparently vestigial read
  value: `"ABCDEFGHIJKLMN"` + 2 zero bytes (16 bytes total) — looks like a leftover
  factory-test string from the module's SDK template, unrelated to its real use
  (receiving 16-byte commands, §4). Its `read` property doesn't appear meaningful.
- **`0xFFF2`** (undocumented by either reference project) is `read`-only, 6 bytes:
  `29 ff 00 01 02 00`. Purpose unknown — not ASCII-decodable, doesn't obviously match
  any format used elsewhere in this protocol.
- **`0xFFF5`** (also undocumented) is `read`-only but **reading it fails with ATT error
  `0x05` "Insufficient Authentication"** — it requires BLE pairing/bonding first, which
  nothing in this project has attempted. Unknown what it contains; worth revisiting if
  pairing is ever set up for another reason.

---

## 3. Live measurement packets (notifications on 0xFFF4)

**Confirmed** end-to-end against real readings (Ohm, V DC, TempC all independently
verified to decode to sane values matching the display).

- **Length**: 6 bytes = three little-endian `uint16` words.
- **Update rate**: **Confirmed** ~2 readings/second in practice on this B41T+ unit,
  matching the manual's stated spec: **3/s** for auto-ranging, **2/s** for True RMS
  models (the B41T+ has True RMS). This is a hardware/display ADC limit, not a
  configurable rate — there is no command to speed it up.
- **Framing marker**: a live packet's `word0` always has its high byte `>= 0xF0`
  (top nibble `0xF`). This distinguishes a live packet from other data arriving on the
  same characteristic (e.g. offline-record bytes, see §6).

### Byte layout

```
byte:   0    1    2    3    4    5
       [--- word0 ---][--- word1 ---][--- word2 ---]
        (LE uint16)     (LE uint16)     (LE uint16)
```

**word0** — function / scale / decimal-places descriptor:

| Bits | Field | Width | Meaning |
|---|---|---|---|
| 12-15 | marker | 4 | Always `0xF` for a live packet (`word0 高 byte >= 0xF0`) |
| 10-11 | reserved | 2 | Unused/unknown |
| 6-9 | function | 4 | Index into the function table (§3.1) |
| 3-5 | scale | 3 | Index into the scale table (§3.2) |
| 0-2 | decimal_places | 3 | Number of digits after the decimal point |

Decode: `function = (word0 >> 6) & 0x0F`, `scale = (word0 >> 3) & 0x07`,
`decimal_places = word0 & 0x07`.

**word1** — status flag bitmask (bit → flag):

| Bit | Value | Flag |
|---|---|---|
| 0 | `0x01` | HOLD |
| 1 | `0x02` | REL |
| 2 | `0x04` | AUTO |
| 3 | `0x08` | LOW_BATTERY |
| 4 | `0x10` | MIN |
| 5 | `0x20` | MAX |
| 6 | `0x40` | OL (overload) |
| 7 | `0x80` | MAXMIN |

Multiple bits may be set simultaneously; decode as `[name for bit,name in enumerate(...) if word1 & (1<<bit)]`.

**Overload detection, corrected (2026-07-28)**: this doc previously assumed bit 6 of word1
was itself the live-packet overload signal, positioned as the "equivalent of the offline
decimal=7 sentinel" (§6.3) — but that was an unconfirmed guess, never checked against a
real overload capture on the live-stream path. A real-world test (open-circuit resistance)
showed the app displaying `0.0000000 MOhm` with no OL indication, meaning bit 6 was not
observed to be set. Cross-checking an independent, working implementation
([PBrunot/owonb41t](https://github.com/PBrunot/owonb41t), `webbluetooth.js`) shows it
detects overload purely via **`decimal_places == 7`** (`word0 & 0x07 == 0b111`) on the
live packet — the exact same sentinel already confirmed for offline records (§6.3), never
via a status bit at all. For **Ohm** measurements at least, `decimal_places == 7` is the
sentinel that should be checked; treat the reading as invalid (`None`/"OL"), not divided
by `10**7` (which is how the observed `0.0000000` arose: magnitude `0` divided by `10^7`).
Bit 6 is kept in both this spec and `STATUS_BITS` regardless — it may still be genuinely
used for other functions/units where the decimal-places field isn't already saturated at
its max value (e.g. a function whose normal decimal_places is already 7, if any exists, or
some other unit's overload path), this just hasn't been observed either way. Treat
`decimal_places == 7` as the primary, confirmed-by-behavior signal for Ohm, and the status
bit as a secondary, still-unconfirmed one for anything else.

**word2** — signed-magnitude reading:

| Bits | Field |
|---|---|
| 15 | sign (1 = negative) |
| 0-14 | magnitude |

Decode: `magnitude = word2 & 0x7FFF`, `sign = -1 if word2 & 0x8000 else 1`,
`value = sign * magnitude / 10**decimal_places`.

### 3.1 Function table (4 bits, index 0-13)

| Index | Function | Base unit |
|---|---|---|
| 0 | V DC | V |
| 1 | V AC | V |
| 2 | A DC | A |
| 3 | A AC | A |
| 4 | Ohm | Ω (`Ohm`) |
| 5 | Farad | F |
| 6 | Hz | Hz |
| 7 | Duty | % |
| 8 | TempC | °C |
| 9 | TempF | °F |
| 10 | Volts Diode | V |
| 11 | Ohms Continuity | Ω |
| 12 | hFE | (none) |
| 13 | NCV/ADP | (none) |

### 3.2 Scale table (3 bits, index 0-7)

| Index | Prefix char | Multiplier |
|---|---|---|
| 0 | `%` | 0.01 |
| 1 | `n` | 1e-9 |
| 2 | `u` | 1e-6 |
| 3 | `m` | 1e-3 |
| 4 | *(none)* | 1.0 |
| 5 | `k` | 1e3 |
| 6 | `M` | 1e6 |
| 7 | `G` | 1e9 |

Displayed unit = `{scale_char}{base_unit}`, e.g. scale `m` + function `V DC` → `mV`.

### 3.3 Worked example (real capture)

Bytes `24 f0 04 00 03 00` (hex, as seen mid-live-stream, little-endian) decode to:
`word0=0xf024` → function index 0 (`V DC`), scale index 4 (no prefix), decimal_places 4;
`word1=0x0004` → bit2 set → `AUTO`; `word2=0x0003` → value `3/10^4 = 0.0003` — a small
transient reading consistent with autoranging settling.

---

## 4. Command characteristic (0xFFF1) — writes

**Confirmed, empirically**: every write to `0xFFF1` **must be exactly 16 bytes**, sent
as a genuine GATT **Write Request** (`response=True`/with-response). Any other length
(tried: 5, 7, 9, 11, 12, 13, 14 bytes) is rejected outright with **ATT error `0x0D`
"Invalid Attribute Value Length"** — this is a hard requirement of this characteristic,
not a response-type quirk. (Initial guesses based on the reference projects' summarized
docs assumed variable-length ASCII text like `"*RECOrd,2,10"` — that is wrong; those
projects' actual source builds fixed 16-byte binary buffers, which is what actually
works.)

All four known commands are 16-byte buffers, ASCII-prefixed, zero-padded or
binary-packed to fill the rest:

| Command | Layout (16 bytes total) | Purpose |
|---|---|---|
| `*RECOrd,` + params | 8-byte ASCII `"*RECOrd,"` + `interval_seconds` (uint32 LE) + `count` (uint32 LE) | Start an offline (long-term) recording (§6.1) |
| `*READlen?` | 9-byte ASCII, zero-padded to 16 | Query offline record length (§6.2) |
| `*READ1?` | 7-byte ASCII, zero-padded to 16 | Request offline record download (§6.2) |
| `*DATe` + fields | 5-byte ASCII `"*DATe"` + century, year-in-century, month, day, hour, minute, second (1 byte each) + zero-pad | Set the meter's internal clock — **confirmed** (2026-07-23): setting it to the PC's current time and then checking a subsequently-started recording's header showed the header's timestamp matched the sent time to within 1 second |

Example real bytes sent for `*RECOrd` with interval=2s, count=10:
`2a 52 45 43 4f 72 64 2c 02 00 00 00 0a 00 00 00`
(`"*RECOrd,"` followed by `u32(2)` then `u32(10)`).

---

## 5. Control characteristic (0xFFF3) — button-press simulation

**Confirmed**: writes here work via **Write Without Response**, 2 bytes
(a little-endian `uint16` opcode). Verified directly: sending `HOLD` (`0x0103`) made the
meter's display show the HOLD indicator and freeze its value, exactly as pressing the
physical button would.

| Opcode | Value | Meaning |
|---|---|---|
| `SELECT` | `0x0101` | Short-press SELECT |
| `RANGE` | `0x0102` | Short-press RANGE (advance to next manual range) |
| `HOLD` | `0x0103` | Short-press HOLD (**confirmed working**) |
| `REL_BLE` | `0x0104` | Short-press REL/BLE |
| `HZ_DUTY` | `0x0105` | Short-press Hz/Duty |
| `MIN_MAX` | `0x0106` | Short-press MIN/MAX |
| `AUTO_RANGE` | `0x0002` | Long-press RANGE equivalent → return to auto-ranging |
| `LIGHT` | `0x0003` | Long-press SELECT equivalent → backlight |
| `BLUETOOTH_OFF` | `0x0004` | Long-press HOLD equivalent → disable BLE |
| `NORMAL` | `0x0006` | Long-press MIN/MAX equivalent → exit MIN/MAX mode |

Pattern: short-press opcodes are `0x01` in the high byte with a small index in the low
nibble; long-press opcodes are `0x00` in the high byte with a different small index.
This pattern is **assumed** to generalize but only `HOLD` has been individually
confirmed against the display; the others are inferred from the same reference-project
enum and not yet each individually display-verified.

---

## 6. Offline (long-term) recording

This is the meter's on-board data-logging feature: it can record up to **10,000**
samples internally (per the manual) without a live BLE connection, then be reconnected
later to retrieve them as a batch — useful for long unattended monitoring while
minimizing Bluetooth battery drain.

### 6.1 Starting a recording

1. Connect, write the 16-byte `*RECOrd,` command (§4) with the desired
   `interval_seconds` and `count`.
2. **Confirmed, full manual passage** (this resolves an earlier open question — see
   below): the app/PC disconnects from the meter within **~2 seconds** of the start
   command being accepted — this is exactly what `offline.py`'s `start_recording()`
   already does by closing the connection right after the write, so that behavior is
   correct, not a testing artifact. After disconnecting, **the meter's Bluetooth goes
   into a "low-power state" — not fully off** — for the entire recording. This is why
   the Bluetooth icon has been observed staying on for a whole ~60s recording
   (`--interval 3 --count 20`): it reflects this low-power/recording state, not an
   active connection. **Only once the recording finishes** does the meter fully disable
   Bluetooth, and the on-screen Bluetooth symbol disappears. There is no distinct
   separate "recording indicator" on the display — what briefly looked like one (a
   black bar/box on the left side) is just the ordinary **minus sign**, unrelated to
   recording state.
3. **Confirmed** (from the manual): only **one recording is retained at a time** —
   starting a new recording overwrites whatever was previously stored. Max count is
   10,000 samples.
4. **Confirmed** (from the manual): while recording is in progress and not finished,
   **the meter will not accept a new BLE connection** — attempting to reconnect early
   will fail; this is expected, not an error in the client. To interrupt a recording in
   progress, hold the relevant button until the Bluetooth symbol disappears from the
   display, or power the meter off. If the low-battery indicator appears, the recording
   may not complete correctly — check batteries before a long unattended run.
5. **Confirmed** (manual, and independently verified by direct observation): once the
   recording completes, Bluetooth is fully disabled — the on-screen symbol disappears
   entirely (no icon at all). **To reconnect for download, BLE must be explicitly
   re-enabled on the meter again** (long-press REL/BLE until the symbol reappears, same
   as the very first connection, §1) before attempting to reconnect — this is a
   required manual step every time, not an optional/occasional one.

*(Earlier revisions of this doc treated the manual's "disconnected automatically"
wording and the observed all-recording-long Bluetooth icon as contradictory, and raised
a hypothesis that the phone apps might send an explicit `BLUETOOTH_OFF` opcode (§5) a
few seconds after `*RECOrd` to force this. The fuller manual passage above resolves
this: both observations are correct and consistent — the GATT *connection* drops
quickly, while the *radio* stays in a low-power state until the recording completes, at
which point it fully disables. No explicit follow-up command from the app is implied or
needed.)*

#### 6.1.1 `interval=0` ("max rate") — confirmed accepted, real rate measured

**Confirmed** (2026-07-23): `interval_seconds=0` is a valid request, not rejected or
silently substituted — the downloaded header echoes back `interval_seconds=0` exactly
as sent (see `poc/diag_offline_rate.py` and the real capture baked into
`tests/test_protocol.py`). This is distinct from the *download transfer* speed discussed
in §6.2.2 below — this is about how fast the meter itself takes/logs samples internally
during the recording, while BLE is in its low-power state (§6.1) and nothing is
connected to observe it directly.

**Measured rate**: approximately **~500 samples/second**, timed manually (stopwatch
started at the moment the `*RECOrd` write completes, stopped when the Bluetooth icon
disappears — the confirmed recording-complete signal). This is a single human-timed
measurement, not lab-precision, but is far outside the noise band: three earlier timing
attempts that started the stopwatch too early (at script start rather than at the
command-sent moment) gave inflated elapsed times and correspondingly lower apparent
rates (353/s, 375/s) before the methodology was corrected — all consistent with
underestimating a true rate near ~500/s, not with the rate itself varying. This is
**roughly 150-250x faster than the 2-3 samples/second the specification assumed** for
`interval=0` (that figure is specifically the *live-streaming* ADC/display limit, §3,
and there was never a structural reason for offline logging to share it).

**Open, unresolved by this test**: whether these ~500 logged samples/second represent
**genuinely independent fast ADC conversions**, or the firmware **duplicating the same
value** into the log at high frequency while the underlying measurement itself still
only updates at the ~2-3/s live rate internally. Every test so far held a physically
stable input (a fixed resistor, unchanging voltage source) for the full recording —
which looks identical either way, since a truly constant input produces the same output
whether sampled independently 500 times/second or copied 500 times/second from a value
that only changes 2-3 times/second. Distinguishing the two requires a recording where
the physical input is deliberately changed partway through, then inspecting whether the
transition in the logged data is a sharp (near single-sample) jump, or a "staircase"
with the old value persisting for a long run of samples after the actual change before
jumping — not yet performed.

### 6.2 Downloading a recording

1. **Re-enable BLE on the meter first** (long-press REL/BLE until the Bluetooth symbol
   reappears, §6.1 point 5) — it will have fully disabled itself once the recording
   completed, unlike the low-power state during recording itself. Then reconnect (the
   meter disallows connecting while still actively recording, per §6.1 point 4).
2. Subscribe to notifications on `0xFFF4` (same characteristic as live data).
3. Write `*READlen?` (16-byte, §4) to `0xFFF1`; wait briefly (~1s is sufficient in
   practice).
4. Write `*READ1?` (16-byte, §4) to `0xFFF1`.
5. The meter streams the recorded data back as a sequence of notifications on
   `0xFFF4`. **Important — confirmed structural quirk**: the notification stream is
   **not** just header+data. It's preceded by:
   - A **variable number** (observed: 2 or 3, varies run to run) of 6-byte packets
     that are exact duplicates of a live-style measurement packet ("echo" packets —
     apparently leftover/residual live-stream state from just before the download
     response begins).
   - Then **one 20-byte chunk of all `0xFF` bytes** (filler/padding).
   - **Then** the real 16-byte header + body begins.
   - After the real record ends, if the connection/subscription is still open, the
     meter may resume sending **ordinary live measurement packets** again — these must
     be ignored, not appended to the record.

   Because of this, **do not assume the header starts at byte 0** of the accumulated
   stream, and **do not wait for an end-of-data marker** (there isn't one — no `0xFFFF`
   terminator is actually used, despite what a naive reading of the reference project
   summaries suggested). Instead:
   - Scan for the real header by finding the first position whose would-be
     `interval_seconds`/`byte_count` fields (§6.3) are *plausible* (small positive
     interval, small positive even byte count) — the leading noise reliably fails this
     check. (Reference implementation: `find_offline_header_offset()`.)
   - Once the header is located, its `byte_count` field tells you exactly how many
     more bytes to expect — stop listening once `header_offset + 16 + byte_count`
     bytes have been received, and decode only that slice (ignore anything after).

#### 6.2.1 No live data during the download itself

**Inferred from the received binary data** (not yet isolated by a dedicated test): while
the actual record transfer is in progress, **no live measurement data is received in
parallel**. The evidence is structural: every live packet observed anywhere (before or
after a download) arrives as its own **isolated 6-byte notification**, whereas the real
record's header/type-words/value-words always arrive **packed together inside larger
notification chunks** (20 bytes, holding several words at once). During the transfer
itself, no standalone 6-byte live-shaped notifications have been observed interleaved
between those larger chunks — the channel appears fully dedicated to serving the stored
record until it's done. (Live streaming does resume afterwards if the connection/
subscription is kept open past the end of the record — see the trailing-packets note
above — but that's *after* the transfer, not during it.)

**Practical consequence**: an app cannot show the meter's current live value while a
recording download is in progress — there is nothing live to show during that window.

#### 6.2.2 Download speed is currently unknown

The rate at which recorded data is actually transferred has **not been measured**. What
we have is indirect and small-sample: a 5-sample recording arrived in 7 notifications
(86 bytes) and a 20-sample recording in 8 notifications (116 bytes), both seemingly in a
quick burst rather than paced like live data — but no wall-clock timestamps were
captured, so there is no actual notifications/second or bytes/second figure to report.
Reasoning from first principles, the transfer should not be limited by the ~2-3
readings/second ADC rate that caps *live* streaming (§3), since offline data is already
sitting in memory by download time and isn't gated by new measurements being taken.
Weak supporting evidence for this: the device's Peripheral Preferred Connection
Parameters (§2.1) advertise a 100–200ms preferred connection interval, which would
plausibly support several notifications/second — consistent with a faster-than-live
transfer, though this is a *preferred*, not measured or even necessarily negotiated,
parameter, so it's suggestive at best. Measuring the real rate still requires
timestamping each notification during an actual download.

### 6.3 Record format (header + body)

**Header — 16 bytes, confirmed against three independent real recordings** (Ohm,
Voltage, Temperature):

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | century | u8 | e.g. `20` for the 2000s. Reads as `0` if the clock was never set via `*DATe`; **confirmed correct** (2026-07-23) once `*DATe` has been sent — see §6.4 |
| 1 | year-in-century | u8 | |
| 2 | month | u8 | |
| 3 | day | u8 | |
| 4 | hour | u8 | |
| 5 | minute | u8 | |
| 6 | second | u8 | |
| 7 | pad | u8 | reserved |
| 8-11 | `interval_seconds` | u32 LE | **Confirmed**: exactly matches the interval passed to `*RECOrd` in every test (1, 2, and 3 seconds all verified) |
| 12-15 | `byte_count` | u32 LE | **Confirmed**: exact byte length of the body that follows (verified equal to `2 × (1 + sample_count)` in every test) |

**Body — `byte_count` bytes, a sequence of little-endian `uint16` words**:

- Any word whose **high byte is `>= 0xF0`** is a **type word** — same bit layout as a
  live packet's `word0` (function/scale/decimal_places, §3). It applies to every
  subsequent value-word until a new type-word appears.
- **Confirmed**: the meter re-emits a fresh type-word whenever the measurement
  range/function changes mid-recording (observed directly when a recording toggled
  between open-circuit and near-zero-ohm readings — a new type-word appeared at every
  transition, not just once at the start).
- **Confirmed, important sentinel**: a type-word whose decoded `decimal_places == 7`
  (`0b111`, the maximum a 3-bit field can hold) means **overload / no valid reading**
  (e.g. open-circuit resistance). All value-words governed by such a type-word should
  be treated as invalid (`None`/"OL"), not divided by `10**7`.
- Every other word is a **value word**: signed-magnitude, same as a live packet's
  `word2` (`magnitude = word & 0x7FFF`, `sign = -1 if word & 0x8000 else 1`), scaled by
  the currently-active `decimal_places`.

### 6.4 Worked examples (real hardware captures)

**Ohm, leads open (infinite resistance)** — `--interval 2 --count 5`:
```
header: interval=2, byte_count=12
body:   37 f1 00 00 00 00 00 00 00 00 00 00
   word0 = 0xf137 -> function=Ohm, scale=M, decimal_places=7  => OVERLOAD sentinel
   word1..5 = 0x0000 (x5)                                     => all 5 readings = OL
```

**Ohm, leads touching (near-zero resistance)** — `--interval 2 --count 5`:
```
header: interval=2, byte_count=12
body:   22 f1 07 00 07 00 07 00 07 00 07 00
   word0 = 0xf122 -> function=Ohm, scale=(none), decimal_places=2
   word1..5 = 0x0007 (x5) -> 7 / 10^2 = 0.07 Ω, five times
```

**Voltage, ~1.6V DC source** — `--interval 1 --count 10`:
```
header: interval=1, byte_count=22
body:   24 f0 f2 3e f2 3e f2 3e f2 3e f2 3e f2 3e f2 3e f2 3e f2 3e f2 3e
   word0 = 0xf024 -> function=V DC, scale=(none), decimal_places=4
   word1..10 = 0x3ef2 (x10) -> 16114 / 10^4 = 1.6114 V, ten times
```

**Temperature, cooling from ~27°C** — `--interval 3 --count 20`:
```
header: interval=3, byte_count=42
20 readings decoded as TempC, smoothly declining 27.1 -> 26.9 °C and holding —
consistent with real ambient-temperature settling, confirming the decode is not
just structurally correct but numerically sane over a real time series.
```

**Clock set via `*DATe`, then verified** (2026-07-23, `poc/diag_datetime.py`): sent
`*DATe` with the PC's local time `2026-07-23 13:16:28`, immediately followed by
`*RECOrd` with `--interval 1 --count 3`. After the recording completed and BLE was
manually re-enabled, the downloaded header decoded to `2026-07-23 13:16:28` — an exact
match (1 second difference, well within processing latency). This confirms
`date_command()` actually works and that the header's date/time fields are correct once
the clock has been set (they only read as zero/unset when it hasn't been).

All five of the above are baked into `poc/tests/test_protocol.py` as regression tests
using the exact captured bytes.

---

## 7. Typical device behavior (operational flow, from the manual + observation)

- **Powering on**: rotary switch to any function position (not `OFF`).
- **Enabling BLE**: long-press REL/BLE until the Bluetooth icon appears (§1). Required
  before any connection attempt will succeed.
- **Auto power-off (APO)**: 30 minutes idle for the B41T(+) (15 min for B35 family)
  normally triggers shutdown, preceded by 5 warning beeps at the 1-minute mark and one
  long beep right before shutoff — but this is **disabled while BLE is active**, so it
  won't interrupt a live BLE session.
- **BLE idle timeout**: BLE itself auto-disables after **10 minutes idle** even with
  APO otherwise suppressed — two warning beeps sound first. Reconnecting requires
  re-enabling BLE on the meter (long-press REL/BLE again) if it has timed out.
- **During an offline recording**: the app/PC disconnects within ~2s of starting it
  (confirmed, manual), after which the meter's Bluetooth is in a **low-power state**
  (not off) for the whole recording — matching the observed behavior of the Bluetooth
  icon staying on for the entire ~60s of an `--interval 3 --count 20` recording. It will
  not accept a new connection during this time (§6.1 point 4). Only once the recording
  fully completes does Bluetooth actually disable and the icon disappear — at which
  point it must be **manually re-enabled** (long-press REL/BLE) before reconnecting to
  download (§6.2).
- **Buzzer/visual cues to watch for**: a beep marks the moment the meter accepts a
  command (confirmed); there is no distinct recording indicator on the display (the
  minus sign was initially mistaken for one, §6.1); two beeps mark BLE about to
  auto-disable from idleness; five beeps + one long beep mark APO shutdown (suppressed
  while BLE is active).
- **Range/mode changes mid-measurement**: the live function/scale can change at any
  time (autoranging, or the user changing the rotary switch/pressing RANGE) — both the
  live decoder and the offline decoder must re-read `word0`/type-words on every packet
  rather than caching the function from a previous packet.

---

## 8. Open items / not yet validated

- **Live-packet overload (§3): `decode_measurement()` does not yet check `decimal_places
  == 7`** — it was only ever implemented for the offline decoder (§6.3). Per the
  corrected note in §3, this is the confirmed signal for Ohm at least; the live decoder
  should apply the same check rather than relying solely on status bit 6 (which has not
  been observed to be set in practice). Not yet changed in code as of this writing.
- Whether bit 6 (`OL`) of the live status word is ever genuinely set for any
  function/unit is unconfirmed either way — only the negative case (Ohm overload, bit not
  observed set) has been seen so far.
- Only `HOLD` among the control opcodes (§5) has been individually confirmed against
  the physical display; the others are inferred from the same source as `HOLD` and
  share its write mechanism, but haven't been checked one-by-one.
- The exact meaning of bits 10-11 in a live/type word (marked "reserved" in §3) is
  unknown — no observed capture has exercised them.
- Behavior when a recording's `count` (10,000 max) is large enough to require many
  more BLE notifications than seen so far hasn't been tested at the full max — a
  6000-sample recording/download has been tested successfully (§6.1.1), a large jump
  from the ~60-sample recordings tested previously, but 10,000 itself is still
  unverified.
- **Whether `interval=0`'s ~500 samples/second are genuinely independent measurements
  or duplicated writes of a more-slowly-updating value is unresolved** — see §6.1.1 for
  the confirmed rate and exactly what test would settle this.
- **Download transfer speed is unknown** (no timestamps captured yet) — see §6.2.2.
  Note this is a *different* rate from the §6.1.1 recording rate above: this one is
  about how fast already-recorded data streams back over BLE during download, not how
  fast the meter logs samples during the recording itself.
- Whether live data is ever interleaved during a download is inferred from packet
  shape, not from a dedicated isolated test — see §6.2.1.
- **`0xFFF2`'s purpose is unknown** — a static 6-byte read-only value (§2.1), not
  documented by either reference project and not decodable as ASCII or any format used
  elsewhere in this protocol.
- **`0xFFF5` is inaccessible without BLE pairing/bonding** (§2.1) — reading it fails
  with ATT error `0x05` "Insufficient Authentication". Nothing in this project has
  attempted pairing; what it contains (possibly something more useful than `0xFFF2`,
  given it's specifically access-controlled) is unknown.
