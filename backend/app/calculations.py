"""Shared calculation engine: time-series alignment/interpolation and the
Ah / Watt-hour / Shunt-current calculators (architecture.md SS3.5).

Deliberately factored as plain functions operating on (timestamp, value)
pairs -- independently unit-testable without any UI/DB involvement, and
reusable by anything that has two time series to align (Watt-hour today,
and the scatter/XY chart's arbitrary measurement pairs).
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta

# Watt-hour's "duration must be similar" check (spec) -- how far apart two
# series' durations may be (as a fraction of the longer duration) before
# alignment is refused. Not yet a user-configurable app setting (that's
# Phase 5's settings store); callers may override per-call in the meantime.
DEFAULT_DURATION_TOLERANCE = 0.10


@dataclass
class SeriesPoint:
    timestamp: datetime
    value: float


@dataclass
class CalculatedPoint:
    timestamp: datetime
    value: float | None
    interpolated: bool = False


@dataclass
class Stats:
    duration_seconds: float
    count: int
    min_value: float | None
    max_value: float | None
    avg_value: float | None
    median_value: float | None


@dataclass
class AlignedSeries:
    """Two series resampled onto a shared set of timestamps, trimmed to
    their overlapping period only (architecture.md SS3.5)."""

    timestamps: list[datetime]
    values_a: list[float]
    values_b: list[float]
    interpolated_a: list[bool]
    interpolated_b: list[bool]


class AlignmentError(ValueError):
    """Raised when two series can't be meaningfully aligned (e.g. their
    durations differ by more than the configured tolerance, or they don't
    overlap in time at all)."""


def compute_stats(points: list[SeriesPoint]) -> Stats:
    if not points:
        return Stats(duration_seconds=0.0, count=0, min_value=None, max_value=None, avg_value=None, median_value=None)
    values = [p.value for p in points]
    duration = (points[-1].timestamp - points[0].timestamp).total_seconds()
    return Stats(
        duration_seconds=duration,
        count=len(points),
        min_value=min(values),
        max_value=max(values),
        avg_value=statistics.fmean(values),
        median_value=statistics.median(values),
    )


def _interpolate_at(points: list[SeriesPoint], t: datetime) -> float:
    """Linear interpolation of `points` (sorted ascending, non-empty) at
    time `t`. Clamps to the nearest endpoint value if `t` falls outside the
    series' own range (callers only ever call this within the overlap
    window computed by align_series, so this is a safety clamp, not the
    normal path)."""
    if len(points) == 1 or t <= points[0].timestamp:
        return points[0].value
    if t >= points[-1].timestamp:
        return points[-1].value
    for left, right in zip(points, points[1:]):
        if left.timestamp <= t <= right.timestamp:
            span = (right.timestamp - left.timestamp).total_seconds()
            if span == 0:
                return left.value
            frac = (t - left.timestamp).total_seconds() / span
            return left.value + frac * (right.value - left.value)
    return points[-1].value  # unreachable given the bounds checks above


def align_series(
    series_a: list[SeriesPoint],
    series_b: list[SeriesPoint],
    tolerance: float = DEFAULT_DURATION_TOLERANCE,
    sync_offset_seconds: float = 0.0,
) -> AlignedSeries:
    """Align two differently-sampled time series (architecture.md SS3.5):
    linear interpolation, trimmed to their overlapping period only, with an
    optional manual sync-point offset for series not started at the same
    real-world moment (applied to series_b's timestamps before alignment).

    The **union of both series' original timestamps within the overlap**
    is used as the common timeline, so every actually-measured point from
    either series is preserved exactly (not interpolated away) and only the
    *other* series gets an interpolated value at that point.
    """
    if not series_a or not series_b:
        raise AlignmentError("both series must have at least one point")

    shifted_b = (
        series_b
        if sync_offset_seconds == 0
        else [
            SeriesPoint(timestamp=p.timestamp + timedelta(seconds=sync_offset_seconds), value=p.value)
            for p in series_b
        ]
    )

    duration_a = (series_a[-1].timestamp - series_a[0].timestamp).total_seconds()
    duration_b = (shifted_b[-1].timestamp - shifted_b[0].timestamp).total_seconds()
    longer = max(duration_a, duration_b)
    if longer > 0 and abs(duration_a - duration_b) / longer > tolerance:
        raise AlignmentError(
            f"series durations differ by more than {tolerance:.0%} ({duration_a:.1f}s vs {duration_b:.1f}s)"
        )

    overlap_start = max(series_a[0].timestamp, shifted_b[0].timestamp)
    overlap_end = min(series_a[-1].timestamp, shifted_b[-1].timestamp)
    if overlap_start > overlap_end:
        raise AlignmentError("series do not overlap in time")

    # overlap_start/overlap_end are themselves one of the four series
    # endpoints, so this set always contains at least those two -- never empty.
    timestamps = sorted(
        {p.timestamp for p in (*series_a, *shifted_b) if overlap_start <= p.timestamp <= overlap_end}
    )

    a_actual = {p.timestamp for p in series_a}
    b_actual = {p.timestamp for p in shifted_b}

    values_a = [_interpolate_at(series_a, t) for t in timestamps]
    values_b = [_interpolate_at(shifted_b, t) for t in timestamps]
    interpolated_a = [t not in a_actual for t in timestamps]
    interpolated_b = [t not in b_actual for t in timestamps]

    return AlignedSeries(
        timestamps=timestamps,
        values_a=values_a,
        values_b=values_b,
        interpolated_a=interpolated_a,
        interpolated_b=interpolated_b,
    )


def _trapezoidal_integral(points: list[SeriesPoint]) -> float:
    """Integral of value over time (value*seconds), via the trapezoidal rule."""
    if len(points) < 2:
        return 0.0
    total = 0.0
    for left, right in zip(points, points[1:]):
        dt = (right.timestamp - left.timestamp).total_seconds()
        total += dt * (left.value + right.value) / 2
    return total


# --- Ah / Watt-hour / Shunt-current calculators ----------------------------


@dataclass
class AhResult:
    stats: Stats
    ah_value: float


def ah(current_points: list[SeriesPoint]) -> AhResult:
    """Ampere-hours over the available period: trapezoidal integration of
    current over time, converted from amp-seconds to amp-hours."""
    if len(current_points) < 2:
        raise ValueError("at least 2 points are required to calculate Ah")
    stats = compute_stats(current_points)
    ah_value = _trapezoidal_integral(current_points) / 3600
    return AhResult(stats=stats, ah_value=ah_value)


@dataclass
class WattHourResult:
    stats: Stats  # stats of the computed power series
    watt_hour_value: float
    power_points: list[CalculatedPoint]  # P = U x I at each aligned timestamp


def watt_hour(
    current_points: list[SeriesPoint] | None,
    voltage_points: list[SeriesPoint] | None,
    default_current: float | None = None,
    default_voltage: float | None = None,
    tolerance: float = DEFAULT_DURATION_TOLERANCE,
    sync_offset_seconds: float = 0.0,
) -> WattHourResult:
    """Watt-hours from a current and/or voltage dataset (spec: P = U x I).
    If only one dataset is given, the other is held at a user-provided
    constant default (spec: "user must enter the default ... e.g. 5V")."""
    if current_points is None and voltage_points is None:
        raise ValueError("at least one of current_points/voltage_points is required")
    if current_points is None and default_current is None:
        raise ValueError("default_current is required when no current dataset is given")
    if voltage_points is None and default_voltage is None:
        raise ValueError("default_voltage is required when no voltage dataset is given")

    if current_points is not None and voltage_points is not None:
        aligned = align_series(
            voltage_points, current_points, tolerance=tolerance, sync_offset_seconds=sync_offset_seconds
        )
        power_points = [
            CalculatedPoint(timestamp=t, value=u * i, interpolated=(interp_u or interp_i))
            for t, u, i, interp_u, interp_i in zip(
                aligned.timestamps,
                aligned.values_a,
                aligned.values_b,
                aligned.interpolated_a,
                aligned.interpolated_b,
            )
        ]
    elif current_points is not None:
        power_points = [
            CalculatedPoint(timestamp=p.timestamp, value=default_voltage * p.value, interpolated=False)
            for p in current_points
        ]
    else:
        power_points = [
            CalculatedPoint(timestamp=p.timestamp, value=default_current * p.value, interpolated=False)
            for p in voltage_points
        ]

    power_series = [SeriesPoint(timestamp=p.timestamp, value=p.value) for p in power_points]
    stats = compute_stats(power_series)
    watt_hour_value = _trapezoidal_integral(power_series) / 3600
    return WattHourResult(stats=stats, watt_hour_value=watt_hour_value, power_points=power_points)


@dataclass
class ShuntCurrentResult:
    stats: Stats
    current_points: list[CalculatedPoint]  # I = U / R at each measured voltage point


def shunt_current(voltage_points: list[SeriesPoint], resistance_ohms: float) -> ShuntCurrentResult:
    """Current through a shunt resistor for every point in a voltage dataset
    (I = U / R, corrected from the spec's original I = U x R -- see
    architecture.md SS3.5)."""
    if resistance_ohms <= 0:
        raise ValueError("resistance_ohms must be positive")
    if not voltage_points:
        raise ValueError("voltage_points must not be empty")
    current_points = [
        CalculatedPoint(timestamp=p.timestamp, value=p.value / resistance_ohms, interpolated=False)
        for p in voltage_points
    ]
    stats = compute_stats([SeriesPoint(timestamp=p.timestamp, value=p.value) for p in current_points])
    return ShuntCurrentResult(stats=stats, current_points=current_points)


# --- Generalized Ohm's-law transform (Data admin "V to I or R" / "Ohm to V
# or I" / "A to V or R" tabs, Changes ausgust-25.txt item 11) --------------

# The three quantities Ohm's law (U = I x R) relates. "V"/"I"/"R" (not "U")
# to match the unit-suffix vocabulary already used elsewhere in this file
# (_is_current_unit-style endswith("A")/endswith("V")/endswith("Ohm")).
OhmsLawQuantity = str  # "V" | "I" | "R"
_OHMS_LAW_QUANTITIES = {"V", "I", "R"}
# Deliberately overlaps with shunt_current() above (primary="V",
# constant="R" is the same I = U/R calculation) -- kept as two separate
# functions/endpoints rather than merged, per explicit confirmation that the
# overlap is fine (a dedicated Shunt-current shortcut alongside the general
# form).
_OHMS_LAW_OUTPUT_UNIT = {"V": "V", "I": "A", "R": "Ohm"}


@dataclass
class OhmsLawResult:
    stats: Stats
    output_points: list[CalculatedPoint]
    output_quantity: OhmsLawQuantity
    output_unit: str


def ohms_law_transform(
    primary_points: list[SeriesPoint],
    primary_quantity: OhmsLawQuantity,
    constant_quantity: OhmsLawQuantity,
    constant_value: float,
) -> OhmsLawResult:
    """Given a measured series for one Ohm's-law quantity and a user-supplied
    constant for a second, computes the third quantity at every point.

    U = I x R has only three shapes once one quantity is held constant:
    - primary is voltage: the constant is always divided out (I = U/R or
      R = U/I -- both are primary/constant).
    - primary is current or resistance and the constant is voltage: the
      constant is divided by the primary (the other factor = V/primary).
    - primary is current or resistance and the constant is the other of the
      two (not voltage): they multiply (V = I x R).
    """
    if primary_quantity not in _OHMS_LAW_QUANTITIES:
        raise ValueError(f"invalid primary_quantity {primary_quantity!r}")
    if constant_quantity not in _OHMS_LAW_QUANTITIES:
        raise ValueError(f"invalid constant_quantity {constant_quantity!r}")
    if constant_quantity == primary_quantity:
        raise ValueError("constant_quantity must differ from the measurement's own quantity")
    if not primary_points:
        raise ValueError("primary_points must not be empty")

    output_quantity = next(q for q in _OHMS_LAW_QUANTITIES if q not in (primary_quantity, constant_quantity))

    if primary_quantity == "V":
        if constant_value == 0:
            raise ValueError("constant value must not be zero")

        def op(x: float) -> float | None:
            return x / constant_value
    elif constant_quantity == "V":
        # Per-point, not upfront: the primary series (current or resistance)
        # can legitimately pass through exactly 0 at some samples even when
        # most aren't -- null that single point rather than failing the
        # whole calculation.
        def op(x: float) -> float | None:
            return constant_value / x if x != 0 else None
    else:

        def op(x: float) -> float | None:
            return x * constant_value

    output_points = [CalculatedPoint(timestamp=p.timestamp, value=op(p.value), interpolated=False) for p in primary_points]
    valid_series = [SeriesPoint(timestamp=p.timestamp, value=p.value) for p in output_points if p.value is not None]
    stats = compute_stats(valid_series)
    return OhmsLawResult(
        stats=stats,
        output_points=output_points,
        output_quantity=output_quantity,
        output_unit=_OHMS_LAW_OUTPUT_UNIT[output_quantity],
    )
