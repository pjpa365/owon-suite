import { createContext, useContext } from "react";

// Backs the mobile client's own instant dark/light toggle -- deliberately
// separate from Mantine's default color-scheme persistence (which writes to
// localStorage): in LAN mode the mobile page and the PC dashboard share the
// same origin, so writing to that same storage key would leak the mobile
// toggle into the PC dashboard's own persisted appearance setting, or vice
// versa. This context instead backs a plain useState in mobile/main.tsx,
// passed to MantineProvider's `forceColorScheme` -- in memory only, so it's
// both mobile-only (that state doesn't exist in the PC bundle at all) and
// session-only (resets on reload) by construction, with no extra bookkeeping
// needed to keep it that way.
interface MobileThemeContextValue {
  toggle: (current: "light" | "dark") => void;
}

export const MobileThemeContext = createContext<MobileThemeContextValue | null>(null);

export function useMobileThemeToggle(): (current: "light" | "dark") => void {
  const ctx = useContext(MobileThemeContext);
  if (!ctx) throw new Error("useMobileThemeToggle must be used within MobileThemeContext.Provider");
  return ctx.toggle;
}
