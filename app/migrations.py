"""PostgreSQL migration runner.

Applies numbered .sql files from migrations/pg/ in ascending order, tracking
what's already run in the schema_migrations table so each file executes at
most once per database.

Migration files are the source of truth for the schema: app/db.py's init_db()
just opens a connection and calls run_migrations(); there is no separate
inline CREATE TABLE path (the SQLite-era init_db() CREATE TABLE blocks were
removed). The legacy SQLite files under migrations/*.sql are kept as history
only and are never read by this runner.

Concurrency: a session-level pg_advisory_lock is taken for the whole run so
two processes migrating the same database at once serialize (the second waits,
then sees every version already applied and does nothing). Each file is
applied inside its own transaction together with its schema_migrations row;
Postgres DDL is transactional, so a failing file rolls back completely and a
later re-run picks up where it left off.

Usage: run_migrations(conn) — call once at startup. `conn` is a psycopg 3
connection (autocommit disabled).
"""
import os
import re

PG_MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'migrations',
    'pg',
)

_FILENAME_RE = re.compile(r'^(\d+)_.*\.sql$')

# Arbitrary, stable bigint used to key the advisory lock. Picking a fixed
# value (rather than hashtext of a string) keeps it obvious in pg_locks.
_ADVISORY_LOCK_KEY = 727081801


def _execute_sql_file(conn, sql):
    """Execute a whole migration .sql file on psycopg 3.

    psycopg's Cursor.execute() does not accept multiple statements, so split
    on statement-terminating semicolons. The split is conservative (only
    splits on a semicolon at end-of-line or followed by whitespace/comments)
    and must never split quoted literals in this migration corpus.
    """
    statement_end = re.compile(r';\s*(?:--.*)?$', re.MULTILINE)
    for statement in statement_end.split(sql):
        statement = statement.strip()
        if statement:
            conn.execute(statement)


def _pending_migrations():
    """[(version, filepath), ...] for every migrations/pg/NNN_*.sql file on
    disk, sorted by version. Files that don't match the NNN_name.sql naming
    pattern are ignored (e.g. a stray README)."""
    if not os.path.isdir(PG_MIGRATIONS_DIR):
        return []
    found = []
    for name in os.listdir(PG_MIGRATIONS_DIR):
        m = _FILENAME_RE.match(name)
        if m:
            found.append((int(m.group(1)), os.path.join(PG_MIGRATIONS_DIR, name)))
    return sorted(found, key=lambda pair: pair[0])


def run_migrations(conn):
    """Apply any migrations/pg/*.sql files not yet recorded in
    schema_migrations, in ascending version order.

    The schema_migrations table is created first (outside the lock it would
    race, so it is created under the same advisory lock as everything else).
    """
    # Serialize concurrent runners. Session-level advisory locks are held for
    # the lifetime of the session (or until explicitly unlocked), independent
    # of transaction boundaries, so this survives the per-file commits below.
    with conn.cursor() as cur:
        cur.execute('SELECT pg_advisory_lock(%s)', (_ADVISORY_LOCK_KEY,))
    conn.commit()
    try:
        with conn.cursor() as cur:
            cur.execute('''
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version integer PRIMARY KEY,
                    filename text NOT NULL,
                    applied_at timestamptz DEFAULT now()
                )
            ''')
        conn.commit()

        applied = _applied_versions(conn)

        for version, path in _pending_migrations():
            if version in applied:
                continue
            with open(path, 'r') as f:
                sql = f.read()
            # One transaction per file: the DDL and its schema_migrations row
            # commit together, or neither does.
            try:
                _execute_sql_file(conn, sql)
                conn.execute(
                    'INSERT INTO schema_migrations (version, filename) VALUES (%s, %s)',
                    (version, os.path.basename(path)),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    finally:
        with conn.cursor() as cur:
            cur.execute('SELECT pg_advisory_unlock(%s)', (_ADVISORY_LOCK_KEY,))
        conn.commit()


def _applied_versions(conn):
    with conn.cursor() as cur:
        cur.execute('SELECT version FROM schema_migrations')
        versions = {row[0] for row in cur.fetchall()}
    conn.rollback()  # end the read transaction; no writes here
    return versions
