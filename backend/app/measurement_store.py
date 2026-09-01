"""Persisted measurement/point CRUD and stats (architecture.md SS2, SS3.4).

Shared `measurements` (metadata) + `measurement_points` (data) tables, not one
table per device or per measurement -- DuckDB's columnar scans are fastest
filtered by id on a shared table, per architecture.md SS2. Computed stats
(min/max/avg/median/count) are stored on the measurement row once known, not
recomputed on demand.
"""

from __future__ import annotations

import csv
import os
import statistics
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime

import duckdb

from . import naming
from .buffer import BufferedReading
from .calculations import CalculatedPoint
from .settings_store import SettingsStore

# Sentinel written in place of a NULL value in the bulk-load CSV (see
# _bulk_insert_points) so it's unambiguous against a genuinely empty string
# (e.g. a reading with no status flags) -- both would otherwise round-trip
# through DuckDB's CSV reader as NULL.
_NULL_SENTINEL = "\\N"

_COLUMNS = (
    "id, device_id, device_name, kind, name, unit, function, decimal_places, status, "
    "start_time, end_time, min_value, max_value, avg_value, median_value, count, created_at"
)


@dataclass
class MeasurementRecord:
    id: str
    device_id: str
    device_name: str
    kind: str  # "buffer_save" | "adhoc" | "online" | "offline" | "calculated"
    name: str
    unit: str
    function: str
    decimal_places: int
    status: str  # "recording" | "paused" | "finalized"
    start_time: datetime
    end_time: datetime | None
    min_value: float | None
    max_value: float | None
    avg_value: float | None
    median_value: float | None
    count: int
    created_at: datetime
    # Source measurement(s) this was derived from, only non-empty when kind == "calculated"
    # (architecture.md SS3.5's lineage/provenance requirement). Populated separately from
    # measurement_lineage, not part of the `measurements` row itself.
    source_measurement_ids: list[str] = field(default_factory=list)


@dataclass
class _Stats:
    min_value: float | None
    max_value: float | None
    avg_value: float | None
    median_value: float | None


def _compute_stats(values: list[float]) -> _Stats:
    if not values:
        return _Stats(min_value=None, max_value=None, avg_value=None, median_value=None)
    return _Stats(
        min_value=min(values),
        max_value=max(values),
        avg_value=statistics.fmean(values),
        median_value=statistics.median(values),
    )


@dataclass
class MeasurementPointRecord:
    id: int
    measurement_id: str
    seq: int
    timestamp: datetime
    value: float | None
    display_value: str
    status_flags: list[str]


def _row_to_record(row: tuple) -> MeasurementRecord:
    return MeasurementRecord(
        id=row[0],
        device_id=row[1],
        device_name=row[2],
        kind=row[3],
        name=row[4],
        unit=row[5],
        function=row[6],
        decimal_places=row[7],
        status=row[8],
        start_time=row[9],
        end_time=row[10],
        min_value=row[11],
        max_value=row[12],
        avg_value=row[13],
        median_value=row[14],
        count=row[15],
        created_at=row[16],
    )


