// Shared by every time-based chart widget (Live chart, Chart (single), Chart
// (multiple)) for the global "chart time axis" setting (Changes ausgust-25.txt):
// elapsed seconds from a chart's own first plotted point (t0), used in
// "relative" mode instead of each point's real recorded time.
export function elapsedSeconds(timestamp: string, t0: string): number {
  return (new Date(timestamp).getTime() - new Date(t0).getTime()) / 1000;
}
