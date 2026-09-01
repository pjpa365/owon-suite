import { useEffect, useRef } from "react";

// The Screen Wake Lock API has no guaranteed TypeScript lib types across
// toolchain versions; this is the minimal shape this hook actually uses.
interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

// Keeps the screen from sleeping while `active` is true (the meter/chart
// page being open, per the request) -- supported on Android Chrome; Safari
// on iPhone doesn't expose this API to websites at all, so this silently
// does nothing there, same "absent, not broken" approach as voice control
// and fullscreen elsewhere in the mobile client.
export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!active) return;

    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let cancelled = false;

    async function acquire() {
      try {
        const sentinel = await wakeLock!.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
      } catch {
        // Declined, or unsupported in this context -- nothing to do.
      }
    }

    // The lock is released automatically by the browser whenever the tab
    // goes out of view (screen off, app-switch, ...) -- re-acquire it once
    // it's visible again, for as long as `active` still holds.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") void acquire();
    }

    void acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void sentinelRef.current?.release();
      sentinelRef.current = null;
    };
  }, [active]);
}