class MeasurementStore:
    def __init__(self, conn: duckdb.DuckDBPyConnection, settings_store: SettingsStore) -> None:
        self._conn = conn
        self._settings = settings_store

    def _naming_template(self) -> str:
        """Read the naming template live from the settings store (Phase 5) so
        an edit made in the UI applies to the next finalized measurement
        immediately, with no restart."""
        return self._settings.get_all()["naming_template"]

    # --- one-shot creation from an already-known point list ---------------
    #
    # Callers (Save Buffer, ad-hoc Stop) accumulate readings in memory first
    # -- the cyclic buffer and an active ad-hoc recording are both plain
    # in-memory lists (architecture.md SS3.3's "explicitly transient" buffer
    # reasoning applies equally to an in-progress ad-hoc recording, which is
    # itself a session-length, actively-attended action, not a durable
    # background job). So the full point list is always available up front
    # by the time anything touches the database, and this writes it as ONE
    # transaction: a single measurement row plus a single batched point
    # insert, not a DB round trip per point. DuckDB is a columnar/OLAP
    # engine -- fast at bulk scans and bulk inserts, not at many tiny
    # auto-committed single-row transactions in a loop.

    def create_finalized(
        self,
        device_id: str,
        device_name: str,
        kind: str,
        function: str,
        unit: str,
        decimal_places: int,
        start_time: datetime,
        end_time: datetime,
        readings: list[BufferedReading],
    ) -> MeasurementRecord:
        measurement_id = str(uuid.uuid4())
        values = [r.measurement.value for r in readings if r.measurement.value is not None]
        stats = _compute_stats(values)
        duration = (end_time - start_time).total_seconds()

        name = naming.final_name(
            device_name,
            start_time,
            unit,
            duration,
            len(readings),
            decimal_places,
            min_value=stats.min_value,
            max_value=stats.max_value,
            template=self._naming_template(),
        )

        self._conn.execute("BEGIN TRANSACTION")
        try:
            self._conn.execute(
                """INSERT INTO measurements
                   (id, device_id, device_name, kind, name, unit, function, decimal_places,
                    status, start_time, end_time, min_value, max_value, avg_value, median_value, count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?)""",
                [
                    measurement_id, device_id, device_name, kind, name, unit, function, decimal_places,
                    start_time, end_time, stats.min_value, stats.max_value, stats.avg_value, stats.median_value,
                    len(readings),
                ],
            )
            if readings:
                self._bulk_insert_points(
                    measurement_id,
                    [
                        (r.timestamp, r.measurement.value, r.measurement.display_value, ",".join(r.measurement.status_flags))
                        for r in readings
                    ],
                )
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise
        return self.get(measurement_id)

    def _bulk_insert_points(
        self, measurement_id: str, rows: list[tuple[datetime, float | None, str, str]]
    ) -> None:
        """Load all of a measurement's points via a temp CSV + COPY, not a
        parameterized INSERT/executemany loop.

        Measured on this machine: parameterized inserts (whether one
        `executemany` call or a single INSERT with all rows' VALUES inlined)
        cost ~1ms per *bound parameter*, independent of batching strategy --
        500 six-column rows took ~3.7s either way. A trivial no-arg query
        looped the same number of times took a fraction of that, so the cost
        is specific to parameter binding in this DuckDB build (quite possibly
        AV/EDR interception on this machine, not something fixable by SQL
        shape). DuckDB's native CSV loader bypasses that path entirely: the
        same 500 rows load in ~0.08s this way, and 10,000 rows (the
        offline-recording max) in ~0.22s.

        `rows` is (timestamp, value, display_value, status_flags_csv) tuples --
        generic enough to serve both a live device reading and a calculated point.
        """
        fd, path = tempfile.mkstemp(suffix=".csv")
        try:
            with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                for seq, (timestamp, value, display_value, status_flags) in enumerate(rows):
                    value = _NULL_SENTINEL if value is None else value
                    writer.writerow([measurement_id, seq, timestamp, value, display_value, status_flags])
            self._conn.execute(
                "COPY measurement_points (measurement_id, seq, timestamp, value, display_value, status_flags) "
                f"FROM '{path}' (FORMAT csv, HEADER false, NULLSTR '{_NULL_SENTINEL}')"
            )
        finally:
            os.remove(path)

    def save_buffer(self, device_id: str, device_name: str, readings: list[BufferedReading]) -> MeasurementRecord:
        """Create an already-finalized measurement from a snapshot of buffered readings."""
        if not readings:
            raise ValueError("buffer is empty")
        first = readings[0].measurement
        return self.create_finalized(
            device_id=device_id,
            device_name=device_name,
            kind="buffer_save",
            function=first.function,
            unit=first.unit,
            decimal_places=first.decimal_places,
            start_time=readings[0].timestamp,
            end_time=readings[-1].timestamp,
            readings=readings,
        )

    def create_calculated(
        self,
        device_id: str,
        device_name: str,
        function: str,
        unit: str,
        decimal_places: int,
        points: list[CalculatedPoint],
        source_measurement_ids: list[str],
    ) -> MeasurementRecord:
        """Persist the output of the calculation engine (architecture.md SS3.5)
        as a regular finalized measurement, `kind="calculated"` marking it as
        derived and `measurement_lineage` rows recording which measurement(s)
        it came from. Points flagged `interpolated` get an `INTERPOLATED`
        status flag, so consumers (the scatter/XY chart) can render them
        distinctly from actually-measured points without a separate column.
        """
        if not points:
            raise ValueError("cannot create a calculated measurement with no points")
        measurement_id = str(uuid.uuid4())
        start_time = points[0].timestamp
        end_time = points[-1].timestamp
        values = [p.value for p in points if p.value is not None]
        stats = _compute_stats(values)
        duration = (end_time - start_time).total_seconds()

        name = naming.final_name(
            device_name,
            start_time,
            unit,
            duration,
            len(points),
            decimal_places,
            min_value=stats.min_value,
            max_value=stats.max_value,
            template=self._naming_template(),
        )

        self._conn.execute("BEGIN TRANSACTION")
        try:
            self._conn.execute(
                """INSERT INTO measurements
                   (id, device_id, device_name, kind, name, unit, function, decimal_places,
                    status, start_time, end_time, min_value, max_value, avg_value, median_value, count)
                   VALUES (?, ?, ?, 'calculated', ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?)""",
                [
                    measurement_id, device_id, device_name, name, unit, function, decimal_places,
                    start_time, end_time, stats.min_value, stats.max_value, stats.avg_value, stats.median_value,
                    len(points),
                ],
            )
            self._bulk_insert_points(
                measurement_id,
                [
                    (
                        p.timestamp,
                        p.value,
                        f"{p.value:.{decimal_places}f}" if p.value is not None else "OL",
                        "INTERPOLATED" if p.interpolated else "",
                    )
                    for p in points
                ],
            )
            for source_id in source_measurement_ids:
                self._conn.execute(
                    "INSERT INTO measurement_lineage (measurement_id, source_measurement_id) VALUES (?, ?)",
                    [measurement_id, source_id],
                )
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise
        return self.get(measurement_id)

    # --- CRUD -------------------------------------------------------------

    def list(
        self,
        device_id: str | None = None,
        name_contains: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> list[MeasurementRecord]:
        clauses: list[str] = []
        params: list = []
        if device_id:
            clauses.append("device_id = ?")
            params.append(device_id)
        if name_contains:
            clauses.append("name ILIKE ?")
            params.append(f"%{name_contains}%")
        if date_from:
            clauses.append("start_time >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("start_time <= ?")
            params.append(date_to)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT {_COLUMNS} FROM measurements {where} ORDER BY start_time DESC", params
        ).fetchall()
        records = [_row_to_record(row) for row in rows]
        self._attach_lineage(records)
        return records

    def get(self, measurement_id: str) -> MeasurementRecord:
        row = self._conn.execute(
            f"SELECT {_COLUMNS} FROM measurements WHERE id = ?", [measurement_id]
        ).fetchone()
        if row is None:
            raise KeyError(f"no measurement with id {measurement_id!r}")
        record = _row_to_record(row)
        self._attach_lineage([record])
        return record

    def _attach_lineage(self, records: list[MeasurementRecord]) -> None:
        """Batch-fetch measurement_lineage rows for the given records and
        populate `source_measurement_ids` in place -- one query regardless of
        how many records are being listed, not one per record."""
        ids = [r.id for r in records]
        if not ids:
            return
        placeholders = ",".join("?" * len(ids))
        rows = self._conn.execute(
            f"SELECT measurement_id, source_measurement_id FROM measurement_lineage "
            f"WHERE measurement_id IN ({placeholders})",
            ids,
        ).fetchall()
        by_measurement: dict[str, list[str]] = {}
        for measurement_id, source_id in rows:
            by_measurement.setdefault(measurement_id, []).append(source_id)
        for record in records:
            record.source_measurement_ids = by_measurement.get(record.id, [])

    def get_points(self, measurement_id: str) -> list[MeasurementPointRecord]:
        rows = self._conn.execute(
            """SELECT id, measurement_id, seq, timestamp, value, display_value, status_flags
               FROM measurement_points WHERE measurement_id = ? ORDER BY seq""",
            [measurement_id],
        ).fetchall()
        return [
            MeasurementPointRecord(
                id=row[0],
                measurement_id=row[1],
                seq=row[2],
                timestamp=row[3],
                value=row[4],
                display_value=row[5],
                status_flags=[f for f in row[6].split(",") if f],
            )
            for row in rows
        ]

    def rename(self, measurement_id: str, name: str) -> MeasurementRecord:
        self.get(measurement_id)  # raises if missing
        self._conn.execute("UPDATE measurements SET name = ? WHERE id = ?", [name, measurement_id])
        return self.get(measurement_id)

    def delete(self, measurement_id: str) -> None:
        self.get(measurement_id)  # raises if missing
        self._conn.execute("DELETE FROM measurement_points WHERE measurement_id = ?", [measurement_id])
        self._conn.execute("DELETE FROM measurements WHERE id = ?", [measurement_id])

    def delete_points(self, measurement_id: str, point_ids: list[int]) -> MeasurementRecord:
        """Delete individual (erroneous) points and recompute stats + name so a
        finalized measurement never displays stale values after an edit."""
        measurement = self.get(measurement_id)
        if point_ids:
            placeholders = ",".join("?" * len(point_ids))
            self._conn.execute(
                f"DELETE FROM measurement_points WHERE measurement_id = ? AND id IN ({placeholders})",
                [measurement_id, *point_ids],
            )

        # Sequence numbers only need to preserve relative order, not be
        # contiguous -- gaps left by a deletion are harmless, so there's no
        # need to renumber the rest (which would cost one UPDATE per
        # remaining row for no behavioral benefit).
        remaining = self._conn.execute(
            "SELECT value FROM measurement_points WHERE measurement_id = ?",
            [measurement_id],
        ).fetchall()

        values = [value for (value,) in remaining if value is not None]
        stats = _compute_stats(values)

        name = measurement.name
        if measurement.status == "finalized":
            duration = (
                (measurement.end_time - measurement.start_time).total_seconds()
                if measurement.end_time
                else 0.0
            )
            name = naming.final_name(
                measurement.device_name,
                measurement.start_time,
                measurement.unit,
                duration,
                len(remaining),
                measurement.decimal_places,
                min_value=stats.min_value,
                max_value=stats.max_value,
                template=self._naming_template(),
            )

        self._conn.execute(
            """UPDATE measurements SET count = ?, min_value = ?, max_value = ?,
               avg_value = ?, median_value = ?, name = ? WHERE id = ?""",
            [len(remaining), stats.min_value, stats.max_value, stats.avg_value, stats.median_value, name, measurement_id],
        )
        return self.get(measurement_id)
