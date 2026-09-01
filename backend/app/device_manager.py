"""Registry of known meters: custom name + BT address + config.

Persisted independently of live connection state (architecture.md SS3.1) -- a
meter can be "known" without being connected. Backed by DuckDB's
`known_devices` table (architecture.md SS2); the public interface
(list/get/add/rename/remove) is unchanged from the Phase 1 JSON-backed
version, so callers elsewhere don't change.

One-time migration: if a Phase 1 `devices.json` is present and the table is
still empty, its contents are imported and the file renamed to
`devices.json.migrated` so this only ever runs once.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

import duckdb

LEGACY_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "devices.json"

# The 8 curated per-device identity colors (theme-tokens.md SS4), offered at
# registration and re-pickable later. This is the single backend-side list of
# valid keys; the actual light/dark hex tints for each key are presentation-
# only and live in frontend/src/deviceColors.ts (so they can follow the
# color-scheme toggle) -- keep the two lists' keys/order in sync by hand.
DEVICE_COLOR_KEYS: tuple[str, ...] = ("coral", "amber", "moss", "jade", "sky", "indigo", "violet", "rose")


@dataclass
class KnownDevice:
    id: str
    name: str
    address: str
    driver: str = "owon_b41t"
    color: str = DEVICE_COLOR_KEYS[0]
    hidden: bool = False


class DeviceManager:
    def __init__(self, conn: duckdb.DuckDBPyConnection) -> None:
        self._conn = conn
        self._migrate_legacy_json()

    def _migrate_legacy_json(self) -> None:
        if not LEGACY_REGISTRY_PATH.exists():
            return
        (count,) = self._conn.execute("SELECT count(*) FROM known_devices").fetchone()
        if count > 0:
            return
        raw = json.loads(LEGACY_REGISTRY_PATH.read_text(encoding="utf-8"))
        for i, entry in enumerate(raw):
            device = KnownDevice(color=DEVICE_COLOR_KEYS[i % len(DEVICE_COLOR_KEYS)], **entry)
            self._conn.execute(
                "INSERT INTO known_devices (id, name, address, driver, color) VALUES (?, ?, ?, ?, ?)",
                [device.id, device.name, device.address, device.driver, device.color],
            )
        LEGACY_REGISTRY_PATH.rename(LEGACY_REGISTRY_PATH.with_suffix(".json.migrated"))

    def list(self, *, include_hidden: bool = False) -> list[KnownDevice]:
        query = "SELECT id, name, address, driver, color, hidden FROM known_devices"
        if not include_hidden:
            query += " WHERE hidden = false"
        rows = self._conn.execute(query).fetchall()
        return [KnownDevice(*row) for row in rows]

    def get(self, device_id: str) -> KnownDevice:
        row = self._conn.execute(
            "SELECT id, name, address, driver, color, hidden FROM known_devices WHERE id = ?", [device_id]
        ).fetchone()
        if row is None:
            raise KeyError(f"no known device with id {device_id!r}")
        return KnownDevice(*row)

    def _get_by_address(self, address: str) -> KnownDevice | None:
        row = self._conn.execute(
            "SELECT id, name, address, driver, color, hidden FROM known_devices WHERE address = ?", [address]
        ).fetchone()
        return KnownDevice(*row) if row else None

    def add(self, name: str, address: str, driver: str = "owon_b41t", color: str | None = None) -> KnownDevice:
        """Register a device. If a (possibly hidden) row already exists for
        this BLE address -- i.e. it was "removed" (soft-deleted) before --
        un-hide and rename that same row instead of minting a new id, so its
        existing measurements stay associated with it (Changes_post_phase5_
        and_color_design.txt: "when I add it back I expect all old data sets
        to be related to that device again")."""
        existing = self._get_by_address(address)
        if existing is not None:
            self._conn.execute(
                "UPDATE known_devices SET name = ?, hidden = false WHERE id = ?", [name, existing.id]
            )
            if color is not None:
                self.set_color(existing.id, color)
            return self.get(existing.id)

        if color is not None and color not in DEVICE_COLOR_KEYS:
            raise ValueError(f"unknown device color {color!r}")
        if color is None:
            # Auto-assign the next swatch in rotation so devices added without an
            # explicit choice (e.g. a bare API call) still get a distinct color
            # rather than all defaulting to the same one.
            (count,) = self._conn.execute("SELECT count(*) FROM known_devices").fetchone()
            color = DEVICE_COLOR_KEYS[count % len(DEVICE_COLOR_KEYS)]
        device = KnownDevice(id=str(uuid.uuid4()), name=name, address=address, driver=driver, color=color)
        self._conn.execute(
            "INSERT INTO known_devices (id, name, address, driver, color) VALUES (?, ?, ?, ?, ?)",
            [device.id, device.name, device.address, device.driver, device.color],
        )
        return device

    def rename(self, device_id: str, name: str) -> KnownDevice:
        self.get(device_id)  # raises if missing
        self._conn.execute("UPDATE known_devices SET name = ? WHERE id = ?", [name, device_id])
        return self.get(device_id)

    def set_color(self, device_id: str, color: str) -> KnownDevice:
        if color not in DEVICE_COLOR_KEYS:
            raise ValueError(f"unknown device color {color!r}")
        self.get(device_id)  # raises if missing
        self._conn.execute("UPDATE known_devices SET color = ? WHERE id = ?", [color, device_id])
        return self.get(device_id)

    def remove(self, device_id: str) -> None:
        """Soft-delete: hide the device rather than deleting its row, so its
        measurements remain intact and re-adding the same address later
        reconnects to the same history (see add())."""
        self.get(device_id)  # raises if missing
        self._conn.execute("UPDATE known_devices SET hidden = true WHERE id = ?", [device_id])
