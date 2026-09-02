import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Single source of truth for the backend's address: backend/config.env
// (the same file restart-dev.ps1 and app/config.py read), so the frontend's
// default API base URL can never silently drift from what the backend
// actually binds to. Falls back to the same defaults as app/config.py if
// the file or a key is missing.
function loadBackendConfig(): { HOST: string; PORT: string; BUFFER_SIZE: string } {
  const defaults = { HOST: '127.0.0.1', PORT: '10765', BUFFER_SIZE: '1000' }
  const configPath = path.resolve(dirname, '../backend/config.env')
  if (!fs.existsSync(configPath)) return defaults

  const values = { ...defaults }
  for (const rawLine of fs.readFileSync(configPath, 'utf-8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [key, ...rest] = line.split('=')
    values[key.trim().toUpperCase() as 'HOST' | 'PORT' | 'BUFFER_SIZE'] = rest.join('=').trim()
  }
  return values
}

const backendConfig = loadBackendConfig()
const backendBaseUrl = `http://${backendConfig.HOST}:${backendConfig.PORT}`
// OWON_RELEASE_VERSION (set by build-release.ps1) overrides package.json's
// version for a public-release build, so the shipped app displays the
// version it was actually released as -- independent of this repo's own
// internal package.json version, which tracks unrelated dev progress.
const appVersion =
  process.env.OWON_RELEASE_VERSION ??
  (JSON.parse(fs.readFileSync(path.resolve(dirname, 'package.json'), 'utf-8')) as { version: string }).version

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Dev serve (`vite`/`npm run dev`) keeps the absolute backend URL, since
  // the dev server and backend are two different origins (127.0.0.1:5173 vs
  // :10765). A production build (`vite build`/`npm run build`) is instead
  // always served BY that same backend, at whatever host/port/IP a client
  // used to load the page (Mobile Requirements.txt's LAN-served mode) -- so
  // it gets an explicitly empty VITE_API_BASE_URL, making every API call in
  // src/api/client.ts relative/same-origin (works from any address, no CORS
  // needed). An empty string, not an absent variable: apiFetch's `?? "http://
  // 127.0.0.1:10765"` fallback only triggers on null/undefined, not "".
  const apiBaseUrl = command === 'build' ? '' : backendBaseUrl

  // Written to .env.local (gitignored via the *.local pattern) rather than
  // passed through `define` with a custom global: this installed Vite version
  // (8.1.1, oxc/rolldown-based) skips `define` replacement for application
  // source at dev-serve time -- it only applies to dependency pre-bundling
  // (confirmed empirically: the existing process.env.NODE_ENV define reaches
  // react-draggable, a dependency, but not our own src files). Vite's actual
  // .env-file-based VITE_-prefixed env var loading is the long-standing,
  // version-independent mechanism, so that's what client.ts (and the footer)
  // read -- also used to stamp the app version from package.json here, so
  // there's exactly one place that number is set.
  fs.writeFileSync(
    path.resolve(dirname, '.env.local'),
    `# Auto-generated from backend/config.env and package.json by vite.config.ts -- do not edit by hand.\nVITE_API_BASE_URL=${apiBaseUrl}\nVITE_APP_VERSION=${appVersion}\nVITE_MAX_BUFFER_SIZE=${backendConfig.BUFFER_SIZE}\n`,
  )

  return {
    plugins: [react()],
    server: { host: '127.0.0.1' },
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
    },
    build: {
      // Two separate pages sharing one build/output (Mobile Requirements.txt):
      // the PC dashboard (index.html) and the phone-optimized mobile client
      // (mobile.html) -- served by the backend at "/" and "/mobile"
      // respectively in LAN mode (see backend/app/static_site.py).
      rollupOptions: {
        input: {
          main: path.resolve(dirname, 'index.html'),
          mobile: path.resolve(dirname, 'mobile.html'),
        },
      },
    },
  }
})
