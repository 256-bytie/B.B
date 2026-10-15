# PostgreSQL Phase 2 report

Branch: `postgres-migration`. PostgreSQL tested: 16.15.

## Changes

- Application connections use a lazy psycopg pool from required `DATABASE_URL`,
  with tuple rows, UTC, autocommit disabled, and defaults 1/8/5 seconds.
  `PG_POOL_MIN`, `PG_POOL_MAX`, and `PG_POOL_TIMEOUT` override those defaults.
  Closing a borrowed connection returns it and rolls back unfinished work.
  Pool exhaustion reaches the Flask JSON 503 handler, including routes with
  broad exception handlers. Pool workers close before interpreter shutdown.
- Converted SQL at its source, including the unregistered legacy `app/posts.py`:
  `%s` parameters, `RETURNING id`, explicit conflict targets for ignored
  membership inserts, compatible upserts, `now()`, and `GREATEST`.
  Removed application SQLite imports, migration fallback, and explicit write
  lock statements. The community slug retry catches `UniqueViolation` because
  it expects a slug uniqueness collision; FK/check failures propagate.
- PostgreSQL migrations remain the schema source. The Phase 1 `seq` column
  replaces membership ordering's implicit SQLite identity. CASE/EXISTS casts
  are limited to making PostgreSQL accept the existing result types.
- Startup reports host/database only. `BEEBO_TEST` guards both initialization
  and pooled acquisition. The throwaway harness no longer prints credentials
  and now preserves its EXIT cleanup when running a command.
- Added local `PG-PHASE3` markers for deferred matching, collation, ordering,
  timestamp serialization, and transaction/concurrency semantics.

Files changed: `app/__init__.py`, `app/db.py`, `app/migrations.py`,
`app/chat_service.py`, `app/community_access.py`, `app/community_service.py`,
`app/library_service.py`, `app/post_service.py`, `app/posts.py`,
`app/search_service.py`, `app/serializers.py`, `app/user_service.py`,
`app/wallet.py`, routes `auth`, `chat`, `communities`, `library`, `posts`,
`search`, `users`, `wallet`, `scripts/pg_test_env.sh`,
`tests/test_pg_phase2.py`, and the phase documentation. Removed
`app/sqlite_migrations.py`. Frontend and production database unchanged.

## Gate evidence

Run with PostgreSQL credentials supplied through the standard environment:

```bash
bash scripts/pg_test_env.sh -- python -B tests/test_pg_phase2.py
PYTHONPYCACHEPREFIX=/tmp/beebo_pg_compile python -m compileall -q app
git diff --check
```

PASS: fresh migrations and a second idempotent initialization, app factory
boot, two signups, login, post, comment, like, follow, community creation,
join twice, member lists/search, DM creation/send, zero wallet balance,
feed/comments, global search, trending hashtags, community search.

PASS: real pool with min/max 1, timeout 0.2 seconds; UTC tuple result,
autocommit false, rollback after uncommitted UPDATE and close, reused connection,
and JSON 503 under exhaustion in 0.202 seconds. The pool closes cleanly.

PASS: missing `DATABASE_URL` fails startup. `BEEBO_TEST=1` rejects a database
without the `beebo_test` prefix in both `init_db()` and `get_db()`.

PASS: compileall and whitespace check. Pyflakes is unavailable in this
environment; compileall is the requested alternative. `git diff -- beebo.db`
is empty. Test databases are created and dropped by the harness.

Exact forbidden-construct grep, restricted to application Python source:

```text
$ grep -RnE 'lastrowid|sqlite3|PRAGMA|BEGIN IMMEDIATE|executescript|INSERT OR IGNORE|CURRENT_TIMESTAMP' app --include='*.py'
(no matches; exit 1)
$ grep -Rn '?' app --include='*.py'
app/__init__.py:31:    # a query string (e.g. /static/js/feed.js?v=1758285000). Without this,
app/__init__.py:46:            return f'/static/{rel_path.lstrip("/")}?v={v}'
app/migrations.py:47:    statement_end = re.compile(r';\s*(?:--.*)?$', re.MULTILINE)
```

The three question marks are a URL example, a cache-busting URL, and a regular
expression; none is an SQL placeholder. There is no runtime SQL translation.
The hashtag literal `LIKE '%#%'` executes without a parameter argument, so
psycopg does not process percent placeholders there. Other wildcard patterns
are bound values. A literal percent in a statement bound with parameters must
be doubled; none remains unescaped in the converted parameterized statements.

## Dynamic SQL review

- `_toggle_like` receives only literal `posts` or `comments` identifiers from
  its two internal callers. Community image columns come from the fixed
  `{'icon': 'icon_image', 'cover': 'cover_image'}` mapping.
- Message order is selected from literal `ASC`/`DESC`. IN lists interpolate
  repetitions of `%s`, with values passed separately. Search, feed, library,
  membership and wallet WHERE clauses concatenate fixed SQL fragments;
  user input is bound as parameters. No user-controlled identifier is used.

## Deferred differences and risks

No smoke or compilation failures remain. The existing SQLite-specific test
suite was not executed against PostgreSQL: it includes SQLite setup and a
known production-database cleanup landmine documented in `PG_MIGRATION.md`.
This report does not claim that suite passes.

The following parity probes intentionally expose Phase 3 differences:

| Observation | Audit tag / local markers |
|---|---|
| `'Smoke' LIKE 'smoke'` returns false | `LIKE_CASE`, search/library/community sites |
| Ascending nullable values sort `(1, NULL)` | `NULL_ORDERING`, feed/comments/history/highlights/library sites |
| Flask serializes native timestamptz as an HTTP-date, e.g. `Thu, 15 Oct 2026 09:51:01 GMT` | `TIMESTAMP_TEXT`, serializers and highlights; wallet also has `TIMESTAMPS` markers |

Concurrency is deliberately unredesigned (`LOCKING`, `READ_MODIFY_WRITE`).
Monthly claims/spending and toggles need PostgreSQL locking/idempotency work.
In particular, a losing conversation INSERT leaves its transaction aborted;
the existing catch's subsequent SELECT requires a savepoint/rollback in Phase 3.
The normal DM smoke passes; this is an explicitly marked race-path risk.
Name collation (`COLLATE_NOCASE`) and boolean ordering (`TYPE_STRICTNESS`)
also remain marked for parity review. Timestamp value formatting changes are
deferred, while response keys/shapes and frontend behavior were not redesigned.

The old schema comparison script still imports the removed application SQLite
migration runner; the Phase 1 `pg_schema_diff.txt` remains the baseline artifact.
Restoring a historical SQLite schema fixture outside `app/` is future tooling
work, not part of the PostgreSQL application smoke gate.
