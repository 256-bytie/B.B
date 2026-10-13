"""Legacy SQLite migration runner (transitional).

During the SQLite -> PostgreSQL migration, the application still runs against
SQLite when no DATABASE_URL is set (see app/db.py). This module preserves the
pre-Postgres numbered-.sql runner so the SQLite path keeps working unchanged.

The Postgres migration runner lives in app/migrations.py and reads
migrations/pg/; this module reads the legacy migrations/*.sql files. Those
files are frozen history (do not add new SQLite migrations); once the cutover
to Postgres is complete this module and the migrations/*.sql directory are
deleted.
"""
import os
import re

SQLITE_MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'migrations'
)

_FILENAME_RE = re.compile(r'^(\d+)_.*\.sql$')


def _pending_migrations():
    """[(version, filepath), ...] for every migrations/NNN_*.sql file on
    disk, sorted by version. Files that don't match the NNN_name.sql naming
    pattern are ignored."""
    if not os.path.isdir(SQLITE_MIGRATIONS_DIR):
        return []
    found = []
    for name in os.listdir(SQLITE_MIGRATIONS_DIR):
        m = _FILENAME_RE.match(name)
        if m:
            found.append((int(m.group(1)), os.path.join(SQLITE_MIGRATIONS_DIR, name)))
    return sorted(found, key=lambda pair: pair[0])


def run_sqlite_migrations(conn):
    """Apply migrations/*.sql files not yet recorded in schema_migrations, in
    ascending version order. Each file executes and records in its own commit.

    This mirrors the historical app/migrations.py runner; it builds the full
    SQLite schema (the migrations/001_baseline.sql snapshot plus 002-008) so
    a fresh SQLite database is fully provisioned without the inline CREATE
    TABLE blocks that used to live in init_db().
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
