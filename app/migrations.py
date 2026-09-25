"""Lightweight SQL migration runner.

Applies numbered .sql files from migrations/ in ascending order, tracking
what's already run in the schema_migrations table so each file executes
at most once per database.

This does NOT replace the table definitions already in init_db() (see
app/db.py) — those keep working exactly as before, including their
ad-hoc PRAGMA table_info() + ALTER TABLE patches for pre-existing
databases. migrations/001_baseline.sql re-declares that same schema
using CREATE TABLE/INDEX IF NOT EXISTS, so running it against a database
init_db() already built is a safe no-op; its real job is to seed
schema_migrations with a starting point.

Going forward, a schema change is a new numbered file in migrations/
(e.g. 002_add_post_visibility.sql) instead of another conditional
ALTER TABLE spliced into init_db().

Usage: run_migrations(conn) — call once at startup, after init_db().
"""
import os
import re

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'migrations'
)

_FILENAME_RE = re.compile(r'^(\d+)_.*\.sql$')


def _pending_migrations():
    """[(version, filepath), ...] for every migrations/NNN_*.sql file on
    disk, sorted by version. Files that don't match the NNN_name.sql
    naming pattern are ignored (e.g. a stray README)."""
    if not os.path.isdir(MIGRATIONS_DIR):
        return []
    found = []
    for name in os.listdir(MIGRATIONS_DIR):
        m = _FILENAME_RE.match(name)
        if m:
            found.append((int(m.group(1)), os.path.join(MIGRATIONS_DIR, name)))
    return sorted(found, key=lambda pair: pair[0])


def run_migrations(conn):
    """Apply any migrations/*.sql files not yet recorded in
    schema_migrations, in ascending version order.

    Each file is executed and recorded in its own commit, so if one
    fails, every version before it stays applied and re-running the
    process later picks up where it left off instead of redoing work.
    """
    conn.execute('''
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()

    applied = {row[0] for row in conn.execute('SELECT version FROM schema_migrations')}

    for version, path in _pending_migrations():
        if version in applied:
            continue
        with open(path, 'r') as f:
            sql = f.read()
        conn.executescript(sql)
        conn.execute(
            'INSERT INTO schema_migrations (version, filename) VALUES (?, ?)',
            (version, os.path.basename(path))
        )
        conn.commit()
