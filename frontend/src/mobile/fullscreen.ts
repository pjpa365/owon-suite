// Browsers only allow entering fullscreen as a direct result of a user
// gesture (a click/tap), never programmatically after the fact -- calling
// this synchronously inside an onClick handler (not after an `await`) is
// what makes it count. iPhone Safari doesn't support the Fullscreen API for
// ordinary web pages at all, so this silently does nothing there rather than
// erroring -- same "absent, not broken" approach as voice control.
export function requestFullscreenBestEffort(): void {
  document.documentElement.requestFullscreen?.().catch(() => {
    // Not supported, or the browser declined -- nothing to do about it.
  });
}

export function exitFullscreenBestEffort(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}
