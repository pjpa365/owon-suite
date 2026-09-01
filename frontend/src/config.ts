// Single source of truth for the buffer-size limit shared with the backend
// (backend/config.env's BUFFER_SIZE, plumbed through by vite.config.ts into
// VITE_MAX_BUFFER_SIZE at build/dev-serve time) -- so the Live chart widget's
// "max values" cap can never drift out of sync with the real server-side
// cyclic buffer size again.
export const MAX_BUFFER_SIZE = Number(import.meta.env.VITE_MAX_BUFFER_SIZE ?? "1000");
