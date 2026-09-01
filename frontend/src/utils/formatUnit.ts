// Display-only remapping -- the underlying unit key ("Ohm", "MOhm", "kOhm", ...)
// is unchanged, still used as-is for chart-color lookups etc. elsewhere. Replace
// (not exact-match) so a scale prefix stays attached to the symbol -- "MOhm" ->
// "MΩ", not left as literal "MOhm" text (Changes ausgust-25.txt item 4).
// Shared by the PC Meter display widget and the mobile client's meter pane.
export function formatUnit(unit: string): string {
  return unit.replace("Ohm", "Ω");
}
