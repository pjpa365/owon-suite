"""Default + templated measurement naming (architecture.md SS3.4).

Templating engine: Python's str.format() over a fixed, closed set of named
tokens -- not a general-purpose template engine like Jinja2, which would be
the wrong tool for a fixed vocabulary. Token values are pre-formatted strings
(already applying e.g. decimal_places), not raw numbers, so the template
itself only combines fixed text with tokens.

One addition on top of plain str.format(): a `[...]`-bracketed section is
*optional* -- if any token it references is unavailable (currently only
min_value/max_value, when a measurement has no valid readings), the whole
bracketed section is dropped, brackets and all, rather than requiring a
second, separately-maintained fallback template. This is what lets a single
user-edited template produce a sensible name either way.
"""

from __future__ import annotations

import datetime
import re

# The fixed, closed set of tokens available to a naming template
# (architecture.md SS3.4). Several (min_value/max_value/duration/count) can
# only be determined once a measurement is finalized -- see initial_name()
# vs final_name() below.
TOKENS = ("device_name", "start_time", "min_value", "max_value", "unit", "duration", "count")

# The min-max clause is wrapped in [...] so it's automatically omitted when a
# measurement has no valid readings (every reading was an overload) --
# without this template authors would need to hand-maintain a second,
# separate template just to drop that one clause.
DEFAULT_TEMPLATE = (
    "{device_name}: {start_time}; [(min-max) {min_value} - {max_value} {unit}; ]"
    "Duration {duration}; {count} values"
)

_OPTIONAL_BLOCK_RE = re.compile(r"\[([^\[\]]*)\]")
_TOKEN_RE = re.compile(r"\{(\w+)\}")


def render(template: str, tokens: dict[str, str], missing: frozenset[str] = frozenset()) -> str:
    """Substitute `tokens` into `template`. Any `[...]` section referencing a
    token in `missing` is dropped entirely (brackets and all); every other
    `[...]` section has its brackets stripped and is substituted normally. A
    `missing` token that appears *outside* any bracketed section (a template-
    authoring mistake) renders as an empty string rather than raising, so one
    stray placeholder can't break every future finalized measurement's name.
    """

    def _resolve_block(match: re.Match[str]) -> str:
        content = match.group(1)
        if set(_TOKEN_RE.findall(content)) & missing:
            return ""
        return content

    without_optional_blocks = _OPTIONAL_BLOCK_RE.sub(_resolve_block, template)
    safe_tokens = {**dict.fromkeys(missing, ""), **tokens}
    return without_optional_blocks.format(**safe_tokens)


def _format_timestamp(dt: datetime.datetime) -> str:
    return f"{dt:%d-%m-%Y %H:%M:%S}.{dt.microsecond // 1000:03d}"


def _format_duration(seconds: float) -> str:
    total = round(max(seconds, 0))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d} min"
    return f"{minutes}:{secs:02d} min"


def initial_name(device_name: str, start_time: datetime.datetime) -> str:
    """The basic name assigned when a measurement/recording begins -- only
    device + start-time are known at this point."""
    return f"{device_name}: {_format_timestamp(start_time)}"


def final_name(
    device_name: str,
    start_time: datetime.datetime,
    unit: str,
    duration_seconds: float,
    count: int,
    decimal_places: int,
    min_value: float | None = None,
    max_value: float | None = None,
    template: str = DEFAULT_TEMPLATE,
) -> str:
    """The full templated name assigned once a measurement is finalized and
    its stats are known. If every reading was an overload/OL (no valid
    values to report), any `[...]` section of `template` referencing
    min_value/max_value is dropped automatically."""
    tokens = {
        "device_name": device_name,
        "start_time": _format_timestamp(start_time),
        "unit": unit,
        "duration": _format_duration(duration_seconds),
        "count": str(count),
    }
    missing: frozenset[str] = frozenset()
    if min_value is None or max_value is None:
        missing = frozenset({"min_value", "max_value"})
    else:
        tokens["min_value"] = f"{min_value:.{decimal_places}f}"
        tokens["max_value"] = f"{max_value:.{decimal_places}f}"
    return render(template, tokens, missing=missing)
