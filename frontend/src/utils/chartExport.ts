export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

// Same character set backend/app/api/measurements.py's _sanitize_filename
// rejects for CSV export filenames -- Windows' reserved set is a strict
// superset of Linux's (which only really objects to "/" and the null byte),
// so filtering to Windows' rules produces a name that's safe on both.
const INVALID_FILENAME_CHARS = /[\\/*?:"<>|]/g;

export function sanitizeFilename(name: string): string {
  return name.replace(INVALID_FILENAME_CHARS, "_").trim() || "measurement";
}
