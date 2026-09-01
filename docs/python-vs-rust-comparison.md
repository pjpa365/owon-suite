# Language comparison: Python vs Rust for the OWON B41T+ desktop app

**Decision (2026-07-22): Python.** This document records the comparison that led to that
decision, for future reference if the choice is ever revisited.

## Context

The app needs to run on both **Windows 11** and **Ubuntu Desktop**, talk to the meter over
BLE, show live readings with unit/status decoding, drive a GUI with live graphs, simulate
button presses, and manage "long-term" (offline) recordings including local storage. None of
this is performance-critical — the meter emits roughly one measurement per second — so the
decision comes down to development speed, library fit, and distribution, not raw performance.

## BLE library comparison (the core dependency)

| | **bleak** (Python) | **btleplug** (Rust) |
|---|---|---|
| Maturity | 2,468★, MIT, pushed 2026-07-01 | 1,156★, permissive license, pushed 2026-05-25 |
| Open issues | 118 | 85 |
| Backend model | Wraps native stack per OS: WinRT (Windows), BlueZ/D-Bus (Linux), CoreBluetooth (macOS) | Same model: WinRT, BlueZ/D-Bus, CoreBluetooth |
| Known Windows quirks | WinRT `GattSession` occasionally drops (#1988, open); notifications sent before `start_notify()` completes can be lost (#1836); some indication/auth setups hit protocol errors (#1792, #1943) | #429: connect/disconnect behaves differently on Windows vs Linux for the same device |
| Linux behavior | Goes through BlueZ D-Bus GATT profile — the *same* underlying stack btleplug uses | Same BlueZ D-Bus layer |
| Other parity gaps | Windows-specific edge cases above | #452 stale devices after adapter power-off; #434 device-name reporting differs across platforms; macOS descriptor gaps (not relevant to us) |

**Takeaway:** on Linux, both libraries are thin wrappers over the same BlueZ D-Bus API, so
Linux reliability is essentially a wash between the two languages. Any meaningful difference
comes from how well each wraps WinRT on Windows, and both have open issues there. Given the
meter's low, steady traffic (~1 notification/sec, occasional writes), neither library's rough
edges are expected to matter much in practice.

## GUI + charting

| | Python | Rust |
|---|---|---|
| GUI framework | **PySide6** (official Qt bindings, LGPL/GPL, v6.11.1 as of 2026-05-13) — native look on both Windows and Ubuntu (GNOME/KDE) | **egui** (29.8k★, immediate-mode, not a native-look toolkit) or **Tauri** (109k★, Rust backend + HTML/CSS/JS frontend, native-feeling via webview) |
| Charting | **pyqtgraph** (4,384★, pushed 2026-07-20) — purpose-built for real-time scientific/engineering plots, exactly this use case | `egui_plot` (more basic) or a JS charting lib (Chart.js/uPlot) inside Tauri's webview — more flexible but more assembly required |
| Dev velocity | High — PySide6 + pyqtgraph is a well-trodden combo for "live instrument data + graphs" apps | Lower — either accept egui's non-native widget look, or take on Tauri's two-language surface to get a nicer UI |

## Storage

Both are a non-issue: Python's `sqlite3` is stdlib (zero dependency); Rust's **rusqlite**
(4,317★, pushed 2026-07-21, MIT) is a thin, well-regarded binding. No meaningful difference.

## Packaging / distribution

- **Python**: needs a bundler (PyInstaller) for a standalone `.exe`/Linux binary, or users
  `pip install` directly (most Ubuntu systems already have Python 3). PyInstaller + a BLE
  backend that shells out to D-Bus on Linux is workable but slightly fiddlier to verify.
- **Rust**: `cargo build --release` produces a single native binary per platform, no runtime
  needed — the cleaner end-user story.

This is the one area where Rust is unambiguously better.

## Pros / cons summary

**Python (bleak + PySide6 + pyqtgraph)**
- Fastest to build; directly reuses the PoC code as the production BLE layer
- `pyqtgraph` is a near-perfect fit for this exact use case
- Huge ecosystem/community coverage for debugging BLE + Qt issues
- Requires a bundler for clean distribution; dependency management is messier than a static binary
- Weaker type safety for the protocol's bit-twiddling — easier to get subtly wrong without a compiler catching it

**Rust (btleplug + egui/Tauri + rusqlite)**
- Single static binary, trivially distributable on both OSes, no runtime dependency
- Compiler-enforced correctness — valuable for the bit-packed measurement decoding
- Lower resource usage (irrelevant at this data rate)
- Slower development; no PoC code reuse if the PoC is in Python (a rewrite, not a port)
- GUI/charting requires more manual assembly to match what `pyqtgraph` gives for free
- Smaller pool of BLE-on-desktop example code to crib from when debugging WinRT/BlueZ oddities

## Conclusion

Both stacks have solid, actively maintained libraries for every requirement — there is no
dealbreaker gap on either side for Windows + Ubuntu. Python was chosen because the PoC
(already built in Python) becomes the production BLE layer directly, `pyqtgraph` matches the
"live instrument graph" requirement out of the box, and the packaging downside (needing
PyInstaller) is a manageable, one-time cost compared to re-implementing the protocol decoding
in a second language.
