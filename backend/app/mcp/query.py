"""Query validation and execution for the MCP server's read-only query tool
(architecture.md SS5.1-5.2).

Originally designed around a second, engine-enforced read-only DuckDB
connection as a backstop behind query-text validation (belt and suspenders).
That's not actually available: DuckDB refuses to open a second connection to
the same file, in the same process, with a different access mode than one
already open -- and the app's primary connection (state._conn) is writable
and open for the app's entire lifetime. state.readonly_conn is therefore just
`state._conn.cursor()` -- a real, separate connection handle safe to use from
another thread, sharing the same underlying writable database, with no
engine-level enforcement of its own. So there are two safety measures here,
not three, and both live in this file:

1. The query text itself is validated before it ever reaches the database --
   must be a single SELECT statement, may only reference the three MCP
   views, and must only call a short allowlist of aggregate functions. Any
   failure rejects the WHOLE query with an error; there is no partial/
   best-effort execution. This is the only thing standing between a query
   and the real database, so a gap here is a real gap.

   Originally a regex-based validator -- replaced after a security review
   (2026-08-31) found two ways to defeat it: a double-quoted identifier
   (`SELECT * FROM "app_settings"`) and an old-style comma-join
   (`FROM mcp_devices, app_settings`) both slipped past the regex's
   FROM/JOIN-anchored table-name check entirely, since neither matches
   `\\bfrom\\s+([a-zA-Z_]\\w*)` at the second table's position. A third gap:
   a query with no FROM/JOIN at all (`SELECT current_setting('temp_directory')`)
   had nothing for that regex to even inspect, and reached the database
   unrestricted -- confirmed to leak real filesystem paths via DuckDB's own
   `current_setting()`. A regex can't reliably answer "what tables/functions
   does this query touch" -- that requires actually parsing the SQL, which is
   what this file does now, via `sqlglot` (parses into a real syntax tree;
   `find_all(exp.Table)`/`find_all(exp.Func)` then can't be fooled by quoting,
   comma-joins, or schema-qualification the way text-pattern matching could).
2. Execution happens on a background thread (asyncio.to_thread), not the
   main event loop -- the app runs everything else synchronously on that one
   thread, so without this an expensive query would freeze live BLE data
   ingestion and every other request for its entire duration.
"""

from __future__ import annotations

import asyncio

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from .. import state

DIALECT = "duckdb"

ALLOWED_VIEWS = {"mcp_devices", "mcp_measurements", "mcp_measurement_points"}

# Deliberately short: only the aggregates the tool's own docstring example
# ("find the max value...") actually needs. Any function not in this list is
# rejected outright, including DuckDB's own scalar/introspection functions
# (version(), current_setting(), etc.) that have no legitimate use here and
# were exactly how the previous validator's FROM-less gap leaked real
# filesystem paths.
ALLOWED_FUNCTIONS = {"count", "min", "max", "avg", "sum"}

QUERY_TIMEOUT_SECONDS = 10.0
MAX_ROWS = 1000


class QueryRejected(Exception):
    """A validation failure -- mcp/server.py turns this into an error result
    for the calling agent, never a partial one."""


def _function_name(func: exp.Func) -> str:
    # A recognized function (Count, Min, Max, ...) has a proper sql_name();
    # anything sqlglot doesn't recognize by name (current_setting(), a
    # DuckDB-specific function, a typo) parses as a generic Anonymous node,
    # whose real name lives in `.this` instead -- sql_name() on that just
    # returns the literal string "ANONYMOUS", which would otherwise let an
    # unrecognized function name slip past a naive allowlist check entirely.
    if isinstance(func, exp.Anonymous):
        return str(func.this).lower()
    return (func.sql_name() or "").lower()


def _validate(sql: str) -> str:
    """Returns the single validated statement as re-serialized SQL (not the
    original text -- re-emitting from the parsed tree is itself part of the
    guarantee: what actually executes is what was actually parsed and
    checked, not a string that merely resembles it), or raises QueryRejected."""
    try:
        statements = [s for s in sqlglot.parse(sql, read=DIALECT) if s is not None]
    except ParseError as exc:
        raise QueryRejected(f"could not parse query: {exc}") from None

    if len(statements) != 1:
        raise QueryRejected("only a single SELECT statement is allowed (no semicolon-separated statements)")

    stmt = statements[0]
    if not isinstance(stmt, exp.Select):
        raise QueryRejected("only SELECT queries are allowed")

    # CTE names (WITH x AS (...)) are local aliases, not real tables -- the
    # CTE's own body is still walked and validated like any other subquery
    # via the same find_all(exp.Table) below, so excluding just the alias
    # itself from the allowlist check doesn't open a gap.
    cte_names = {cte.alias.lower() for cte in stmt.find_all(exp.CTE)}
    tables = {t.name.lower() for t in stmt.find_all(exp.Table)} - cte_names
    if not tables:
        raise QueryRejected(
            "query must reference at least one of the allowed views: " + ", ".join(sorted(ALLOWED_VIEWS))
        )
    disallowed_tables = tables - ALLOWED_VIEWS
    if disallowed_tables:
        raise QueryRejected(
            f"query references table(s)/view(s) that aren't allowed: {', '.join(sorted(disallowed_tables))}. "
            f"Allowed: {', '.join(sorted(ALLOWED_VIEWS))}"
        )

    for func in stmt.find_all(exp.Func):
        name = _function_name(func)
        if name not in ALLOWED_FUNCTIONS:
            raise QueryRejected(
                f"query uses a function that isn't allowed: {name}. "
                f"Allowed: {', '.join(sorted(ALLOWED_FUNCTIONS))}"
            )

    if not stmt.args.get("limit"):
        stmt = stmt.limit(MAX_ROWS)
    return stmt.sql(dialect=DIALECT)


def _execute_sync(sql: str) -> list[dict[str, object]]:
    result = state.readonly_conn.execute(sql)
    columns = [d[0] for d in result.description]
    rows = result.fetchall()
    return [dict(zip(columns, row, strict=True)) for row in rows]


async def run_query(sql: str) -> list[dict[str, object]]:
    validated = _validate(sql)
    try:
        return await asyncio.wait_for(asyncio.to_thread(_execute_sync, validated), timeout=QUERY_TIMEOUT_SECONDS)
    except TimeoutError:
        raise QueryRejected(f"query did not complete within {QUERY_TIMEOUT_SECONDS:.0f}s") from None
