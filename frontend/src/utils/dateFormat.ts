import { format as formatWithTokens } from "date-fns";

import { useSettings } from "../api/settings";

export const DEFAULT_DATE_TIME_FORMAT = "dd-MM-yyyy HH:mm:ss";

// The user-editable template (Changes_post_phase5_and_color_design.txt's
// "UI/client config settings" section) is treated as "<date part> <time
// part>" split on the first space -- true of the default and every format
// offered in Settings. A date-only or time-only display uses just its half,
// so there's exactly one template to edit rather than three kept in sync.
function splitTemplate(template: string): { datePart: string; timePart: string | null } {
  const spaceIndex = template.indexOf(" ");
  if (spaceIndex === -1) return { datePart: template, timePart: null };
  return { datePart: template.slice(0, spaceIndex), timePart: template.slice(spaceIndex + 1) };
}

export function formatDateTime(value: Date | string | number, template: string): string {
  return formatWithTokens(new Date(value), template);
}

export function formatDateOnly(value: Date | string | number, template: string): string {
  return formatWithTokens(new Date(value), splitTemplate(template).datePart);
}

export function formatTimeOnly(value: Date | string | number, template: string): string {
  const { datePart, timePart } = splitTemplate(template);
  return formatWithTokens(new Date(value), timePart ?? datePart);
}

/** Bound formatters using the persisted global template, falling back to the
 * default while settings are still loading. */
export function useDateFormat() {
  const settings = useSettings();
  const template = settings.data?.date_format ?? DEFAULT_DATE_TIME_FORMAT;
  return {
    formatDateTime: (value: Date | string | number) => formatDateTime(value, template),
    formatDate: (value: Date | string | number) => formatDateOnly(value, template),
    formatTime: (value: Date | string | number) => formatTimeOnly(value, template),
  };
}
