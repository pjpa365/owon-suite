// Shared by every value-y-axis chart widget (Live chart, Chart (single),
// Chart (multiple), and the mobile client's chart) for the "Auto Y-axis
// offset" setting: starts the axis near the data instead of forced to 0, so
// a small ripple on top of a high baseline is actually visible.

// Below this many samples, a min/max computed from the data is too noisy to
// commit an axis boundary to -- wait for a small buffer first rather than
// jumping the axis around (or picking a wildly wrong offset) on the first
// point or two.
const MIN_SAMPLES_FOR_AUTO_OFFSET = 5;

/** Rounds `step` up to a "nice" 1/2/5x10^n value -- the standard trick behind
 * most charting libraries' automatic tick spacing (D3's tickStep, ECharts'
 * own internal axis logic, etc.), used here to size the margin below the
 * data rather than to place ticks. */
function niceStep(step: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const normalized = step / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/** The axis minimum itself, given the visible data's own min/max. Sized off
 * the actual spread of the data (max - min), not just the magnitude of the
 * minimum value alone -- a min of 141.8 with a max of 143.1 (a tight ripple)
 * needs a step around 0.5, not the ~100 a magnitude-only rule would pick
 * (141.8's leading digit alone says "hundreds"), which is what previously
 * made a ripple sitting at ~140-143 nearly invisible against an axis
 * starting at 100. Falls back to a magnitude-based step when there's no
 * usable spread yet (a flat signal, or a single sample). */
export function niceAxisMin(min: number, max: number): number | undefined {
  if (!Number.isFinite(min) || min <= 0) return undefined;
  const range = max - min;
  const rawStep = range > 0 ? range / 4 : 10 ** (Math.floor(Math.log10(min)) - 1);
  const step = niceStep(rawStep);
  return Math.floor(min / step) * step;
}

/** Full pipeline a chart widget calls directly: filter out nulls (overload
 * readings), wait for enough samples to be meaningful, then compute the
 * offset from the actual min/max in view. */
export function computeAutoYMin(values: (number | null)[]): number | undefined {
  const numeric = values.filter((v): v is number => v !== null);
  if (numeric.length < MIN_SAMPLES_FOR_AUTO_OFFSET) return undefined;
  return niceAxisMin(Math.min(...numeric), Math.max(...numeric));
}
