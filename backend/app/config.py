"""Backend configuration, loaded from backend/config.env (plain NAME=VALUE lines).

Kept as a flat key=value file rather than python-dotenv/pydantic-settings --
the handful of scalar values needed today doesn't warrant a dependency, and
this exact format is trivially readable from PowerShell too (restart-dev.ps1
parses it with the built-in ConvertFrom-StringData), so both sides agree on
one file without needing a shared parser library.
"""

from __future__ import annotations

from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BACKEND_DIR / "config.env"

_DEFAULTS = {
    "HOST": "127.0.0.1",
    "PORT": "10765",
    "DB_PATH": "owon_meter.duckdb",
    # Per-device cyclic buffer size (architecture.md SS3.3) -- one fixed
    # number, read from here by both the backend (buffer.py, via state.py)
    # and the frontend (vite.config.ts injects it into the build the same
    # way it already does for HOST/PORT), so the two can never disagree
    # about it the way a separate hardcoded constant on each side once did.
    "BUFFER_SIZE": "1000",
}


def _load_raw() -> dict[str, str]:
    values = dict(_DEFAULTS)
    if CONFIG_PATH.exists():
        for line in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip().upper()] = value.strip()
    return values


_raw = _load_raw()

HOST: str = _raw["HOST"]
PORT: int = int(_raw["PORT"])
BUFFER_SIZE: int = int(_raw["BUFFER_SIZE"])

_db_path = Path(_raw["DB_PATH"])
DB_PATH: Path = _db_path if _db_path.is_absolute() else BACKEND_DIR / _db_path
